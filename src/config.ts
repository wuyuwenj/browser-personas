import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_PORT = 9223;
export const DEFAULT_HOST = "127.0.0.1";

/**
 * Everything this tool owns lives under one directory so `init --config-dir` can point a
 * test (or a second install) somewhere harmless. Nothing here ever writes to the user's
 * agent configuration outside an explicit `init`.
 */
export function configDir(override?: string): string {
  if (override) return override;
  if (process.env["BROWSER_PERSONAS_CONFIG_DIR"]) return process.env["BROWSER_PERSONAS_CONFIG_DIR"];
  return join(homedir(), ".config", "browser-personas");
}

export function personasDir(override?: string): string {
  return join(configDir(override), "personas");
}

export function chromeProfileDir(override?: string): string {
  return join(configDir(override), "chrome-profile");
}

export function runtimeDir(override?: string): string {
  return join(configDir(override), "run");
}

export function lockPath(override?: string): string {
  return join(runtimeDir(override), "daemon.lock");
}
