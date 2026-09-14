import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchChrome, type LaunchedChrome } from "../chrome/launch.js";
import { CdpClient } from "../cdp/client.js";
import { jarPath, loadManifest, normalizeOrigin, saveManifest, type PersonaManifest } from "./manifest.js";
import { vaultKey, writeJar, type StoredCookie } from "./vault.js";
import { captureStorage } from "./storage.js";

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
};

function safePath(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
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
  #landedAt: string | null = null;

  private constructor(options: LoginSessionOptions, chrome: LaunchedChrome, cdp: CdpClient) {
    this.#options = options;
    this.#chrome = chrome;
    this.#cdp = cdp;
    this.persona = options.persona;
    this.url = options.url;
  }

  static async start(options: LoginSessionOptions): Promise<LoginSession> {
    const profile = mkdtempSync(join(tmpdir(), `bp-login-${options.persona}-`));
    // Headed, always: the daemon may be headless, Chrome cannot switch modes while
    // running, and a captcha needs a human looking at it.
    const chrome = launchChrome({ headless: false, userDataDir: profile });
    const cdp = new CdpClient(chrome.transport);
    const session = new LoginSession(options, chrome, cdp);
    (session as { profileDir?: string }).profileDir = profile;

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
      try {
        const info = await this.#cdp.send("Target.getTargetInfo", { targetId: this.#targetId ?? "" });
        const targetInfo = info["targetInfo"] as { url?: string } | undefined;
        currentUrl = targetInfo?.url ?? currentUrl;
        const origin = normalizeOrigin(currentUrl);
        if (/^https?:/.test(origin)) this.#visited.add(origin);
      } catch {
        /* the human may have closed the tab; the poll below still decides */
      }

      const probe = this.probeUrl;
      if (probe) {
        // Asked from inside the page, so the cookies the login just set ride along and the
        // application itself answers whether they are enough.
        probeStatus = await this.#evaluateStatus(probe);
        signedIn = probeStatus !== null && probeStatus >= 200 && probeStatus < 300;
        if (signedIn) this.#landedAt = currentUrl;
      } else {
        // With no probe, the honest signal is that the app moved the human off the page
        // it landed them on.
        signedIn = currentUrl !== this.#options.url && !/\/login\b/.test(currentUrl);
        if (signedIn) this.#landedAt = currentUrl;
      }
    }

    return {
      persona: this.persona,
      url: this.url,
      currentUrl,
      signedIn: this.#finished ? true : signedIn,
      probeStatus,
      probeUrl: this.probeUrl,
      startedAt: this.startedAt,
      finished: this.#finished,
      cookiesSaved: this.#cookiesSaved,
      error: this.#error,
    };
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
    try {
      // Every cookie in the browser, not just the app's: an OAuth login leaves the
      // provider's session behind too, and that is what makes a silent re-auth work.
      const result = await this.#cdp.send("Storage.getCookies", {});
      const cookies = Array.isArray(result["cookies"]) ? (result["cookies"] as StoredCookie[]) : [];

      const appOrigin = normalizeOrigin(this.#options.url);
      const storage = await captureStorage(this.#cdp, [...new Set([appOrigin, ...this.#visited])]);

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
      const inferredProbe =
        existing?.accounts?.[0]?.probe ??
        (this.#landedAt ? safePath(this.#landedAt) : undefined);
      const accounts = existing?.accounts?.length
        ? [{ ...existing.accounts[0]!, probe: inferredProbe }, ...existing.accounts.slice(1)]
        : [{ origin: appOrigin, probe: inferredProbe }];

      saveManifest(this.#options.personasDir, {
        name: this.persona,
        ...existing,
        accounts,
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
