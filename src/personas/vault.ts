import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * Cookie jars at rest.
 *
 * A session cookie is a bearer token: whoever holds the jar is that user. Chrome encrypts
 * its own cookie database with a key in the system keychain, so a plaintext export would
 * be strictly weaker than what it replaces. The key lives in the macOS Keychain, or in a
 * 0600 file elsewhere, and the plaintext is never written to disk at any point.
 */
const SERVICE = "browser-personas-vault";
const ACCOUNT = "browser-personas";

function keychainGet(): Buffer | null {
  try {
    const out = execFileSync("security", ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return Buffer.from(out.trim(), "base64");
  } catch {
    return null;
  }
}

function keychainSet(key: Buffer): void {
  execFileSync(
    "security",
    ["add-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w", key.toString("base64"), "-U"],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
}

function fileKey(configDir: string): Buffer {
  const file = join(configDir, "vault.key");
  if (existsSync(file)) return Buffer.from(readFileSync(file, "utf8").trim(), "base64");
  const key = randomBytes(32);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, key.toString("base64"), { mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}

export function vaultKey(configDir: string): Buffer {
  if (process.platform === "darwin") {
    const existing = keychainGet();
    if (existing && existing.length === 32) return existing;
    const key = randomBytes(32);
    try {
      keychainSet(key);
      return key;
    } catch {
      // A headless CI runner has no keychain; fall through to the file key.
    }
  }
  return fileKey(configDir);
}

/** `iv:tag:ciphertext`, all base64. AES-256-GCM, so tampering fails loudly on read. */
export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

export function unseal(key: Buffer, sealed: string): string {
  const [ivB64, tagB64, bodyB64] = sealed.trim().split(":");
  if (!ivB64 || !tagB64 || !bodyB64) throw new Error("cookie jar is not in the expected format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(bodyB64, "base64")), decipher.final()]).toString("utf8");
}

export type StoredCookie = Record<string, unknown>;

export function writeJar(path: string, key: Buffer, cookies: StoredCookie[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, seal(key, JSON.stringify(cookies)), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readJar(path: string, key: Buffer): StoredCookie[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(unseal(key, readFileSync(path, "utf8"))) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredCookie[]) : [];
  } catch {
    // A jar sealed with a key we no longer have is not recoverable, and is not an error
    // worth crashing a daemon over — the persona is simply logged out.
    return [];
  }
}
