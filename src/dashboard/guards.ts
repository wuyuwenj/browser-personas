import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Guards for the console.
 *
 * Reading state over loopback is harmless. Writing credentials over loopback is not: any
 * page on the internet can POST to 127.0.0.1 from a visitor's browser, and any process on
 * this machine can reach the port. The CDP endpoints cannot carry a token — chrome-devtools-mcp
 * has nowhere to put one — so the token gate covers the console and its API only, and the
 * proxy paths stay open exactly as before.
 */

export type GuardVerdict = { ok: true } | { ok: false; status: number; reason: string };

/** Minted once per daemon, kept 0600, and carried in the console URL. */
export function loadOrCreateToken(path: string): string {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) return existing;
  }
  const token = randomBytes(24).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

/** Constant-time, so a wrong token cannot be guessed a character at a time. */
export function tokenMatches(expected: string, given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  const withoutPort = value.replace(/:\d+$/, "");
  return withoutPort.toLowerCase();
}

/**
 * DNS rebinding turns an attacker's domain into 127.0.0.1 and reaches the port with the
 * attacker's Host header. Requiring a loopback Host closes that; the browser cannot forge it.
 */
export function hostIsLoopback(hostHeader: string | undefined): boolean {
  const host = hostOf(hostHeader);
  return host !== null && LOOPBACK_HOSTS.has(host);
}

/**
 * A cross-site page's `fetch` always carries Origin, and one carrying `application/json`
 * needs a preflight the console never answers. Same-origin requests from the console send
 * our own origin; curl sends none.
 */
export function originIsOurs(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) && url.port === String(port);
  } catch {
    return false;
  }
}

export type RequestFacts = {
  method: string;
  host: string | undefined;
  origin: string | undefined;
  contentType: string | undefined;
  token: string | null;
  /** Whether the request actually carries a body. A DELETE normally does not. */
  hasBody: boolean;
};

export function checkConsoleRequest(
  expectedToken: string,
  port: number,
  facts: RequestFacts,
): GuardVerdict {
  if (!hostIsLoopback(facts.host)) {
    return { ok: false, status: 403, reason: "The console answers on loopback only." };
  }
  if (!tokenMatches(expectedToken, facts.token)) {
    return {
      ok: false,
      status: 401,
      reason: "Missing or wrong console token. Run `browser-personas console` for the link.",
    };
  }
  const writes = facts.method !== "GET" && facts.method !== "HEAD";
  if (writes) {
    if (!originIsOurs(facts.origin, port)) {
      return { ok: false, status: 403, reason: "Cross-origin writes are refused." };
    }
    if (facts.hasBody && !facts.contentType?.toLowerCase().startsWith("application/json")) {
      // A form post can be made cross-site without a preflight; JSON cannot. A bodyless
      // write has nothing to smuggle and is already covered by the Origin check.
      return { ok: false, status: 415, reason: "Writes with a body must be application/json." };
    }
  }
  return { ok: true };
}
