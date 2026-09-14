import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { DOORVEST, startPersonaHarness, type PersonaHarness } from "./personaHarness.js";
import { hasSecret } from "../../src/personas/secrets.js";

/** Creating, editing and deleting a persona from the console, without a terminal. */
describe("console API", () => {
  let harness: PersonaHarness;

  afterEach(async () => {
    await harness?.dispose();
  });

  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> => {
    const url = new URL(harness.daemon.consoleUrl());
    const res = await fetch(`http://127.0.0.1:${harness.daemon.port}${path}?t=${url.searchParams.get("t")}`, {
      method,
      headers: body ? { "content-type": "application/json", origin: url.origin } : { origin: url.origin },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("creates a persona that the daemon serves immediately", async () => {
    harness = await startPersonaHarness([]);

    const created = await call("POST", "/api/personas", {
      name: "katy",
      origin: DOORVEST,
      username: "katy@example.com",
      probe: "/my-homes",
      env: "staging",
      description: "Owner with a renewal.",
      read_only: "cooperative",
      exclusive: true,
    });
    expect(created.status).toBe(200);

    const state = (await call("GET", "/api/state")).json as {
      personas: { name: string; env?: string; readOnly: unknown; exclusive: boolean; origins: string[] }[];
    };
    const katy = state.personas.find((p) => p.name === "katy");
    expect(katy).toBeDefined();
    expect(katy?.env).toBe("staging");
    expect(katy?.readOnly).toBe("cooperative");
    expect(katy?.exclusive).toBe(true);
    expect(katy?.origins).toContain(DOORVEST);

    // The fence is live without a restart: an agent on it cannot reach production.
    const browser = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent", "katy") });
    try {
      const page = await browser.newPage();
      await expect(page.goto("https://doorvest.com/")).rejects.toThrow(/may only reach|staging/i);
    } finally {
      await browser.disconnect();
    }
  }, 120_000);

  it("refuses a name that is not a safe directory name", async () => {
    harness = await startPersonaHarness([]);
    for (const name of ["../escape", "with space", "", "a/b"]) {
      const res = await call("POST", "/api/personas", { name, origin: DOORVEST });
      expect(res.status, name).toBe(400);
    }
    expect(existsSync(join(harness.personasDir, "..", "escape"))).toBe(false);
  }, 60_000);

  it("refuses a duplicate rather than overwriting a persona that has a login", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const res = await call("POST", "/api/personas", { name: "katy", origin: DOORVEST });
    expect(res.status).toBe(409);
  }, 60_000);

  it("stores a password encrypted, and never hands it back", async () => {
    harness = await startPersonaHarness([]);
    await call("POST", "/api/personas", { name: "katy", origin: DOORVEST, password: "hunter2-not-real" });

    expect(hasSecret(harness.personasDir, "katy")).toBe(true);

    const state = (await call("GET", "/api/state")).json as { secrets: Record<string, boolean> };
    expect(state.secrets["katy"]).toBe(true);

    const detail = (await call("GET", "/api/personas/katy")).json;
    expect(JSON.stringify(detail)).not.toContain("hunter2-not-real");
    expect(detail["hasSecret"]).toBe(true);

    // And it is not sitting on disk in the clear.
    const { readFileSync } = await import("node:fs");
    const sealed = readFileSync(join(harness.personasDir, "katy", "secret.enc"), "utf8");
    expect(sealed).not.toContain("hunter2-not-real");
  }, 60_000);

  it("edits a persona in place", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const res = await call("PATCH", "/api/personas/katy", { description: "Now a buyer.", read_only: "strict" });
    expect(res.status).toBe(200);

    const state = (await call("GET", "/api/state")).json as {
      personas: { name: string; description?: string; readOnly: unknown }[];
    };
    const katy = state.personas.find((p) => p.name === "katy");
    expect(katy?.description).toBe("Now a buyer.");
    expect(katy?.readOnly).toBe("strict");
  }, 60_000);

  it("refuses to delete a persona an agent is holding, then allows it once they leave", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const browser = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent-1", "katy") });

    const refused = await call("DELETE", "/api/personas/katy");
    expect(refused.status).toBe(409);
    expect(String(refused.json["error"])).toContain("agent-1");
    expect(existsSync(join(harness.personasDir, "katy"))).toBe(true);

    await browser.disconnect();
    await new Promise((r) => setTimeout(r, 500));

    const removed = await call("DELETE", "/api/personas/katy");
    expect(removed.status).toBe(200);
    expect(existsSync(join(harness.personasDir, "katy"))).toBe(false);
  }, 120_000);
});
