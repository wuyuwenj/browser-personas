import { existsSync, rmSync } from "node:fs";
import {
  allowedOrigins,
  loadManifest,
  normalizeOrigin,
  personaPath,
  removeAccount,
  saveManifest,
  upsertAccount,
  type PersonaAccount,
  type PersonaManifest,
  type ReadOnlyLevel,
} from "../personas/manifest.js";
import { deleteSecret, hasSecret, writeSecret } from "../personas/secrets.js";
import type { LoginState } from "../personas/loginSession.js";
import type { DaemonStatus } from "../proxy/status.js";

/**
 * The console's API. Small, JSON-only, and behind the token gate in `guards.ts`.
 *
 * The CLI keeps working unchanged — scripts and CI need it, and a page that is the only
 * way to configure something is a page you cannot automate around.
 */

export type ApiResult = { status: number; body: unknown };

export type ConsoleState = DaemonStatus & {
  /** Which personas have a password stored. The password itself never leaves the vault. */
  secrets: Record<string, boolean>;
  logins: LoginState[];
};

export type ApiDeps = {
  personasDir: string;
  vaultKey: () => Buffer;
  status: () => DaemonStatus;
  loginStates: () => Promise<LoginState[]>;
  /** `origin` picks which of the persona's websites to sign in to. */
  startLogin: (persona: string, origin?: string) => Promise<LoginState>;
  finishLogin: (persona: string) => Promise<LoginState>;
  cancelLogin: (persona: string) => Promise<void>;
  autofillLogin: (persona: string) => Promise<boolean>;
  reloadPersona: (persona: string) => void;
};

const ok = (body: unknown): ApiResult => ({ status: 200, body });
const bad = (status: number, reason: string): ApiResult => ({ status, body: { error: reason } });

function readLevel(value: unknown): ReadOnlyLevel {
  return value === "strict" || value === "inspect" || value === "cooperative" ? value : false;
}

/** Persona-level fields the console may set. A website is edited through its own route. */
function applyPersonaFields(manifest: PersonaManifest, body: Record<string, unknown>): PersonaManifest {
  const next: PersonaManifest = { ...manifest };
  if (typeof body["description"] === "string") next.description = body["description"];
  if (typeof body["env"] === "string") next.env = body["env"];
  if (typeof body["exclusive"] === "boolean") next.exclusive = body["exclusive"];
  if ("read_only" in body) next.read_only = readLevel(body["read_only"]);
  return next;
}

/** One website inside a persona. `origin` identifies it; everything else is optional. */
function accountFrom(body: Record<string, unknown>): PersonaAccount | null {
  const origin = typeof body["origin"] === "string" ? body["origin"].trim() : "";
  if (!origin) return null;
  try {
    return {
      origin: new URL(origin).origin,
      ...(typeof body["username"] === "string" && body["username"] ? { username: body["username"] } : {}),
      ...(typeof body["role"] === "string" && body["role"] ? { role: body["role"] } : {}),
      ...(typeof body["probe"] === "string" && body["probe"] ? { probe: body["probe"] } : {}),
      ...(typeof body["password_ref"] === "string" && body["password_ref"]
        ? { password_ref: body["password_ref"] }
        : {}),
    };
  } catch {
    return null;
  }
}

export async function handleApi(
  deps: ApiDeps,
  method: string,
  path: string,
  body: Record<string, unknown>,
): Promise<ApiResult> {
  if (method === "GET" && path === "/api/state") {
    const status = deps.status();
    const secrets: Record<string, boolean> = {};
    for (const persona of status.personas) secrets[persona.name] = hasSecret(deps.personasDir, persona.name);
    const state: ConsoleState = { ...status, secrets, logins: await deps.loginStates() };
    return ok(state);
  }

  if (method === "POST" && path === "/api/personas") {
    const name = String(body["name"] ?? "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
      return bad(400, "A persona name may use letters, digits, dot, dash and underscore.");
    }
    if (existsSync(personaPath(deps.personasDir, name))) return bad(409, `"${name}" already exists.`);
    const origin = String(body["origin"] ?? "").trim();
    if (!origin) return bad(400, "An origin is required — it is what scopes the persona.");

    const account = accountFrom(body);
    if (!account) return bad(400, `"${origin}" is not a URL this can navigate to.`);
    const manifest = applyPersonaFields({ name, accounts: [account] }, body);
    saveManifest(deps.personasDir, {
      ...manifest,
      seeded_by: process.env["USER"],
      seeded_at: new Date().toISOString().slice(0, 10),
    });
    if (typeof body["password"] === "string" && body["password"]) {
      writeSecret(deps.personasDir, name, deps.vaultKey(), body["password"]);
    }
    deps.reloadPersona(name);
    return ok({ name, created: true });
  }

  const personaMatch = /^\/api\/personas\/([^/]+)(\/.*)?$/.exec(path);
  if (personaMatch) {
    const name = decodeURIComponent(personaMatch[1]!);
    const rest = personaMatch[2] ?? "";
    const manifest = loadManifest(deps.personasDir, name);
    if (!manifest) return bad(404, `No persona named "${name}".`);

    if (method === "PATCH" && rest === "") {
      saveManifest(deps.personasDir, applyPersonaFields(manifest, body));
      if (typeof body["password"] === "string") {
        if (body["password"]) writeSecret(deps.personasDir, name, deps.vaultKey(), body["password"]);
        else deleteSecret(deps.personasDir, name);
      }
      deps.reloadPersona(name);
      return ok({ name, updated: true });
    }

    if (method === "DELETE" && rest === "") {
      const live = deps.status().personas.find((p) => p.name === name);
      if (live && live.holders.length > 0) {
        return bad(409, `"${name}" is in use by ${live.holders.map((h) => h.owner).join(", ")}.`);
      }
      await deps.cancelLogin(name).catch(() => undefined);
      rmSync(personaPath(deps.personasDir, name), { recursive: true, force: true });
      deps.reloadPersona(name);
      return ok({ name, removed: true });
    }

    // ---- the websites inside a persona ----------------------------------
    if (rest === "/accounts") {
      if (method === "PUT") {
        const account = accountFrom(body);
        if (!account) return bad(400, "A website needs an origin, e.g. https://app.example.com");
        saveManifest(deps.personasDir, upsertAccount(manifest, account));
        deps.reloadPersona(name);
        return ok({ origin: account.origin, saved: true });
      }
      if (method === "DELETE") {
        const origin = typeof body["origin"] === "string" ? body["origin"] : "";
        if (!origin) return bad(400, "Which website? Pass its origin.");
        const next = removeAccount(manifest, origin);
        if ((next.accounts ?? []).length === (manifest.accounts ?? []).length) {
          return bad(404, `"${name}" has no website at ${origin}.`);
        }
        if ((next.accounts ?? []).length === 0) {
          // An empty allowlist means "unscoped", which is the opposite of what removing
          // the last website should mean. Deleting the persona is the honest way to do it.
          return bad(409, `That is ${name}'s only website. Delete the persona instead.`);
        }
        saveManifest(deps.personasDir, next);
        deps.reloadPersona(name);
        return ok({ origin: normalizeOrigin(origin), removed: true });
      }
    }

    if (method === "POST" && rest === "/login") {
      const origin = typeof body["origin"] === "string" ? body["origin"] : undefined;
      return ok(await deps.startLogin(name, origin));
    }
    if (method === "POST" && rest === "/login/autofill") return ok({ filled: await deps.autofillLogin(name) });
    if (method === "POST" && rest === "/login/finish") return ok(await deps.finishLogin(name));
    if (method === "DELETE" && rest === "/login") {
      await deps.cancelLogin(name);
      return ok({ cancelled: true });
    }

    if (method === "GET" && rest === "") {
      // Never the password, and never the cookies: counts and scope only.
      return ok({
        ...manifest,
        origins: allowedOrigins(manifest),
        hasSecret: hasSecret(deps.personasDir, name),
      });
    }
  }

  return bad(404, `No such endpoint: ${method} ${path}`);
}
