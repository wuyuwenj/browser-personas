import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { launchChrome } from "../chrome/launch.js";
import { jarPath, loadManifest, saveManifest, type PersonaManifest } from "../personas/manifest.js";
import { vaultKey, writeJar, type StoredCookie } from "../personas/vault.js";
import { captureStorage } from "../personas/storage.js";

/**
 * Log a persona in, once, by hand.
 *
 * A throwaway headed Chrome rather than the daemon's own: the daemon is headless by
 * default and Chrome cannot switch modes while running, and a captcha needs a human
 * looking at it. The jar is the artifact — the temporary profile is deleted, so the only
 * thing that survives is the encrypted cookie file.
 */
export type LoginOptions = {
  personasDir: string;
  configDir: string;
  name: string;
  url: string;
  env?: string;
  username?: string;
  description?: string;
  /** Injected by tests; the real flow waits on the human. */
  waitForHuman?: () => Promise<void>;
};

function pressEnter(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return rl.question("Log in in the browser window, then press Enter here… ").then(() => {
    rl.close();
  });
}

export async function loginPersona(options: LoginOptions): Promise<{ cookies: number; jar: string }> {
  const profile = mkdtempSync(join(tmpdir(), `bp-login-${options.name}-`));
  const chrome = launchChrome({ headless: false, userDataDir: profile });

  let nextId = 1;
  const pending = new Map<number, (result: Record<string, unknown>) => void>();
  chrome.transport.on("message", (msg: Record<string, unknown>) => {
    const id = typeof msg["id"] === "number" ? (msg["id"] as number) : null;
    if (id === null) return;
    const resolve = pending.get(id);
    if (!resolve) return;
    pending.delete(id);
    resolve((msg["result"] as Record<string, unknown>) ?? {});
  });
  const call = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      chrome.transport.send({ id, method, params });
    });

  try {
    await call("Target.createTarget", { url: options.url });
    await (options.waitForHuman ?? pressEnter)();

    const result = await call("Storage.getCookies", {});
    const cookies = Array.isArray(result["cookies"]) ? (result["cookies"] as StoredCookie[]) : [];
    // Web storage too: an OAuth login often leaves its token there and nothing in a cookie.
    const storage = await captureStorage({ send: call }, [new URL(options.url).origin]).catch(() => ({}));

    const jar = jarPath(options.personasDir, options.name);
    writeJar(jar, vaultKey(options.configDir), { version: 2, cookies, storage });

    const existing = loadManifest(options.personasDir, options.name);
    const manifest: PersonaManifest = {
      name: options.name,
      description: options.description ?? existing?.description,
      env: options.env ?? existing?.env,
      exclusive: existing?.exclusive,
      read_only: existing?.read_only,
      origins: existing?.origins,
      accounts: existing?.accounts ?? [
        { origin: new URL(options.url).origin, username: options.username },
      ],
      seeded_by: existing?.seeded_by ?? process.env["USER"],
      seeded_at: existing?.seeded_at ?? new Date().toISOString().slice(0, 10),
    };
    saveManifest(options.personasDir, manifest);

    // Count only — a cookie value must never reach a terminal, a log, or a transcript.
    return { cookies: cookies.length, jar };
  } finally {
    chrome.kill();
    await chrome.exited();
    rmSync(profile, { recursive: true, force: true });
  }
}
