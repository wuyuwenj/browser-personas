import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpClient } from "./mcpClient.js";
import { startHarness, type Harness } from "./helpers.js";

/**
 * The v0.1 exit criterion, exactly as an agent experiences it: two real
 * chrome-devtools-mcp servers on one Chrome, and neither `list_pages` shows the other's
 * tab. This is the README demo, asserted.
 */
describe("two chrome-devtools-mcp servers on one Chrome", () => {
  let harness: Harness;
  let a: McpClient;
  let b: McpClient;

  beforeEach(async () => {
    harness = await startHarness();
    a = await McpClient.start(["--wsEndpoint", harness.wsUrl("mcp-a")]);
    b = await McpClient.start(["--wsEndpoint", harness.wsUrl("mcp-b")]);
  }, 90_000);

  afterEach(async () => {
    await a?.stop();
    await b?.stop();
    await harness?.dispose();
  });

  it("shows each server only its own page", async () => {
    await a.callTool("new_page", { url: "data:text/html,<title>Only-A</title>" });
    await b.callTool("new_page", { url: "data:text/html,<title>Only-B</title>" });

    const listA = await a.callTool("list_pages");
    const listB = await b.callTool("list_pages");

    expect(listA).toContain("Only-A");
    expect(listA).not.toContain("Only-B");
    expect(listB).toContain("Only-B");
    expect(listB).not.toContain("Only-A");
  }, 90_000);

  it("refuses close_page on a page the other server opened", async () => {
    await a.callTool("new_page", { url: "data:text/html,<title>Keep-A</title>" });
    await b.callTool("new_page", { url: "data:text/html,<title>Keep-B</title>" });

    const idA = harness.daemon.registry
      .targetsOf("mcp-a")
      .filter((t) => t.type === "page")
      .map((t) => t.targetId)[0]!;

    // B is told about a page id it does not own. Whether the server rejects the call or
    // reports an error back, the page must survive — that is the guarantee.
    const before = harness.daemon.registry.pageCount("mcp-a");
    await b.callTool("close_page", { pageId: idA }).catch(() => "refused");

    expect(harness.daemon.registry.pageCount("mcp-a")).toBe(before);
    expect(await a.callTool("list_pages")).toContain("Keep-A");
  }, 90_000);

  it("runs both servers against a single Chrome process", async () => {
    await a.callTool("new_page", { url: "data:text/html,A" });
    await b.callTool("new_page", { url: "data:text/html,B" });

    const owners = harness.daemon.registry.owners().map((o) => o.id).sort();
    expect(owners).toEqual(["mcp-a", "mcp-b"]);
    expect(harness.daemon.registry.pageCount("mcp-a")).toBeGreaterThan(0);
    expect(harness.daemon.registry.pageCount("mcp-b")).toBeGreaterThan(0);
  }, 90_000);
});
