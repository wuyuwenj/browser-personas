import { afterEach, describe, expect, it } from "vitest";
import puppeteer from "puppeteer-core";
import { DOORVEST, startPersonaHarness, type PersonaHarness } from "./personaHarness.js";
import { loadManifest } from "../../src/personas/manifest.js";

/**
 * A persona is a person, and a person signs in to more than one site. The websites are
 * addressed by origin rather than by position: an index-keyed API lands the edit on the
 * wrong site the moment a row is removed between read and write, and does it silently.
 */
describe("a persona with several websites", () => {
  let harness: PersonaHarness;

  afterEach(async () => {
    await harness?.dispose();
  });

  const call = async (method: string, path: string, body?: unknown) => {
    const url = new URL(harness.daemon.consoleUrl());
    const res = await fetch(`http://127.0.0.1:${harness.daemon.port}${path}?t=${url.searchParams.get("t")}`, {
      method,
      headers: body ? { "content-type": "application/json", origin: url.origin } : { origin: url.origin },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  const OTHER = "https://admin.example.com";

  it("adds a second website, and both are in scope for the same agent", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);

    const added = await call("PUT", "/api/personas/katy/accounts", {
      origin: OTHER,
      username: "katy@admin",
      role: "admin",
      probe: "/dashboard",
    });
    expect(added.status).toBe(200);

    const manifest = loadManifest(harness.personasDir, "katy");
    expect(manifest?.accounts?.map((a) => a.origin).sort()).toEqual([OTHER, DOORVEST].sort());
    expect(manifest?.accounts?.find((a) => a.origin === OTHER)?.role).toBe("admin");

    const state = (await call("GET", "/api/state")).json as {
      personas: { name: string; origins: string[]; accounts: { origin: string; probe?: string }[] }[];
    };
    const katy = state.personas.find((p) => p.name === "katy");
    expect(katy?.origins).toContain(OTHER);
    expect(katy?.origins).toContain(DOORVEST);
    expect(katy?.accounts.find((a) => a.origin === OTHER)?.probe).toBe("/dashboard");
  }, 90_000);

  it("edits one website without touching the other", async () => {
    harness = await startPersonaHarness([
      { name: "katy", env: "staging", accounts: [{ origin: DOORVEST, username: "first" }, { origin: OTHER, username: "second" }] },
    ]);

    await call("PUT", "/api/personas/katy/accounts", { origin: OTHER, username: "changed" });

    const manifest = loadManifest(harness.personasDir, "katy");
    expect(manifest?.accounts?.find((a) => a.origin === DOORVEST)?.username).toBe("first");
    expect(manifest?.accounts?.find((a) => a.origin === OTHER)?.username).toBe("changed");
    expect(manifest?.accounts).toHaveLength(2);
  }, 90_000);

  it("removes one website and keeps the rest of the persona intact", async () => {
    harness = await startPersonaHarness([
      { name: "katy", description: "Owner.", env: "staging", accounts: [{ origin: DOORVEST }, { origin: OTHER }] },
    ]);

    const removed = await call("DELETE", "/api/personas/katy/accounts", { origin: OTHER });
    expect(removed.status).toBe(200);

    const manifest = loadManifest(harness.personasDir, "katy");
    expect(manifest?.accounts?.map((a) => a.origin)).toEqual([DOORVEST]);
    expect(manifest?.description).toBe("Owner.");
  }, 90_000);

  it("refuses to remove the last website, which would silently unscope the persona", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);

    const refused = await call("DELETE", "/api/personas/katy/accounts", { origin: DOORVEST });
    expect(refused.status).toBe(409);
    expect(String(refused.json["error"])).toContain("Delete the persona instead");
    expect(loadManifest(harness.personasDir, "katy")?.accounts).toHaveLength(1);
  }, 90_000);

  it("refuses a website that is not a URL, and an unknown one on remove", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);

    expect((await call("PUT", "/api/personas/katy/accounts", { origin: "not a url" })).status).toBe(400);
    expect((await call("DELETE", "/api/personas/katy/accounts", { origin: "https://nope.example" })).status).toBe(404);
  }, 90_000);

  it("fences to every one of the persona's websites, and nothing else", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    await call("PUT", "/api/personas/katy/accounts", { origin: `http://127.0.0.1:${harness.daemon.port}` });

    const browser = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent", "katy") });
    try {
      const page = await browser.newPage();
      // The second website is reachable the moment it is added, with no restart.
      await page.goto(`http://127.0.0.1:${harness.daemon.port}/health`, { waitUntil: "domcontentloaded" });
      expect(page.url()).toContain("/health");
      await expect(page.goto("https://doorvest.com/")).rejects.toThrow(/may only reach|staging/i);
    } finally {
      await browser.disconnect();
    }
  }, 120_000);

  it("carries the first website's session into a second sign-in, rather than replacing it", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const { writeJar, vaultKey } = await import("../../src/personas/vault.js");
    const { jarPath } = await import("../../src/personas/manifest.js");
    const { LoginSession } = await import("../../src/personas/loginSession.js");

    writeJar(jarPath(harness.personasDir, "katy"), vaultKey(harness.root), {
      version: 2,
      cookies: [{ name: "first_site", value: "kept", domain: "localhost", path: "/" }],
      storage: { [DOORVEST]: { local: { token: "from-first" }, session: {} } },
    });

    // A fake browser, so what the session SENDS can be asserted without a window opening.
    const sent: { method: string; params: Record<string, unknown> }[] = [];
    const cdp = {
      send: async (method: string, params: Record<string, unknown> = {}) => {
        sent.push({ method, params });
        if (method === "Target.createTarget") return { targetId: "t1" };
        if (method === "Target.attachToTarget") return { sessionId: "s1" };
        return {};
      },
    };

    const session = await LoginSession.start({
      personasDir: harness.personasDir,
      configDir: harness.root,
      persona: "katy",
      url: OTHER,
      client: { cdp: cdp as never, kill: () => {}, exited: async () => {} },
    });
    await session.close();

    // The old cookies go in BEFORE the human starts, so the capture at the end is the
    // union of both sites. Without this, signing in to the second site logs out the first.
    const setCookies = sent.find((c) => c.method === "Storage.setCookies");
    expect(setCookies, "the existing jar was never restored into the login browser").toBeDefined();
    expect((setCookies!.params["cookies"] as { name: string }[]).map((c) => c.name)).toContain("first_site");

    // And the first site's web storage is replayed too, by opening a tab on its origin.
    expect(sent.some((c) => c.method === "Target.createTarget" && String(c.params["url"]).startsWith(DOORVEST)))
      .toBe(true);
  }, 90_000);
});

/**
 * Filling in the username after a login, rather than asking for it twice. The session's
 * decisions are driven through a fake browser so both sources can be exercised: the field
 * a human typed into, and the ID token an OAuth sign-in leaves behind.
 */
describe("learning who signed in", () => {
  let harness: PersonaHarness;

  afterEach(async () => {
    await harness?.dispose();
  });

  const jwt = (payload: Record<string, unknown>): string =>
    ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");

  async function runLogin(opts: {
    typed?: string | null;
    cookies?: Record<string, unknown>[];
    storage?: Record<string, { local: Record<string, string>; session: Record<string, string> }>;
  }) {
    const { LoginSession } = await import("../../src/personas/loginSession.js");
    const cdp = {
      send: async (method: string, params: Record<string, unknown> = {}) => {
        if (method === "Target.createTarget") return { targetId: "t1" };
        if (method === "Target.attachToTarget") return { sessionId: "s1" };
        if (method === "Storage.getCookies") return { cookies: opts.cookies ?? [] };
        if (method === "Runtime.evaluate") {
          const expr = String(params["expression"] ?? "");
          if (expr.includes("querySelectorAll")) return { result: { value: opts.typed ?? null } };
          if (expr.includes("localStorage")) {
            const first = Object.values(opts.storage ?? {})[0];
            return { result: { value: first ?? { local: {}, session: {} } } };
          }
        }
        return {};
      },
    };
    const session = await LoginSession.start({
      personasDir: harness.personasDir,
      configDir: harness.root,
      persona: "katy",
      url: DOORVEST,
      client: { cdp: cdp as never, kill: () => {}, exited: async () => {} },
    });
    await session.state();
    await session.finish();
    return loadManifest(harness.personasDir, "katy");
  }

  it("fills in the address the human typed into the sign-in form", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const manifest = await runLogin({ typed: "katy@example.com" });
    expect(manifest?.accounts?.find((a) => a.origin === DOORVEST)?.username).toBe("katy@example.com");
  }, 90_000);

  it("reads the address out of an ID token when the sign-in was OAuth", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    // No form to read: the provider hosted it. The token it left behind names the user.
    const manifest = await runLogin({
      typed: null,
      cookies: [{ name: "id_token", value: jwt({ email: "katy@gmail.com" }) }],
    });
    expect(manifest?.accounts?.find((a) => a.origin === DOORVEST)?.username).toBe("katy@gmail.com");
  }, 90_000);

  it("never overwrites a username somebody set by hand", async () => {
    harness = await startPersonaHarness([
      { name: "katy", env: "staging", accounts: [{ origin: DOORVEST, username: "chosen-by-hand" }] },
    ]);
    const manifest = await runLogin({ typed: "something-else@example.com" });
    expect(manifest?.accounts?.find((a) => a.origin === DOORVEST)?.username).toBe("chosen-by-hand");
  }, 90_000);

  it("leaves the username unset rather than guessing from a password field", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const manifest = await runLogin({ typed: "correct horse battery staple" });
    expect(manifest?.accounts?.find((a) => a.origin === DOORVEST)?.username).toBeUndefined();
  }, 90_000);
});

/**
 * Saving a login without being asked to click. The signal is the application's, and it has
 * to hold still before it counts: a multi-step sign-in passes through pages that are not
 * the login page, and a probe can answer before a second factor is finished.
 */
describe("saving a login by itself", () => {
  let harness: PersonaHarness;

  afterEach(async () => {
    await harness?.dispose();
  });

  /** A fake browser whose probe answer is whatever the test says it is, per call. */
  async function sessionWithProbe(answers: number[], calls: string[] = []) {
    const { LoginSession } = await import("../../src/personas/loginSession.js");
    let at = 0;
    const cdp = {
      send: async (method: string, params: Record<string, unknown> = {}) => {
        calls.push(method);
        if (method === "Target.createTarget") return { targetId: "t1" };
        if (method === "Target.attachToTarget") return { sessionId: "s1" };
        if (method === "Storage.getCookies") return { cookies: [{ name: "s", value: "v" }] };
        if (method === "Target.getTargetInfo") return { targetInfo: { url: DOORVEST + "/dashboard" } };
        if (method === "Runtime.evaluate") {
          const expr = String(params["expression"] ?? "");
          if (expr.includes("querySelectorAll")) return { result: { value: null } };
          if (expr.includes("fetch(")) return { result: { value: answers[Math.min(at++, answers.length - 1)] } };
        }
        return {};
      },
    };
    return LoginSession.start({
      personasDir: harness.personasDir,
      configDir: harness.root,
      persona: "katy",
      url: DOORVEST,
      probe: "/my-homes",
      client: { cdp: cdp as never, kill: () => {}, exited: async () => {} },
    });
  }

  it("does not settle on the first signed-in answer, only once it holds", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const session = await sessionWithProbe([200, 200]);
    try {
      await session.state();
      expect(session.settled, "settled after a single check").toBe(false);
      await session.state();
      expect(session.settled).toBe(true);
    } finally {
      await session.close();
    }
  }, 90_000);

  it("starts counting again if the app stops answering mid-flow", async () => {
    // 200, then a redirect back to a login page (401), then 200 twice: the shape of a
    // second factor landing after the first page said yes.
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const session = await sessionWithProbe([200, 401, 200, 200]);
    try {
      await session.state();
      await session.state();
      expect(session.settled, "settled across a 401").toBe(false);
      await session.state();
      expect(session.settled).toBe(false);
      await session.state();
      expect(session.settled).toBe(true);
    } finally {
      await session.close();
    }
  }, 90_000);

  it("stops saving by itself once the human asks to keep the window", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const session = await sessionWithProbe([200, 200, 200]);
    try {
      session.holdOpen();
      await session.state();
      await session.state();
      expect(session.settled).toBe(false);
      expect((await session.state()).autoFinish).toBe(false);
    } finally {
      await session.close();
    }
  }, 90_000);

  it("captures once when the watcher and the Save button arrive together", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const calls: string[] = [];
    const session = await sessionWithProbe([200, 200], calls);
    await session.state();
    await session.state();

    calls.length = 0;
    const [a, b] = await Promise.all([session.finish(), session.finish()]);

    // Counting the captures is the assertion that matters. Two would run the second
    // against a browser the first already closed, and could overwrite a good jar with
    // whatever a dying session returns.
    expect(calls.filter((c) => c === "Storage.getCookies")).toHaveLength(1);
    expect(a).toBe(b);
    expect((await session.state()).finished).toBe(true);
  }, 90_000);
});
