import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { McpClient } from "./mcpClient.js";
import { DOORVEST, startPersonaHarness, type PersonaHarness } from "./personaHarness.js";

const require = createRequire(import.meta.url);
const CLI = require.resolve("../../src/cli.ts");

/**
 * One chrome-devtools entry, one registry, and the persona chosen at runtime. The two
 * servers are what one Claude session launches; they agree on the owner id, which is the
 * whole mechanism — so the tests pin it with --owner exactly as deriveOwner would compute
 * one shared value for both.
 */
describe("switching persona at runtime", () => {
  let harness: PersonaHarness;
  const clients: McpClient[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.stop();
    await harness?.dispose();
  });

  async function session(owner: string) {
    const devtools = await McpClient.start(["exec", "--port", String(harness.daemon.port), "--owner", owner], { entry: CLI });
    const registry = await McpClient.startRegistry({ daemonPort: harness.daemon.port, personasDir: harness.personasDir, owner });
    clients.push(devtools, registry);
    return { devtools, registry };
  }

  const contextOf = (owner: string, url: string) =>
    harness.daemon.registry
      .targetsOf(owner)
      .find((t) => t.type === "page" && t.url.includes(url))?.browserContextId;

  it("puts new pages in the chosen persona's context, and leaves open ones where they were", async () => {
    harness = await startPersonaHarness([
      { name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] },
      { name: "jlo", env: "staging", accounts: [{ origin: DOORVEST }] },
    ]);
    const { devtools, registry } = await session("agent-1");

    await devtools.callTool("new_page", { url: "data:text/html,<title>before</title>" });
    const reply = await registry.callTool("use_persona", { name: "jlo" });
    expect(reply).toContain('Now browsing as "jlo"');

    await devtools.callTool("new_page", { url: "data:text/html,<title>after</title>" });

    const jloContext = harness.daemon.personas.context("jlo")?.browserContextId;
    expect(jloContext).toBeDefined();
    expect(contextOf("agent-1", "after")).toBe(jloContext);
    // The page opened before the switch did not move.
    expect(contextOf("agent-1", "before")).not.toBe(jloContext);
  }, 120_000);

  it("works when the agent chooses before its browser has connected at all", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const { devtools, registry } = await session("agent-early");

    // chrome-devtools-mcp opens its connection lazily; nothing has touched the browser yet.
    await registry.callTool("use_persona", { name: "katy" });
    await devtools.callTool("new_page", { url: "data:text/html,<title>first</title>" });

    expect(contextOf("agent-early", "first")).toBe(harness.daemon.personas.context("katy")?.browserContextId);
  }, 120_000);

  it("fences to the new persona's websites once switched", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const { devtools, registry } = await session("agent-fence");

    // Connected and browsing as the unscoped default first, so the connection itself says
    // "default"; only the runtime switch can make the fence apply.
    await devtools.callTool("new_page", { url: "data:text/html,<title>default</title>" });
    await registry.callTool("use_persona", { name: "katy" });
    const refused = await devtools.callTool("new_page", { url: "https://doorvest.com/admin" }).catch((e: Error) => e.message);
    expect(String(refused)).toMatch(/may only reach|staging/i);
  }, 120_000);

  it("says who else is on the persona, and refuses one that does not exist", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const a = await session("agent-a");
    await a.registry.callTool("use_persona", { name: "katy" });
    await a.devtools.callTool("new_page", { url: "data:text/html,a" });

    const b = await session("agent-b");
    const shared = await b.registry.callTool("use_persona", { name: "katy" });
    expect(shared).toContain("Shared login");
    expect(shared).toContain("agent-a");

    const missing = await b.registry.callTool("use_persona", { name: "nobody" });
    expect(missing).toContain('No persona named "nobody"');
  }, 120_000);

  it("honours an exclusive persona across a runtime switch", async () => {
    harness = await startPersonaHarness([{ name: "solo", env: "staging", exclusive: true, accounts: [{ origin: DOORVEST }] }]);
    const a = await session("holder");
    await a.registry.callTool("use_persona", { name: "solo" });
    await a.devtools.callTool("new_page", { url: "data:text/html,a" });

    const b = await session("latecomer");
    const refused = await b.registry.callTool("use_persona", { name: "solo" });
    expect(refused).toContain("held by holder");

    // Switching away frees it.
    await a.registry.callTool("use_persona", { name: "default" });
    expect(await b.registry.callTool("use_persona", { name: "solo" })).toContain('Now browsing as "solo"');
  }, 120_000);
});
