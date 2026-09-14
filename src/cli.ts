#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromeProfileDir, configDir, DEFAULT_HOST, DEFAULT_PORT, runtimeDir } from "./config.js";
import { DaemonLock } from "./cli/lock.js";
import { knownHosts, proxyUrl, revertHostFile, rewriteHostFile } from "./cli/mcpConfig.js";
import { BrowserPersonasDaemon } from "./proxy/server.js";

type Flags = Record<string, string | boolean>;

function parseFlags(argv: string[]): { command: string; flags: Flags } {
  const [command = "help", ...rest] = argv;
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
    } else {
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[token.slice(2)] = next;
        i++;
      } else {
        flags[token.slice(2)] = true;
      }
    }
  }
  return { command, flags };
}

const HELP = `browser-personas — one Chrome, many agents

  init [--config-dir DIR] [--port N]   point chrome-devtools-mcp entries at the proxy
  init --revert                        restore the agent configs init changed
  start [--port N] [--headed]          run the daemon in the foreground
  status [--port N]                    who holds which tabs
  stop [--config-dir DIR]              stop a running daemon

Flags: --config-dir, --port, --host, --chrome-path, --headed, --max-tabs
`;

async function main(): Promise<number> {
  const { command, flags } = parseFlags(process.argv.slice(2));
  const dir = typeof flags["config-dir"] === "string" ? flags["config-dir"] : undefined;
  const port = typeof flags["port"] === "string" ? Number(flags["port"]) : DEFAULT_PORT;
  const host = typeof flags["host"] === "string" ? flags["host"] : DEFAULT_HOST;

  switch (command) {
    case "init": {
      const url = proxyUrl(port);
      if (flags["revert"]) {
        for (const hostCfg of knownHosts()) {
          if (revertHostFile(hostCfg.path)) console.log(`restored ${hostCfg.path}`);
        }
        return 0;
      }
      mkdirSync(configDir(dir), { recursive: true });
      mkdirSync(chromeProfileDir(dir), { recursive: true });
      mkdirSync(runtimeDir(dir), { recursive: true });
      let touched = 0;
      for (const hostCfg of knownHosts()) {
        const changed = rewriteHostFile(hostCfg.path, url);
        for (const name of changed) {
          console.log(`${hostCfg.name}: ${name} now uses ${url}`);
          touched++;
        }
      }
      if (touched === 0) {
        console.log(`No chrome-devtools MCP entry found. Add one pointing at ${url}, for example:`);
        console.log(`  npx chrome-devtools-mcp@latest --browserUrl=${url}`);
      }
      console.log(`config dir: ${configDir(dir)}`);
      console.log("Restart every running agent session — an MCP server reads its flags once, at startup.");
      return 0;
    }

    case "start": {
      const lock = new DaemonLock(join(runtimeDir(dir), "daemon.lock"));
      if (!lock.acquire(port)) {
        const info = lock.read();
        console.error(`A daemon is already running (pid ${info?.pid ?? "?"}, port ${info?.port ?? "?"}).`);
        return 1;
      }
      mkdirSync(chromeProfileDir(dir), { recursive: true });
      const daemon = new BrowserPersonasDaemon({
        port,
        host,
        userDataDir: chromeProfileDir(dir),
        chromePath: typeof flags["chrome-path"] === "string" ? flags["chrome-path"] : undefined,
        headless: flags["headed"] ? false : true,
        ownership:
          typeof flags["max-tabs"] === "string" ? { maxTabsPerOwner: Number(flags["max-tabs"]) } : undefined,
      });
      const shutdown = async (): Promise<void> => {
        await daemon.stop();
        lock.release();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
      await daemon.start();
      console.log(`browser-personas listening on http://${host}:${daemon.port}`);
      console.log(`point a client at it:  --browserUrl=${proxyUrl(daemon.port)}`);
      return -1; // stay in the foreground
    }

    case "status": {
      try {
        const res = await fetch(`http://${host}:${port}/status`);
        const body = (await res.json()) as {
          owners: { id: string; persona: string; connected: boolean; tabs: { url: string }[] }[];
        };
        if (body.owners.length === 0) {
          console.log("no agents connected");
          return 0;
        }
        for (const owner of body.owners) {
          const state = owner.connected ? "connected" : "disconnected";
          console.log(`${owner.id}  persona=${owner.persona}  ${state}  tabs=${owner.tabs.length}`);
          for (const tab of owner.tabs) console.log(`    ${tab.url}`);
        }
        return 0;
      } catch {
        console.error(`No daemon answering on http://${host}:${port}. Start one with: browser-personas start`);
        return 1;
      }
    }

    case "stop": {
      const lock = new DaemonLock(join(runtimeDir(dir), "daemon.lock"));
      const info = lock.read();
      if (!info) {
        console.log("no daemon running");
        return 0;
      }
      try {
        process.kill(info.pid, "SIGTERM");
        console.log(`stopped daemon pid ${info.pid}`);
      } catch {
        console.log(`daemon pid ${info.pid} was already gone; clearing the lock`);
        lock.release(true);
      }
      return 0;
    }

    default:
      console.log(HELP);
      return command === "help" ? 0 : 1;
  }
}

main()
  .then((code) => {
    if (code >= 0) process.exit(code);
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
