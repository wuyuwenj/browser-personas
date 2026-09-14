import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * A child `chrome-devtools-mcp` spoken to over stdio.
 *
 * The wrapper re-exports that server's tools rather than reimplementing any of them, so
 * upstream keeps shipping features and this project stays a thin layer that adds identity
 * and isolation on top.
 */
export class UpstreamMcp {
  #proc: ChildProcessWithoutNullStreams;
  #buffer = "";
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(proc: ChildProcessWithoutNullStreams) {
    this.#proc = proc;
    proc.stdout.on("data", (chunk: Buffer) => this.#onData(chunk.toString()));
    // Upstream's diagnostics belong on OUR stderr: stdout is the MCP stream and anything
    // stray on it corrupts the protocol for the host.
    proc.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  }

  static async start(command: string, args: string[]): Promise<UpstreamMcp> {
    const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const upstream = new UpstreamMcp(proc);
    await upstream.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "browser-personas", version: "0.3.0" },
    });
    upstream.#notify("notifications/initialized", {});
    return upstream;
  }

  #onData(text: string): void {
    this.#buffer += text;
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) this.#dispatch(line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  #dispatch(line: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return;
    const pending = this.#pending.get(msg.id);
    if (!pending) return;
    this.#pending.delete(msg.id);
    if (msg.error) pending.reject(new Error(msg.error.message ?? "upstream error"));
    else pending.resolve(msg.result);
  }

  #notify(method: string, params: unknown): void {
    this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  request(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`upstream ${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  stop(): void {
    this.#proc.stdin.end();
    this.#proc.kill("SIGTERM");
  }
}
