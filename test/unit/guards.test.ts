import { describe, expect, it } from "vitest";
import { checkConsoleRequest, hostIsLoopback, originIsOurs, tokenMatches } from "../../src/dashboard/guards.js";

const TOKEN = "a".repeat(48);
const PORT = 9223;
const ok = {
  method: "GET",
  host: "127.0.0.1:9223",
  origin: undefined,
  contentType: undefined,
  token: TOKEN,
  hasBody: false,
};

describe("token", () => {
  it("accepts the right token and rejects everything else", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN, null)).toBe(false);
    expect(tokenMatches(TOKEN, "")).toBe(false);
    expect(tokenMatches(TOKEN, `${"a".repeat(47)}b`)).toBe(false);
    expect(tokenMatches(TOKEN, "a".repeat(47))).toBe(false);
  });
});

describe("host", () => {
  it("accepts loopback and refuses a rebound hostname", () => {
    for (const host of ["127.0.0.1:9223", "localhost:9223", "127.0.0.1", "LOCALHOST:9223"]) {
      expect(hostIsLoopback(host), host).toBe(true);
    }
    for (const host of ["evil.example:9223", "192.168.1.5:9223", undefined]) {
      expect(hostIsLoopback(host), String(host)).toBe(false);
    }
  });
});

describe("origin", () => {
  it("accepts our own origin and no origin, refuses anyone else's", () => {
    expect(originIsOurs(undefined, PORT)).toBe(true);
    expect(originIsOurs("http://127.0.0.1:9223", PORT)).toBe(true);
    expect(originIsOurs("http://localhost:9223", PORT)).toBe(true);
    expect(originIsOurs("https://evil.example", PORT)).toBe(false);
    // A different port on loopback is a different origin, and another local app.
    expect(originIsOurs("http://127.0.0.1:3005", PORT)).toBe(false);
  });
});

describe("the whole gate", () => {
  it("lets a tokened read through", () => {
    expect(checkConsoleRequest(TOKEN, PORT, ok).ok).toBe(true);
  });

  it("refuses a read with no token", () => {
    const v = checkConsoleRequest(TOKEN, PORT, { ...ok, token: null });
    expect(v).toMatchObject({ ok: false, status: 401 });
  });

  it("refuses any request whose Host is not loopback, token or not", () => {
    const v = checkConsoleRequest(TOKEN, PORT, { ...ok, host: "evil.example:9223" });
    expect(v).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a write from another origin even with the token", () => {
    const v = checkConsoleRequest(TOKEN, PORT, {
      ...ok,
      method: "POST",
      origin: "https://evil.example",
      contentType: "application/json",
    });
    expect(v).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses a form-encoded write, which is the shape that needs no preflight", () => {
    const v = checkConsoleRequest(TOKEN, PORT, {
      ...ok,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      hasBody: true,
    });
    expect(v).toMatchObject({ ok: false, status: 415 });
  });

  it("allows a bodyless write, because a DELETE cannot carry a content type", () => {
    const v = checkConsoleRequest(TOKEN, PORT, { ...ok, method: "DELETE", origin: "http://127.0.0.1:9223" });
    expect(v.ok).toBe(true);
  });

  it("accepts a JSON write from the console itself", () => {
    const v = checkConsoleRequest(TOKEN, PORT, {
      ...ok,
      method: "POST",
      origin: "http://127.0.0.1:9223",
      contentType: "application/json; charset=utf-8",
      hasBody: true,
    });
    expect(v.ok).toBe(true);
  });
});
