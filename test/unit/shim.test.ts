import { describe, expect, it } from "vitest";
import { deriveOwner, planShim, resolveUpstream, stripConnectionFlags } from "../../src/cli/shim.js";

describe("stripping connection flags", () => {
  it("removes every way of choosing a browser, in both spellings and both forms", () => {
    expect(
      stripConnectionFlags([
        "--browserUrl=http://x:9222",
        "--headless",
        "--wsEndpoint",
        "ws://x/devtools/browser/1",
        "--isolated",
        "--experimentalPageIdRouting",
        "--user-data-dir",
        "/tmp/p",
      ]),
    ).toEqual(["--headless", "--experimentalPageIdRouting"]);
  });

  it("leaves everything else exactly where it was", () => {
    const args = ["-y", "chrome-devtools-mcp@latest", "--categoryPerformance", "false"];
    expect(stripConnectionFlags(args)).toEqual(args);
  });
});

describe("owner id", () => {
  it("honours an explicit id first", () => {
    expect(deriveOwner({ BROWSER_PERSONAS_OWNER: "agent one" })).toBe("agent-one");
  });

  it("uses the terminal when there is one, and the parent pid when there is not", () => {
    expect(deriveOwner({ TTY: "/dev/ttys004" })).toBe("tty-ttys004");
    // pid 1 has no controlling terminal on any system.
    expect(deriveOwner({}, 1)).toBe("pid-1");
  });
});

describe("upstream resolution", () => {
  it("prefers the user's own command", () => {
    expect(resolveUpstream(["npx", "-y", "chrome-devtools-mcp@1.8.0"])).toMatchObject({
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@1.8.0"],
      source: "user",
    });
  });

  it("falls back to the bundled copy", () => {
    const r = resolveUpstream([]);
    expect(r.source).toBe("bundled");
    expect(r.args[0]).toMatch(/chrome-devtools-mcp\.js$/);
  });
});

describe("the plan", () => {
  it("keeps the user's flags, drops their browser choice, and appends ours", () => {
    const plan = planShim({
      persona: "katy",
      host: "127.0.0.1",
      port: 9223,
      owner: "tty-ttys004",
      userCommand: ["npx", "-y", "chrome-devtools-mcp@latest", "--browserUrl=http://127.0.0.1:9222", "--headless"],
    });
    expect(plan.command).toBe("npx");
    expect(plan.args).toEqual([
      "-y",
      "chrome-devtools-mcp@latest",
      "--headless",
      "--wsEndpoint",
      "ws://127.0.0.1:9223/devtools/browser/bp?owner=tty-ttys004&persona=katy",
    ]);
    expect(plan.upstream).toBe("user");
  });
});
