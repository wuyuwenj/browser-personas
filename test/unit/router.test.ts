import { describe, expect, it } from "vitest";
import { OwnershipRegistry } from "../../src/proxy/ownership.js";
import { decideInbound, decideOutbound, filterTargetInfos } from "../../src/proxy/router.js";

const T0 = 1_000_000;

function twoOwnersOneTabEach() {
  const registry = new OwnershipRegistry({ maxTabsPerOwner: 3 });
  registry.connectOwner("A", "default", T0);
  registry.connectOwner("B", "default", T0);
  registry.noteTarget({ targetId: "tA", type: "page", url: "http://a" }, T0);
  registry.noteTarget({ targetId: "tB", type: "page", url: "http://b" }, T0);
  registry.claim("tA", "A", T0);
  registry.claim("tB", "B", T0);
  return registry;
}

describe("cross-owner commands", () => {
  it("refuses close, attach and activate on another agent's tab, in both directions", () => {
    const registry = twoOwnersOneTabEach();
    for (const method of ["Target.closeTarget", "Target.attachToTarget", "Target.activateTarget"]) {
      const aOnB = decideInbound(registry, "A", { id: 1, method, params: { targetId: "tB" } }, T0);
      const bOnA = decideInbound(registry, "B", { id: 1, method, params: { targetId: "tA" } }, T0);
      expect(aOnB.kind, `${method} A→B`).toBe("refuse");
      expect(bOnA.kind, `${method} B→A`).toBe("refuse");
    }
  });

  it("allows each agent the same commands on its own tab", () => {
    const registry = twoOwnersOneTabEach();
    expect(decideInbound(registry, "A", { id: 1, method: "Target.closeTarget", params: { targetId: "tA" } }, T0).kind)
      .toBe("forward");
    expect(decideInbound(registry, "B", { id: 1, method: "Target.closeTarget", params: { targetId: "tB" } }, T0).kind)
      .toBe("forward");
  });

  it("refuses a command carrying another agent's session id", () => {
    const registry = twoOwnersOneTabEach();
    registry.bindSession("B", "sB", "tB");

    const decision = decideInbound(registry, "A", { id: 1, method: "Page.navigate", sessionId: "sB" }, T0);

    expect(decision.kind).toBe("refuse");
  });

  it("lets an agent use its own session id", () => {
    const registry = twoOwnersOneTabEach();
    registry.bindSession("A", "sA", "tA");

    expect(decideInbound(registry, "A", { id: 1, method: "Page.navigate", sessionId: "sA" }, T0).kind)
      .toBe("forward");
  });

  it("hides an unclaimed target from everyone rather than sharing it", () => {
    const registry = twoOwnersOneTabEach();
    registry.noteTarget({ targetId: "human", type: "page", url: "http://human" }, T0);

    expect(decideInbound(registry, "A", { id: 1, method: "Target.closeTarget", params: { targetId: "human" } }, T0).kind)
      .toBe("refuse");
    expect(decideInbound(registry, "B", { id: 1, method: "Target.closeTarget", params: { targetId: "human" } }, T0).kind)
      .toBe("refuse");
  });
});

describe("browser-wide and foreground commands", () => {
  it("refuses the commands that would end every agent's session at once", () => {
    const registry = twoOwnersOneTabEach();
    for (const method of ["Browser.close", "Browser.crash", "Browser.crashGpuProcess"]) {
      expect(decideInbound(registry, "A", { id: 1, method }, T0).kind, method).toBe("refuse");
    }
  });

  it("answers bringToFront locally instead of letting agents fight over the front window", () => {
    const registry = twoOwnersOneTabEach();
    const decision = decideInbound(registry, "A", { id: 1, method: "Page.bringToFront" }, T0);

    expect(decision.kind).toBe("respond");
    expect(decision.kind === "respond" && decision.result).toEqual({});
  });
});

describe("tab cap", () => {
  it("refuses the fourth tab and names the three already open", () => {
    const registry = new OwnershipRegistry({ maxTabsPerOwner: 3 });
    registry.connectOwner("A", "default", T0);
    for (const [id, url] of [["t1", "http://one"], ["t2", "http://two"], ["t3", "http://three"]]) {
      registry.noteTarget({ targetId: id!, type: "page", url: url! }, T0);
      registry.claim(id!, "A", T0);
    }

    const decision = decideInbound(registry, "A", { id: 1, method: "Target.createTarget", params: {} }, T0);

    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") throw new Error("unreachable");
    expect(decision.message).toContain("http://one");
    expect(decision.message).toContain("http://three");
  });

  it("allows a create while under the cap", () => {
    const registry = new OwnershipRegistry({ maxTabsPerOwner: 3 });
    registry.connectOwner("A", "default", T0);
    registry.claim("t1", "A", T0);

    expect(decideInbound(registry, "A", { id: 1, method: "Target.createTarget", params: {} }, T0).kind)
      .toBe("forward");
  });
});

describe("list_pages filtering", () => {
  it("shows each agent only its own tab", () => {
    const registry = twoOwnersOneTabEach();
    const infos = [
      { targetId: "tA", type: "page", url: "http://a" },
      { targetId: "tB", type: "page", url: "http://b" },
      { targetId: "human", type: "page", url: "http://human" },
    ];

    expect(filterTargetInfos(registry, "A", infos)).toEqual([infos[0]]);
    expect(filterTargetInfos(registry, "B", infos)).toEqual([infos[1]]);
  });

  it("drops malformed rows rather than passing them through", () => {
    const registry = twoOwnersOneTabEach();
    expect(filterTargetInfos(registry, "A", [null, "nope", { type: "page" }])).toEqual([]);
  });
});

describe("event routing", () => {
  it("sends a target's events only to its owner", () => {
    const registry = twoOwnersOneTabEach();
    const event = { method: "Target.targetInfoChanged", params: { targetInfo: { targetId: "tB" } } };

    expect(decideOutbound(registry, event)).toEqual({ kind: "deliver", to: "B" });
  });

  it("holds an event for a target nobody has claimed yet", () => {
    const registry = twoOwnersOneTabEach();
    registry.noteTarget({ targetId: "fresh", type: "page", url: "" }, T0);
    const event = { method: "Target.targetCreated", params: { targetInfo: { targetId: "fresh" } } };

    expect(decideOutbound(registry, event)).toEqual({ kind: "hold", targetId: "fresh" });
  });

  it("drops events for a target the claim window already disowned", () => {
    const registry = twoOwnersOneTabEach();
    registry.noteTarget({ targetId: "human", type: "page", url: "" }, T0);
    registry.hold("human", {}, T0);
    registry.expireClaims(T0 + 5_000);

    const event = { method: "Target.targetCreated", params: { targetInfo: { targetId: "human" } } };

    expect(decideOutbound(registry, event)).toEqual({ kind: "drop" });
  });

  it("routes a flattened event by its session, not by its target", () => {
    const registry = twoOwnersOneTabEach();
    registry.bindSession("B", "sB", "tB");

    expect(decideOutbound(registry, { method: "Page.loadEventFired", sessionId: "sB" }))
      .toEqual({ kind: "deliver", to: "B" });
  });

  it("drops a frame on a session no owner holds", () => {
    const registry = twoOwnersOneTabEach();

    expect(decideOutbound(registry, { method: "Page.loadEventFired", sessionId: "ghost" }))
      .toEqual({ kind: "drop" });
  });

  it("broadcasts browser-scoped events that name no target", () => {
    const registry = twoOwnersOneTabEach();

    expect(decideOutbound(registry, { method: "Inspector.targetCrashed" })).toEqual({ kind: "broadcast" });
  });
});
