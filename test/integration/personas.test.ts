import { afterAll, beforeAll, describe, expect, it } from "vitest";
import puppeteer, { type Browser } from "puppeteer-core";
import {
  DOORVEST,
  PERSONAS,
  doorvestIsUp,
  machineHasHeadroom,
  startPersonaHarness,
  testPassword,
  type PersonaHarness,
} from "./personaHarness.js";

const up = (await doorvestIsUp()) && machineHasHeadroom();

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

  /**
   * Each persona is signed in on its own connection, then both are opened at once after a
   * restart. Signing both in back to back inside one session is deliberately avoided: the
   * application's own auth client does not reliably complete a second sign-in immediately
   * after the first, and that is not what this test is about. Restoring from the jar is
   * also the stronger assertion — it proves the login was persisted, not merely held in
   * memory.
   */
  it("signs each persona in on its own connection", async () => {
    for (const [persona, email] of [
      ["katy", PERSONAS.katy.email],
      ["kendrick", PERSONAS.kendrick.email],
    ] as const) {
      const browser = await puppeteer.connect({
        browserWSEndpoint: harness.wsUrl(`signin-${persona}`, persona),
      });
      try {
        await signIn(browser, email);
        expect(await whoAmI(browser)).toBe(email);
      } finally {
        await browser.disconnect();
      }
      // Disconnecting persists the jar, which is what the next test restores from.
      await new Promise((r) => setTimeout(r, 750));
    }
  }, 300_000);

  it("has both personas logged in at once, as different users, after a full restart", async () => {
    // Chrome and the daemon both go away and come back. The whole reason not to use
    // --isolated: a restart must not cost a login.
    await harness.restart();

    const a = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent-a", "katy") });
    const b = await puppeteer.connect({ browserWSEndpoint: harness.wsUrl("agent-b", "kendrick") });
    try {
      // Read both in the same breath: one browser, one profile, two signed-in users.
      const [whoA, whoB] = await Promise.all([whoAmI(a), whoAmI(b)]);
      expect(whoA).toBe(PERSONAS.katy.email);
      expect(whoB).toBe(PERSONAS.kendrick.email);
      expect(whoA).not.toBe(whoB);
    } finally {
      await a.disconnect();
      await b.disconnect();
    }
  }, 300_000);
});
