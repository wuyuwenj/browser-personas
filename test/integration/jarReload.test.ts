import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { utimesSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { startPersonaHarness, type PersonaHarness } from "./personaHarness.js";
import { jarPath } from "../../src/personas/manifest.js";
import { readJar, vaultKey, writeJar } from "../../src/personas/vault.js";

/**
 * A login saved OUTSIDE the daemon — `browser-personas login` runs its own browser and
 * writes the jar directly. demopm6, 9/25: the jar was valid, the sign-in window opened
 * already signed in, and every agent tab still landed on the sign-in page, because the
 * daemon's context had loaded the jar once at creation and never looked again.
 */
describe("a login saved while the daemon is running", () => {
  let harness: PersonaHarness;
  let app: { srv: Server; port: number };

  beforeEach(async () => {
    app = await new Promise((resolve) => {
      const srv = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>app</title>ok");
      });
      srv.listen(0, "127.0.0.1", () => resolve({ srv, port: (srv.address() as { port: number }).port }));
    });
  });
  afterEach(async () => {
    await harness?.dispose();
    app.srv.close();
  });

  const origin = () => `http://127.0.0.1:${app.port}`;

  /** What the CLI does: write the jar, straight to disk, with no word to the daemon. */
  function saveLoginOutsideDaemon(value: string): void {
    const path = jarPath(harness.personasDir, "katy");
    writeJar(path, vaultKey(harness.root), {
      version: 2,
      cookies: [{ name: "session", value, domain: "127.0.0.1", path: "/" }],
      storage: {},
    });
    // Filesystem mtimes can be coarse; make "newer" unambiguous.
    const later = new Date(Date.now() + 5_000);
    utimesSync(path, later, later);
  }

  const sessionCookie = async (page: import("puppeteer-core").Page): Promise<string | null> =>
    page.evaluate(() => /(?:^|; )session=([^;]*)/.exec(document.cookie)?.[1] ?? null);

  it("reaches the agent's next tab without a restart or a reconnect", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: origin() }] }]);
    const browser = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent", "katy") });
    try {
      const before = await browser.newPage();
      await before.goto(`${origin()}/`);
      expect(await sessionCookie(before)).toBeNull();

      saveLoginOutsideDaemon("fresh");

      // Same connection, next tab.
      const after = await browser.newPage();
      await after.goto(`${origin()}/`);
      expect(await sessionCookie(after), "the new tab still has the old, signed-out session").toBe("fresh");
    } finally {
      await browser.disconnect();
    }
  }, 120_000);

  it("does not mistake the daemon's own save for a new login", async () => {
    // The daemon saves, the session moves on, the agent opens a tab. Reloading the
    // daemon's own older save there would roll the live session back.
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: origin() }] }]);
    const agent = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent", "katy") });
    try {
      const page = await agent.newPage();
      await page.goto(`${origin()}/`);
      await page.evaluate(() => {
        document.cookie = "session=one; path=/";
      });

      // Another client leaving is what makes the daemon save every persona.
      const other = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("other", "katy") });
      await other.disconnect();
      await new Promise((r) => setTimeout(r, 1_500));
      const jar = readJar(jarPath(harness.personasDir, "katy"), vaultKey(harness.root));
      expect(jar.cookies.find((c) => c["name"] === "session")?.["value"], "the daemon never saved").toBe("one");

      await page.evaluate(() => {
        document.cookie = "session=two; path=/";
      });
      const next = await agent.newPage();
      await next.goto(`${origin()}/`);
      expect(await sessionCookie(next), "rolled back to the daemon's own earlier save").toBe("two");
    } finally {
      await agent.disconnect();
    }
  }, 120_000);

  it("is not overwritten by the daemon saving its stale session on disconnect", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: origin() }] }]);
    const browser = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent", "katy") });
    const page = await browser.newPage();
    await page.goto(`${origin()}/`);
    // The daemon's live context holds a session of its own — the signed-out one.
    await page.evaluate(() => {
      document.cookie = "session=stale; path=/";
    });

    saveLoginOutsideDaemon("fresh");

    // Disconnecting the last client saves every persona's live cookies to disk.
    await browser.disconnect();
    await new Promise((r) => setTimeout(r, 1_500));

    const jar = readJar(jarPath(harness.personasDir, "katy"), vaultKey(harness.root));
    const saved = jar.cookies.find((c) => c["name"] === "session")?.["value"];
    expect(saved, "the fresh login was replaced by the daemon's stale session").toBe("fresh");
  }, 120_000);
});
