import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpClient } from "./mcpClient.js";
import { startHarness, type Harness } from "./helpers.js";

const require = createRequire(import.meta.url);
const CLI = require.resolve("../../src/cli.ts");
const TSX = require.resolve("tsx/cli");

/** Transparent mode, end to end: the user's own entry, through the shim, on one Chrome. */
describe("the shim", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });
  afterEach(async () => {
    await harness?.dispose();
  });

  it("runs the user's command with their flags kept, their browser choice dropped, and ours appended", async () => {
    // A fake upstream that prints the argv it received, so the plan can be asserted end to end.
    const fake = join(mkdtempSync(join(tmpdir(), "bp-fake-")), "upstream.mjs");
    writeFileSync(fake, "console.log(JSON.stringify(process.argv.slice(2)));");

    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [
        TSX, CLI, "exec", "--port", String(harness.daemon.port), "--persona", "katy", "--owner", "agent-9",
        "--", process.execPath, fake, "--headless", "--browserUrl=http://127.0.0.1:9222", "--categoryPerformance", "false",
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let buf = "";
      child.stdout.on("data", (c: Buffer) => (buf += c.toString()));
      child.on("exit", () => resolve(buf));
    });

    const argv = JSON.parse(out.trim().split("\n").pop()!) as string[];
    expect(argv).toEqual([
      "--headless", "--categoryPerformance", "false",
      "--wsEndpoint", `ws://127.0.0.1:${harness.daemon.port}/devtools/browser/bp?owner=agent-9&persona=katy`,
    ]);
  });

  it("gives two real chrome-devtools-mcp servers, launched the way init installs them, their own tabs", async () => {
    const a = await McpClient.start(
      ["exec", "--port", String(harness.daemon.port), "--owner", "shim-a"],
      { entry: CLI },
    );
    const b = await McpClient.start(
      ["exec", "--port", String(harness.daemon.port), "--owner", "shim-b"],
      { entry: CLI },
    );
    try {
      await a.callTool("new_page", { url: "data:text/html,<title>Shim-A</title>" });
      await b.callTool("new_page", { url: "data:text/html,<title>Shim-B</title>" });

      const listA = await a.callTool("list_pages");
      const listB = await b.callTool("list_pages");
      expect(listA).toContain("Shim-A");
      expect(listA).not.toContain("Shim-B");
      expect(listB).toContain("Shim-B");
      expect(listB).not.toContain("Shim-A");

      // Exactly the upstream toolset: no wrapper, nothing added.
      const tools = (await a.request("tools/list", {})) as { tools: { name: string }[] };
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("new_page");
      expect(names).not.toContain("list_personas");
    } finally {
      await a.stop();
      await b.stop();
    }
  }, 120_000);
});
