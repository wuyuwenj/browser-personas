import { describe, expect, it } from "vitest";
import { checkOrigin, checkReadOnly, checkRequest, policyHeaders } from "../../src/personas/policy.js";
import type { PersonaManifest } from "../../src/personas/manifest.js";

const staging: PersonaManifest = {
  name: "katy",
  env: "staging",
  accounts: [{ origin: "http://localhost:3005", username: "someone" }],
};

describe("origin allowlist", () => {
  it("allows the persona's own origin and refuses production", () => {
    expect(checkOrigin(staging, "http://localhost:3005/my-homes").allowed).toBe(true);

    const refused = checkOrigin(staging, "https://doorvest.com/admin");
    expect(refused.allowed).toBe(false);
    expect(refused.allowed === false && refused.reason).toContain("https://doorvest.com");
    expect(refused.allowed === false && refused.reason).toContain("staging");
  });

  it("refuses a different port on the same host — a port is part of an origin", () => {
    expect(checkOrigin(staging, "http://localhost:3006/my-homes").allowed).toBe(false);
  });

  it("permits the scaffolding URLs every client opens", () => {
    for (const url of ["about:blank", "data:text/html,hi", "chrome://version", "devtools://devtools/x"]) {
      expect(checkOrigin(staging, url).allowed, url).toBe(true);
    }
  });

  it("leaves an unscoped persona unrestricted rather than locking it out of the web", () => {
    expect(checkOrigin({ name: "open" }, "https://anywhere.example").allowed).toBe(true);
  });
});

describe("read-only levels", () => {
  const get = { method: "GET", url: "http://localhost:3005/x" };
  const post = { method: "POST", url: "http://localhost:3005/x" };

  it("lets reads through at every level", () => {
    for (const level of [false, "strict", "inspect", "cooperative"] as const) {
      expect(checkReadOnly(level, get).allowed, String(level)).toBe(true);
    }
  });

  it("strict blocks every POST, including one that only reads", () => {
    expect(checkReadOnly("strict", post).allowed).toBe(false);
    expect(checkReadOnly("strict", { ...post, body: '{"query":"{ me { id } }"}' }).allowed).toBe(false);
  });

  it("inspect passes a GraphQL query and blocks a mutation on the same endpoint", () => {
    expect(checkReadOnly("inspect", { ...post, body: '{"query":"query Me { me { id } }"}' }).allowed).toBe(true);
    expect(checkReadOnly("inspect", { ...post, body: '{"query":"mutation Pay { pay }"}' }).allowed).toBe(false);
    expect(checkReadOnly("inspect", post).allowed).toBe(false);
  });

  it("cooperative passes POSTs, because a server action that reads is a POST too", () => {
    expect(checkReadOnly("cooperative", post).allowed).toBe(true);
    expect(policyHeaders({ name: "p", read_only: "cooperative" })).toEqual({ "X-Read-Only": "1" });
    expect(policyHeaders({ name: "p", read_only: "strict" })).toEqual({});
  });

  it("blocks DELETE and PUT at every restricted level", () => {
    for (const level of ["strict", "inspect", "cooperative"] as const) {
      for (const method of ["DELETE", "PUT", "PATCH"]) {
        const verdict = checkReadOnly(level, { method, url: "http://localhost:3005/x" });
        if (level === "cooperative") expect(verdict.allowed, `${level} ${method}`).toBe(true);
        else expect(verdict.allowed, `${level} ${method}`).toBe(false);
      }
    }
  });
});

describe("combined", () => {
  const prod: PersonaManifest = {
    name: "prod",
    env: "prod",
    read_only: "cooperative",
    accounts: [{ origin: "https://doorvest.com" }],
  };

  it("refuses a navigation on origin before it ever considers the method", () => {
    expect(checkRequest(prod, { method: "GET", url: "http://localhost:3005/", isNavigation: true }).allowed)
      .toBe(false);
  });

  it("lets a subresource off the allowlist through — the app's auth provider is one", () => {
    // A staging persona whose allowlist names only its own app still has to reach
    // Cognito, its CDN and its fonts, or the app cannot load at all.
    expect(
      checkRequest(staging, {
        method: "POST",
        url: "https://cognito-idp.us-west-2.amazonaws.com/",
        isNavigation: false,
      }).allowed,
    ).toBe(true);
  });

  it("still applies read_only to a subresource, wherever it is going", () => {
    const strict: PersonaManifest = { ...staging, read_only: "strict" };
    expect(
      checkRequest(strict, { method: "POST", url: "https://third-party.example/x", isNavigation: false }).allowed,
    ).toBe(false);
  });
});

describe("auth origins", () => {
  it("allows the identity provider the app itself redirected to", async () => {
    const { allowedOrigins, primaryOrigins } = await import("../../src/personas/manifest.js");
    const manifest: PersonaManifest = {
      name: "katy",
      env: "staging",
      accounts: [{ origin: "http://localhost:3005" }],
      auth_origins: ["https://accounts.google.com"],
    };

    // The fence has to let a Google sign-in through, or the persona can never
    // re-authenticate when its session expires mid-run.
    expect(checkOrigin(manifest, "https://accounts.google.com/o/oauth2/auth").allowed).toBe(true);
    expect(checkOrigin(manifest, "http://localhost:3005/x").allowed).toBe(true);
    // It still fences everything else, which is the point.
    expect(checkOrigin(manifest, "https://doorvest.com/admin").allowed).toBe(false);

    expect(allowedOrigins(manifest)).toEqual(["http://localhost:3005", "https://accounts.google.com"]);
    // The persona is still scoped to its own app; the provider is a means, not the scope.
    expect(primaryOrigins(manifest)).toEqual(["http://localhost:3005"]);
  });
});
