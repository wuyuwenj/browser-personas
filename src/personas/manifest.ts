import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";

/**
 * What a persona IS. Durable, reviewable, and safe to commit for a team — it names
 * accounts but never holds a secret. The password lives wherever your team already keeps
 * passwords; `password_ref` is a pointer to it, so a reader knows where to look without
 * the registry becoming a place secrets leak from.
 */
export type PersonaAccount = {
  origin: string;
  username?: string;
  role?: string;
  /** Path fetched to answer "is this persona still logged in?" 200 = yes. */
  probe?: string;
  password_ref?: string;
};

/**
 * How much a persona is allowed to do. `false` is unrestricted.
 *
 * "GET only" is the wrong rule for an app that reads through POST — every Next.js server
 * action is a POST, and so is every GraphQL query — so a strict persona would load a page
 * shell and nothing inside it. The three levels exist so the restriction can match how
 * the app under test actually talks.
 */
export type ReadOnlyLevel = false | "strict" | "inspect" | "cooperative";

export type PersonaManifest = {
  name: string;
  description?: string;
  /** Free-form label; its real job is to make the origin allowlist obvious to a reader. */
  env?: string;
  /** One owner at a time. A second requester is refused, and told who holds it. */
  exclusive?: boolean;
  read_only?: ReadOnlyLevel;
  accounts?: PersonaAccount[];
  /**
   * Origins this persona may reach. Defaults to the origins of its accounts, which is
   * what makes a staging persona unable to wander onto production.
   */
  origins?: string[];
  seeded_by?: string;
  seeded_at?: string;
};

export type PersonaNote = {
  at: string;
  by: string;
  text: string;
  /** Notes about DATA rot; notes about identity do not. */
  expires_at?: string;
};

export function personaPath(personasDir: string, name: string): string {
  return join(personasDir, name);
}

export function manifestPath(personasDir: string, name: string): string {
  return join(personaPath(personasDir, name), "manifest.yaml");
}

export function notesPath(personasDir: string, name: string): string {
  return join(personaPath(personasDir, name), "notes.jsonl");
}

export function jarPath(personasDir: string, name: string): string {
  return join(personaPath(personasDir, name), "cookies.enc");
}

export function loadManifest(personasDir: string, name: string): PersonaManifest | null {
  const file = manifestPath(personasDir, name);
  if (!existsSync(file)) return null;
  const parsed = parse(readFileSync(file, "utf8")) as PersonaManifest | null;
  if (!parsed || typeof parsed !== "object") return null;
  return { ...parsed, name };
}

export function saveManifest(personasDir: string, manifest: PersonaManifest): void {
  mkdirSync(personaPath(personasDir, manifest.name), { recursive: true });
  writeFileSync(manifestPath(personasDir, manifest.name), stringify(manifest));
}

export function appendNote(personasDir: string, name: string, note: PersonaNote): void {
  mkdirSync(personaPath(personasDir, name), { recursive: true });
  const file = notesPath(personasDir, name);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, `${existing}${JSON.stringify(note)}\n`);
}

/** Notes past their TTL are dropped on read, so stale data-state never misleads an agent. */
export function readNotes(personasDir: string, name: string, now = new Date()): PersonaNote[] {
  const file = notesPath(personasDir, name);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as PersonaNote];
      } catch {
        return [];
      }
    })
    .filter((note) => !note.expires_at || new Date(note.expires_at) > now);
}

/**
 * The origins a persona may reach. Explicit `origins` wins; otherwise the accounts'
 * origins are the allowlist, which is the behaviour that makes `env: staging` mean
 * something instead of being a label.
 */
export function allowedOrigins(manifest: PersonaManifest): string[] {
  if (manifest.origins?.length) return manifest.origins.map(normalizeOrigin);
  return (manifest.accounts ?? []).map((a) => normalizeOrigin(a.origin));
}

export function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}
