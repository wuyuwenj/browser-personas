import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import {
  DOORVEST,
  PERSONAS,
  doorvestIsUp,
  startPersonaHarness,
  testPassword,
  type PersonaHarness,
} from "./personaHarness.js";

const up = await doorvestIsUp();

/**
 * Personas against the real app.
 *
 * The claim under test is the one that made this project worth building: two agents, one
 * Chrome, two different logged-in users, and a login that survives the browser being
 * restarted. Nothing here is mocked — it is the stage database behind a local dev server.
 */
describe.skipIf(!up)("personas against a real logged-in app", () => {
  let harness: PersonaHarness;

  beforeAll(async () => {
    harness = await startPersonaHarness([
      {
        name: "katy",
        description: "Owner with a renewal awaiting approval.",
        env: "staging",
        accounts: [{ origin: DOORVEST, username: PERSONAS.katy.email, role: "homeowner", probe: "/my-homes" }],
      },
      {
        name: "kendrick",
        description: "Buyer with bookmarks and an open bid.",
        env: "staging",
        accounts: [{ origin: DOORVEST, username: PERSONAS.kendrick.email, role: "buyer", probe: "/marketplace/homes" }],
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await harness?.dispose();
  });

  async function signIn(browser: Browser, email: string): Promise<void> {
    const page = await browser.newPage();
    await page.goto(`${DOORVEST}/login`, { waitUntil: "domcontentloaded" });

    // Typed, not filled. The form's submit button stays disabled until React has seen
    // real key events on both fields — setting `value` directly leaves it disabled and
    // the click times out on a button that never became clickable.
    await page.click("#email-input");
    await page.keyboard.type(email, { delay: 8 });
    await page.click("#password-input");
    await page.keyboard.type(testPassword(), { delay: 8 });

    await page.waitForFunction(
      () => !(document.querySelector("button[type=submit]") as HTMLButtonElement | null)?.disabled,
      { timeout: 30_000 },
    );
    await page.click("button[type=submit]");

    // Polled from Node, not from inside the page. A waitForFunction racing a redirect
    // chain dies with "execution context was destroyed" at the exact moment it succeeds.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (!new URL(page.url()).pathname.startsWith("/login")) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(new URL(page.url()).pathname.startsWith("/login"), `sign-in for ${email} never left /login`).toBe(false);
    await page.close();
  }

  /** The signed-in account, read off the settings page — the app's own answer, not ours. */
  async function whoAmI(browser: Browser): Promise<string> {
    const page = await browser.newPage();
    try {
      await page.goto(`${DOORVEST}/settings`, { waitUntil: "domcontentloaded" });
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const found = await page
          .evaluate(() => /justin\+[a-z0-9]+@doorvest\.com/.exec(document.body.innerText)?.[0] ?? "")
          .catch(() => "");
        if (found) return found;
        if (new URL(page.url()).pathname.startsWith("/login")) return "";
        await new Promise((r) => setTimeout(r, 750));
      }
      return "";
    } finally {
      await page.close();
    }
  }

  it("keeps two agents logged in as two different users at the same time", async () => {
    const a = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent-a", "katy") });
    const b = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent-b", "kendrick") });
    try {
      await signIn(a, PERSONAS.katy.email);
      await signIn(b, PERSONAS.kendrick.email);

      // Each persona has its own cookie store inside the same Chrome process, so signing
      // one in must not move the other.
      expect(await whoAmI(a)).toBe(PERSONAS.katy.email);
      expect(await whoAmI(b)).toBe(PERSONAS.kendrick.email);
    } finally {
      await a.disconnect();
      await b.disconnect();
    }
  }, 240_000);

  it("still has both logins after the daemon and Chrome restart", async () => {
    // The whole reason not to use --isolated: a restart must not cost a login.
    await harness.restart();

    const a = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent-a2", "katy") });
    const b = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent-b2", "kendrick") });
    try {
      expect(await whoAmI(a)).toBe(PERSONAS.katy.email);
      expect(await whoAmI(b)).toBe(PERSONAS.kendrick.email);
    } finally {
      await a.disconnect();
      await b.disconnect();
    }
  }, 240_000);
});
