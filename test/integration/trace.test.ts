import { describe, expect, it } from "vitest";
import puppeteer from "puppeteer-core";
import { startHarness } from "./helpers.js";

describe.skipIf(!process.env["BP_TRACE"])("trace", () => {
  it("opens a CDP session on its own page", async () => {
    const harness = await startHarness();
    const browser = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("A") });
    try {
      const page = await browser.newPage();
      await page.goto("data:text/html,<title>Hi</title>");
      console.error("=== about to createCDPSession ===");
      const session = await page.createCDPSession();
      console.error("=== session created ===");
      expect(session).toBeDefined();
    } finally {
      await browser.disconnect();
      await harness.dispose();
    }
  }, 25000);
});
