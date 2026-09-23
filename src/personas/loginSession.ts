import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchChrome, type LaunchedChrome } from "../chrome/launch.js";
import { CdpClient } from "../cdp/client.js";
import {
  findAccount,
  jarPath,
  loadManifest,
  normalizeOrigin,
  saveManifest,
  upsertAccount,
  type PersonaManifest,
} from "./manifest.js";
import { readJar, vaultKey, writeJar, type StoredCookie } from "./vault.js";
import { captureStorage, restoreStorage } from "./storage.js";
import { bestIdentifier, emailFromTokens, IDENTIFIER_SELECTORS, sessionValues } from "./identity.js";

/**
 * One interactive login, driven by polling rather than by a keypress.
 *
 * The terminal flow asked the human to press Enter when they were done, which means the
 * tool has to trust a claim it cannot check — and gives a page no way to show progress.
 * Here the session answers "are you signed in yet?" by asking the application, through the
 * very cookies the login is producing, so the answer is the app's rather than the user's.
 */
export type LoginState = {
  persona: string;
  url: string;
  /** The page the human is looking at right now. */
  currentUrl: string;
  signedIn: boolean;
  /** Who this looks like, learned rather than typed twice. */
  identity: string | null;
  /** Consecutive checks that have seen a real session. Two means it is settled. */
  stableChecks: number;
  /** False once the human asks to keep the window open and save by hand. */
  autoFinish: boolean;
  /** What the probe returned, when there is one. */
  probeStatus: number | null;
  probeUrl: string | null;
  startedAt: number;
  finished: boolean;
  cookiesSaved: number | null;
  error: string | null;
};

export type LoginSessionOptions = {
  personasDir: string;
  configDir: string;
  persona: string;
  url: string;
  /** Path that answers 2xx only for a signed-in user. */
  probe?: string;
  /** Typed into the form when the persona has a stored password. */
  autofill?: { email?: string; password?: string };
  /**
   * Test seam. Supplying a client skips launching a browser, so the parts that decide
   * WHAT to send can be asserted without a window opening.
   */
  client?: { cdp: CdpClient; kill: () => void; exited: () => Promise<void> };
};

function safePath(url: string): string | undefined {
  try {
    const path = new URL(url).pathname;
    return path && path !== "/" ? path : undefined;
  } catch {
    return undefined;
  }
}

export class LoginSession {
  readonly persona: string;
  readonly url: string;
  readonly startedAt = Date.now();
  #options: LoginSessionOptions;
  #chrome: LaunchedChrome;
  #cdp: CdpClient;
  #pageSession: string | null = null;
  #targetId: string | null = null;
  #finished = false;
  #cookiesSaved: number | null = null;
  #error: string | null = null;
  /**
   * Every origin the human passed through. A login through Google or GitHub is a tour of
   * two or three origins, and those are exactly the ones the app will redirect to again
   * when the session expires — so they are learned here rather than guessed later.
   */
  #visited = new Set<string>();
  /** Origins the persona already had storage for, so a re-login keeps them. */
  #knownOrigins = new Set<string>();
  #landedAt: string | null = null;
  /**
   * Identifiers seen in a sign-in field at any point in the journey. Google and Okta host
   * that field on their own page, so watching the whole journey is what makes this work
   * for SSO rather than only for a local password form.
   */
  #identifiers: string[] = [];
  /**
   * How many checks in a row have seen a signed-in session.
   *
   * One is not enough. A multi-step sign-in passes through pages that are not the login
   * page — a consent screen, an account chooser, an interstitial — and a probe can answer
   * before a second factor is done. Requiring the answer to hold still is what separates
   * "signed in" from "part way through signing in".
   */
  #stable = 0;
  #autoFinish = true;
  #finishing: Promise<number> | null = null;

  private constructor(options: LoginSessionOptions, chrome: LaunchedChrome, cdp: CdpClient) {
    this.#options = options;
    this.#chrome = chrome;
    this.#cdp = cdp;
    this.persona = options.persona;
    this.url = options.url;
  }

  static async start(options: LoginSessionOptions): Promise<LoginSession> {
    const profile = options.client ? null : mkdtempSync(join(tmpdir(), `bp-login-${options.persona}-`));
    // Headed, always: the daemon may be headless, Chrome cannot switch modes while
    // running, and a captcha needs a human looking at it.
    const chrome =
      options.client ??
      (launchChrome({ headless: false, userDataDir: profile! }) as unknown as {
        cdp: CdpClient;
        kill: () => void;
        exited: () => Promise<void>;
      });
    const cdp = options.client?.cdp ?? new CdpClient((chrome as unknown as LaunchedChrome).transport);
    const session = new LoginSession(options, chrome as unknown as LaunchedChrome, cdp);
    if (profile) (session as { profileDir?: string }).profileDir = profile;

    // A persona holds several websites and ONE session. Signing in to the second must not
    // cost the first: the existing jar goes into this browser before the human starts, so
    // the capture at the end is the union rather than a replacement. It also means they
    // arrive already signed in to everything else, which is usually what they expect.
    const existingJar = readJar(jarPath(options.personasDir, options.persona), vaultKey(options.configDir));
    if (existingJar.cookies.length > 0) {
      await cdp.send("Storage.setCookies", { cookies: existingJar.cookies }).catch(() => undefined);
    }
    if (Object.keys(existingJar.storage).length > 0) {
      await restoreStorage(cdp, existingJar.storage).catch(() => 0);
    }
    session.#knownOrigins = new Set(Object.keys(existingJar.storage));

    const created = await cdp.send("Target.createTarget", { url: options.url });
    session.#targetId = typeof created["targetId"] === "string" ? (created["targetId"] as string) : null;
    if (session.#targetId) {
      const attached = await cdp.send("Target.attachToTarget", {
        targetId: session.#targetId,
        flatten: true,
      });
      session.#pageSession =
        typeof attached["sessionId"] === "string" ? (attached["sessionId"] as string) : null;
    }
    return session;
  }

  get probeUrl(): string | null {
    if (!this.#options.probe) return null;
    try {
      return new URL(this.#options.probe, this.#options.url).toString();
    } catch {
      return null;
    }
  }

  async state(): Promise<LoginState> {
    let currentUrl = this.#options.url;
    let probeStatus: number | null = null;
    let signedIn = false;

    if (!this.#finished && this.#pageSession) {
      const resolved = await this.#resolvePage();
      if (resolved) {
        currentUrl = resolved;
        const origin = normalizeOrigin(currentUrl);
        if (/^https?:/.test(origin)) this.#visited.add(origin);
      }

      // Read before the probe, so a redirect away from the form does not lose it.
      const typed = await this.#readIdentifier();
      if (typed) this.#identifiers.push(typed);

      const probe = this.probeUrl;
      if (probe) {
        // Asked from inside the page, so the cookies the login just set ride along and the
        // application itself answers whether they are enough.
        probeStatus = await this.#evaluateStatus(probe);
        signedIn = probeStatus !== null && probeStatus >= 200 && probeStatus < 300;
      } else {
        signedIn = this.#looksSignedInWithoutProbe(currentUrl);
      }
      if (signedIn) this.#landedAt = currentUrl;
      this.#stable = signedIn ? this.#stable + 1 : 0;
    }

    return {
      persona: this.persona,
      url: this.url,
      currentUrl,
      signedIn: this.#finished ? true : signedIn,
      identity: bestIdentifier(this.#identifiers),
      stableChecks: this.#stable,
      autoFinish: this.#autoFinish,
      probeStatus,
      probeUrl: this.probeUrl,
      startedAt: this.startedAt,
      finished: this.#finished,
      cookiesSaved: this.#cookiesSaved,
      error: this.#error,
    };
  }

  /**
   * The page the human is on now, following the tab rather than one page target.
   *
   * Under Chrome's tab-target model a cross-origin round trip — out to an identity
   * provider and back — can replace the page target. The original id then answers nothing,
   * the URL falls back to the start page, the probe is bound to a dead session, and the
   * login never settles. So when the id we hold stops answering, find the live page and
   * re-attach to it.
   */
  async #resolvePage(): Promise<string | null> {
    if (this.#targetId) {
      try {
        const info = await this.#cdp.send("Target.getTargetInfo", { targetId: this.#targetId });
        const url = (info["targetInfo"] as { url?: string } | undefined)?.url;
        if (url) return url;
      } catch {
        /* replaced or closed — look for the live one below */
      }
    }
    try {
      const all = await this.#cdp.send("Target.getTargets", {});
      const pages = ((all["targetInfos"] as { targetId: string; type: string; url: string }[] | undefined) ?? [])
        .filter((t) => t.type === "page" && /^https?:/.test(t.url));
      // The throwaway browser holds only the human's own tabs; the newest is where they are.
      const live = pages[pages.length - 1];
      if (!live) return null;
      if (live.targetId !== this.#targetId) {
        const attached = await this.#cdp.send("Target.attachToTarget", { targetId: live.targetId, flatten: true });
        this.#targetId = live.targetId;
        this.#pageSession =
          typeof attached["sessionId"] === "string" ? (attached["sessionId"] as string) : this.#pageSession;
      }
      return live.url;
    } catch {
      return null;
    }
  }

  /**
   * Signed in, judged without a probe. Weak by nature, so it is held to three conditions:
   *
   * - the page is on the APP's origin. A sign-in with Google puts the human on
   *   accounts.google.com, which is neither the start URL nor a /login path, and under
   *   the old rule that alone counted as signed in — so auto-save captured a logged-out
   *   session mid-flow;
   * - the path does not look like a sign-in page;
   * - the human actually did something: typed an identifier, or went out to another
   *   origin and came back. A start URL that redirects when logged out (/admin → /)
   *   otherwise "succeeds" before anyone has touched the page.
   *
   * With a probe none of this is needed; the console says so.
   */
  #looksSignedInWithoutProbe(currentUrl: string): boolean {
    const app = normalizeOrigin(this.#options.url);
    if (normalizeOrigin(currentUrl) !== app) return false;
    let path = "";
    try {
      path = new URL(currentUrl).pathname;
    } catch {
      return false;
    }
    if (/\/(log-?in|sign-?in|auth|oauth|sso|callback)\b/i.test(path)) return false;
    const leftAndCameBack = [...this.#visited].some((o) => o !== app);
    return this.#identifiers.length > 0 || leftAndCameBack;
  }

  /** Stop saving by itself, so the human can keep using the window first. */
  holdOpen(): void {
    this.#autoFinish = false;
  }

  get settled(): boolean {
    return !this.#finished && this.#autoFinish && this.#stable >= LoginSession.STABLE_CHECKS;
  }

  /**
   * Two checks in a row, roughly three seconds apart.
   *
   * One is not enough: a multi-step sign-in passes through pages that are not the login
   * page — a consent screen, an account chooser — and a probe can answer before a second
   * factor is finished. Requiring the answer to hold still is what separates "signed in"
   * from "part way through signing in".
   */
  static readonly STABLE_CHECKS = 2;

  /** The value sitting in whatever passes for a username field on this page. */
  async #readIdentifier(): Promise<string | null> {
    if (!this.#pageSession) return null;
    try {
      const result = await this.#cdp.send(
        "Runtime.evaluate",
        {
          // Password fields are never read: the selector list names identity inputs only.
          expression: `Array.from(document.querySelectorAll(${JSON.stringify(IDENTIFIER_SELECTORS)}))
            .map(el => el.value).filter(Boolean)[0] || null`,
          returnByValue: true,
        },
        this.#pageSession,
        8_000,
      );
      const value = (result["result"] as { value?: unknown } | undefined)?.value;
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }

  async #evaluateStatus(probe: string): Promise<number | null> {
    if (!this.#pageSession) return null;
    try {
      const result = await this.#cdp.send(
        "Runtime.evaluate",
        {
          expression: `fetch(${JSON.stringify(probe)}, { credentials: "include", redirect: "follow" })
            .then(r => (new URL(r.url).pathname.startsWith("/login") ? 401 : r.status))
            .catch(() => -1)`,
          awaitPromise: true,
          returnByValue: true,
        },
        this.#pageSession,
        15_000,
      );
      const value = (result["result"] as { value?: unknown } | undefined)?.value;
      return typeof value === "number" && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /** Type the credentials in, when the persona has them stored. Best effort by design. */
  async autofill(): Promise<boolean> {
    if (!this.#pageSession || !this.#options.autofill) return false;
    const { email, password } = this.#options.autofill;
    if (!email || !password) return false;
    try {
      // Native setters plus input events: a React-controlled form ignores a plain
      // `value =` assignment and leaves its submit button disabled.
      const script = `(() => {
        const set = (el, v) => {
          const proto = Object.getPrototypeOf(el);
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          desc && desc.set ? desc.set.call(el, v) : (el.value = v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const e = document.querySelector('input[type=email], input[name=email], #email-input');
        const p = document.querySelector('input[type=password], #password-input');
        if (!e || !p) return false;
        set(e, ${JSON.stringify(email)});
        set(p, ${JSON.stringify(password)});
        return true;
      })()`;
      const result = await this.#cdp.send(
        "Runtime.evaluate",
        { expression: script, returnByValue: true },
        this.#pageSession,
      );
      return (result["result"] as { value?: unknown } | undefined)?.value === true;
    } catch {
      return false;
    }
  }

  /** Save the jar and close the browser. The jar is the artifact; the profile is discarded. */
  async finish(extra: Partial<PersonaManifest> = {}): Promise<number> {
    // The daemon's watcher and the Save button can arrive together; the second must not
    // capture a second time against a browser the first already closed.
    if (this.#finishing) return this.#finishing;
    this.#finishing = this.#doFinish(extra);
    return this.#finishing;
  }

  async #doFinish(extra: Partial<PersonaManifest>): Promise<number> {
    try {
      // Every cookie in the browser, not just the app's: an OAuth login leaves the
      // provider's session behind too, and that is what makes a silent re-auth work.
      const result = await this.#cdp.send("Storage.getCookies", {});
      const cookies = Array.isArray(result["cookies"]) ? (result["cookies"] as StoredCookie[]) : [];

      const appOrigin = normalizeOrigin(this.#options.url);
      const storage = await captureStorage(this.#cdp, [
        ...new Set([appOrigin, ...this.#knownOrigins, ...this.#visited]),
      ]);

      writeJar(jarPath(this.#options.personasDir, this.persona), vaultKey(this.#options.configDir), {
        version: 2,
        cookies,
        storage,
      });
      this.#cookiesSaved = cookies.length;

      const existing = loadManifest(this.#options.personasDir, this.persona);
      // Origins the identity provider used are remembered so the fence does not block a
      // re-authentication later. They are learned from a real login, never guessed.
      const authOrigins = [...new Set([...(existing?.auth_origins ?? []), ...this.#visited])].filter(
        (origin) => origin !== appOrigin,
      );
      // With no probe configured, where the login actually landed is the best one there is.
      // An OAuth login shows the app no password and no form — but it does leave an ID
      // token in the session it just created, and that token names the user.
      const identity =
        bestIdentifier(this.#identifiers) ?? emailFromTokens(sessionValues(cookies, storage));

      const current = existing ? findAccount(existing, appOrigin) : undefined;
      // Only a page on the app's own origin can be its probe, and only its path: a query
      // string on a post-login URL is often a one-time OAuth `state` that 400s next time.
      const inferredProbe =
        current?.probe ??
        (this.#landedAt && normalizeOrigin(this.#landedAt) === appOrigin ? safePath(this.#landedAt) : undefined);
      // Only the website that was signed in to is touched; the persona's other sites keep
      // whatever they were configured with.
      const withAccount = upsertAccount(existing ?? { name: this.persona }, {
        origin: appOrigin,
        ...(inferredProbe ? { probe: inferredProbe } : {}),
        // Never overwrite a name the user set by hand; only fill one in.
        ...(current?.username || !identity ? {} : { username: identity }),
      });

      saveManifest(this.#options.personasDir, {
        name: this.persona,
        ...existing,
        accounts: withAccount.accounts,
        ...(authOrigins.length ? { auth_origins: authOrigins } : {}),
        ...extra,
        seeded_by: existing?.seeded_by ?? process.env["USER"],
        seeded_at: existing?.seeded_at ?? new Date().toISOString().slice(0, 10),
      });
      this.#finished = true;
      return cookies.length;
    } catch (err) {
      this.#error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    this.#chrome.kill();
    await this.#chrome.exited();
    const profile = (this as { profileDir?: string }).profileDir;
    if (profile) rmSync(profile, { recursive: true, force: true });
  }
}
