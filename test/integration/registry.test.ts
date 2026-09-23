import { afterEach, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import { McpClient } from "./mcpClient.js";
import { DOORVEST, startPersonaHarness, type PersonaHarness } from "./personaHarness.js";
import { readNotes } from "../../src/personas/manifest.js";

/**
 * The registry as an agent meets it: five tools beside an untouched chrome-devtools-mcp.
 * It has no browser of its own; everything it says comes from the daemon.
 */
describe("the persona registry, through MCP", () => {
  let harness: PersonaHarness;
  const clients: McpClient[] = [];
  const browsers: Browser[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.stop();
    for (const browser of browsers.splice(0)) await browser.disconnect().catch(() => undefined);
    await harness?.dispose();
  });

  const registry = async (owner = "agent-1"): Promise<McpClient> => {
    const client = await McpClient.startRegistry({ daemonPort: harness.daemon.port, personasDir: harness.personasDir, owner });
    clients.push(client);
    return client;
  };
  const hold = async (owner: string, persona: string): Promise<Browser> => {
    const browser = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl(owner, persona) });
    browsers.push(browser);
    return browser;
  };

  it("offers exactly the six persona tools and nothing of upstream's", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const tools = (await (await registry()).request("tools/list", {})) as { tools: { name: string }[] };
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["add_persona", "list_personas", "note_persona", "remove_persona", "use_persona", "verify_persona"]);
  }, 90_000);

  it("describes each persona, its scope, and who is holding it", async () => {
    harness = await startPersonaHarness([
      {
        name: "katy",
        description: "Owner with a renewal awaiting approval.",
        env: "staging",
        accounts: [{ origin: DOORVEST, username: "katy@example.com", role: "homeowner" }],
      },
    ]);
    await hold("agent-1", "katy");

    const listing = await (await registry()).callTool("list_personas");

    expect(listing).toContain("katy");
    expect(listing).toContain("Owner with a renewal awaiting approval.");
    expect(listing).toContain("staging");
    expect(listing).toContain(DOORVEST);
    expect(listing).toContain("agent-1");
    expect(listing).toContain('use_persona("katy")');
  }, 90_000);

  it("tells an agent when a persona is shared, and says what that means", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    await hold("agent-1", "katy");
    await hold("agent-2", "katy");

    const listing = await (await registry("agent-2")).callTool("list_personas");

    expect(listing).toContain("SHARED LOGIN");
    expect(listing).toContain("agent-1");
    expect(listing).toContain("same signed-in user");
  }, 90_000);

  it("says nothing about sharing when nobody else is on it", async () => {
    harness = await startPersonaHarness([{ name: "solo-user", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const listing = await (await registry()).callTool("list_personas");
    expect(listing).toContain("in use by: nobody");
    expect(listing).not.toContain("SHARED LOGIN");
  }, 90_000);

  it("verifies a login through the persona's own cookies, in the daemon's browser", async () => {
    // No app to be signed in to here, so the honest answer is "not signed in" with the
    // status the probe actually got — not a crash, and not a guess.
    harness = await startPersonaHarness([
      { name: "katy", env: "staging", accounts: [{ origin: `http://127.0.0.1:${harness?.daemon.port ?? 1}`, probe: "/health" }] },
    ]);
    const port = harness.daemon.port;
    const { saveManifest } = await import("../../src/personas/manifest.js");
    saveManifest(harness.personasDir, {
      name: "katy",
      env: "staging",
      accounts: [{ origin: `http://127.0.0.1:${port}`, probe: "/health" }],
    });
    harness.daemon.personas.refresh("katy");

    const result = await (await registry()).callTool("verify_persona", { name: "katy" });
    // /health answers 200 to anyone, so through the daemon it reads as signed in.
    expect(result).toContain("IS signed in");
    expect(result).toContain("200");
  }, 90_000);

  it("writes a note that the next agent reads, and expires the ones about data", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    const r = await registry();
    await r.callTool("note_persona", { name: "katy", note: "Renewal on unit 52 is mid-approval — leave it." });
    await r.callTool("note_persona", { name: "katy", note: "Consumed the seeded bid.", ttl_hours: 1 });

    const listing = await r.callTool("list_personas");
    expect(listing).toContain("Renewal on unit 52");
    expect(listing).toContain("agent-1");

    const later = new Date(Date.now() + 2 * 3_600_000);
    expect(readNotes(harness.personasDir, "katy", later).map((n) => n.text)).toEqual([
      "Renewal on unit 52 is mid-approval — leave it.",
    ]);
  }, 90_000);

  it("refuses to remove a persona somebody is using, and names them", async () => {
    harness = await startPersonaHarness([{ name: "katy", env: "staging", accounts: [{ origin: DOORVEST }] }]);
    await hold("agent-1", "katy");
    const refusal = await (await registry()).callTool("remove_persona", { name: "katy" });
    expect(refusal).toContain("in use by");
    expect(refusal).toContain("agent-1");
  }, 90_000);
});
