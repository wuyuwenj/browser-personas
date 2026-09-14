import { afterEach, describe, expect, it } from "vitest";
import puppeteer from "puppeteer-core";
import { DOORVEST, startPersonaHarness, type PersonaHarness } from "./personaHarness.js";

/** The human's view of who is holding what, served by the daemon itself. */
describe("dashboard", () => {
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

      const html = await (await fetch(`http://127.0.0.1:${harness.daemon.port}/`)).text();

      expect(html).toContain("katy");
      expect(html).toContain("Owner with a renewal awaiting approval.");
      expect(html).toContain("staging");
      expect(html).toContain("read-only: cooperative");
      expect(html).toContain("agent-1");
      // A watch link per tab, so a human can look without taking the tab.
      expect(html).toContain("devtools://devtools/bundled/inspector.html");
    } finally {
      await browser.disconnect();
    }
  }, 120_000);

  it("flags a persona two agents are sharing", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const a = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent-1", "katy") });
    const b = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent-2", "katy") });
    try {
      const html = await (await fetch(`http://127.0.0.1:${harness.daemon.port}/`)).text();
      expect(html).toContain("shared by 2 agents");
      expect(html).toContain("agent-1");
      expect(html).toContain("agent-2");
    } finally {
      await a.disconnect();
      await b.disconnect();
    }
  }, 120_000);

  it("escapes persona text rather than letting it into the page as markup", async () => {
    harness = await startPersonaHarness([
      { name: "katy", description: "<script>alert(1)</script>", env: "staging", accounts: [{ origin: DOORVEST }] },
    ]);
    const html = await (await fetch(`http://127.0.0.1:${harness.daemon.port}/`)).text();

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  }, 60_000);
});
