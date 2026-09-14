import { allowedOrigins, normalizeOrigin, type PersonaManifest, type ReadOnlyLevel } from "./manifest.js";

/**
 * What a persona may reach, and what it may do when it gets there. Pure, so the rules can
 * be asserted without a browser — which matters, because these are the rules that stop an
 * agent wandering from staging onto production.
 */

export type PolicyVerdict = { allowed: true } | { allowed: false; reason: string };

export const READ_ONLY_HEADER = "X-Read-Only";

/** Requests that never change state, whatever the app is. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function hasPolicy(manifest: PersonaManifest | null): boolean {
  if (!manifest) return false;
  return Boolean(manifest.read_only) || allowedOrigins(manifest).length > 0;
}

/**
 * Origin check. An empty allowlist means the persona was never scoped, so everything is
 * permitted — scoping is opt-in, and silently locking an unscoped persona out of the web
 * would be a worse failure than not scoping it.
 */
export function checkOrigin(manifest: PersonaManifest | null, url: string): PolicyVerdict {
  if (!manifest) return { allowed: true };
  const allowed = allowedOrigins(manifest);
  if (allowed.length === 0) return { allowed: true };

  // about:blank, data: and devtools: URLs carry no origin worth policing, and Chrome and
  // every client open them constantly as scaffolding.
  if (/^(about:|data:|blob:|chrome:|devtools:)/i.test(url)) return { allowed: true };

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return { allowed: true };
  }

  if (allowed.includes(normalizeOrigin(origin))) return { allowed: true };
  return {
    allowed: false,
    reason:
      `Persona "${manifest.name}"${manifest.env ? ` (${manifest.env})` : ""} may only reach ` +
      `${allowed.join(", ")}. Refused: ${origin}`,
  };
}

/**
 * A POST that only reads. GraphQL is the case worth handling by body: one endpoint, one
 * method, and the operation keyword is the only thing that says whether it writes.
 */
function looksLikeRead(body: string | undefined): boolean {
  if (!body) return false;
  const trimmed = body.slice(0, 4_000);
  if (/"?\bmutation\b/i.test(trimmed)) return false;
  return /"?\bquery\b/i.test(trimmed) || /"operationName"/i.test(trimmed);
}

export type RequestFacts = {
  method: string;
  url: string;
  body?: string;
  /**
   * True for a top-level document load. The origin allowlist applies to these ONLY.
   *
   * Enforcing it on subresources breaks every real application: the page's own auth
   * provider, CDN, fonts and analytics are all third-party origins, and blocking them
   * does not stop an agent going anywhere — it just stops the app working. The guarantee
   * worth having is "this agent cannot navigate to production", and that is a navigation
   * rule. `read_only` is different and still applies to every request, because a write is
   * a write whichever origin it goes to.
   */
  isNavigation?: boolean;
};

/**
 * The read-only decision.
 *
 * `strict` — methods only. Right for a site you do not control.
 * `inspect` — plus POSTs whose body reads (GraphQL queries).
 * `cooperative` — plus any POST, because the proxy cannot tell a Next.js server action
 *   that reads from one that writes; it stamps a header instead and the app decides.
 *   This is the honest option for server-action apps: a proxy claiming to block writes it
 *   cannot identify would be a false guarantee.
 */
export function checkReadOnly(level: ReadOnlyLevel, facts: RequestFacts): PolicyVerdict {
  if (!level) return { allowed: true };
  const method = facts.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return { allowed: true };

  if (level === "strict") {
    return { allowed: false, reason: `Read-only persona: ${method} ${facts.url} was blocked.` };
  }

  if (level === "inspect") {
    if (method === "POST" && looksLikeRead(facts.body)) return { allowed: true };
    return {
      allowed: false,
      reason: `Read-only persona (inspect): ${method} ${facts.url} does not look like a read.`,
    };
  }

  // cooperative: the header rides along and the application enforces.
  return { allowed: true };
}

export function checkRequest(manifest: PersonaManifest | null, facts: RequestFacts): PolicyVerdict {
  if (facts.isNavigation !== false) {
    const origin = checkOrigin(manifest, facts.url);
    if (!origin.allowed) return origin;
  }
  if (!manifest) return { allowed: true };
  return checkReadOnly(manifest.read_only ?? false, facts);
}

/** Headers the proxy adds on a cooperative persona, so the app can refuse its own writes. */
export function policyHeaders(manifest: PersonaManifest | null): Record<string, string> {
  if (manifest?.read_only === "cooperative") return { [READ_ONLY_HEADER]: "1" };
  return {};
}

/** The 403 body a blocked request is answered with, so the agent's network log explains itself. */
export function blockedBody(reason: string): string {
  return JSON.stringify({ error: "blocked_by_browser_personas", reason }, null, 2);
}
