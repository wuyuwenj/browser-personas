import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Single-daemon lock, ported from the shell lease this tool replaces.
 *
 * `mkdir` is the atomic claim: macOS has no usable flock, and check-then-create races.
 * The pid file is written after the directory exists, which opens a window where a
 * lock directory legitimately has no pid yet — a second starter must NOT read that as
 * stale, so a young directory is respected even while empty.
 */
const YOUNG_LOCK_MS = 15_000;

export type LockInfo = { pid: number; port: number; startedAt: number };

export class DaemonLock {
  readonly dir: string;
  #held = false;

  constructor(lockDir: string) {
    this.dir = lockDir;
  }

  read(): LockInfo | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, "info.json"), "utf8")) as LockInfo;
    } catch {
      return null;
    }
  }

  static alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** True if the lock is held by a process that no longer exists. */
  stale(): boolean {
    let age = 0;
    try {
      age = Date.now() - statSync(this.dir).mtimeMs;
    } catch {
      return false;
    }
    const info = this.read();
    if (!info) return age > YOUNG_LOCK_MS;
    return !DaemonLock.alive(info.pid);
  }

  acquire(port: number): boolean {
    mkdirSync(dirname(this.dir), { recursive: true });
    try {
      mkdirSync(this.dir);
    } catch {
      if (!this.stale()) return false;
      this.release(true);
      try {
        mkdirSync(this.dir);
      } catch {
        return false;
      }
    }
    writeFileSync(
      join(this.dir, "info.json"),
      JSON.stringify({ pid: process.pid, port, startedAt: Date.now() } satisfies LockInfo),
    );
    this.#held = true;
    return true;
  }

  release(force = false): void {
    if (!this.#held && !force) return;
    this.#held = false;
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* the lock is advisory; a failed cleanup self-heals via the pid check */
    }
  }
}
