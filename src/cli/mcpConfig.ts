import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Rewrites an agent host's MCP entry to point chrome-devtools-mcp at the proxy.
 *
 * Adoption is deliberately one flag: an existing entry keeps every argument its owner
 * chose and gains `--browserUrl`. A backup is written first so `init --revert` can put
 * the file back exactly as it was.
 */
export type HostName = "claude-code" | "codex" | "cursor";

export type HostConfig = { name: HostName; path: string; serverKey: string };

export function knownHosts(home = homedir()): HostConfig[] {
  return [
    { name: "claude-code", path: join(home, ".claude.json"), serverKey: "mcpServers" },
    { name: "cursor", path: join(home, ".cursor", "mcp.json"), serverKey: "mcpServers" },
  ];
}

export function proxyUrl(port: number, persona?: string, owner?: string): string {
  const segments = ["http://127.0.0.1:" + port];
  if (persona && persona !== "default") segments.push("p", encodeURIComponent(persona));
  if (owner) segments.push("o", encodeURIComponent(owner));
  return segments.join("/");
}

type JsonObject = Record<string, unknown>;

export function backupPath(file: string): string {
  return `${file}.browser-personas.bak`;
}

/**
 * Add `--browserUrl` to every chrome-devtools server entry in one host file.
 * Returns the names of the entries it changed; an entry that already points at the
 * proxy is left alone so repeated `init` runs are idempotent.
 */
export function rewriteHostFile(file: string, url: string): string[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8");
  let parsed: JsonObject;
  try {
    parsed = JSON.parse(raw) as JsonObject;
  } catch {
    return [];
  }

  const changed: string[] = [];
  const visitServers = (servers: JsonObject | undefined): void => {
    if (!servers) return;
    for (const [name, entry] of Object.entries(servers)) {
      if (!name.includes("chrome-devtools")) continue;
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as JsonObject;
      const args = Array.isArray(record["args"]) ? (record["args"] as string[]) : [];
      if (args.some((a) => a.startsWith("--browserUrl"))) continue;
      record["args"] = [...args, `--browserUrl=${url}`];
      changed.push(name);
    }
  };

  visitServers(parsed["mcpServers"] as JsonObject | undefined);
  for (const project of Object.values((parsed["projects"] as JsonObject) ?? {})) {
    if (typeof project === "object" && project !== null) {
      visitServers((project as JsonObject)["mcpServers"] as JsonObject | undefined);
    }
  }

  if (changed.length === 0) return [];
  if (!existsSync(backupPath(file))) copyFileSync(file, backupPath(file));
  writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  return changed;
}

export function revertHostFile(file: string): boolean {
  const backup = backupPath(file);
  if (!existsSync(backup)) return false;
  copyFileSync(backup, file);
  return true;
}
