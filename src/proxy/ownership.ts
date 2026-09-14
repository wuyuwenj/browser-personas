/**
 * Ownership engine: who owns which tab.
 *
 * Pure bookkeeping — no sockets, no CDP, no timers of its own beyond the clock it is
 * handed. Everything the proxy refuses or hides is decided here, so the rules can be
 * unit-tested without a browser.
 */

export type OwnerId = string;
export type TargetId = string;
export type SessionId = string;

export type TargetRecord = {
  targetId: TargetId;
  type: string;
  url: string;
  ownerId: OwnerId | null;
  browserContextId?: string;
  openerId?: TargetId;
  createdAt: number;
  lastActivity: number;
};

export type OwnerRecord = {
  id: OwnerId;
  persona: string;
  connected: boolean;
  connectedAt: number;
  disconnectedAt: number | null;
  lastActivity: number;
  targets: Set<TargetId>;
  sessions: Map<SessionId, TargetId>;
};

export type OwnershipOptions = {
  /** Tabs one owner may hold at once. */
  maxTabsPerOwner: number;
  /** How long a disconnected owner's tabs survive, so a reconnect reclaims them. */
  graceMs: number;
  /** Idle time after which a tab is closed. */
  idleTabMs: number;
  /** Idle time after which an owner holding no tabs is forgotten. */
  idleOwnerMs: number;
  /**
   * How long an unclaimed `targetCreated` is held before we decide a human opened it.
   * Chrome broadcasts the event BEFORE the creator's `createTarget` response arrives,
   * so at the instant the event lands nobody owns the target yet.
   */
  claimWindowMs: number;
};

export const DEFAULT_OWNERSHIP: OwnershipOptions = {
  maxTabsPerOwner: 3,
  graceMs: 120_000,
  idleTabMs: 15 * 60_000,
  idleOwnerMs: 30 * 60_000,
  claimWindowMs: 2_000,
};

export type HeldEvent = { message: Record<string, unknown>; heldAt: number };

export class OwnershipRegistry {
  readonly options: OwnershipOptions;
  #owners = new Map<OwnerId, OwnerRecord>();
  #targets = new Map<TargetId, TargetRecord>();
  /** targetId → events seen before anyone claimed the target. */
  #held = new Map<TargetId, HeldEvent[]>();
  /** targetId → true once the claim window closed with no owner (a human's tab). */
  #disowned = new Set<TargetId>();
  /**
   * sessionId → the target it drives. Session access is derived from target ownership
   * rather than stored beside it, because Chrome attaches to a new tab BEFORE the
   * creating client's response claims it — a session bound to an owner at attach time
   * would be bound to nobody, and every later frame on it would be dropped.
   */
  #sessionTarget = new Map<SessionId, TargetId>();

  constructor(options: Partial<OwnershipOptions> = {}) {
    this.options = { ...DEFAULT_OWNERSHIP, ...options };
  }

  // ---- owners -------------------------------------------------------------

  connectOwner(id: OwnerId, persona: string, now: number): OwnerRecord {
    const existing = this.#owners.get(id);
    if (existing) {
      existing.connected = true;
      existing.disconnectedAt = null;
      existing.lastActivity = now;
      existing.persona = persona;
      return existing;
    }
    const record: OwnerRecord = {
      id,
      persona,
      connected: true,
      connectedAt: now,
      disconnectedAt: null,
      lastActivity: now,
      targets: new Set(),
      sessions: new Map(),
    };
    this.#owners.set(id, record);
    return record;
  }

  disconnectOwner(id: OwnerId, now: number): void {
    const owner = this.#owners.get(id);
    if (!owner) return;
    owner.connected = false;
    owner.disconnectedAt = now;
    for (const sessionId of owner.sessions.keys()) this.#sessionTarget.delete(sessionId);
    owner.sessions.clear();
  }

  owner(id: OwnerId): OwnerRecord | undefined {
    return this.#owners.get(id);
  }

  owners(): OwnerRecord[] {
    return [...this.#owners.values()];
  }

  /** Owners currently connected on a persona, newest first. Drives the co-tenancy notice. */
  holdersOf(persona: string): OwnerRecord[] {
    return this.owners()
      .filter((o) => o.connected && o.persona === persona)
      .sort((a, b) => b.connectedAt - a.connectedAt);
  }

  touchOwner(id: OwnerId, now: number): void {
    const owner = this.#owners.get(id);
    if (owner) owner.lastActivity = now;
  }

  // ---- targets ------------------------------------------------------------

  target(targetId: TargetId): TargetRecord | undefined {
    return this.#targets.get(targetId);
  }

  targets(): TargetRecord[] {
    return [...this.#targets.values()];
  }

  targetsOf(ownerId: OwnerId): TargetRecord[] {
    const owner = this.#owners.get(ownerId);
    if (!owner) return [];
    return [...owner.targets].flatMap((t) => {
      const rec = this.#targets.get(t);
      return rec ? [rec] : [];
    });
  }

  /** True when this owner may see/act on this target. Ownership is exact, never inherited. */
  canAccess(ownerId: OwnerId, targetId: TargetId): boolean {
    return this.#targets.get(targetId)?.ownerId === ownerId;
  }

  /** Tabs, not targets: iframes, workers and service workers are owned but never counted. */
  pageCount(ownerId: OwnerId): number {
    return this.targetsOf(ownerId).filter((t) => t.type === "page").length;
  }

  atCap(ownerId: OwnerId): boolean {
    const owner = this.#owners.get(ownerId);
    if (!owner) return false;
    return this.pageCount(ownerId) >= this.options.maxTabsPerOwner;
  }

  /**
   * Record a target Chrome just told us about. Ownership is decided here for popups
   * (inherited from the opener) and deferred for everything else until a `createTarget`
   * response claims it.
   */
  noteTarget(
    info: { targetId: TargetId; type: string; url: string; browserContextId?: string; openerId?: TargetId },
    now: number,
  ): TargetRecord {
    const existing = this.#targets.get(info.targetId);
    if (existing) {
      existing.url = info.url;
      existing.type = info.type;
      existing.lastActivity = now;
      return existing;
    }
    const inheritedOwner =
      info.openerId && this.#targets.get(info.openerId)?.ownerId
        ? (this.#targets.get(info.openerId)!.ownerId as OwnerId)
        : null;
    const record: TargetRecord = {
      targetId: info.targetId,
      type: info.type,
      url: info.url,
      ownerId: inheritedOwner,
      browserContextId: info.browserContextId,
      openerId: info.openerId,
      createdAt: now,
      lastActivity: now,
    };
    this.#targets.set(info.targetId, record);
    if (inheritedOwner) this.#owners.get(inheritedOwner)?.targets.add(info.targetId);
    return record;
  }

  /** Claim an unowned target for an owner. Returns false if someone already owns it. */
  claim(targetId: TargetId, ownerId: OwnerId, now: number): boolean {
    const target = this.#targets.get(targetId);
    const owner = this.#owners.get(ownerId);
    if (!owner) return false;
    if (target && target.ownerId !== null && target.ownerId !== ownerId) return false;
    if (target) {
      target.ownerId = ownerId;
      target.lastActivity = now;
    } else {
      this.#targets.set(targetId, {
        targetId,
        type: "page",
        url: "",
        ownerId,
        createdAt: now,
        lastActivity: now,
      });
    }
    this.#disowned.delete(targetId);
    owner.targets.add(targetId);
    owner.lastActivity = now;
    return true;
  }

  removeTarget(targetId: TargetId): void {
    for (const [sessionId, boundTarget] of this.#sessionTarget) {
      if (boundTarget === targetId) this.#sessionTarget.delete(sessionId);
    }
    const target = this.#targets.get(targetId);
    if (target?.ownerId) this.#owners.get(target.ownerId)?.targets.delete(targetId);
    this.#targets.delete(targetId);
    this.#held.delete(targetId);
    this.#disowned.delete(targetId);
  }

  touchTarget(targetId: TargetId, now: number): void {
    const target = this.#targets.get(targetId);
    if (!target) return;
    target.lastActivity = now;
    if (target.ownerId) this.touchOwner(target.ownerId, now);
  }

  // ---- sessions -----------------------------------------------------------

  /** Record which target a session drives. Ownership follows the target, so this is safe
   * to call before anyone has claimed it. */
  noteSession(sessionId: SessionId, targetId: TargetId): void {
    this.#sessionTarget.set(sessionId, targetId);
  }

  bindSession(ownerId: OwnerId, sessionId: SessionId, targetId: TargetId): void {
    this.noteSession(sessionId, targetId);
    this.#owners.get(ownerId)?.sessions.set(sessionId, targetId);
  }

  unbindSession(ownerId: OwnerId, sessionId: SessionId): void {
    this.#owners.get(ownerId)?.sessions.delete(sessionId);
    this.#sessionTarget.delete(sessionId);
  }

  targetOfSession(sessionId: SessionId): TargetId | null {
    return this.#sessionTarget.get(sessionId) ?? null;
  }

  ownerOfSession(sessionId: SessionId): OwnerId | null {
    const targetId = this.#sessionTarget.get(sessionId);
    if (targetId) {
      const owner = this.#targets.get(targetId)?.ownerId;
      if (owner) return owner;
    }
    for (const owner of this.#owners.values()) {
      if (owner.sessions.has(sessionId)) return owner.id;
    }
    return null;
  }

  // ---- the claim window ---------------------------------------------------

  hold(targetId: TargetId, message: Record<string, unknown>, now: number): void {
    const queue = this.#held.get(targetId) ?? [];
    queue.push({ message, heldAt: now });
    this.#held.set(targetId, queue);
  }

  /** Take everything held for a target; the caller forwards it to the claiming owner alone. */
  releaseHeld(targetId: TargetId): Record<string, unknown>[] {
    const queue = this.#held.get(targetId);
    this.#held.delete(targetId);
    return queue ? queue.map((h) => h.message) : [];
  }

  isDisowned(targetId: TargetId): boolean {
    return this.#disowned.has(targetId);
  }

  /** Held events older than the claim window belonged to a human. Drop them, for good. */
  expireClaims(now: number): TargetId[] {
    const expired: TargetId[] = [];
    for (const [targetId, queue] of this.#held) {
      const oldest = queue[0];
      if (!oldest) continue;
      if (now - oldest.heldAt >= this.options.claimWindowMs) {
        this.#held.delete(targetId);
        this.#disowned.add(targetId);
        expired.push(targetId);
      }
    }
    return expired;
  }

  // ---- reaping ------------------------------------------------------------

  /** Tabs of owners whose grace window has closed. The caller closes them in Chrome. */
  expiredGraceTargets(now: number): { ownerId: OwnerId; targetIds: TargetId[] }[] {
    const out: { ownerId: OwnerId; targetIds: TargetId[] }[] = [];
    for (const owner of this.#owners.values()) {
      if (owner.connected || owner.disconnectedAt === null) continue;
      if (now - owner.disconnectedAt < this.options.graceMs) continue;
      if (owner.targets.size > 0) out.push({ ownerId: owner.id, targetIds: [...owner.targets] });
    }
    return out;
  }

  idleTargets(now: number): TargetId[] {
    return this.targets()
      .filter((t) => t.ownerId !== null && now - t.lastActivity >= this.options.idleTabMs)
      .map((t) => t.targetId);
  }

  /** Owners safe to forget: disconnected past grace, or connected-but-silent with no tabs. */
  forgettableOwners(now: number): OwnerId[] {
    return this.owners()
      .filter((o) => o.targets.size === 0)
      .filter((o) =>
        o.connected
          ? now - o.lastActivity >= this.options.idleOwnerMs
          : o.disconnectedAt !== null && now - o.disconnectedAt >= this.options.graceMs,
      )
      .map((o) => o.id);
  }

  forgetOwner(ownerId: OwnerId): void {
    const owner = this.#owners.get(ownerId);
    if (!owner) return;
    for (const targetId of owner.targets) {
      const target = this.#targets.get(targetId);
      if (target) target.ownerId = null;
    }
    this.#owners.delete(ownerId);
  }
}
