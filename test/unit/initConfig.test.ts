import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupPath, isThroughShim, revertHostFile, rewriteHostFile } from "../../src/cli/mcpConfig.js";

const launcher = { command: "/usr/bin/node", prefix: ["/opt/bp/dist/cli.js"] };
const tmp = (): string => mkdtempSync(join(tmpdir(), "bp-init-"));
const read = (f: string): Record<string, unknown> => JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
const servers = (f: string): Record<string, { command: string; args: string[]; env?: unknown }> =>
  read(f)["mcpServers"] as never;

/**
 * `init` on a host config file. The promise is transparency: the user's entry keeps every
 * flag and every environment variable it had, and gains only the shim in front of it.
 */
describe("routing an existing chrome-devtools entry through the shim", () => {
  it("wraps the user's own command, keeps their flags and env, and backs the file up first", () => {
    const f = join(tmp(), ".claude.json");
    writeFileSync(f, JSON.stringify({
      mcpServers: {
        "chrome-devtools": {
          command: "npx",
          args: ["-y", "chrome-devtools-mcp@latest", "--headless", "--browserUrl=http://127.0.0.1:9222"],
          env: { DEBUG: "1" },
        },
        "some-other-server": { command: "foo", args: [] },
      },
    }));

    const report = rewriteHostFile(f, { launcher, persona: "default", create: true });

    expect(report.changed).toEqual(["chrome-devtools"]);
    const entry = servers(f)["chrome-devtools"]!;
    expect(entry.command).toBe("/usr/bin/node");
    expect(entry.args).toEqual([
      "/opt/bp/dist/cli.js", "exec", "--persona", "default",
      "--", "npx", "-y", "chrome-devtools-mcp@latest", "--headless", "--browserUrl=http://127.0.0.1:9222",
    ]);
    expect(entry.env).toEqual({ DEBUG: "1" });
    // Untouched neighbours stay untouched; the backup is the original byte for byte.
    expect(servers(f)["some-other-server"]).toEqual({ command: "foo", args: [] });
    expect(existsSync(backupPath(f))).toBe(true);
    expect(JSON.parse(readFileSync(backupPath(f), "utf8")).mcpServers["chrome-devtools"].command).toBe("npx");
  });

  it("is idempotent: a second init changes nothing and does not double-wrap", () => {
    const f = join(tmp(), ".claude.json");
    writeFileSync(f, JSON.stringify({ mcpServers: { "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] } } }));
    rewriteHostFile(f, { launcher, persona: "default" });
    const once = readFileSync(f, "utf8");

    const again = rewriteHostFile(f, { launcher, persona: "default" });

    expect(again.changed).toEqual([]);
    expect(again.skipped).toEqual(["chrome-devtools"]);
    expect(readFileSync(f, "utf8")).toBe(once);
    expect(servers(f)["chrome-devtools"]!.args.filter((a) => a === "exec")).toHaveLength(1);
  });

  it("reverts to the exact original", () => {
    const f = join(tmp(), ".claude.json");
    const original = JSON.stringify({ mcpServers: { "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] } } });
    writeFileSync(f, original);
    rewriteHostFile(f, { launcher, persona: "default" });

    expect(revertHostFile(f)).toBe(true);
    expect(readFileSync(f, "utf8")).toBe(original);
  });

  it("also routes project-scoped entries, with the persona they had rather than a new one", () => {
    const f = join(tmp(), ".claude.json");
    writeFileSync(f, JSON.stringify({
      mcpServers: {},
      projects: { "/Users/x/repo": { mcpServers: { "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] } } } },
    }));

    const report = rewriteHostFile(f, { launcher, persona: "default", personas: ["katy"], create: true });

    expect(report.changed).toEqual(["/Users/x/repo: chrome-devtools"]);
    const proj = (read(f)["projects"] as never)["/Users/x/repo"]["mcpServers"];
    expect(isThroughShim(proj["chrome-devtools"])).toBe(true);
    // Sibling personas belong at the top level only.
    expect(proj["chrome-devtools-katy"]).toBeUndefined();
    expect(servers(f)["chrome-devtools-katy"]).toBeDefined();
  });
});

describe("a custom launcher script", () => {
  const withLauncher = () => {
    const f = join(tmp(), ".claude.json");
    writeFileSync(f, JSON.stringify({ mcpServers: { "chrome-devtools": { command: "/Users/me/.claude/bin/cdp-profile-lease", args: ["--experimentalPageIdRouting"] } } }));
    return f;
  };

  it("is left alone and flagged, because it may pick its own browser at runtime", () => {
    const f = withLauncher();
    const report = rewriteHostFile(f, { launcher, persona: "default" });

    expect(report.changed).toEqual([]);
    expect(report.warned).toEqual(["chrome-devtools (/Users/me/.claude/bin/cdp-profile-lease)"]);
    expect(servers(f)["chrome-devtools"]!.command).toBe("/Users/me/.claude/bin/cdp-profile-lease");
    expect(existsSync(backupPath(f))).toBe(false);
  });

  it("is swapped for the bundled upstream on request", () => {
    const f = withLauncher();
    const report = rewriteHostFile(f, { launcher, persona: "default", replaceLaunchers: true });

    expect(report.replaced).toEqual(["chrome-devtools"]);
    expect(servers(f)["chrome-devtools"]!.args).toEqual(["/opt/bp/dist/cli.js", "exec", "--persona", "default"]);
  });

  it("still recognises the ordinary ways of running upstream", async () => {
    const { isKnownUpstream } = await import("../../src/cli/mcpConfig.js");
    expect(isKnownUpstream({ command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] })).toBe(true);
    expect(isKnownUpstream({ command: "/usr/local/bin/node", args: ["/x/chrome-devtools-mcp.js"] })).toBe(true);
    expect(isKnownUpstream({ command: "chrome-devtools-mcp", args: [] })).toBe(true);
    expect(isKnownUpstream({ command: "/home/me/my-launcher.sh", args: ["--flag"] })).toBe(false);
  });
});

describe("a fresh install", () => {
  it("creates one entry that runs the bundled upstream", () => {
    const f = join(tmp(), ".claude.json");
    const report = rewriteHostFile(f, { launcher, persona: "default", create: true });

    expect(report.created).toEqual(["chrome-devtools"]);
    expect(servers(f)["chrome-devtools"]!.args).toEqual(["/opt/bp/dist/cli.js", "exec", "--persona", "default"]);
  });

  it("does not invent a file when asked only to rewrite", () => {
    const f = join(tmp(), ".claude.json");
    const report = rewriteHostFile(f, { launcher, persona: "default" });
    expect(report.created).toEqual([]);
    expect(existsSync(f)).toBe(false);
  });
});

describe("collapsing the per-persona entries", () => {
  it("removes the chrome-devtools-<name> entries it made, keeps pinned ones and the user's own", () => {
    const f = join(tmp(), ".claude.json");
    const shimmed = (p: string) => ({ command: "/usr/bin/node", args: ["/opt/bp/dist/cli.js", "exec", "--persona", p] });
    writeFileSync(f, JSON.stringify({
      mcpServers: {
        "chrome-devtools": shimmed("default"),
        "chrome-devtools-jlo": shimmed("jlo"),
        "chrome-devtools-katy": shimmed("katy"),
        // Somebody's own server that happens to share the prefix.
        "chrome-devtools-canary": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest", "--channel", "canary"] },
      },
    }));

    const report = rewriteHostFile(f, { launcher, persona: "default", personas: ["katy"], collapse: true });

    expect(report.removed).toEqual(["chrome-devtools-jlo"]);
    const names = Object.keys(servers(f)).sort();
    expect(names).toEqual(["chrome-devtools", "chrome-devtools-canary", "chrome-devtools-katy"]);
    // The user's own entry was wrapped like any other upstream command, not deleted.
    expect(isThroughShim(servers(f)["chrome-devtools-canary"] as never)).toBe(true);
  });
});

describe("personas and the registry", () => {
  it("adds a chrome-devtools-<name> entry per persona, seeded from the user's base command", () => {
    const f = join(tmp(), ".claude.json");
    writeFileSync(f, JSON.stringify({ mcpServers: { "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@1.9.0", "--headless"] } } }));

    const report = rewriteHostFile(f, { launcher, persona: "default", personas: ["katy", "kendrick"], registry: true });

    expect(report.created).toEqual(["chrome-devtools-katy", "chrome-devtools-kendrick", "browser-personas"]);
    const katy = servers(f)["chrome-devtools-katy"]!;
    expect(katy.args).toEqual([
      "/opt/bp/dist/cli.js", "exec", "--persona", "katy",
      "--", "npx", "-y", "chrome-devtools-mcp@1.9.0", "--headless",
    ]);
    expect(servers(f)["browser-personas"]!.args).toEqual(["/opt/bp/dist/cli.js", "mcp"]);
  });
});
