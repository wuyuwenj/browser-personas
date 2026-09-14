import type { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";

/**
 * Chrome's `--remote-debugging-pipe` transport.
 *
 * Chrome READS commands from fd 3 and WRITES events/responses to fd 4. Messages are
 * UTF-8 JSON separated by a NUL byte. There is exactly ONE pipe connection for the
 * life of the browser, which is the whole point: no TCP port exists, so nothing can
 * reach Chrome without going through this process. Every downstream client is
 * multiplexed onto this single connection by the proxy.
 */
export class PipeTransport extends EventEmitter {
  #write: Writable;
  #pending = "";
  #closed = false;

  constructor(write: Writable, read: Readable) {
    super();
    this.#write = write;
    read.on("data", (chunk: Buffer) => this.#onChunk(chunk));
    read.on("close", () => this.#onClose());
    read.on("error", (err) => this.emit("error", err));
    write.on("error", (err) => this.emit("error", err));
  }

  #onChunk(chunk: Buffer): void {
    let start = 0;
    let end = chunk.indexOf(0, start);
    while (end !== -1) {
      const message = this.#pending + chunk.toString("utf8", start, end);
      this.#pending = "";
      this.#dispatch(message);
      start = end + 1;
      end = chunk.indexOf(0, start);
    }
    this.#pending += chunk.toString("utf8", start);
  }

  #dispatch(raw: string): void {
    if (raw.length === 0) return;
    try {
      this.emit("message", JSON.parse(raw) as Record<string, unknown>);
    } catch (err) {
      this.emit("error", new Error(`unparseable CDP frame from Chrome: ${String(err)}`));
    }
  }

  #onClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("close");
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(message: unknown): void {
    if (this.#closed) return;
    this.#write.write(JSON.stringify(message));
    this.#write.write("\0");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#write.end();
    this.emit("close");
  }
}
