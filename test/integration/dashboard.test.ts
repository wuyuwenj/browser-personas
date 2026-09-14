import { afterEach, describe, expect, it } from "vitest";
import puppeteer from "puppeteer-core";
import { DOORVEST, startPersonaHarness, type PersonaHarness } from "./personaHarness.js";

import { request } from "node:http";

/** The console is token-gated; the daemon prints the whole link. */
const consoleUrl = (harness: PersonaHarness): string => harness.daemon.consoleUrl();
const stateUrl = (harness: PersonaHarness): string => consoleUrl(harness).replace("/?", "/api/state?");

/** `fetch` will not set Host, and Host is exactly what a rebinding attack controls. */
function rawGet(port: number, search: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: `/${search}`, method: "GET", headers: { host } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** The human's view of who is holding what, served by the daemon itself. */
describe("console", () => {
  it("refuses to serve itself without the token, and to anyone off loopback", async () => {
    const local = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    try {
      const noToken = await fetch(`http://127.0.0.1:${local.daemon.port}/`);
      expect(noToken.status).toBe(401);

      const badToken = await fetch(`http://127.0.0.1:${local.daemon.port}/?t=nope`);
      expect(badToken.status).toBe(401);

      // A rebound hostname reaches the port carrying somebody else's Host header. `fetch`
      // refuses to set Host at all, so this has to go out as a raw request.
      const rebound = await rawGet(local.daemon.port, new URL(consoleUrl(local)).search, "evil.example");
      expect(rebound).toBe(403);

      // The CDP endpoints must stay open — a client has nowhere to put a token.
      const cdp = await fetch(`http://127.0.0.1:${local.daemon.port}/json/version`);
      expect(cdp.status).toBe(200);
    } finally {
      await local.dispose();
    }
  }, 60_000);

  it("refuses a cross-origin write even with the token", async () => {
    const local = await startPersonaHarness([]);
    try {
      const url = new URL(consoleUrl(local));
      const res = await fetch(`http://127.0.0.1:${local.daemon.port}/api/personas?t=${url.searchParams.get("t")}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ name: "sneaky", origin: DOORVEST }),
      });
      expect(res.status).toBe(403);
    } finally {
      await local.dispose();
    }
  }, 60_000);

  let harness: PersonaHarness;

  afterEach(async () => {
    await harness?.dispose();
  });

  it("names each persona, its scope, and the agents holding it", async () => {
    harness = await startPersonaHarness([
      {
        name: "katy",
        description: "Owner with a renewal awaiting approval.",
        env: "staging",
        read_only: "cooperative",
        accounts: [{ origin: DOORVEST }],
      },
    ]);
    const browser = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent-1", "katy") });
    try {
      const page = await browser.newPage();
      await page.goto("data:text/html,<title>work</title>");

      const html = await (await fetch(consoleUrl(harness))).text();

      // The shell ships the markup; the persona rows come from state, so that is where
      // the facts are asserted.
      expect(html).toContain("Add a persona");
      expect(html).toContain("devtools://devtools/bundled/inspector.html");

      const state = (await (await fetch(stateUrl(harness))).json()) as {
        personas: { name: string; description?: string; env?: string; readOnly: unknown; origins: string[] }[];
        owners: { id: string; tabs: unknown[] }[];
      };
      const katy = state.personas.find((p) => p.name === "katy");
      expect(katy?.description).toBe("Owner with a renewal awaiting approval.");
      expect(katy?.env).toBe("staging");
      expect(katy?.readOnly).toBe("cooperative");
      expect(katy?.origins).toContain(DOORVEST);
      expect(state.owners.find((o) => o.id === "agent-1")?.tabs.length).toBeGreaterThan(0);
    } finally {
      await browser.disconnect();
    }
  }, 120_000);

  it("flags a persona two agents are sharing", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const a = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent-1", "katy") });
    const b = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent-2", "katy") });
    try {
      const state = await (await fetch(stateUrl(harness))).json();
      const katy = (state as { personas: { name: string; holders: { owner: string }[] }[] }).personas
        .find((p) => p.name === "katy");
      expect(katy?.holders.map((h) => h.owner).sort()).toEqual(["agent-1", "agent-2"]);
    } finally {
      await a.disconnect();
      await b.disconnect();
    }
  }, 120_000);

  it("escapes persona text rather than letting it into the page as markup", async () => {
    harness = await startPersonaHarness([
      { name: "katy", description: "<script>alert(1)</script>", env: "staging", accounts: [{ origin: DOORVEST }] },
    ]);
    // Persona text reaches the page as JSON and is escaped again when rendered, so a
    // description someone else wrote cannot become markup.
    const html = await (await fetch(consoleUrl(harness))).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("\\u003c");
  }, 60_000);
});
