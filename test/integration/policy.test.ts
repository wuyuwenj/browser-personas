import { afterEach, describe, expect, it } from "vitest";
import puppeteer from "puppeteer-core";
import { DOORVEST, doorvestIsUp, startPersonaHarness, type PersonaHarness } from "./personaHarness.js";

const up = await doorvestIsUp();

/**
 * The restrictions a persona can carry, against the real app.
 *
 * The production case is asserted by refusal: the proxy answers the navigation itself, so
 * no request ever leaves this machine. A test that reached production to prove it could
 * not reach production would defeat its own purpose.
 */
describe.skipIf(!up)("persona restrictions", () => {
  let harness: PersonaHarness;

  afterEach(async () => {
    await harness?.dispose();
  });

  it("refuses to navigate a staging persona to production, and issues no request", async () => {
    harness = await startPersonaHarness([
      { name: "staging-only", env: "staging", accounts: [{ origin: DOORVEST }] },
    ]);
    const browser = await puppeteer.connect({
      browserWSEndpoint: harness.wsUrl("agent", "staging-only"),
    });
    try {
      const page = await browser.newPage();
      const attempted: string[] = [];
      page.on("request", (r) => attempted.push(r.url()));

      await expect(page.goto("https://doorvest.com/admin")).rejects.toThrow(/may only reach|staging/i);

      expect(attempted.filter((u) => u.includes("doorvest.com"))).toEqual([]);
      // The persona's own app is still reachable; the rule is a fence, not a wall.
      await page.goto(`${DOORVEST}/login`, { waitUntil: "domcontentloaded" });
      expect(page.url()).toContain("localhost:3005");
    } finally {
      await browser.disconnect();
    }
  }, 180_000);

  it("hands an exclusive persona to one agent and names the holder to the second", async () => {
    harness = await startPersonaHarness([
      { name: "solo", env: "staging", exclusive: true, accounts: [{ origin: DOORVEST }] },
    ]);
    const first = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("first", "solo") });
    try {
      await expect(
        puppeteer.connect({ browserWSEndpoint: harness.wsUrl("second", "solo") }),
      ).rejects.toThrow();
      expect(harness.daemon.personas.leaseHolder("solo")).toBe("first");
    } finally {
      await first.disconnect();
    }
  }, 120_000);

  it("lets a second agent in once the holder disconnects", async () => {
    harness = await startPersonaHarness([
      { name: "solo", env: "staging", exclusive: true, accounts: [{ origin: DOORVEST }] },
    ]);
    const first = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("first", "solo") });
    await first.disconnect();
    await new Promise((r) => setTimeout(r, 500));

    const second = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("second", "solo") });
    try {
      expect(harness.daemon.personas.leaseHolder("solo")).toBe("second");
    } finally {
      await second.disconnect();
    }
  }, 120_000);

  it("blocks a write from a strict read-only persona and explains itself in the response", async () => {
    harness = await startPersonaHarness([
      { name: "readonly", env: "staging", read_only: "strict", accounts: [{ origin: DOORVEST }] },
    ]);
    const browser = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent", "readonly") });
    try {
      const page = await browser.newPage();
      await page.goto(`${DOORVEST}/login`, { waitUntil: "domcontentloaded" });

      const outcome = await page.evaluate(async (base) => {
        const res = await fetch(`${base}/api/does-not-matter`, { method: "POST", body: "{}" });
        return { status: res.status, body: await res.text() };
      }, DOORVEST);

      expect(outcome.status).toBe(403);
      expect(outcome.body).toContain("blocked_by_browser_personas");
      expect(outcome.body).toContain("Read-only");

      // A GET on the same origin is untouched, so the agent can still read everything.
      const read = await page.evaluate(async (base) => (await fetch(`${base}/login`)).status, DOORVEST);
      expect(read).toBe(200);
    } finally {
      await browser.disconnect();
    }
  }, 180_000);

  it("passes a write through on a cooperative persona, stamped for the app to refuse", async () => {
    harness = await startPersonaHarness([
      { name: "coop", env: "staging", read_only: "cooperative", accounts: [{ origin: DOORVEST }] },
    ]);
    const browser = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent", "coop") });
    try {
      const page = await browser.newPage();
      await page.goto(`${DOORVEST}/login`, { waitUntil: "domcontentloaded" });

      // The proxy cannot tell a server action that reads from one that writes, so it
      // marks the request and leaves the decision to the application.
      const status = await page.evaluate(
        async (base) => (await fetch(`${base}/api/does-not-matter`, { method: "POST", body: "{}" })).status,
        DOORVEST,
      );
      expect(status).not.toBe(403);
    } finally {
      await browser.disconnect();
    }
  }, 180_000);
});
