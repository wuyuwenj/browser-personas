import { afterEach, beforeEach, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import { startHarness, type Harness } from "./helpers.js";

/**
 * The claim this project makes, against a real Chrome: two agents, one browser, one
 * profile, and neither can see or touch the other's tab. Every assertion runs in both
 * directions — a filter that only works one way is a filter that does not work.
 */
describe("two agents on one Chrome", () => {
  let harness: Harness;
  let a: Browser;
  let b: Browser;

  beforeEach(async () => {
    harness = await startHarness();
    a = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent-a") });
    b = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent-b") });
  });

  afterEach(async () => {
    await a?.disconnect();
    await b?.disconnect();
    await harness?.dispose();
  });

  it("shares one Chrome process between both agents", () => {
    // One daemon, one launched browser: the memory win this whole design exists for.
    expect(harness.daemon.registry.owners().map((o) => o.id).sort()).toEqual(["agent-a", "agent-b"]);
  });

  it("shows each agent only its own tab", async () => {
    const pageA = await a.newPage();
    await pageA.goto("data:text/html,<title>A</title>hello-a");
    const pageB = await b.newPage();
    await pageB.goto("data:text/html,<title>B</title>hello-b");

    const titlesA = await Promise.all((await a.pages()).map((p) => p.title()));
    const titlesB = await Promise.all((await b.pages()).map((p) => p.title()));

    expect(titlesA).toContain("A");
    expect(titlesA).not.toContain("B");
    expect(titlesB).toContain("B");
    expect(titlesB).not.toContain("A");
  });

  it("refuses each agent access to the other's target id", async () => {
    const pageA = await a.newPage();
    await pageA.goto("data:text/html,A");
    const pageB = await b.newPage();
    await pageB.goto("data:text/html,B");

    const idA = harness.daemon.registry.targetsOf("agent-a")[0]!.targetId;
    const idB = harness.daemon.registry.targetsOf("agent-b")[0]!.targetId;

    const sessionA = await pageA.createCDPSession();
    const sessionB = await pageB.createCDPSession();

    await expect(sessionA.send("Target.closeTarget", { targetId: idB })).rejects.toThrow(/No target/);
    await expect(sessionB.send("Target.closeTarget", { targetId: idA })).rejects.toThrow(/No target/);

    // And neither tab actually died.
    expect(await pageA.title()).toBeDefined();
    expect(await pageB.title()).toBeDefined();
  });

  it("lets each agent close its own tab", async () => {
    const pageA = await a.newPage();
    await pageA.goto("data:text/html,A");
    await pageA.close();

    expect(harness.daemon.registry.pageCount("agent-a")).toBe(0);
  });

  it("keeps a tab opened by one agent invisible to an agent that connects later", async () => {
    const pageA = await a.newPage();
    await pageA.goto("data:text/html,<title>Early</title>");

    const c = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent-c") });
    try {
      const titles = await Promise.all((await c.pages()).map((p) => p.title()));
      expect(titles).not.toContain("Early");
    } finally {
      await c.disconnect();
    }
  });

  it("refuses Browser.close so one agent cannot end the other's session", async () => {
    const pageA = await a.newPage();
    const session = await pageA.createCDPSession();

    await expect(session.send("Browser.close")).rejects.toThrow(/shared with other agents/);

    const pageB = await b.newPage();
    await pageB.goto("data:text/html,<title>Still here</title>");
    expect(await pageB.title()).toBe("Still here");
  });
});

describe("the --browserUrl form", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  });
  afterEach(async () => {
    await harness?.dispose();
  });

  it("still isolates two clients that never name an owner", async () => {
    // Puppeteer discards any path or query on browserURL when it fetches /json/version,
    // so these two get generated connection ids. Isolation must not depend on the name.
    const one = await puppeteer.connect({ browserURL: harness.url() });
    const two = await puppeteer.connect({ browserURL: harness.url() });
    try {
      await (await one.newPage()).goto("data:text/html,<title>One</title>");
      await (await two.newPage()).goto("data:text/html,<title>Two</title>");

      const titlesOne = await Promise.all((await one.pages()).map((p) => p.title()));
      const titlesTwo = await Promise.all((await two.pages()).map((p) => p.title()));

      expect(titlesOne).toContain("One");
      expect(titlesOne).not.toContain("Two");
      expect(titlesTwo).toContain("Two");
      expect(titlesTwo).not.toContain("One");
    } finally {
      await one.disconnect();
      await two.disconnect();
    }
  });
});

describe("tab cap", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness({ maxTabsPerOwner: 2 });
  });
  afterEach(async () => {
    await harness?.dispose();
  });

  it("refuses the tab past the cap and names what is already open", async () => {
    const browser = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("capped") });
    try {
      await (await browser.newPage()).goto("data:text/html,one");
      await (await browser.newPage()).goto("data:text/html,two");

      await expect(browser.newPage()).rejects.toThrow(/Tab limit reached \(2\)/);
      expect(harness.daemon.registry.pageCount("capped")).toBe(2);
    } finally {
      await browser.disconnect();
    }
  });
});
