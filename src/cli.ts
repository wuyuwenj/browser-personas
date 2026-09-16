#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromeProfileDir, configDir, DEFAULT_HOST, DEFAULT_PORT, personasDir, runtimeDir } from "./config.js";
import { DaemonLock } from "./cli/lock.js";
import { knownHosts, proxyUrl, revertHostFile, rewriteHostFile } from "./cli/mcpConfig.js";
import { BrowserPersonasDaemon } from "./proxy/server.js";
import { loginPersona } from "./cli/login.js";
import { allowedOrigins, loadManifest } from "./personas/manifest.js";

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
  login NAME --url URL [--env staging] log a persona in once; the cookies persist
  personas                             list personas, their scope and login state
  console                              print the local console link (token included)
  mcp [--persona NAME] [--owner ID]    run as an MCP server: chrome-devtools-mcp's tools,
                                       plus the persona registry, on this proxy
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
        // Loud, and on both streams. A refusal that only goes to a log file lets an old
        // daemon keep serving an old build while a restart looks like it worked.
        const message =
          `browser-personas is ALREADY RUNNING (pid ${info?.pid ?? "?"}, port ${info?.port ?? "?"}).\n` +
          `Nothing was started, and that daemon may be running an older build.\n` +
          `Stop it first:  browser-personas stop${dir ? ` --config-dir ${dir}` : ""}`;
        console.error(message);
        console.log(message);
        return 1;
      }
      mkdirSync(chromeProfileDir(dir), { recursive: true });
      const daemon = new BrowserPersonasDaemon({
        port,
        host,
        userDataDir: chromeProfileDir(dir),
        personasDir: personasDir(dir),
        configDir: configDir(dir),
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
      console.log(`console:               ${daemon.consoleUrl()}`);
      return -1; // stay in the foreground
    }

    case "login": {
      const name = process.argv[3];
      const url = typeof flags["url"] === "string" ? flags["url"] : undefined;
      if (!name || name.startsWith("--") || !url) {
        console.error("usage: browser-personas login NAME --url https://example.com [--env staging]");
        return 1;
      }
      const result = await loginPersona({
        personasDir: personasDir(dir),
        configDir: configDir(dir),
        name,
        url,
        probe: typeof flags["probe"] === "string" ? flags["probe"] : undefined,
        env: typeof flags["env"] === "string" ? flags["env"] : undefined,
        username: typeof flags["username"] === "string" ? flags["username"] : undefined,
        description: typeof flags["description"] === "string" ? flags["description"] : undefined,
      });
      // The count, never the contents.
      console.log(`saved ${result.cookies} cookies for "${name}"${result.identity ? ` (${result.identity})` : ""}`);
      console.log("restart the daemon, or reconnect, to pick it up");
      return 0;
    }

    case "personas": {
      const root = personasDir(dir);
      const { readdirSync, existsSync } = await import("node:fs");
      if (!existsSync(root)) {
        console.log(`no personas yet. Create one with: browser-personas login NAME --url URL`);
        return 0;
      }
      const names = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      if (names.length === 0) {
        console.log("no personas yet");
        return 0;
      }
      for (const name of names) {
        const manifest = loadManifest(root, name);
        const scope = manifest ? allowedOrigins(manifest) : [];
        const restriction = manifest?.read_only ? ` read-only:${manifest.read_only}` : "";
        const exclusive = manifest?.exclusive ? " exclusive" : "";
        console.log(`${name}${manifest?.env ? `  [${manifest.env}]` : ""}${restriction}${exclusive}`);
        if (manifest?.description) console.log(`    ${manifest.description}`);
        if (scope.length > 0) console.log(`    may reach: ${scope.join(", ")}`);
      }
      return 0;
    }

    case "mcp": {
      const { startWrapper } = await import("./mcp/server.js");
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);

      const persona = typeof flags["persona"] === "string" ? flags["persona"] : "default";
      // A stable owner id lets a reconnect reclaim this session's tabs. The controlling
      // terminal is the most stable thing available that is also different per session.
      const owner =
        typeof flags["owner"] === "string"
          ? flags["owner"]
          : `mcp-${(process.env["TTY"] ?? String(process.ppid)).replace(/[^A-Za-z0-9]+/g, "-")}`;
      const query = new URLSearchParams({ owner, persona });
      const wsEndpoint = `ws://${host}:${port}/devtools/browser/bp?${query}`;

      let upstreamBin: string;
      try {
        upstreamBin = require.resolve("chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js");
      } catch {
        console.error(
          "chrome-devtools-mcp is not installed next to browser-personas.\n" +
            "Install it (npm i -g chrome-devtools-mcp) or point your agent straight at\n" +
            `  npx chrome-devtools-mcp@latest --wsEndpoint ${wsEndpoint}`,
        );
        return 1;
      }

      await startWrapper({
        personasDir: personasDir(dir),
        configDir: configDir(dir),
        persona,
        owner,
        daemonUrl: `http://${host}:${port}`,
        upstreamCommand: process.execPath,
        upstreamArgs: [upstreamBin, "--wsEndpoint", wsEndpoint],
      });
      return -1;
    }

    case "console": {
      const { readFileSync, existsSync } = await import("node:fs");
      // runtimeDir() is already <configDir>/run — the daemon writes the token there.
      const file = join(runtimeDir(dir), "console.token");
      if (!existsSync(file)) {
        console.error("No console token yet. Start the daemon first: browser-personas start");
        return 1;
      }
      const url = `http://${host}:${port}/?t=${readFileSync(file, "utf8").trim()}`;
      console.log(url);
      if (flags["open"]) {
        const { spawn } = await import("node:child_process");
        spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" }).unref();
      }
      return 0;
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
      } catch {
        console.log(`daemon pid ${info.pid} was already gone; clearing the lock`);
        lock.release(true);
        return 0;
      }
      // Wait for it to actually go. Returning while the port is still held is what makes
      // a following `start` fail, which is the failure that hid a stale daemon twice.
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          process.kill(info.pid, 0);
        } catch {
          console.log(`stopped daemon pid ${info.pid}`);
          lock.release(true);
          return 0;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      console.error(`daemon pid ${info.pid} did not exit within 10s`);
      return 1;
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
