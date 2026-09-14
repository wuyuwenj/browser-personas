import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * A real `chrome-devtools-mcp` process speaking MCP over stdio.
 *
 * The point of testing through the actual server, rather than through puppeteer alone, is
 * that the isolation claim is about what an AGENT sees — `list_pages` is the tool an agent
 * calls, and it is the thing that must never show someone else's tab.
 */
export class McpClient {
  #proc: ChildProcessWithoutNullStreams;
  #buffer = "";
  #nextId = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(proc: ChildProcessWithoutNullStreams) {
    this.#proc = proc;
    proc.stdout.on("data", (chunk: Buffer) => this.#onData(chunk.toString()));
    proc.stderr.on("data", () => {});
  }

  static binPath(): string {
    return require.resolve("chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js");
  }

  /**
   * Start the browser-personas wrapper itself, which is what an agent actually connects
   * to: chrome-devtools-mcp's tools re-exported, plus the persona registry.
   */
  static async startWrapper(options: {
    daemonPort: number;
    personasDir: string;
    persona: string;
    owner: string;
  }): Promise<McpClient> {
    const cli = require.resolve("../../src/cli.ts");
    return McpClient.start(
      [
        "mcp",
        "--port",
        String(options.daemonPort),
        "--persona",
        options.persona,
        "--owner",
        options.owner,
      ],
      { entry: cli, env: { BROWSER_PERSONAS_CONFIG_DIR: join(options.personasDir, "..") } },
    );
  }

  static async start(
    args: string[],
    options: { entry?: string; env?: Record<string, string> } = {},
  ): Promise<McpClient> {
    const entry = options.entry ?? McpClient.binPath();
    // The CLI is TypeScript in this repo, so it runs through tsx when it is the entry.
    const argv = entry.endsWith(".ts")
      ? [require.resolve("tsx/cli"), entry, ...args]
      : [entry, ...args];
    const proc = spawn(process.execPath, argv, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
    });
    const client = new McpClient(proc);
    await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "browser-personas-test", version: "0.1.0" },
    });
    client.#notify("notifications/initialized", {});
    return client;
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
    if (msg.error) pending.reject(new Error(msg.error.message ?? "mcp error"));
    else pending.resolve(msg.result);
  }

  #notify(method: string, params: unknown): void {
    this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`mcp ${method} timed out after ${timeoutMs}ms`));
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

  /** Call a tool and flatten its text content, which is what the agent actually reads. */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: { type: string; text?: string }[];
    };
    return (result.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }

  async stop(): Promise<void> {
    this.#proc.stdin.end();
    this.#proc.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (this.#proc.exitCode !== null) return resolve();
      this.#proc.once("exit", () => resolve());
      setTimeout(() => {
        this.#proc.kill("SIGKILL");
        resolve();
      }, 3_000).unref();
    });
  }
}
