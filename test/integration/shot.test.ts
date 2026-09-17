import { describe, it } from "vitest";
import puppeteer from "puppeteer-core";
import { startPersonaHarness } from "./personaHarness.js";

/** One look at the rendered console, with realistic state, for a visual check. Never in CI. */
describe.skipIf(!process.env["BP_SHOT"])("console screenshot", () => {
  it("renders with two personas and a connected agent", async () => {
    const harness = await startPersonaHarness([
      {
        name: "katy",
        description: "Owner with an active renewal awaiting approval. Owner-facing flows only.",
        env: "staging",
        read_only: "cooperative",
        auth_origins: ["https://accounts.google.com"],
        accounts: [
          { origin: "http://localhost:3005", username: "justin+katy@doorvest.com", role: "homeowner", probe: "/my-homes" },
          { origin: "https://demopm6.rentvine.com", username: "katy.demo", role: "tenant", probe: "/portal" },
        ],
      },
      {
        name: "kendrick",
        description: "Buyer with bookmarks and an open bid.",
        env: "staging",
        exclusive: true,
        accounts: [{ origin: "http://localhost:3005", username: "justin+kendrick@doorvest.com", role: "buyer" }],
      },
    ]);
    const agent = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent-ttys004", "katy") });
    const viewer = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("viewer", "default") });
    try {
      const work = await agent.newPage();
      await work.goto("data:text/html,<title>Renewal 52</title>");
      const work2 = await agent.newPage();
      await work2.goto("data:text/html,<title>Messages</title>");

      const page = await viewer.newPage();
      await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 2 });
      await page.goto(harness.daemon.consoleUrl(), { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 2_500));
      await page.screenshot({ path: process.env["BP_SHOT"]!, fullPage: true });
    } finally {
      await agent.disconnect();
      await viewer.disconnect();
      await harness.dispose();
    }
  }, 120_000);
});
