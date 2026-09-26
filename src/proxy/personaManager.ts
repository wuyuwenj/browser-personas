import { existsSync, readdirSync, statSync } from "node:fs";
import {
  allowedOrigins,
  jarPath,
  loadManifest,
  manifestPath,
  type PersonaManifest,
} from "../personas/manifest.js";
import { hasPolicy } from "../personas/policy.js";
import { readJar, vaultKey, writeJar, type StoredCookie } from "../personas/vault.js";
import { captureStorage, restoreStorage } from "../personas/storage.js";
import type { OwnerId } from "./ownership.js";

export const DEFAULT_PERSONA = "default";

function manifestMtime(personasDir: string, name: string): number | undefined {
  try {
    return statSync(manifestPath(personasDir, name)).mtimeMs;
  } catch {
    return undefined;
  }
}

function jarMtime(personasDir: string, name: string): number | undefined {
  try {
    return statSync(jarPath(personasDir, name)).mtimeMs;
  } catch {
    return undefined;
  }
}

export type PersonaContext = {
  name: string;
  manifest: PersonaManifest | null;
  /** Undefined for the shared default persona, which uses Chrome's own default context. */
  browserContextId?: string;
  /** Set when a response was seen writing a cookie, so the jar is only saved when it changed. */
  dirty: boolean;
  /** mtime of manifest.yaml when `manifest` was read; a different value means re-read. */
  manifestMtime?: number;
  /**
   * mtime of the jar this context last loaded or wrote. A different value on disk means
   * a login was saved by someone else — the CLI, another daemon build — since then.
   */
  jarMtime?: number;
};

type Upstream = {
  call: (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ) => Promise<Record<string, unknown>>;
};

/**
 * Named identities inside one browser.
 *
 * A persona is a Chrome browser context plus a cookie jar on disk. The context gives it a
 * cookie store separate from every other persona in the same process; the jar is what
 * makes the login survive a restart, which is the whole reason not to use `--isolated`.
 */
export class PersonaManager {
  #personasDir: string;
  #configDir: string;
  #upstream: Upstream;
  #contexts = new Map<string, PersonaContext>();
  #leases = new Map<string, OwnerId>();
  #key: Buffer | null = null;

  constructor(personasDir: string, configDir: string, upstream: Upstream) {
    this.#personasDir = personasDir;
    this.#configDir = configDir;
    this.#upstream = upstream;
  }

  #vaultKey(): Buffer {
    this.#key ??= vaultKey(this.#configDir);
    return this.#key;
  }

  names(): string[] {
    if (!existsSync(this.#personasDir)) return [];
    return readdirSync(this.#personasDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  }

  /** Re-read a persona's manifest into its live context, so an edit takes effect at once. */
  refresh(name: string): void {
    const ctx = this.#contexts.get(name);
    if (!ctx) return;
    ctx.manifest = loadManifest(this.#personasDir, name);
    ctx.manifestMtime = manifestMtime(this.#personasDir, name);
  }

  /**
   * The persona's manifest, re-read whenever the file on disk changes.
   *
   * The console refreshes its cache explicitly, but a hand edit of manifest.yaml has no
   * such hook — and a cached copy that silently outlives the file is the same stale-cache
   * bug the console had in v0.4, entered through the other door. One stat per lookup is
   * cheaper than being wrong about a persona's fence.
   */
  manifest(name: string): PersonaManifest | null {
    const ctx = this.#contexts.get(name);
    const mtime = manifestMtime(this.#personasDir, name);
    if (ctx) {
      if (ctx.manifestMtime !== mtime) {
        ctx.manifest = loadManifest(this.#personasDir, name);
        ctx.manifestMtime = mtime;
      }
      return ctx.manifest;
    }
    return loadManifest(this.#personasDir, name);
  }

  context(name: string): PersonaContext | undefined {
    return this.#contexts.get(name);
  }

  /** True when this persona restricts anything, and therefore needs request interception. */
  needsInterception(name: string): boolean {
    return hasPolicy(this.manifest(name));
  }

  /**
   * A persona marked `exclusive` is handed to one owner at a time. This is the profile
   * lease from the shell era, moved to where the conflict actually is: two agents on one
   * server-side session, not two processes on one directory.
   */
  claimLease(name: string, ownerId: OwnerId): { ok: true } | { ok: false; heldBy: OwnerId } {
    const manifest = this.manifest(name);
    if (!manifest?.exclusive) return { ok: true };
    const holder = this.#leases.get(name);
    if (holder && holder !== ownerId) return { ok: false, heldBy: holder };
    this.#leases.set(name, ownerId);
    return { ok: true };
  }

  releaseLease(name: string, ownerId: OwnerId): void {
    if (this.#leases.get(name) === ownerId) this.#leases.delete(name);
  }

  leaseHolder(name: string): OwnerId | null {
    return this.#leases.get(name) ?? null;
  }

  /**
   * Make sure a persona has a live browser context, restoring its cookies the first time.
   * The default persona deliberately maps to Chrome's own default context, so a setup with
   * no personas at all pays nothing for this machinery.
   */
  async ensure(name: string): Promise<PersonaContext> {
    const existing = this.#contexts.get(name);
    if (existing) {
      await this.syncJar(name).catch(() => false);
      return existing;
    }

    const manifest = loadManifest(this.#personasDir, name);

    if (name === DEFAULT_PERSONA) {
      const ctx: PersonaContext = { name, manifest, dirty: false };
      this.#contexts.set(name, ctx);
      await this.syncJar(name).catch(() => false);
      return ctx;
    }

    const created = await this.#upstream.call("Target.createBrowserContext", {});
    const browserContextId =
      typeof created["browserContextId"] === "string" ? (created["browserContextId"] as string) : undefined;
    const ctx: PersonaContext = { name, manifest, browserContextId, dirty: false };
    this.#contexts.set(name, ctx);

    await this.restore(name);
    return ctx;
  }

  /**
   * Put a persona's saved session back into its live context: cookies first, then any web
   * storage. Storage replay needs a document on each origin, so it costs a throwaway tab
   * per origin and only runs for personas that actually captured some.
   */
  async restore(name: string): Promise<number> {
    const ctx = this.#contexts.get(name);
    if (!ctx) return 0;
    // Stat before reading: a write landing in between then looks new next time, rather
    // than being marked as already loaded.
    ctx.jarMtime = jarMtime(this.#personasDir, name);
    const jar = readJar(jarPath(this.#personasDir, name), this.#vaultKey());
    if (jar.cookies.length > 0) {
      const params: Record<string, unknown> = { cookies: jar.cookies };
      if (ctx.browserContextId) params["browserContextId"] = ctx.browserContextId;
      await this.#upstream.call("Storage.setCookies", params);
    }
    if (Object.keys(jar.storage).length > 0) {
      await restoreStorage(
        { send: (method, params, sessionId) => this.#upstream.call(method, params ?? {}, sessionId) },
        jar.storage,
        ctx.browserContextId,
      ).catch(() => 0);
    }
    return jar.cookies.length;
  }

  /**
   * Load the jar again if it changed on disk since this context last saw it.
   *
   * A login saved outside the daemon — `browser-personas login` runs its own browser and
   * writes the jar directly — was otherwise invisible until a restart: the context outlives
   * every reconnect, and restore only ran when the context was first made. One stat per
   * call, so it is cheap enough to run before every new tab.
   */
  async syncJar(name: string): Promise<boolean> {
    const ctx = this.#contexts.get(name);
    if (!ctx) return false;
    const onDisk = jarMtime(this.#personasDir, name);
    if (onDisk === undefined || onDisk === ctx.jarMtime) return false;
    await this.restore(name);
    return true;
  }

  /** Write a persona's current session back to disk. Values never pass through a log. */
  async persist(name: string): Promise<number> {
    const ctx = this.#contexts.get(name);
    if (!ctx) return 0;
    // A jar newer than anything this context has seen is a fresh login saved elsewhere.
    // Writing the live cookies now would replace it with the session it was meant to
    // fix — so load it instead, and let the next persist save the merged result.
    if (await this.syncJar(name)) return 0;
    const params: Record<string, unknown> = {};
    if (ctx.browserContextId) params["browserContextId"] = ctx.browserContextId;
    const result = await this.#upstream.call("Storage.getCookies", params);
    const cookies = Array.isArray(result["cookies"]) ? (result["cookies"] as StoredCookie[]) : [];

    // Re-read storage for the origins the jar already knows about. Anything else would
    // mean opening tabs on origins this persona may never have used.
    const previous = readJar(jarPath(this.#personasDir, name), this.#vaultKey());
    const origins = Object.keys(previous.storage);
    const storage = origins.length
      ? await captureStorage(
          { send: (method, p, sessionId) => this.#upstream.call(method, p ?? {}, sessionId) },
          origins,
          ctx.browserContextId,
        ).catch(() => previous.storage)
      : previous.storage;

    if (cookies.length === 0 && Object.keys(storage).length === 0) return 0;
    writeJar(jarPath(this.#personasDir, name), this.#vaultKey(), { version: 2, cookies, storage });
    ctx.jarMtime = jarMtime(this.#personasDir, name);
    ctx.dirty = false;
    return cookies.length;
  }

  /**
   * Persist every named persona. Deliberately unconditional rather than gated on a
   * "cookies changed" signal: detecting that needs the Network domain enabled, which
   * depends on what the client happened to ask for, and a missed save means a persona
   * silently logged out on the next restart. One getCookies per persona is cheap.
   */
  async persistAll(): Promise<void> {
    for (const name of this.#contexts.keys()) {
      if (name !== DEFAULT_PERSONA) await this.persist(name).catch(() => 0);
    }
  }

  markDirty(name: string): void {
    const ctx = this.#contexts.get(name);
    if (ctx) ctx.dirty = true;
  }

  origins(name: string): string[] {
    const manifest = this.manifest(name);
    return manifest ? allowedOrigins(manifest) : [];
  }
}
