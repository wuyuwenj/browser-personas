import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserPersonasDaemon } from "../../src/proxy/server.js";

export type Harness = {
  daemon: BrowserPersonasDaemon;
  /** Bare HTTP base, the `--browserUrl` form. Ownership is the connection. */
  url: () => string;
  /**
   * The `--wsEndpoint` form, which is the only one that can carry a name.
   * Puppeteer resolves `/json/version` as an ABSOLUTE path against browserURL, so any
   * path or query on that URL is discarded before it reaches us — a websocket endpoint
   * is passed through verbatim and keeps its query string.
   */
  wsUrl: (owner: string, persona?: string) => string;
  dispose: () => Promise<void>;
};

/**
 * A daemon on an ephemeral port with a throwaway profile. Nothing here touches the
 * user's real config directory or their Chrome profile pool.
 */
export async function startHarness(
  options: { headless?: boolean; maxTabsPerOwner?: number } = {},
): Promise<Harness> {
  const profile = mkdtempSync(join(tmpdir(), "bp-test-"));
  const daemon = new BrowserPersonasDaemon({
    port: 0,
    host: "127.0.0.1",
    userDataDir: profile,
    headless: options.headless ?? true,
    ownership: options.maxTabsPerOwner ? { maxTabsPerOwner: options.maxTabsPerOwner } : undefined,
    sweepIntervalMs: 0,
  });
  await daemon.start();

  return {
    daemon,
    url: () => `http://127.0.0.1:${daemon.port}`,
    wsUrl: (owner, persona = "default") => {
      const query = new URLSearchParams({ owner, persona });
      return `ws://127.0.0.1:${daemon.port}/devtools/browser/bp?${query}`;
    },
    dispose: async () => {
      await daemon.stop();
      // Chrome flushes its cache as it exits; a delete that lands mid-flush throws
      // ENOTEMPTY. The profile is a temp dir either way, so a failed sweep is harmless.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(profile, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    },
  };
}
