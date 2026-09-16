import { describe, expect, it } from "vitest";
import { bestIdentifier, emailFromTokens, sessionValues } from "../../src/personas/identity.js";

describe("the identifier someone typed", () => {
  it("prefers an email over a username", () => {
    expect(bestIdentifier(["katy", "katy@example.com"])).toBe("katy@example.com");
  });

  it("takes a username when that is all there was", () => {
    expect(bestIdentifier(["", "  ", "katy.perry"])).toBe("katy.perry");
  });

  it("never returns something that could be a password or a token", () => {
    // Whitespace, over-long values and anything with punctuation a name would not have.
    expect(bestIdentifier(["correct horse battery staple"])).toBeNull();
    expect(bestIdentifier(["a".repeat(200)])).toBeNull();
    expect(bestIdentifier(["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"])).toBeNull();
    // ...but a name with dots in it is still a name.
    expect(bestIdentifier(["mary.jane.watson"])).toBe("mary.jane.watson");
    expect(bestIdentifier([null, undefined, ""])).toBeNull();
  });
});

describe("the address inside an ID token", () => {
  const jwt = (payload: Record<string, unknown>): string =>
    ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");

  it("reads the email claim a provider left behind", () => {
    expect(emailFromTokens([jwt({ email: "katy@example.com", sub: "123" })])).toBe("katy@example.com");
  });

  it("falls back through the claims providers actually use", () => {
    expect(emailFromTokens([jwt({ preferred_username: "katy@corp.example" })])).toBe("katy@corp.example");
    expect(emailFromTokens([jwt({ upn: "katy@corp.example" })])).toBe("katy@corp.example");
  });

  it("finds a token embedded in a larger stored value", () => {
    const stored = JSON.stringify({ idToken: jwt({ email: "katy@example.com" }), other: 1 });
    expect(emailFromTokens([stored])).toBe("katy@example.com");
  });

  it("ignores a sub that is not an address, rather than inventing a username", () => {
    expect(emailFromTokens([jwt({ sub: "5f3c9a10-0000" })])).toBeNull();
  });

  it("ignores values that are not tokens at all", () => {
    expect(emailFromTokens(["session=abc", "", null, "a.b.c"])).toBeNull();
  });
});

describe("flattening a captured session", () => {
  it("gathers cookie values and both kinds of web storage", () => {
    const values = sessionValues(
      [{ name: "s", value: "cookie-value" }, { name: "x" }],
      { "https://app.example": { local: { a: "local-value" }, session: { b: "session-value" } } },
    );
    expect(values.sort()).toEqual(["cookie-value", "local-value", "session-value"]);
  });
});
