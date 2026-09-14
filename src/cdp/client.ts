import type { PipeTransport } from "./pipeTransport.js";

/**
 * A promise-shaped CDP client over one pipe, with flattened session support.
 * Small on purpose: the proxy has its own routing, and this exists for the places that
 * drive a browser directly — the login flow and its probes.
 */
export class CdpClient {
  #transport: PipeTransport;
  #nextId = 1;
  #pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();

  constructor(transport: PipeTransport) {
    this.#transport = transport;
    transport.on("message", (msg: Record<string, unknown>) => {
      const id = typeof msg["id"] === "number" ? (msg["id"] as number) : null;
      if (id === null) return;
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      const error = msg["error"] as { message?: string } | undefined;
      if (error) pending.reject(new Error(error.message ?? "cdp error"));
      else pending.resolve((msg["result"] as Record<string, unknown>) ?? {});
    });
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      const frame: Record<string, unknown> = { id, method, params };
      if (sessionId) frame["sessionId"] = sessionId;
      this.#transport.send(frame);
    });
  }
}
