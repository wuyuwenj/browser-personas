import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { BrowserPersonasDaemon } from "../../src/proxy/server.js";
import { saveManifest } from "../../src/personas/manifest.js";
import { readJar, vaultKey, writeJar } from "../../src/personas/vault.js";
import { jarPath } from "../../src/personas/manifest.js";

/**
 * The shape of an OAuth login, without an OAuth provider.
 *
 * A sign-in through Google, GitHub or Okta leaves two things a cookies-only jar misses:
 * a token in `localStorage`, and a session that only exists because the app was allowed
 * to redirect to somebody else's origin. This stands up a tiny app that keeps its auth
 * exactly that way, so both can be asserted without depending on a third party.
 */
describe("a login that keeps its token in web storage", () => {
  let app: Server;
  let appPort = 0;
  let root: string;
  let daemon: BrowserPersonasDaemon;

  beforeEach(async () => {
    app = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>app</title><body>signed in as <span id=who></span>
        <script>document.getElementById("who").textContent = localStorage.getItem("auth_token") || "nobody";</script>`);
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    appPort = (app.address() as { port: number }).port;

    root = mkdtempSync(join(tmpdir(), "bp-oauth-"));
    saveManifest(join(root, "personas"), {
      name: "oauthy",
      env: "staging",
      accounts: [{ origin: `http://127.0.0.1:${appPort}` }],
    });
    daemon = new BrowserPersonasDaemon({
      port: 0,
      host: "127.0.0.1",
      userDataDir: join(root, "chrome-profile"),
      personasDir: join(root, "personas"),
      configDir: root,
      headless: true,
      sweepIntervalMs: 0,
    });
    await daemon.start();
  }, 90_000);

  afterEach(async () => {
    await daemon?.stop();
    await new Promise<void>((resolve) => app.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  const ws = (owner: string): string =>
    `ws://127.0.0.1:${daemon.port}/devtools/browser/bp?owner=${owner}&persona=oauthy`;

  it("restores a localStorage token, so the app sees the persona as signed in", async () => {
    // What a captured OAuth login looks like on disk: no useful cookie, a token in storage.
    writeJar(jarPath(join(root, "personas"), "oauthy"), vaultKey(root), {
      version: 2,
      cookies: [],
      storage: { [`http://127.0.0.1:${appPort}`]: { local: { auth_token: "from-google" }, session: {} } },
    });
    await daemon.personas.restore("oauthy");

    const browser = await puppeteer.connect({ browserWSEndpoint: ws("agent") });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${appPort}/`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => document.getElementById("who")?.textContent !== "", { timeout: 15_000 });
      expect(await page.$eval("#who", (el) => el.textContent)).toBe("from-google");
    } finally {
      await browser.disconnect();
    }
  }, 120_000);

  it("captures a token the app wrote, so a manual sign-in of any kind is enough", async () => {
    const browser = await puppeteer.connect({ browserWSEndpoint: ws("agent") });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${appPort}/`, { waitUntil: "domcontentloaded" });
      // Stand in for whatever the provider's redirect left behind.
      await page.evaluate(() => localStorage.setItem("auth_token", "written-by-the-app"));
    } finally {
      await browser.disconnect();
    }

    // Seed the jar with the origin so persist knows where to look, then persist.
    writeJar(jarPath(join(root, "personas"), "oauthy"), vaultKey(root), {
      version: 2,
      cookies: [],
      storage: { [`http://127.0.0.1:${appPort}`]: { local: {}, session: {} } },
    });
    // A jar written behind the daemon's back is a login it must load, not overwrite
    // (jarReload.test.ts) — so the seed is loaded first, as the next tab would.
    await daemon.personas.syncJar("oauthy");
    await daemon.personas.persist("oauthy");

    const jar = readJar(jarPath(join(root, "personas"), "oauthy"), vaultKey(root));
    expect(jar.storage[`http://127.0.0.1:${appPort}`]?.local["auth_token"]).toBe("written-by-the-app");
  }, 120_000);

  it("lets the persona reach an identity provider it learned, and still fences the rest", async () => {
    saveManifest(join(root, "personas"), {
      name: "oauthy",
      env: "staging",
      accounts: [{ origin: `http://127.0.0.1:${appPort}` }],
      auth_origins: [`http://localhost:${appPort}`],
    });
    daemon.personas.refresh("oauthy");

    const browser = await puppeteer.connect({ browserWSEndpoint: ws("agent") });
    try {
      const page = await browser.newPage();
      // The learned provider origin is reachable...
      await page.goto(`http://localhost:${appPort}/`, { waitUntil: "domcontentloaded" });
      expect(page.url()).toContain(`localhost:${appPort}`);
      // ...and nothing else is.
      await expect(page.goto("https://doorvest.com/")).rejects.toThrow(/may only reach|staging/i);
    } finally {
      await browser.disconnect();
    }
  }, 120_000);
});
