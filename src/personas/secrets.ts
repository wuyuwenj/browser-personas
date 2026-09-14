import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { personaPath } from "./manifest.js";
import { seal, unseal } from "./vault.js";

/**
 * A password, if the user chose to store one.
 *
 * Deliberately opt-in and off by default. A cookie jar holds a session that expires; a
 * password does not, so the same file gains a much longer blast radius. What it buys is
 * automatic re-login when a session dies, which matters for long unattended runs and very
 * little otherwise — so the default stays a `password_ref` pointing at wherever the team
 * already keeps passwords.
 *
 * Nothing reads this back out to a screen, a tool result or a log. The only consumer is
 * the login flow typing it into a form.
 */
export function secretPath(personasDir: string, name: string): string {
  return join(personaPath(personasDir, name), "secret.enc");
}

export function hasSecret(personasDir: string, name: string): boolean {
  return existsSync(secretPath(personasDir, name));
}

export function writeSecret(personasDir: string, name: string, key: Buffer, password: string): void {
  const path = secretPath(personasDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, seal(key, JSON.stringify({ password })), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readSecret(personasDir: string, name: string, key: Buffer): string | null {
  const path = secretPath(personasDir, name);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(unseal(key, readFileSync(path, "utf8"))) as { password?: unknown };
    return typeof parsed.password === "string" ? parsed.password : null;
  } catch {
    return null;
  }
}

export function deleteSecret(personasDir: string, name: string): void {
  rmSync(secretPath(personasDir, name), { force: true });
}
