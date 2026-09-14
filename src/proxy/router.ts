/**
 * The protocol table, in code (design §5).
 *
 * Pure decisions: given the registry and one CDP frame, say what happens to it. No I/O
 * here, so every rule below is unit-testable against a fake registry and the whole
 * isolation guarantee can be asserted without launching a browser.
 */
import type { OwnerId, OwnershipRegistry, TargetId } from "./ownership.js";

export type CdpCommand = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

export type CdpEvent = {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

export type InboundDecision =
  | { kind: "forward"; message: CdpCommand }
  | { kind: "refuse"; code: number; message: string }
  | { kind: "respond"; result: Record<string, unknown> };

export type OutboundDecision =
  | { kind: "deliver"; to: OwnerId }
  | { kind: "broadcast" }
  | { kind: "hold"; targetId: TargetId }
  | { kind: "drop" };

/** Chrome's own code for a refused command; clients already render it as an error. */
export const CDP_SERVER_ERROR = -32000;

/**
 * Commands that would take down, or reach across, every owner at once.
 * `Browser.close` is the obvious one; the crash pair is a debugging tool that is
 * indistinguishable from sabotage when the browser is shared.
 */
const BROWSER_WIDE_REFUSALS = new Set([
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess",
]);

/** Commands that name a target the caller must own. */
const TARGET_SCOPED = new Set([
  "Target.attachToTarget",
  "Target.closeTarget",
  "Target.activateTarget",
  "Target.detachFromTarget",
  "Target.exposeDevToolsProtocol",
  "Target.getTargetInfo",
]);

export function decideInbound(
  registry: OwnershipRegistry,
  ownerId: OwnerId,
  command: CdpCommand,
  now: number,
): InboundDecision {
  const { method, params = {} } = command;

  if (BROWSER_WIDE_REFUSALS.has(method)) {
    return {
      kind: "refuse",
      code: CDP_SERVER_ERROR,
      message: `${method} is refused: this Chrome is shared with other agents. Close your own tabs instead.`,
    };
  }

  // Foreground stealing. In a shared browser every agent would fight for the front
  // window, so the call is answered locally and never reaches Chrome. Screenshots and
  // input work on background tabs over CDP, so nothing downstream needs it.
  if (method === "Page.bringToFront") {
    return { kind: "respond", result: {} };
  }

  // A flattened session id is the other way to address a target. Anything carrying a
  // session this owner does not hold is a cross-owner reach.
  if (command.sessionId) {
    const sessionOwner = registry.ownerOfSession(command.sessionId);
    if (sessionOwner !== null && sessionOwner !== ownerId) {
      return {
        kind: "refuse",
        code: CDP_SERVER_ERROR,
        message: `Session ${command.sessionId} belongs to another agent.`,
      };
    }
  }

  if (method === "Target.createTarget") {
    if (registry.atCap(ownerId)) {
      const open = registry
        .targetsOf(ownerId)
        .map((t) => t.url || t.targetId)
        .join(", ");
      return {
        kind: "refuse",
        code: CDP_SERVER_ERROR,
        message:
          `Tab limit reached (${registry.options.maxTabsPerOwner}). ` +
          `Close one of your open tabs first: ${open}`,
      };
    }
    return { kind: "forward", message: command };
  }

  if (TARGET_SCOPED.has(method)) {
    const targetId = typeof params["targetId"] === "string" ? (params["targetId"] as string) : null;
    if (targetId && !registry.canAccess(ownerId, targetId)) {
      return {
        kind: "refuse",
        code: CDP_SERVER_ERROR,
        message: `No target with given id found: ${targetId}`,
      };
    }
  }

  registry.touchOwner(ownerId, now);
  return { kind: "forward", message: command };
}

/**
 * `Target.getTargets` is the agent's `list_pages`. Strip every row the caller does not own,
 * including the human's own tabs and the browser-level targets Chrome reports.
 */
export function filterTargetInfos(
  registry: OwnershipRegistry,
  ownerId: OwnerId,
  infos: unknown[],
): unknown[] {
  return infos.filter((info) => {
    if (typeof info !== "object" || info === null) return false;
    const targetId = (info as { targetId?: unknown }).targetId;
    return typeof targetId === "string" && registry.canAccess(ownerId, targetId);
  });
}

/**
 * At browser level, only a tab and its page can ever belong to an agent.
 *
 * Chrome's own furniture — the omnibox popup, extension background pages, service
 * workers, the browser target itself — is attached to as well, and a client that asked
 * for `waitForDebuggerOnStart` leaves each of those paused until somebody answers. They
 * are nobody's to own, so they are dropped on sight rather than held: holding them would
 * stall a renderer for the whole claim window for no possible benefit.
 */
const BROWSER_LEVEL_OWNABLE = new Set(["page", "tab"]);

export function isOwnableAtBrowserLevel(type: string | undefined): boolean {
  return type !== undefined && BROWSER_LEVEL_OWNABLE.has(type);
}

/** The target's type, where the event carries it. */
export function targetTypeOf(event: CdpEvent): string | undefined {
  const info = (event.params ?? {})["targetInfo"];
  if (typeof info === "object" && info !== null) {
    const type = (info as { type?: unknown }).type;
    if (typeof type === "string") return type;
  }
  return undefined;
}

/** Events that name a target in a known place. */
function targetIdOf(event: CdpEvent): TargetId | null {
  const params = event.params ?? {};
  switch (event.method) {
    case "Target.targetCreated":
    case "Target.targetInfoChanged":
    case "Target.attachedToTarget": {
      const info = params["targetInfo"];
      if (typeof info === "object" && info !== null) {
        const id = (info as { targetId?: unknown }).targetId;
        if (typeof id === "string") return id;
      }
      return null;
    }
    case "Target.targetDestroyed":
    case "Target.targetCrashed": {
      const id = params["targetId"];
      return typeof id === "string" ? id : null;
    }
    default:
      return null;
  }
}

export function decideOutbound(registry: OwnershipRegistry, event: CdpEvent): OutboundDecision {
  // A flattened event carries the session it belongs to; that is the most precise routing
  // we have, so it wins over any target lookup.
  if (event.sessionId) {
    const owner = registry.ownerOfSession(event.sessionId);
    return owner ? { kind: "deliver", to: owner } : { kind: "drop" };
  }

  const targetId = targetIdOf(event);
  if (targetId === null) {
    // Browser-scoped events with no target (Browser.*, Inspector.*) are safe for everyone.
    return { kind: "broadcast" };
  }

  if (registry.isDisowned(targetId)) return { kind: "drop" };

  const owner = registry.target(targetId)?.ownerId ?? null;
  if (owner) return { kind: "deliver", to: owner };

  const type = targetTypeOf(event) ?? registry.target(targetId)?.type;
  if (type !== undefined && !isOwnableAtBrowserLevel(type)) return { kind: "drop" };

  // Nobody owns it yet. Chrome announces a target BEFORE the creating client's response
  // arrives, so this is the normal path for a tab an agent just asked for — hold the
  // event until the `createTarget` response says whose it is.
  return { kind: "hold", targetId };
}
