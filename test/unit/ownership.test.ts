import { describe, expect, it } from "vitest";
import { OwnershipRegistry } from "../../src/proxy/ownership.js";

const T0 = 1_000_000;

function withTwoOwners() {
  const registry = new OwnershipRegistry({ claimWindowMs: 2_000, graceMs: 120_000 });
  registry.connectOwner("A", "default", T0);
  registry.connectOwner("B", "default", T0);
  return registry;
}

describe("claiming", () => {
  it("leaves a target unowned until a createTarget response claims it", () => {
    const registry = withTwoOwners();
    registry.noteTarget({ targetId: "t1", type: "page", url: "about:blank" }, T0);

    expect(registry.target("t1")?.ownerId).toBeNull();
    expect(registry.canAccess("A", "t1")).toBe(false);
    expect(registry.canAccess("B", "t1")).toBe(false);

    expect(registry.claim("t1", "A", T0)).toBe(true);
    expect(registry.canAccess("A", "t1")).toBe(true);
    expect(registry.canAccess("B", "t1")).toBe(false);
  });

  it("refuses to hand an owned target to a second owner", () => {
    const registry = withTwoOwners();
    registry.noteTarget({ targetId: "t1", type: "page", url: "" }, T0);
    registry.claim("t1", "A", T0);

    expect(registry.claim("t1", "B", T0)).toBe(false);
    expect(registry.target("t1")?.ownerId).toBe("A");
  });

  it("gives a popup to whoever owns its opener, with no claim window", () => {
    const registry = withTwoOwners();
    registry.noteTarget({ targetId: "t1", type: "page", url: "" }, T0);
    registry.claim("t1", "A", T0);

    registry.noteTarget({ targetId: "popup", type: "page", url: "", openerId: "t1" }, T0);

    expect(registry.canAccess("A", "popup")).toBe(true);
    expect(registry.canAccess("B", "popup")).toBe(false);
  });

  it("disowns a target nobody claimed inside the window, and keeps it disowned", () => {
    const registry = withTwoOwners();
    registry.noteTarget({ targetId: "human", type: "page", url: "" }, T0);
    registry.hold("human", { method: "Target.targetCreated" }, T0);

    expect(registry.expireClaims(T0 + 1_999)).toEqual([]);
    expect(registry.expireClaims(T0 + 2_000)).toEqual(["human"]);
    expect(registry.isDisowned("human")).toBe(true);
    expect(registry.releaseHeld("human")).toEqual([]);
  });

  it("releases held frames exactly once", () => {
    const registry = withTwoOwners();
    registry.hold("t1", { method: "Target.targetCreated" }, T0);
    registry.hold("t1", { method: "Target.attachedToTarget" }, T0);

    expect(registry.releaseHeld("t1")).toHaveLength(2);
    expect(registry.releaseHeld("t1")).toHaveLength(0);
  });
});

describe("tab cap", () => {
  it("caps an owner at maxTabsPerOwner and frees a slot when a tab closes", () => {
    const registry = new OwnershipRegistry({ maxTabsPerOwner: 3 });
    registry.connectOwner("A", "default", T0);
    for (const id of ["t1", "t2", "t3"]) {
      expect(registry.atCap("A")).toBe(false);
      registry.claim(id, "A", T0);
    }
    expect(registry.atCap("A")).toBe(true);

    registry.removeTarget("t2");
    expect(registry.atCap("A")).toBe(false);
  });

  it("counts each owner separately", () => {
    const registry = new OwnershipRegistry({ maxTabsPerOwner: 1 });
    registry.connectOwner("A", "default", T0);
    registry.connectOwner("B", "default", T0);
    registry.claim("t1", "A", T0);

    expect(registry.atCap("A")).toBe(true);
    expect(registry.atCap("B")).toBe(false);
  });
});

describe("grace and reaping", () => {
  it("keeps a disconnected owner's tabs until grace expires", () => {
    const registry = new OwnershipRegistry({ graceMs: 120_000 });
    registry.connectOwner("A", "default", T0);
    registry.claim("t1", "A", T0);
    registry.disconnectOwner("A", T0);

    expect(registry.expiredGraceTargets(T0 + 119_999)).toEqual([]);
    expect(registry.expiredGraceTargets(T0 + 120_000)).toEqual([{ ownerId: "A", targetIds: ["t1"] }]);
  });

  it("reclaims tabs when the same owner id reconnects inside grace", () => {
    const registry = new OwnershipRegistry({ graceMs: 120_000 });
    registry.connectOwner("A", "default", T0);
    registry.claim("t1", "A", T0);
    registry.disconnectOwner("A", T0);

    registry.connectOwner("A", "default", T0 + 30_000);

    expect(registry.canAccess("A", "t1")).toBe(true);
    expect(registry.expiredGraceTargets(T0 + 200_000)).toEqual([]);
  });

  it("reaps a tab that has seen no traffic, and touching it resets the clock", () => {
    const registry = new OwnershipRegistry({ idleTabMs: 900_000 });
    registry.connectOwner("A", "default", T0);
    registry.claim("t1", "A", T0);

    expect(registry.idleTargets(T0 + 899_999)).toEqual([]);
    registry.touchTarget("t1", T0 + 800_000);
    expect(registry.idleTargets(T0 + 900_000)).toEqual([]);
    expect(registry.idleTargets(T0 + 1_700_000)).toEqual(["t1"]);
  });

  it("never reaps a tab nobody owns — that tab is a human's", () => {
    const registry = new OwnershipRegistry({ idleTabMs: 1_000 });
    registry.noteTarget({ targetId: "human", type: "page", url: "" }, T0);

    expect(registry.idleTargets(T0 + 10_000)).toEqual([]);
  });
});

describe("co-tenancy", () => {
  it("lists connected holders of a persona, newest first, and only that persona", () => {
    const registry = new OwnershipRegistry();
    registry.connectOwner("A", "katy", T0);
    registry.connectOwner("B", "katy", T0 + 5);
    registry.connectOwner("C", "kendrick", T0 + 10);
    registry.connectOwner("D", "katy", T0 + 15);
    registry.disconnectOwner("D", T0 + 20);

    expect(registry.holdersOf("katy").map((o) => o.id)).toEqual(["B", "A"]);
    expect(registry.holdersOf("kendrick").map((o) => o.id)).toEqual(["C"]);
  });
});

describe("sessions", () => {
  it("resolves a session to its owner and forgets it on unbind", () => {
    const registry = withTwoOwners();
    registry.claim("t1", "A", T0);
    registry.bindSession("A", "s1", "t1");

    expect(registry.ownerOfSession("s1")).toBe("A");
    registry.unbindSession("A", "s1");
    expect(registry.ownerOfSession("s1")).toBeNull();
  });

  it("drops an owner's sessions when it disconnects, so a stale id cannot be replayed", () => {
    const registry = withTwoOwners();
    registry.claim("t1", "A", T0);
    registry.bindSession("A", "s1", "t1");
    registry.disconnectOwner("A", T0);

    expect(registry.ownerOfSession("s1")).toBeNull();
  });
});
