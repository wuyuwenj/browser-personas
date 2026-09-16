import { LoginSession } from "../personas/loginSession.js";
import { loadManifest, saveManifest, type PersonaManifest } from "../personas/manifest.js";

/**
 * Log a persona in from the terminal.
 *
 * Shares one implementation with the console, so both detect completion the same way:
 * by asking the application, not by asking the human. The old flow waited on a keypress,
 * which is a claim the tool cannot check and which strands the browser if the person
 * walks away.
 */
export type LoginOptions = {
  personasDir: string;
  configDir: string;
  name: string;
  url: string;
  probe?: string;
  env?: string;
  username?: string;
  description?: string;
  /** How long to wait for the sign-in before giving up. */
  timeoutMs?: number;
  onProgress?: (line: string) => void;
};

export async function loginPersona(
  options: LoginOptions,
): Promise<{ cookies: number; identity: string | null }> {
  const existing = loadManifest(options.personasDir, options.name);
  const probe = options.probe ?? existing?.accounts?.[0]?.probe;

  // Write the manifest first so the persona exists even if the sign-in is abandoned.
  const manifest: PersonaManifest = {
    name: options.name,
    description: options.description ?? existing?.description,
    env: options.env ?? existing?.env,
    exclusive: existing?.exclusive,
    read_only: existing?.read_only,
    auth_origins: existing?.auth_origins,
    accounts: existing?.accounts?.length
      ? existing.accounts
      : [{ origin: new URL(options.url).origin, ...(options.username ? { username: options.username } : {}), ...(probe ? { probe } : {}) }],
    seeded_by: existing?.seeded_by ?? process.env["USER"],
    seeded_at: existing?.seeded_at ?? new Date().toISOString().slice(0, 10),
  };
  saveManifest(options.personasDir, manifest);

  const session = await LoginSession.start({
    personasDir: options.personasDir,
    configDir: options.configDir,
    persona: options.name,
    url: options.url,
    ...(probe ? { probe } : {}),
  });

  const say = options.onProgress ?? ((line: string) => process.stderr.write(`${line}\n`));
  say(`A browser window opened at ${options.url}. Sign in however that site wants.`);
  if (!probe) {
    say("No signed-in path is set yet, so this watches for the app to move you off the page it opened.");
  }

  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  let announced = false;
  try {
    while (Date.now() < deadline) {
      const state = await session.state();
      if (state.identity && !announced) {
        announced = true;
        say(`Signing in as ${state.identity}…`);
      }
      if (session.settled) {
        const cookies = await session.finish();
        return { cookies, identity: state.identity };
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    throw new Error("Timed out waiting for the sign-in to finish.");
  } finally {
    await session.close().catch(() => undefined);
  }
}
