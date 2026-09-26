import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { startPersonaHarness, type PersonaHarness } from "./personaHarness.js";

/**
 * The login session's checks run against a REAL page here — every page-side script is
 * evaluated in Chrome, so the probe's fetch really lands in the page's resource timing.
 *
 * The scripted fakes in sso.test.ts answer each evaluate from a table, which is how a
 * probe that kept the network from ever looking quiet shipped green: in the fake, the
 * probe sent nothing. demopm6, 9/25: dashboard loaded, API 200, window never closed.
 */
function serve(handler: (url: string) => { status: number; body: string; type?: string }): Promise<{ srv: Server; port: number }> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      const out = handler(req.url ?? "/");
      res.writeHead(out.status, {
        "content-type": out.type ?? "text/html",
        "access-control-allow-origin": "*",
      });
      res.end(out.body);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: (srv.address() as { port: number }).port }));
  });
}

describe("the login session on a real page", () => {
  let harness: PersonaHarness;
  let app: { srv: Server; port: number };
  let tracker: { srv: Server; port: number };
  let browser: Browser;

  beforeEach(async () => {
    tracker = await serve(() => ({ status: 200, body: "{}", type: "application/json" }));
    app = await serve((url) => {
      if (url.startsWith("/api/")) return { status: 200, body: '{"ok":true}', type: "application/json" };
      // A dashboard: one call to its own API on load, and a third-party widget that polls
      // forever — the shape of every real app with analytics or chat.
      return {
        status: 200,
        body: `<!doctype html><title>dash</title>
          <input type="email" value="katy@example.com">
          <script>
            fetch("/api/me");
            setInterval(() => fetch("http://localhost:${tracker.port}/ping"), 200);
          </script>`,
      };
    });
    harness = await startPersonaHarness([]);
    browser = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("test", "default") });
  });
  afterEach(async () => {
    await browser?.disconnect();
    await harness?.dispose();
    app.srv.close();
    tracker.srv.close();
  });

  const appOrigin = () => `http://127.0.0.1:${app.port}`;

  /** A LoginSession whose page-side scripts run in `page`; only the targets are faked. */
  async function sessionOn(page: Page, probe?: string) {
    const { LoginSession } = await import("../../src/personas/loginSession.js");
    const real = await page.createCDPSession();
    const cdp = {
      send: async (method: string, params: Record<string, unknown> = {}) => {
        if (method === "Target.createTarget") return { targetId: "t1" };
        if (method === "Target.attachToTarget") return { sessionId: "s1" };
        if (method === "Target.getTargetInfo") return { targetInfo: { url: page.url() } };
        if (method === "Storage.getCookies") return { cookies: [] };
        if (method === "Runtime.evaluate") return real.send("Runtime.evaluate", params as never);
        return {};
      },
    };
    return LoginSession.start({
      personasDir: harness.personasDir,
      configDir: harness.root,
      persona: "katy",
      url: appOrigin(),
      ...(probe ? { probe } : {}),
      client: { cdp: cdp as never, kill: () => {}, exited: async () => {} },
    });
  }

  /** Poll the way the daemon does, until settled or out of tries. */
  async function settles(session: Awaited<ReturnType<typeof sessionOn>>, tries: number): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      await session.state();
      if (session.settled) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  it("settles when the probe answers 2xx, even though the probe itself is network traffic", async () => {
    const page = await browser.newPage();
    await page.goto(`${appOrigin()}/dashboard`);
    const session = await sessionOn(page, "/api/manager/init");
    try {
      expect(await settles(session, 10), "never settled: the probe kept the page from looking loaded").toBe(true);
    } finally {
      await session.close();
    }
  }, 120_000);

  it("settles without a probe while a third-party widget polls forever", async () => {
    const page = await browser.newPage();
    await page.goto(`${appOrigin()}/dashboard`);
    const session = await sessionOn(page);
    try {
      expect(await settles(session, 12), "never settled: third-party polling kept the network busy").toBe(true);
    } finally {
      await session.close();
    }
  }, 120_000);
});
