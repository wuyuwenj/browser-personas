import { existsSync, rmSync } from "node:fs";
import {
  allowedOrigins,
  loadManifest,
  personaPath,
  saveManifest,
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
  startLogin: (persona: string) => Promise<LoginState>;
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

/** Fields the console may set. Anything else in the body is ignored rather than trusted. */
function applyFields(manifest: PersonaManifest, body: Record<string, unknown>): PersonaManifest {
  const next: PersonaManifest = { ...manifest };
  if (typeof body["description"] === "string") next.description = body["description"];
  if (typeof body["env"] === "string") next.env = body["env"];
  if (typeof body["exclusive"] === "boolean") next.exclusive = body["exclusive"];
  if ("read_only" in body) next.read_only = readLevel(body["read_only"]);
  if (typeof body["origin"] === "string" && body["origin"]) {
    const accounts = next.accounts?.length ? [...next.accounts] : [{ origin: body["origin"] }];
    accounts[0] = {
      ...accounts[0]!,
      origin: body["origin"],
      ...(typeof body["username"] === "string" ? { username: body["username"] } : {}),
      ...(typeof body["probe"] === "string" ? { probe: body["probe"] } : {}),
    };
    next.accounts = accounts;
  } else if (next.accounts?.[0]) {
    next.accounts = [
      {
        ...next.accounts[0],
        ...(typeof body["username"] === "string" ? { username: body["username"] } : {}),
        ...(typeof body["probe"] === "string" ? { probe: body["probe"] } : {}),
      },
      ...next.accounts.slice(1),
    ];
  }
  return next;
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

    const manifest = applyFields({ name, accounts: [{ origin }] }, body);
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
      saveManifest(deps.personasDir, applyFields(manifest, body));
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

    if (method === "POST" && rest === "/login") return ok(await deps.startLogin(name));
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
