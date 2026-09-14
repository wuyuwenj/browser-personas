import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readJar, seal, unseal, writeJar } from "../../src/personas/vault.js";

const KEY = randomBytes(32);
const dir = (): string => mkdtempSync(join(tmpdir(), "bp-vault-"));

describe("sealing", () => {
  it("round-trips and refuses tampered ciphertext", () => {
    const sealed = seal(KEY, "a secret");
    expect(sealed).not.toContain("a secret");
    expect(unseal(KEY, sealed)).toBe("a secret");

    const [iv, tag, body] = sealed.split(":");
    const flipped = Buffer.from(body!, "base64");
    flipped[0] = flipped[0]! ^ 0xff;
    expect(() => unseal(KEY, [iv, tag, flipped.toString("base64")].join(":"))).toThrow();
  });

  it("refuses a jar sealed with a different key rather than returning garbage", () => {
    expect(() => unseal(randomBytes(32), seal(KEY, "x"))).toThrow();
  });
});

describe("the jar", () => {
  it("round-trips cookies and per-origin storage", () => {
    const path = join(dir(), "cookies.enc");
    writeJar(path, KEY, {
      version: 2,
      cookies: [{ name: "session", value: "abc", domain: "localhost" }],
      storage: { "http://localhost:3005": { local: { token: "xyz" }, session: {} } },
    });

    const jar = readJar(path, KEY);
    expect(jar.cookies).toHaveLength(1);
    expect(jar.storage["http://localhost:3005"]?.local["token"]).toBe("xyz");
  });

  it("reads a version-1 jar, so upgrading does not log every persona out", () => {
    const path = join(dir(), "cookies.enc");
    // v1 was a bare cookie array with no envelope.
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(path, seal(KEY, JSON.stringify([{ name: "old", value: "1" }])));

    const jar = readJar(path, KEY);
    expect(jar.version).toBe(2);
    expect(jar.cookies).toEqual([{ name: "old", value: "1" }]);
    expect(jar.storage).toEqual({});
  });

  it("reports an unreadable jar as logged out rather than throwing", () => {
    const path = join(dir(), "cookies.enc");
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(path, "not a jar at all");
    expect(readJar(path, KEY)).toEqual({ version: 2, cookies: [], storage: {} });
  });
});
