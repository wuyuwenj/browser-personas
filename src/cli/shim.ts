import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

/**
 * The shim: what an agent host actually launches in transparent mode.
 *
 * It exists because of two facts. `--browserUrl` cannot carry a persona or an owner name
 * (puppeteer resolves `/json/version` as an absolute path and discards the rest), and a
 * static config entry cannot hold a per-session id — every session using that entry would
 * share it, and reclaim-after-reconnect would hand one session another's tabs. So the id
 * is computed here, at spawn time, and the real chrome-devtools-mcp is run with the proxy
 * endpoint appended. Every argument the user had is preserved. From the agent's side the
 * tools are exactly the ones it always had.
 */

export type ShimPlan = {
  command: string;
  args: string[];
  owner: string;
  persona: string;
  wsEndpoint: string;
  /** Where the upstream came from, so drift is visible rather than mysterious. */
  upstream: "user" | "bundled" | "npx";
};

const CONNECTION_FLAGS = /^--(browserUrl|browser-url|wsEndpoint|ws-endpoint|autoConnect|auto-connect|userDataDir|user-data-dir|isolated)(=|$)/;

/**
 * Strip the flags that decide which browser upstream talks to. The proxy is the browser
 * now, and a leftover `--browserUrl` would win the argument over ours.
 */
export function stripConnectionFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (CONNECTION_FLAGS.test(arg)) {
      // A separate-value form (`--browserUrl http://…`) eats the next token too.
      if (!arg.includes("=") && i + 1 < args.length && !args[i + 1]!.startsWith("-")) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}

/**
 * A stable-per-session, different-per-session owner id.
 *
 * The controlling terminal is the best thing available that is both: it survives a
 * `/mcp` reconnect inside the same session, and two terminals never share one. With no
 * tty (a subagent, a CI runner) the parent pid is the fallback, which still separates
 * sessions and merely loses reclaim.
 */
export function deriveOwner(env: NodeJS.ProcessEnv = process.env, ppid = process.ppid): string {
  const explicit = env["BROWSER_PERSONAS_OWNER"];
  if (explicit) return sanitize(explicit);
  let tty = env["TTY"] ?? "";
  if (!tty) {
    try {
      tty = execFileSync("ps", ["-o", "tty=", "-p", String(ppid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      tty = "";
    }
  }
  tty = tty.replace(/^\/dev\//, "");
  if (tty && tty !== "??" && tty !== "?" && tty !== "-") return sanitize(`tty-${tty}`);
  return sanitize(`pid-${ppid}`);
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 64);
}

/** Resolution order: the user's own command, then the copy shipped with us, then npx. */
export function resolveUpstream(userCommand: string[]): { command: string; args: string[]; source: ShimPlan["upstream"] } {
  if (userCommand.length > 0) {
    return { command: userCommand[0]!, args: userCommand.slice(1), source: "user" };
  }
  try {
    const require = createRequire(import.meta.url);
    const bin = require.resolve("chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js");
    return { command: process.execPath, args: [bin], source: "bundled" };
  } catch {
    return { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"], source: "npx" };
  }
}

export function planShim(options: {
  persona: string;
  host: string;
  port: number;
  userCommand: string[];
  owner?: string;
}): ShimPlan {
  const owner = options.owner ?? deriveOwner();
  const upstream = resolveUpstream(options.userCommand);
  const query = new URLSearchParams({ owner, persona: options.persona });
  const wsEndpoint = `ws://${options.host}:${options.port}/devtools/browser/bp?${query}`;
  return {
    command: upstream.command,
    args: [...stripConnectionFlags(upstream.args), "--wsEndpoint", wsEndpoint],
    owner,
    persona: options.persona,
    wsEndpoint,
    upstream: upstream.source,
  };
}

/** Run the plan as this process: stdio straight through, exit code mirrored, signals forwarded. */
export function runShim(plan: ShimPlan): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(plan.command, plan.args, { stdio: "inherit" });
    const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
    process.on("SIGINT", forward("SIGINT"));
    process.on("SIGTERM", forward("SIGTERM"));
    process.on("SIGHUP", forward("SIGHUP"));
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on("error", () => resolve(1));
  });
}
