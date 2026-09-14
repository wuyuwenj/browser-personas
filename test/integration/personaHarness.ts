import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserPersonasDaemon } from "../../src/proxy/server.js";
import { saveManifest, type PersonaManifest } from "../../src/personas/manifest.js";

export const DOORVEST = "http://localhost:3005";

/**
 * The two seeded stage personas this suite drives. Owner and buyer, because the two
 * render different navigation — which makes "did the right persona load?" visible in the
 * page itself rather than only in our own bookkeeping.
 */
export const PERSONAS = {
  katy: { email: "justin+katy@doorvest.com", role: "homeowner" },
  kendrick: { email: "justin+kendrick@doorvest.com", role: "buyer" },
} as const;

/**
 * The shared stage password, read from a 0600 file outside the repo. It is never inlined
 * in a test, never printed, and never committed.
 */
export function testPassword(): string {
  const file = join(homedir(), ".config", "browser-personas-test", "env");
  if (!existsSync(file)) throw new Error(`missing ${file} — stage password not staged for tests`);
  const match = /^BP_TEST_PASSWORD=(.+)$/m.exec(readFileSync(file, "utf8"));
  if (!match?.[1]) throw new Error("BP_TEST_PASSWORD not found");
  return match[1].trim();
}

export async function doorvestIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${DOORVEST}/login`, { signal: AbortSignal.timeout(4_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export type PersonaHarness = {
  daemon: BrowserPersonasDaemon;
  root: string;
  personasDir: string;
  wsUrl: (owner: string, persona: string) => string;
  restart: () => Promise<void>;
  dispose: () => Promise<void>;
};

export async function startPersonaHarness(
  manifests: PersonaManifest[],
  options: { root?: string } = {},
): Promise<PersonaHarness> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "bp-persona-"));
  const personasDir = join(root, "personas");
  for (const manifest of manifests) saveManifest(personasDir, manifest);

  const make = (): BrowserPersonasDaemon =>
    new BrowserPersonasDaemon({
      port: 0,
      host: "127.0.0.1",
      userDataDir: join(root, "chrome-profile"),
      personasDir,
      configDir: root,
      headless: true,
      sweepIntervalMs: 0,
    });

  let daemon = make();
  await daemon.start();

  const harness: PersonaHarness = {
    get daemon() {
      return daemon;
    },
    root,
    personasDir,
    wsUrl: (owner, persona) =>
      `ws://127.0.0.1:${daemon.port}/devtools/browser/bp?${new URLSearchParams({ owner, persona })}`,
    restart: async () => {
      await daemon.stop();
      daemon = make();
      await daemon.start();
    },
    dispose: async () => {
      await daemon.stop();
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(root, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    },
  };
  return harness;
}
