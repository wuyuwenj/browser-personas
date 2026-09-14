import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { PipeTransport } from "../cdp/pipeTransport.js";

const MAC_CHANNELS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const LINUX_CHANNELS = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

export function findChrome(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`Chrome not found at ${explicit}`);
    return explicit;
  }
  const candidates = process.platform === "darwin" ? MAC_CHANNELS : LINUX_CHANNELS;
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `Could not find Chrome. Looked in:\n  ${candidates.join("\n  ")}\nPass --chrome-path to point at it.`,
    );
  }
  return found;
}

export type LaunchOptions = {
  chromePath?: string;
  headless?: boolean;
  userDataDir: string;
  extraArgs?: string[];
};

export type LaunchedChrome = {
  process: ChildProcess;
  transport: PipeTransport;
  kill: () => void;
  /** Resolves once the process is really gone, so a caller may delete its profile. */
  exited: () => Promise<void>;
};

/**
 * Baseline flags. Two are load-bearing rather than cosmetic:
 * `--disable-backgrounding-occluded-windows` and `--disable-renderer-backgrounding` stop
 * Chrome throttling the tabs nobody is looking at — with many agents sharing one browser,
 * every tab but one is occluded, and a throttled renderer makes screenshots and timing
 * measurements wrong in ways that read as flaky tests rather than as a config choice.
 */
function baseArgs(opts: LaunchOptions): string[] {
  const args = [
    "--remote-debugging-pipe",
    `--user-data-dir=${opts.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--password-store=basic",
    "--use-mock-keychain",
  ];
  if (opts.headless !== false) args.push("--headless=new");
  if (opts.extraArgs) args.push(...opts.extraArgs);
  args.push("about:blank");
  return args;
}

export function launchChrome(opts: LaunchOptions): LaunchedChrome {
  const chromePath = findChrome(opts.chromePath);
  const child = spawn(chromePath, baseArgs(opts), {
    // fd 3 = Chrome reads our commands, fd 4 = Chrome writes to us.
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    detached: false,
  });

  const writeToChrome = child.stdio[3] as NodeJS.WritableStream;
  const readFromChrome = child.stdio[4] as NodeJS.ReadableStream;
  if (!writeToChrome || !readFromChrome) {
    child.kill("SIGKILL");
    throw new Error("Chrome did not expose the remote-debugging pipe on fds 3/4");
  }

  const transport = new PipeTransport(
    writeToChrome as unknown as import("node:stream").Writable,
    readFromChrome as unknown as import("node:stream").Readable,
  );

  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    transport.close();
    if (child.exitCode === null) child.kill("SIGKILL");
  };

  const exited = (): Promise<void> =>
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("exit", () => resolve()));

  return { process: child, transport, kill, exited };
}
