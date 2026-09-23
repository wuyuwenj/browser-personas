import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startHarness } from "./helpers.js";

/**
 * `stop` must finish even when a client will not let go. A daemon that ignored SIGTERM
 * with a chrome-devtools-mcp attached is what left an old build serving after a restart.
 */
describe("stopping the daemon", () => {
  it("exits within its deadline while a client refuses to answer the close handshake", async () => {
    const harness = await startHarness();
    const ws = new WebSocket(`ws://127.0.0.1:${harness.daemon.port}/devtools/browser/bp?owner=stubborn`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    // Stop reading: the close frame is never seen, so it is never answered.
    (ws as unknown as { _socket: { pause: () => void } })._socket.pause();

    const started = Date.now();
    await harness.dispose();
    const took = Date.now() - started;

    expect(took, `stop took ${took}ms`).toBeLessThan(15_000);
    ws.terminate();
  }, 60_000);
});
