import { afterEach, describe, expect, it } from "vitest";
import { McpClient } from "./mcpClient.js";
import { DOORVEST, startPersonaHarness, type PersonaHarness } from "./personaHarness.js";
import { readNotes } from "../../src/personas/manifest.js";

/**
 * The registry as an agent meets it: the wrapper exposes chrome-devtools-mcp's whole
 * toolset alongside the persona tools, and tells an agent when it is sharing a login.
 */
describe("the persona registry, through MCP", () => {
  let harness: PersonaHarness;
  const clients: McpClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.stop();
    await harness?.dispose();
  });

  it("offers the persona tools alongside chrome-devtools-mcp's own", async () => {
    harness = await startPersonaHarness([
      { name: "katy", description: "Owner with a renewal.", env: "staging", accounts: [{ origin: DOORVEST }] },
    ]);
    const wrapper = await McpClient.startWrapper({
      daemonPort: harness.daemon.port,
      personasDir: harness.personasDir,
      persona: "katy",
      owner: "agent-1",
    });
    clients.push(wrapper);

    const tools = (await wrapper.request("tools/list", {})) as { tools: { name: string }[] };
    const names = tools.tools.map((t) => t.name);

    expect(names).toContain("list_personas");
    expect(names).toContain("note_persona");
    expect(names).toContain("new_page");
    expect(names).toContain("list_pages");
  }, 120_000);

  it("describes each persona, its scope, and who is holding it", async () => {
    harness = await startPersonaHarness([
      {
        name: "katy",
        description: "Owner with a renewal awaiting approval.",
        env: "staging",
        accounts: [{ origin: DOORVEST, username: "katy@example.com", role: "homeowner" }],
      },
    ]);
    const wrapper = await McpClient.startWrapper({
      daemonPort: harness.daemon.port,
      personasDir: harness.personasDir,
      persona: "katy",
      owner: "agent-1",
    });
    clients.push(wrapper);
    await wrapper.callTool("new_page", { url: "data:text/html,<title>x</title>" });

    const listing = await wrapper.callTool("list_personas");

    expect(listing).toContain("katy");
    expect(listing).toContain("Owner with a renewal awaiting approval.");
    expect(listing).toContain("staging");
    expect(listing).toContain(DOORVEST);
    expect(listing).toContain("agent-1");
  }, 120_000);

  it("tells the second agent it is sharing a login, once, on its first page", async () => {
    harness = await startPersonaHarness([
      { name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] },
    ]);
    const first = await McpClient.startWrapper({
      daemonPort: harness.daemon.port,
      personasDir: harness.personasDir,
      persona: "katy",
      owner: "agent-1",
    });
    clients.push(first);
    await first.callTool("new_page", { url: "data:text/html,A" });

    const second = await McpClient.startWrapper({
      daemonPort: harness.daemon.port,
      personasDir: harness.personasDir,
      persona: "katy",
      owner: "agent-2",
    });
    clients.push(second);

    const firstPage = await second.callTool("new_page", { url: "data:text/html,B" });
    expect(firstPage).toContain("Shared login");
    expect(firstPage).toContain("agent-1");
    expect(firstPage).toContain("same signed-in user");

    // Once, not on every page: a notice repeated every call is a notice that gets ignored.
    const secondPage = await second.callTool("new_page", { url: "data:text/html,C" });
    expect(secondPage).not.toContain("Shared login");
  }, 180_000);

  it("says nothing about sharing when the agent is alone on a persona", async () => {
    harness = await startPersonaHarness([
      { name: "solo-user", env: "staging", accounts: [{ origin: DOORVEST }] },
    ]);
    const only = await McpClient.startWrapper({
      daemonPort: harness.daemon.port,
      personasDir: harness.personasDir,
      persona: "solo-user",
      owner: "agent-1",
    });
    clients.push(only);

    const page = await only.callTool("new_page", { url: "data:text/html,A" });
    expect(page).not.toContain("Shared login");
  }, 120_000);

  it("writes a note that the next agent reads, and expires the ones about data", async () => {
    harness = await startPersonaHarness([
      { name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] },
    ]);
    const wrapper = await McpClient.startWrapper({
      daemonPort: harness.daemon.port,
      personasDir: harness.personasDir,
      persona: "katy",
      owner: "agent-1",
    });
    clients.push(wrapper);

    await wrapper.callTool("note_persona", { name: "katy", note: "Renewal on unit 52 is mid-approval — leave it." });
    await wrapper.callTool("note_persona", { name: "katy", note: "Consumed the seeded bid.", ttl_hours: 1 });

    const listing = await wrapper.callTool("list_personas");
    expect(listing).toContain("Renewal on unit 52");
    expect(listing).toContain("agent-1");

    // An hour later the data note is gone and the identity note remains.
    const later = new Date(Date.now() + 2 * 3_600_000);
    const surviving = readNotes(harness.personasDir, "katy", later).map((n) => n.text);
    expect(surviving).toEqual(["Renewal on unit 52 is mid-approval — leave it."]);
  }, 120_000);

  it("refuses to remove a persona somebody is using, and names them", async () => {
    harness = await startPersonaHarness([
      { name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] },
    ]);
    const holder = await McpClient.startWrapper({
      daemonPort: harness.daemon.port,
      personasDir: harness.personasDir,
      persona: "katy",
      owner: "agent-1",
    });
    clients.push(holder);
    await holder.callTool("new_page", { url: "data:text/html,A" });

    const refusal = await holder.callTool("remove_persona", { name: "katy" });
    expect(refusal).toContain("in use by");
    expect(refusal).toContain("agent-1");
  }, 120_000);
});
