/**
 * Who just signed in.
 *
 * Asking the user to type a username they already typed into the login form is the kind
 * of small friction that makes a tool feel unfinished. Two sources cover nearly every
 * login shape, and both are pure so they can be tested without a browser.
 */

/** Fields that hold an identity on the sign-in pages people actually meet. */
export const IDENTIFIER_SELECTORS = [
  "input[type=email]",
  "input[name=email]",
  "input[name=username]",
  "input[name=login]", // GitHub
  "input[name=identifier]", // Google, Okta
  "input[name=loginfmt]", // Microsoft
  "input[id=email-input]",
  "input[autocomplete=username]",
].join(",");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * The best identifier among everything typed during the login. An email wins outright;
 * otherwise a plausible username. Anything with whitespace, or long enough to be a token
 * rather than a name, is refused — a password field must never reach this.
 */
export function bestIdentifier(candidates: (string | null | undefined)[]): string | null {
  const cleaned = candidates
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0 && value.length <= 120 && !/\s/.test(value));

  const email = cleaned.find((value) => EMAIL.test(value));
  if (email) return email;

  // A username, but not a token. Length alone is not enough: a JWT is dot-separated
  // word characters, so it sails through a naive username pattern and would be written
  // into the manifest as somebody's name.
  const username = cleaned.find(
    (value) => value.length <= 40 && /^[\w.+-]+$/.test(value) && !looksLikeToken(value),
  );
  return username ?? null;
}

/** Dot-separated with a long segment: a token's shape, not a person's name. */
function looksLikeToken(value: string): boolean {
  const segments = value.split(".");
  return segments.length >= 3 && segments.some((segment) => segment.length >= 12);
}

/** Claims an OpenID provider puts an address in, in the order worth trusting. */
const EMAIL_CLAIMS = ["email", "preferred_username", "upn", "unique_name", "sub"];

function decodeSegment(segment: string): unknown {
  try {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * An address out of an ID token the login already left in our own jar.
 *
 * This is the OAuth answer: a Google or Okta sign-in never shows the app a password, but
 * it does leave a JWT whose payload names the user. The signature is not checked and does
 * not need to be — nothing is being authorised here, a label is being read off a token we
 * already hold.
 */
export function emailFromTokens(values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value !== "string" || value.length < 20) continue;
    for (const candidate of value.split(/[^A-Za-z0-9._-]+/)) {
      const parts = candidate.split(".");
      if (parts.length !== 3 || !parts[1]) continue;
      const payload = decodeSegment(parts[1]);
      if (typeof payload !== "object" || payload === null) continue;
      for (const claim of EMAIL_CLAIMS) {
        const found = (payload as Record<string, unknown>)[claim];
        if (typeof found === "string" && EMAIL.test(found)) return found;
      }
    }
  }
  return null;
}

/** Every string a captured session holds, flattened for the token scan. */
export function sessionValues(
  cookies: Record<string, unknown>[],
  storage: Record<string, { local: Record<string, string>; session: Record<string, string> }>,
): string[] {
  const out: string[] = [];
  for (const cookie of cookies) {
    if (typeof cookie["value"] === "string") out.push(cookie["value"]);
  }
  for (const entry of Object.values(storage)) {
    out.push(...Object.values(entry.local), ...Object.values(entry.session));
  }
  return out;
}
