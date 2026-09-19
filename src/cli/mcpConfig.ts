import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Rewrites an agent host's MCP config so chrome-devtools-mcp runs through the shim.
 *
 * Transparent mode: the user keeps their `chrome-devtools` entry and its 29 tools. The
 * entry now launches `browser-personas exec`, which computes a per-session owner id and
 * runs the very command the user had — every argument preserved — with the proxy's
 * endpoint appended. A backup is written before the first change so `init --revert` can
 * put the file back exactly as it was.
 */
export type HostName = "claude-code" | "cursor";
export type HostConfig = { name: HostName; path: string };

export function knownHosts(home = homedir()): HostConfig[] {
  return [
    { name: "claude-code", path: join(home, ".claude.json") },
    { name: "cursor", path: join(home, ".cursor", "mcp.json") },
  ];
}

export function proxyUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function backupPath(file: string): string {
  return `${file}.browser-personas.bak`;
}

type JsonObject = Record<string, unknown>;
type Entry = { command?: string; args?: string[]; env?: Record<string, string>; type?: string };

/** How the entry should invoke this tool. Default: the CLI that is running `init`. */
export type Launcher = { command: string; prefix: string[] };

export function selfLauncher(): Launcher {
  return { command: process.execPath, prefix: [process.argv[1] ?? "browser-personas"] };
}

export type RewriteOptions = {
  launcher: Launcher;
  /** Persona for the base entry. */
  persona: string;
  /** Extra sibling entries, one per persona: `chrome-devtools-<name>`. */
  personas?: string[];
  /** Add the registry server as its own entry. */
  registry?: boolean;
  /** Create a `chrome-devtools` entry when the file has none. */
  create?: boolean;
};

export type RewriteReport = { changed: string[]; created: string[]; skipped: string[] };

function throughShim(entry: Entry, launcher: Launcher, persona: string): Entry {
  const user = entry.command ? [entry.command, ...(entry.args ?? [])] : [];
  return {
    ...(entry.type ? { type: entry.type } : {}),
    command: launcher.command,
    args: [...launcher.prefix, "exec", "--persona", persona, ...(user.length ? ["--", ...user] : [])],
    ...(entry.env ? { env: entry.env } : {}),
  };
}

export function isThroughShim(entry: Entry): boolean {
  return Array.isArray(entry.args) && entry.args.includes("exec") && entry.args.includes("--persona");
}

/** The user command a shimmed entry wraps, or the entry itself when it is not shimmed yet. */
function userCommandOf(entry: Entry): Entry {
  if (!isThroughShim(entry)) return entry;
  const args = entry.args ?? [];
  const at = args.indexOf("--");
  if (at === -1) return { ...(entry.env ? { env: entry.env } : {}) };
  const [command, ...rest] = args.slice(at + 1);
  return { command, args: rest, ...(entry.env ? { env: entry.env } : {}) };
}

function rewriteServers(servers: JsonObject, options: RewriteOptions, report: RewriteReport, scope: string): void {
  let baseEntry = servers["chrome-devtools"] as Entry | undefined;

  for (const [name, raw] of Object.entries(servers)) {
    if (!/chrome-devtools/.test(name) || typeof raw !== "object" || raw === null) continue;
    const entry = raw as Entry;
    if (isThroughShim(entry)) {
      report.skipped.push(`${scope}${name}`);
      continue;
    }
    servers[name] = throughShim(entry, options.launcher, options.persona);
    report.changed.push(`${scope}${name}`);
  }

  // Sibling personas and the registry live at the top level only; a project-scoped entry
  // is somebody's deliberate override and is left with exactly the persona it had.
  if (scope !== "") return;

  if (!baseEntry && options.create) {
    servers["chrome-devtools"] = throughShim({}, options.launcher, options.persona);
    baseEntry = servers["chrome-devtools"] as Entry;
    report.created.push("chrome-devtools");
  }

  for (const persona of options.personas ?? []) {
    const name = `chrome-devtools-${persona}`;
    const existing = servers[name] as Entry | undefined;
    if (existing && isThroughShim(existing)) {
      report.skipped.push(name);
      continue;
    }
    const seed = existing ?? (baseEntry ? userCommandOf(baseEntry) : {});
    servers[name] = throughShim(seed, options.launcher, persona);
    report.created.push(name);
  }

  if (options.registry && !servers["browser-personas"]) {
    servers["browser-personas"] = { command: options.launcher.command, args: [...options.launcher.prefix, "mcp"] };
    report.created.push("browser-personas");
  }
}

export function rewriteHostFile(file: string, options: RewriteOptions): RewriteReport {
  const report: RewriteReport = { changed: [], created: [], skipped: [] };
  let parsed: JsonObject = {};
  if (existsSync(file)) {
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as JsonObject;
    } catch {
      return report;
    }
  } else if (!options.create) {
    return report;
  }

  parsed["mcpServers"] ??= {};
  rewriteServers(parsed["mcpServers"] as JsonObject, options, report, "");
  for (const [project, value] of Object.entries((parsed["projects"] as JsonObject) ?? {})) {
    const servers = (value as JsonObject | null)?.["mcpServers"];
    if (typeof servers === "object" && servers !== null) {
      rewriteServers(servers as JsonObject, options, report, `${project}: `);
    }
  }

  if (report.changed.length + report.created.length === 0) return report;
  if (existsSync(file) && !existsSync(backupPath(file))) copyFileSync(file, backupPath(file));
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  return report;
}

export function revertHostFile(file: string): boolean {
  const backup = backupPath(file);
  if (!existsSync(backup)) return false;
  copyFileSync(backup, file);
  return true;
}
