import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { utimesSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { startPersonaHarness, type PersonaHarness } from "./personaHarness.js";
import { saveManifest } from "../../src/personas/manifest.js";

/**
 * Two origins, because SSO is two origins. Every login test before this one used a single
 * app, so nothing ever crossed to an identity provider — which is how a strict persona
 * that could not sign in with Google shipped. The "IdP" here is a second server on a
 * different host name; the browser treats it as a separate origin, exactly like
 * accounts.google.com.
 */
function server(): Promise<{ srv: Server; port: number }> {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>${req.method} ${req.url}</title>ok`);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: (srv.address() as { port: number }).port }));
  });
}

describe("a strict persona signing in through a second origin", () => {
  let harness: PersonaHarness;
  let app: { srv: Server; port: number };
  let idp: { srv: Server; port: number };

  beforeEach(async () => {
    app = await server();
    idp = await server();
  });
  afterEach(async () => {
    await harness?.dispose();
    app.srv.close();
    idp.srv.close();
  });

  // 127.0.0.1 and localhost are different origins to the browser.
  const appOrigin = () => `http://127.0.0.1:${app.port}`;
  const idpOrigin = () => `http://localhost:${idp.port}`;

  const postFrom = async (page: import("puppeteer-core").Page, url: string): Promise<number> =>
    page.evaluate(async (u) => (await fetch(u, { method: "POST", body: "credential=x" })).status, url);

  it("can POST to its identity provider but still cannot POST to its app", async () => {
    harness = await startPersonaHarness([
      {
        name: "katy",
        env: "staging",
        read_only: "strict",
        accounts: [{ origin: appOrigin() }],
        auth_origins: [idpOrigin()],
      },
    ]);
    const browser = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent", "katy") });
    try {
      const page = await browser.newPage();

      // On the IdP, the credential POST goes through — before the fix this was the 403
      // that Google reports as "Something went wrong".
      await page.goto(`${idpOrigin()}/signin`, { waitUntil: "domcontentloaded" });
      expect(await postFrom(page, `${idpOrigin()}/signin/credential`)).toBe(200);

      // Back on the app, strict still means strict.
      await page.goto(`${appOrigin()}/dashboard`, { waitUntil: "domcontentloaded" });
      expect(await postFrom(page, `${appOrigin()}/api/write`)).toBe(403);
    } finally {
      await browser.disconnect();
    }
  }, 120_000);

  it("picks up a hand edit of manifest.yaml without a restart", async () => {
    harness = await startPersonaHarness([
      { name: "katy", env: "staging", accounts: [{ origin: appOrigin() }] },
    ]);
    const browser = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent", "katy") });
    try {
      const page = await browser.newPage();
      await expect(page.goto(`${idpOrigin()}/signin`)).rejects.toThrow(/may only reach/);

      // Edit the file the way a person would — no console, no API, no refresh call.
      saveManifest(harness.personasDir, {
        name: "katy",
        env: "staging",
        accounts: [{ origin: appOrigin() }],
        auth_origins: [idpOrigin()],
      });
      const later = new Date(Date.now() + 2_000);
      utimesSync(`${harness.personasDir}/katy/manifest.yaml`, later, later);

      await page.goto(`${idpOrigin()}/signin`, { waitUntil: "domcontentloaded" });
      expect(page.url()).toContain(`localhost:${idp.port}`);
    } finally {
      await browser.disconnect();
    }
  }, 120_000);
});

/**
 * The login session's own judgement, driven through a scripted browser so the SSO journey
 * — app, out to the provider, back — can be replayed exactly, including the target swap a
 * real cross-origin round trip causes.
 */
describe("the login session across an SSO round trip", () => {
  let harness: PersonaHarness;
  afterEach(async () => {
    await harness?.dispose();
  });

  const APP = "https://app.example.com";
  const IDP = "https://accounts.google.com";

  type Step = { url: string; targetId?: string; typed?: string };

  async function scripted(steps: Step[], probe?: string) {
    const { LoginSession } = await import("../../src/personas/loginSession.js");
    let at = 0;
    const attached: string[] = [];
    const current = () => steps[Math.min(at, steps.length - 1)]!;
    const cdp = {
      send: async (method: string, params: Record<string, unknown> = {}) => {
        const step = current();
        const liveId = step.targetId ?? "t1";
        if (method === "Target.createTarget") return { targetId: "t1" };
        if (method === "Target.attachToTarget") {
          attached.push(String(params["targetId"]));
          return { sessionId: `s-${String(params["targetId"])}` };
        }
        if (method === "Target.getTargetInfo") {
          // The original page target dies when the round trip replaces it.
          if (params["targetId"] !== liveId) throw new Error("No target with given id found");
          return { targetInfo: { url: step.url } };
        }
        if (method === "Target.getTargets") return { targetInfos: [{ targetId: liveId, type: "page", url: step.url }] };
        if (method === "Storage.getCookies") return { cookies: [] };
        if (method === "Runtime.evaluate") {
          const expr = String(params["expression"] ?? "");
          if (expr.includes("querySelectorAll")) return { result: { value: step.typed ?? null } };
          if (expr.includes("fetch(")) return { result: { value: step.url.startsWith(APP) && step.url.includes("/dashboard") ? 200 : 401 } };
          return { result: { value: { local: {}, session: {} } } };
        }
        return {};
      },
    };
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: APP }] }]);
    const session = await LoginSession.start({
      personasDir: harness.personasDir,
      configDir: harness.root,
      persona: "katy",
      url: `${APP}/admin`,
      ...(probe ? { probe } : {}),
      client: { cdp: cdp as never, kill: () => {}, exited: async () => {} },
    });
    const next = async () => {
      const state = await session.state();
      at++;
      return state;
    };
    return { session, next, attached };
  }

  it("does not count the identity provider's page as signed in", async () => {
    // The account chooser is the case that matters: a provider page whose path looks
    // nothing like a sign-in page, reached after the human has typed an address.
    const { session, next } = await scripted([
      { url: `${APP}/admin` },
      { url: `${IDP}/v3/signin/identifier?state=abc`, typed: "katy@example.com" },
      { url: `${IDP}/AccountChooser?continue=x` },
      { url: `${IDP}/AccountChooser?continue=x` },
    ]);
    try {
      await next();
      await next();
      expect((await next()).signedIn, "counted the IdP account chooser as signed in").toBe(false);
      await next();
      expect(session.settled).toBe(false);
    } finally {
      await session.close();
    }
  }, 90_000);

  it("does not count an instant logged-out redirect as a sign-in", async () => {
    // /admin bounces a logged-out visitor to "/": off the start URL, not a login path,
    // and nobody has touched the page.
    const { session, next } = await scripted([{ url: `${APP}/` }, { url: `${APP}/` }, { url: `${APP}/` }]);
    try {
      await next();
      await next();
      await next();
      expect(session.settled, "saved a session nobody had signed in to").toBe(false);
    } finally {
      await session.close();
    }
  }, 90_000);

  it("settles once the human is back on the app after the provider", async () => {
    const { session, next } = await scripted([
      { url: `${APP}/admin` },
      { url: `${IDP}/v3/signin/identifier`, typed: "katy@example.com" },
      { url: `${APP}/dashboard?code=one-time&state=abc` },
      { url: `${APP}/dashboard?code=one-time&state=abc` },
    ]);
    try {
      for (let i = 0; i < 4; i++) await next();
      expect(session.settled).toBe(true);

      // The inferred probe is the app's path — never the query's one-time state, and
      // never anything on the provider's origin.
      await session.finish();
      const { loadManifest } = await import("../../src/personas/manifest.js");
      expect(loadManifest(harness.personasDir, "katy")?.accounts?.[0]?.probe).toBe("/dashboard");
    } finally {
      await session.close();
    }
  }, 90_000);

  it("follows the tab when the round trip replaces its page target", async () => {
    const { session, next, attached } = await scripted(
      [
        { url: `${APP}/admin`, targetId: "t1" },
        { url: `${IDP}/v3/signin`, targetId: "t2" },
        { url: `${APP}/dashboard`, targetId: "t3" },
        { url: `${APP}/dashboard`, targetId: "t3" },
      ],
      "/dashboard",
    );
    try {
      await next();
      const onIdp = await next();
      expect(onIdp.currentUrl, "fell back to the start URL when t1 died").toContain(IDP);
      await next();
      await next();
      expect(attached).toContain("t3");
      expect(session.settled, "never settled after the target swap").toBe(true);
    } finally {
      await session.close();
    }
  }, 90_000);
});
