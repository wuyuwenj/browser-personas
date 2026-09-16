import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { LaunchedChrome } from "../chrome/launch.js";
import { launchChrome } from "../chrome/launch.js";
import type { PipeTransport } from "../cdp/pipeTransport.js";
import { OwnershipRegistry, type OwnerId, type OwnershipOptions } from "./ownership.js";
import { PersonaManager } from "./personaManager.js";
import { blockedBody, checkRequest, policyHeaders } from "../personas/policy.js";
import { renderConsole } from "../dashboard/render.js";
import { checkConsoleRequest, loadOrCreateToken } from "../dashboard/guards.js";
import { handleApi } from "../dashboard/api.js";
import { LoginSession, type LoginState } from "../personas/loginSession.js";
import { readSecret } from "../personas/secrets.js";
import { findAccount, loadManifest } from "../personas/manifest.js";
import { vaultKey } from "../personas/vault.js";
import type { DaemonStatus } from "./status.js";
import {
  CDP_SERVER_ERROR,
  decideInbound,
  decideOutbound,
  filterTargetInfos,
  type CdpCommand,
} from "./router.js";

export const DEFAULT_PERSONA = "default";

export type DaemonOptions = {
  port: number;
  host: string;
  userDataDir: string;
  /** Where persona directories live. Omit and the daemon runs with the default persona only. */
  personasDir?: string;
  configDir?: string;
  chromePath?: string;
  headless?: boolean;
  ownership?: Partial<OwnershipOptions>;
  /** Injected in tests so reaping can be driven without waiting on wall-clock time. */
  now?: () => number;
  sweepIntervalMs?: number;
};

type ClientConn = {
  id: string;
  ownerId: OwnerId;
  persona: string;
  ws: WebSocket;
  /** Clients that asked Chrome to pause new targets until they say go. */
  waitsForDebugger: boolean;
  /** Commands that arrived before the persona's browser context existed. */
  pending: string[];
  contextReady: boolean;
};

type Inflight = {
  ownerId: OwnerId;
  connId: string;
  clientId: number;
  method: string;
  params: Record<string, unknown>;
};

export class BrowserPersonasDaemon {
  readonly registry: OwnershipRegistry;
  readonly options: DaemonOptions;
  #http: Server;
  #wss: WebSocketServer;
  #chrome: LaunchedChrome | null = null;
  #transport: PipeTransport | null = null;
  #clients = new Map<string, ClientConn>();
  #inflight = new Map<number, Inflight>();
  /** Proxy-originated calls (discovery, unblocking) that no client should ever see. */
  #internal = new Map<number, (result: Record<string, unknown>) => void>();
  #nextUpstreamId = 1;
  /**
   * Only one `Target.createTarget` is ever in flight across all owners.
   *
   * Chrome 152 answers createTarget with the PAGE target's id, but first announces a
   * separate "tab" target that wraps it — a different id, with no field linking the two.
   * The only way to attribute that tab is the window it appeared in, and the window is
   * only unambiguous if one agent is creating at a time. Creating a tab is a few
   * milliseconds, so serialising it costs nothing and removes the guesswork entirely.
   */
  #creatingOwner: OwnerId | null = null;
  #createQueue: (() => void)[] = [];
  #createTimer: NodeJS.Timeout | null = null;
  #sweep: NodeJS.Timeout | null = null;
  #now: () => number;
  #personasDir!: string;
  #configDir!: string;
  #started = false;
  #personas: PersonaManager;
  #consoleToken: string;
  #logins = new Map<string, LoginSession>();
  #loginWatch: NodeJS.Timeout | null = null;
  /** Sessions the proxy has taken over request interception on, for a restricted persona. */
  #intercepted = new Set<string>();

  constructor(options: DaemonOptions) {
    this.options = options;
    this.#now = options.now ?? (() => Date.now());
    this.registry = new OwnershipRegistry(options.ownership);
    this.#personasDir = options.personasDir ?? join(options.userDataDir, "..", "personas");
    this.#configDir = options.configDir ?? join(options.userDataDir, "..");
    this.#personas = new PersonaManager(
      this.#personasDir,
      this.#configDir,
      { call: (method, params, sessionId) => this.#callUpstream(method, params ?? {}, sessionId) },
    );
    this.#consoleToken = loadOrCreateToken(join(this.#configDir, "run", "console.token"));
    this.#http = createServer((req, res) => void this.#onHttp(req, res));
    this.#wss = new WebSocketServer({ noServer: true });
    this.#http.on("upgrade", (req, socket, head) => {
      this.#wss.handleUpgrade(req, socket as never, head, (ws) => this.#onClient(ws, req));
    });
  }

  get personas(): PersonaManager {
    return this.#personas;
  }

  /** The console link, token and all. Printed by `start`, never logged elsewhere. */
  consoleUrl(): string {
    return `http://${this.options.host}:${this.port}/?t=${this.#consoleToken}`;
  }

  // ---- login sessions -----------------------------------------------------

  /** `origin` picks which of the persona's websites to sign in to; the first, by default. */
  async startLogin(persona: string, origin?: string): Promise<LoginState> {
    await this.#logins.get(persona)?.close().catch(() => undefined);
    const manifest = loadManifest(this.#personasDir, persona);
    const account = origin && manifest ? findAccount(manifest, origin) : manifest?.accounts?.[0];
    if (!account?.origin) {
      throw new Error(
        origin
          ? `Persona "${persona}" has no website at ${origin}.`
          : `Persona "${persona}" has no website to log in to.`,
      );
    }

    const password = readSecret(this.#personasDir, persona, vaultKey(this.#configDir));
    const session = await LoginSession.start({
      personasDir: this.#personasDir,
      configDir: this.#configDir,
      persona,
      url: account.origin,
      probe: account.probe,
      ...(password && account.username
        ? { autofill: { email: account.username, password } }
        : {}),
    });
    this.#logins.set(persona, session);
    this.#watchLogins();
    return session.state();
  }

  async loginStates(): Promise<LoginState[]> {
    return Promise.all([...this.#logins.values()].map((s) => s.state()));
  }

  /**
   * Watch every login in progress and save it as soon as it settles.
   *
   * Run by the daemon rather than by the console, so a sign-in started from the terminal
   * finishes by itself too — and so closing the console tab mid-login does not strand a
   * browser waiting for a click nobody is going to make.
   */
  #watchLogins(): void {
    if (this.#loginWatch) return;
    this.#loginWatch = setInterval(() => {
      void (async () => {
        if (this.#logins.size === 0) {
          if (this.#loginWatch) clearInterval(this.#loginWatch);
          this.#loginWatch = null;
          return;
        }
        for (const [persona, session] of [...this.#logins]) {
          await session.state().catch(() => undefined);
          if (session.settled) await this.finishLogin(persona).catch(() => undefined);
        }
      })();
    }, 1_500);
    this.#loginWatch.unref?.();
  }

  /** Let the human keep the window open and save by hand. */
  holdLogin(persona: string): boolean {
    const session = this.#logins.get(persona);
    if (!session) return false;
    session.holdOpen();
    return true;
  }

  async autofillLogin(persona: string): Promise<boolean> {
    return (await this.#logins.get(persona)?.autofill()) ?? false;
  }

  async finishLogin(persona: string): Promise<LoginState> {
    const session = this.#logins.get(persona);
    if (!session) throw new Error(`No login in progress for "${persona}".`);
    await session.finish();
    const state = await session.state();
    this.#logins.delete(persona);
    // The daemon's own context picks up the new jar without a restart.
    await this.#personas.ensure(persona).catch(() => undefined);
    await this.#personas.restore(persona).catch(() => undefined);
    return state;
  }

  async cancelLogin(persona: string): Promise<void> {
    const session = this.#logins.get(persona);
    if (!session) return;
    this.#logins.delete(persona);
    await session.close().catch(() => undefined);
  }

  get port(): number {
    const addr = this.#http.address();
    return typeof addr === "object" && addr ? addr.port : this.options.port;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#chrome = launchChrome({
      chromePath: this.options.chromePath,
      headless: this.options.headless,
      userDataDir: this.options.userDataDir,
    });
    this.#transport = this.#chrome.transport;
    this.#transport.on("message", (msg: Record<string, unknown>) => this.#onUpstream(msg));
    this.#transport.on("close", () => this.#onChromeGone());

    // The proxy keeps its own view of every target, independent of what any client asks
    // for. Without this a human's pre-existing tabs would be invisible to the registry
    // and the first agent to connect would inherit them.
    await this.#callUpstream("Target.setDiscoverTargets", { discover: true });

    // Personas are human-curated, so the set is known at start. Creating their contexts
    // up front means a connecting client never waits on one.
    for (const name of this.#personas.names()) {
      await this.#personas.ensure(name).catch(() => undefined);
    }

    await new Promise<void>((resolve) => {
      this.#http.listen(this.options.port, this.options.host, resolve);
    });

    const interval = this.options.sweepIntervalMs ?? 5_000;
    if (interval > 0) {
      this.#sweep = setInterval(() => this.sweep(), interval);
      this.#sweep.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.#sweep) clearInterval(this.#sweep);
    if (this.#loginWatch) clearInterval(this.#loginWatch);
    this.#loginWatch = null;
    for (const session of this.#logins.values()) await session.close().catch(() => undefined);
    this.#logins.clear();
    await this.#personas.persistAll().catch(() => undefined);
    for (const client of this.#clients.values()) client.ws.close(1001, "daemon stopping");
    this.#clients.clear();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
    this.#chrome?.kill();
    await this.#chrome?.exited();
    this.#started = false;
  }

  // ---- upstream -----------------------------------------------------------

  /**
   * A proxy-originated call. `sessionId` matters more than it looks: anything that has to
   * run INSIDE a page — reading or writing that page's web storage — is meaningless
   * without it, and dropping it silently sends the command to the browser instead, where
   * it succeeds and does nothing.
   */
  #callUpstream(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const id = this.#nextUpstreamId++;
      this.#internal.set(id, resolve);
      const frame: Record<string, unknown> = { id, method, params };
      if (sessionId) frame["sessionId"] = sessionId;
      this.#transport?.send(frame);
    });
  }

  #sendUpstreamOnSession(method: string, sessionId: string, params: Record<string, unknown> = {}): void {
    const id = this.#nextUpstreamId++;
    this.#internal.set(id, () => {});
    this.#transport?.send({ id, method, params, sessionId });
  }

  #onUpstream(msg: Record<string, unknown>): void {
    const now = this.#now();
    if (process.env["BP_TRACE"]) console.error("  chrome→", JSON.stringify(msg).slice(0, 220));
    this.#expireClaims(now);
    const id = typeof msg["id"] === "number" ? (msg["id"] as number) : null;

    if (id !== null) {
      const internal = this.#internal.get(id);
      if (internal) {
        this.#internal.delete(id);
        internal((msg["result"] as Record<string, unknown>) ?? {});
        return;
      }
      const pending = this.#inflight.get(id);
      if (!pending) return;
      this.#inflight.delete(id);
      this.#completeResponse(pending, msg, now);
      return;
    }

    this.#routeEvent(msg, now);
  }

  #completeResponse(pending: Inflight, msg: Record<string, unknown>, now: number): void {
    const client = this.#clients.get(pending.connId);
    const result = (msg["result"] as Record<string, unknown>) ?? null;

    if (pending.method === "Target.createTarget") {
      const targetId = result?.["targetId"];
      if (typeof targetId === "string") {
        this.registry.claim(targetId, pending.ownerId, now);
        // Chrome announced this tab before it told the creator its id. Those held frames
        // are the creator's alone; release them now, ahead of the response, which is the
        // order a client talking straight to Chrome would have seen.
        for (const held of this.registry.releaseHeld(targetId)) {
          this.#deliver(pending.ownerId, held);
        }
      }
      this.#endCreate();
    }

    if (result && pending.method === "Target.getTargets" && Array.isArray(result["targetInfos"])) {
      result["targetInfos"] = filterTargetInfos(
        this.registry,
        pending.ownerId,
        result["targetInfos"] as unknown[],
      );
    }

    if (result && pending.method === "Target.attachToTarget") {
      const sessionId = result["sessionId"];
      const targetId = pending.params["targetId"];
      if (typeof sessionId === "string" && typeof targetId === "string") {
        this.registry.bindSession(pending.ownerId, sessionId, targetId);
      }
    }

    if (!client) return;
    const out: Record<string, unknown> = { id: pending.clientId };
    if (msg["error"] !== undefined) out["error"] = msg["error"];
    else out["result"] = result ?? {};
    if (msg["sessionId"] !== undefined) out["sessionId"] = msg["sessionId"];
    this.#sendTo(client, out);
  }

  /**
   * Held frames whose claim window closed belonged to a human. Drop them — but first
   * release any renderer they left paused, or that tab is frozen for the browser's life.
   */
  #expireClaims(now: number): void {
    for (const targetId of this.registry.expireClaims(now)) {
      for (const held of this.registry.releaseHeld(targetId)) {
        const params = (held["params"] as Record<string, unknown>) ?? {};
        if (held["method"] === "Target.attachedToTarget" && params["waitingForDebugger"] === true) {
          const sessionId = params["sessionId"];
          if (typeof sessionId === "string") {
            this.#sendUpstreamOnSession("Runtime.runIfWaitingForDebugger", sessionId);
          }
        }
      }
    }
  }

  #startCreate(ownerId: OwnerId, send: () => void): void {
    const begin = (): void => {
      this.#creatingOwner = ownerId;
      if (this.#createTimer) clearTimeout(this.#createTimer);
      // A create that never answers must not wedge every other agent's tabs.
      this.#createTimer = setTimeout(() => this.#endCreate(), 10_000);
      this.#createTimer.unref?.();
      send();
    };
    if (this.#creatingOwner === null) begin();
    else this.#createQueue.push(begin);
  }

  #endCreate(): void {
    if (this.#createTimer) {
      clearTimeout(this.#createTimer);
      this.#createTimer = null;
    }
    this.#creatingOwner = null;
    const next = this.#createQueue.shift();
    if (next) next();
  }

  #personaOf(ownerId: OwnerId): string | null {
    return this.registry.owner(ownerId)?.persona ?? null;
  }

  /**
   * Take over requests on one page session.
   *
   * `Fetch` is paused at the Request stage so the method, URL and body are all visible
   * before anything leaves Chrome, and service workers are bypassed because requests they
   * issue never surface as `Fetch.requestPaused` and would otherwise walk straight past
   * the policy.
   */
  #beginInterception(sessionId: string): void {
    if (this.#intercepted.has(sessionId)) return;
    this.#intercepted.add(sessionId);
    this.#sendUpstreamOnSession("Network.setBypassServiceWorker", sessionId, { bypass: true });
    this.#sendUpstreamOnSession("Fetch.enable", sessionId, {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
  }

  #handleInterceptedRequest(sessionId: string, params: Record<string, unknown>): void {
    const requestId = params["requestId"];
    const request = (params["request"] as Record<string, unknown>) ?? {};
    if (typeof requestId !== "string") return;

    const url = String(request["url"] ?? "");
    const httpMethod = String(request["method"] ?? "GET");
    const body = typeof request["postData"] === "string" ? (request["postData"] as string) : undefined;
    const isNavigation = String(params["resourceType"] ?? "") === "Document";

    const ownerId = this.registry.ownerOfSession(sessionId);
    const persona = ownerId ? this.#personaOf(ownerId) : null;
    const manifest = persona ? this.#personas.manifest(persona) : null;

    const verdict = checkRequest(manifest, { method: httpMethod, url, body, isNavigation });
    if (verdict.allowed) {
      const extra = policyHeaders(manifest);
      const headers = Object.entries({
        ...Object.fromEntries(
          Object.entries((request["headers"] as Record<string, string>) ?? {}).map(([k, v]) => [k, String(v)]),
        ),
        ...extra,
      }).map(([name, value]) => ({ name, value }));
      this.#sendUpstreamOnSession("Fetch.continueRequest", sessionId, {
        requestId,
        ...(Object.keys(extra).length > 0 ? { headers } : {}),
      });
      return;
    }

    // Answered, not failed. A network error reads to an agent as a flaky site; a 403 whose
    // body names the policy tells it exactly why, and it stops retrying.
    const payload = blockedBody(verdict.reason ?? "refused by policy");
    this.#sendUpstreamOnSession("Fetch.fulfillRequest", sessionId, {
      requestId,
      responseCode: 403,
      responseHeaders: [
        { name: "content-type", value: "application/json" },
        { name: "x-blocked-by", value: "browser-personas" },
      ],
      body: Buffer.from(payload, "utf8").toString("base64"),
    });
  }

  #routeEvent(msg: Record<string, unknown>, now: number): void {
    const method = String(msg["method"] ?? "");
    const params = (msg["params"] as Record<string, unknown>) ?? {};

    // Keep the registry's view current before deciding anything.
    if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
      const info = params["targetInfo"] as Record<string, unknown> | undefined;
      if (info && typeof info["targetId"] === "string") {
        const targetId = info["targetId"] as string;
        const type = String(info["type"] ?? "other");
        const record = this.registry.noteTarget(
          {
            targetId,
            type,
            url: String(info["url"] ?? ""),
            browserContextId:
              typeof info["browserContextId"] === "string" ? (info["browserContextId"] as string) : undefined,
            openerId: typeof info["openerId"] === "string" ? (info["openerId"] as string) : undefined,
          },
          now,
        );
        // The tab wrapper Chrome makes for a page an agent asked for. It appears inside
        // that agent's create window and carries no link back to the page id, so the
        // window is what attributes it.
        if (
          method === "Target.targetCreated" &&
          record.ownerId === null &&
          this.#creatingOwner !== null &&
          (type === "tab" || type === "page")
        ) {
          this.registry.claim(targetId, this.#creatingOwner, now);
          for (const held of this.registry.releaseHeld(targetId)) {
            this.#deliver(this.#creatingOwner, held);
          }
        }
      }
    }

    const parentSession = typeof msg["sessionId"] === "string" ? (msg["sessionId"] as string) : undefined;

    // Sessions are wired up BEFORE the routing decision, because the decision reads them.
    // Chrome attaches to a new tab before the creating client's response claims it, so a
    // session bound only at delivery time would never be bound at all, and every later
    // frame on that session would be dropped as an orphan.
    if (method === "Target.attachedToTarget") {
      const info = params["targetInfo"] as Record<string, unknown> | undefined;
      const newSession = params["sessionId"];
      const targetId = info && typeof info["targetId"] === "string" ? (info["targetId"] as string) : null;
      if (targetId && typeof newSession === "string") {
        this.registry.noteSession(newSession, targetId);
        // A nested attach (an out-of-process iframe, a worker) arrives on the page's own
        // session. Those targets belong to whoever owns the page — without this they stay
        // unowned and the page's own frames get dropped.
        if (parentSession) {
          const parentOwner = this.registry.ownerOfSession(parentSession);
          if (parentOwner && this.registry.target(targetId)?.ownerId == null) {
            this.registry.claim(targetId, parentOwner, now);
          }
        }
      }
    }

    const decision = decideOutbound(this.registry, {
      method,
      params,
      sessionId: parentSession,
    });

    if (method === "Target.attachedToTarget") {
      const newSession = params["sessionId"];
      // A renderer paused on `waitForDebuggerOnStart` that nobody is listening for would
      // hang forever, so the proxy releases it itself when the event reaches no owner.
      if (params["waitingForDebugger"] === true && decision.kind === "drop" && typeof newSession === "string") {
        this.#sendUpstreamOnSession("Runtime.runIfWaitingForDebugger", newSession);
      }
    }

    if (method === "Target.detachedFromTarget") {
      const sessionId = params["sessionId"];
      if (typeof sessionId === "string") {
        const owner = this.registry.ownerOfSession(sessionId);
        if (owner) this.registry.unbindSession(owner, sessionId);
      }
    }

    // Request interception for a restricted persona is the proxy's own business: the
    // client never asked for Fetch, so these frames must not reach it.
    if (method === "Fetch.requestPaused" && parentSession && this.#intercepted.has(parentSession)) {
      this.#handleInterceptedRequest(parentSession, params);
      return;
    }

    switch (decision.kind) {
      case "deliver":
        this.#deliver(decision.to, msg);
        break;
      case "broadcast":
        for (const client of this.#clients.values()) this.#sendTo(client, msg);
        break;
      case "hold":
        this.registry.hold(decision.targetId, msg, now);
        break;
      case "drop":
        break;
    }

    if (method === "Target.targetDestroyed" && typeof params["targetId"] === "string") {
      this.registry.removeTarget(params["targetId"] as string);
    }
  }

  #deliver(ownerId: OwnerId, msg: Record<string, unknown>): void {
    // Arming happens here rather than at the routing decision because a page's attach
    // event often arrives while its tab is still unclaimed: it is held, then released
    // straight to the owner once the claim lands. Delivery is the one point every path
    // to an owner passes through.
    if (msg["method"] === "Target.attachedToTarget") {
      const params = (msg["params"] as Record<string, unknown>) ?? {};
      const info = (params["targetInfo"] as Record<string, unknown>) ?? {};
      const type = String(info["type"] ?? "");
      const sessionId = params["sessionId"];
      const persona = this.#personaOf(ownerId);
      if (
        typeof sessionId === "string" &&
        (type === "page" || type === "iframe") &&
        persona !== null &&
        this.#personas.needsInterception(persona)
      ) {
        this.#beginInterception(sessionId);
      }
    }
    for (const client of this.#clients.values()) {
      if (client.ownerId === ownerId) this.#sendTo(client, msg);
    }
  }

  #sendTo(client: ClientConn, msg: Record<string, unknown>): void {
    if (process.env["BP_TRACE"]) console.error(`  →${client.ownerId}`, JSON.stringify(msg).slice(0, 220));
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
  }

  // ---- downstream ---------------------------------------------------------

  #onClient(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const persona = url.searchParams.get("persona") ?? parsePathPersona(url.pathname) ?? DEFAULT_PERSONA;
    const ownerId =
      url.searchParams.get("owner") ?? parsePathOwner(url.pathname) ?? `conn-${randomUUID().slice(0, 8)}`;
    const connId = randomUUID();
    const now = this.#now();

    // An exclusive persona is handed to one agent at a time. Refusing at connect time,
    // by name, is far kinder than letting two agents share a server-side session and
    // discover it when one of them is silently logged out.
    const lease = this.#personas.claimLease(persona, ownerId);
    if (!lease.ok) {
      ws.close(
        1008,
        `persona "${persona}" is held by ${lease.heldBy}. Pick another persona or wait for it to disconnect.`,
      );
      return;
    }

    this.registry.connectOwner(ownerId, persona, now);
    const client: ClientConn = {
      id: connId,
      ownerId,
      persona,
      ws,
      waitsForDebugger: false,
      pending: [],
      contextReady: false,
    };
    this.#clients.set(connId, client);

    // Creating a persona's browser context is a round trip to Chrome. Commands that
    // arrive first are buffered rather than answered against the wrong context — a tab
    // opened in the default context would carry the wrong login, which is the exact
    // failure this project exists to prevent.
    void this.#personas
      .ensure(persona)
      .catch(() => undefined)
      .then(() => {
        client.contextReady = true;
        const queued = client.pending.splice(0);
        for (const raw of queued) this.#onClientMessage(client, raw);
      });

    ws.on("message", (data) => {
      const raw = data.toString();
      if (!client.contextReady) client.pending.push(raw);
      else this.#onClientMessage(client, raw);
    });
    ws.on("close", () => {
      this.#clients.delete(connId);
      const stillConnected = [...this.#clients.values()].some((c) => c.ownerId === ownerId);
      if (!stillConnected) {
        this.registry.disconnectOwner(ownerId, this.#now());
        this.#personas.releaseLease(persona, ownerId);
        void this.#personas.persistAll().catch(() => undefined);
      }
    });
    ws.on("error", () => {});
  }

  #onClientMessage(client: ClientConn, raw: string): void {
    const now = this.#now();
    let command: CdpCommand;
    try {
      command = JSON.parse(raw) as CdpCommand;
    } catch {
      return;
    }
    if (typeof command.id !== "number" || typeof command.method !== "string") return;

    if (command.method === "Target.setAutoAttach" && command.params?.["waitForDebuggerOnStart"] === true) {
      client.waitsForDebugger = true;
    }

    if (process.env["BP_TRACE"]) console.error(`${client.ownerId} →chrome`, JSON.stringify(command).slice(0, 220));
    if (
      command.method === "Fetch.disable" &&
      command.sessionId &&
      this.#intercepted.has(command.sessionId)
    ) {
      // Answered as a success the client can proceed on, but never forwarded: puppeteer
      // disables Fetch on every page session during setup, and letting that through would
      // turn a persona's read-only policy off without anyone asking for it.
      this.#sendTo(client, { id: command.id, sessionId: command.sessionId, result: {} });
      return;
    }

    if (
      command.method === "Fetch.enable" &&
      command.sessionId &&
      this.#intercepted.has(command.sessionId)
    ) {
      this.#sendTo(client, {
        id: command.id,
        sessionId: command.sessionId,
        error: {
          code: CDP_SERVER_ERROR,
          message:
            `Fetch is held by browser-personas on this page: persona "${client.persona}" restricts ` +
            `where it may go. Use a persona without an origin allowlist or read_only setting.`,
        },
      });
      return;
    }

    const manifest = this.#personas.manifest(client.persona);
    const decision = decideInbound(this.registry, client.ownerId, command, now, {
      check: (url) => checkRequest(manifest, { method: "GET", url }),
    });

    // A reply to a command sent on a session MUST carry that session id back. Puppeteer
    // routes responses by session before it looks at the id, so a refusal answered at
    // browser level lands in the wrong callback map and the caller's promise never
    // settles — a refusal that reads to the agent as a hang rather than as a "no".
    const echo = (body: Record<string, unknown>): void => {
      const reply: Record<string, unknown> = { id: command.id, ...body };
      if (command.sessionId) reply["sessionId"] = command.sessionId;
      this.#sendTo(client, reply);
    };

    if (decision.kind === "refuse") {
      echo({ error: { code: decision.code, message: decision.message } });
      return;
    }
    if (decision.kind === "respond") {
      echo({ result: decision.result });
      return;
    }

    const upstreamId = this.#nextUpstreamId++;
    this.#inflight.set(upstreamId, {
      ownerId: client.ownerId,
      connId: client.id,
      clientId: command.id,
      method: command.method,
      params: decision.message.params ?? {},
    });
    const out: Record<string, unknown> = {
      id: upstreamId,
      method: decision.message.method,
      params: decision.message.params ?? {},
    };
    if (decision.message.sessionId) out["sessionId"] = decision.message.sessionId;

    if (command.method === "Target.createTarget") {
      // Every tab an agent opens lands in its persona's context, so the cookies it sees
      // are that persona's and nobody else's.
      const contextId = this.#personas.context(client.persona)?.browserContextId;
      if (contextId) {
        out["params"] = { ...(out["params"] as Record<string, unknown>), browserContextId: contextId };
      }
      this.#startCreate(client.ownerId, () => this.#transport?.send(out));
      return;
    }
    this.#transport?.send(out);
  }

  // ---- http ---------------------------------------------------------------

  async #onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const persona = parsePathPersona(url.pathname) ?? DEFAULT_PERSONA;
    const owner = parsePathOwner(url.pathname);
    const endpoint = stripPrefixes(url.pathname);

    const json = (body: unknown, status = 200): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json; charset=UTF-8" });
      res.end(payload);
    };

    if (endpoint === "/json/version" || endpoint === "/json/version/") {
      const version = await this.#callUpstream("Browser.getVersion");
      const query = new URLSearchParams({ persona });
      if (owner) query.set("owner", owner);
      json({
        Browser: version["product"] ?? "Chrome",
        "Protocol-Version": version["protocolVersion"] ?? "1.3",
        "User-Agent": version["userAgent"] ?? "",
        "V8-Version": version["jsVersion"] ?? "",
        "WebKit-Version": version["revision"] ?? "",
        webSocketDebuggerUrl: `ws://${this.options.host}:${this.port}/devtools/browser/${randomUUID()}?${query}`,
      });
      return;
    }

    if (endpoint === "/json" || endpoint === "/json/list") {
      // HTTP carries no connection identity, so it is scoped by persona, not by owner —
      // a weaker boundary than the WebSocket path, and documented as such.
      const rows = this.registry
        .targets()
        .filter((t) => t.type === "page" && t.ownerId !== null)
        .filter((t) => this.registry.owner(t.ownerId!)?.persona === persona)
        .map((t) => ({
          id: t.targetId,
          type: t.type,
          url: t.url,
          title: t.url,
          webSocketDebuggerUrl: `ws://${this.options.host}:${this.port}/devtools/page/${t.targetId}`,
        }));
      json(rows);
      return;
    }

    if (endpoint === "/health") {
      json({ ok: true, chrome: this.#chrome?.process.exitCode === null, port: this.port });
      return;
    }

    if (endpoint === "/status" || endpoint === "/" || endpoint === "/dashboard" || endpoint.startsWith("/api/")) {
      const guard = checkConsoleRequest(this.#consoleToken, this.port, {
        method: req.method ?? "GET",
        host: req.headers.host,
        origin: typeof req.headers.origin === "string" ? req.headers.origin : undefined,
        contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined,
        hasBody:
          req.headers["transfer-encoding"] !== undefined ||
          Number(req.headers["content-length"] ?? 0) > 0,
        token:
          url.searchParams.get("t") ??
          (typeof req.headers["x-console-token"] === "string" ? req.headers["x-console-token"] : null),
      });
      if (!guard.ok) {
        json({ error: guard.reason }, guard.status);
        return;
      }

      if (endpoint === "/status") {
        json(this.status());
        return;
      }

      if (endpoint.startsWith("/api/")) {
        const raw = await readBody(req);
        let parsed: Record<string, unknown> = {};
        if (raw) {
          try {
            parsed = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            json({ error: "Body must be JSON." }, 400);
            return;
          }
        }
        try {
          const result = await handleApi(this.#apiDeps(), req.method ?? "GET", endpoint, parsed);
          json(result.body, result.status);
        } catch (err) {
          json({ error: err instanceof Error ? err.message : String(err) }, 500);
        }
        return;
      }

      res.writeHead(200, { "content-type": "text/html; charset=UTF-8" });
      res.end(renderConsole(this.status(), this.options.host, this.port, this.#consoleToken));
      return;
    }

    json({ error: `unknown endpoint ${endpoint}` }, 404);
  }

  #apiDeps() {
    return {
      personasDir: this.#personasDir,
      vaultKey: () => vaultKey(this.#configDir),
      status: () => this.status(),
      loginStates: () => this.loginStates(),
      startLogin: (persona: string, origin?: string) => this.startLogin(persona, origin),
      finishLogin: (persona: string) => this.finishLogin(persona),
      cancelLogin: (persona: string) => this.cancelLogin(persona),
      autofillLogin: (persona: string) => this.autofillLogin(persona),
      holdLogin: (persona: string) => this.holdLogin(persona),
      reloadPersona: (persona: string) => {
        this.#personas.refresh(persona);
        void this.#personas.ensure(persona).catch(() => undefined);
      },
    };
  }

  /** Everything the console and the registry MCP read. One shape, one source. */
  status(): DaemonStatus {
    const personaNames = new Set<string>([
      ...this.#personas.names(),
      ...this.registry.owners().map((o) => o.persona),
    ]);
    return {
      port: this.port,
      chromeAlive: this.#chrome?.process.exitCode === null,
      personas: [...personaNames].sort().map((name) => {
        const manifest = this.#personas.manifest(name);
        return {
          name,
          description: manifest?.description,
          env: manifest?.env,
          exclusive: Boolean(manifest?.exclusive),
          readOnly: manifest?.read_only ?? false,
          origins: this.#personas.origins(name),
          authOrigins: manifest?.auth_origins ?? [],
          accounts: (manifest?.accounts ?? []).map((a) => ({
            origin: a.origin,
            username: a.username,
            role: a.role,
            probe: a.probe,
          })),
          leaseHolder: this.#personas.leaseHolder(name),
          holders: this.registry.holdersOf(name).map((o) => ({
            owner: o.id,
            tabs: this.registry.pageCount(o.id),
            since: new Date(o.connectedAt).toISOString(),
          })),
        };
      }),
      owners: this.registry.owners().map((o) => ({
        id: o.id,
        persona: o.persona,
        connected: o.connected,
        tabs: this.registry
          .targetsOf(o.id)
          .filter((t) => t.type === "page")
          .map((t) => ({ id: t.targetId, url: t.url })),
      })),
    };
  }

  // ---- housekeeping -------------------------------------------------------

  /** One pass of the claim window, grace window and idle reaping. Called on a timer. */
  sweep(): void {
    const now = this.#now();

    for (const targetId of this.registry.expireClaims(now)) {
      // Held frames for a tab nobody claimed belong to a human. Drop them, and make sure
      // a paused renderer is not left waiting on an agent that will never speak.
      this.registry.releaseHeld(targetId);
    }

    for (const { ownerId, targetIds } of this.registry.expiredGraceTargets(now)) {
      for (const targetId of targetIds) {
        void this.#callUpstream("Target.closeTarget", { targetId });
        this.registry.removeTarget(targetId);
      }
      this.registry.forgetOwner(ownerId);
    }

    for (const targetId of this.registry.idleTargets(now)) {
      void this.#callUpstream("Target.closeTarget", { targetId });
      this.registry.removeTarget(targetId);
    }

    for (const ownerId of this.registry.forgettableOwners(now)) {
      const owner = this.registry.owner(ownerId);
      if (owner?.connected && [...this.#clients.values()].some((c) => c.ownerId === ownerId)) continue;
      this.registry.forgetOwner(ownerId);
    }
  }

  #onChromeGone(): void {
    for (const client of this.#clients.values()) {
      this.#sendTo(client, {
        method: "Inspector.detached",
        params: { reason: "browser_closed" },
      });
      client.ws.close(1011, "chrome exited");
    }
    this.#clients.clear();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      // A console request has no business being large; refuse to buffer more than 64 KB.
      if (body.length < 65_536) body += chunk.toString("utf8");
    });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(""));
  });
}

// ---- path parsing ---------------------------------------------------------

/** `/p/<persona>/...` picks the persona; anything else uses the shared default. */
export function parsePathPersona(pathname: string): string | null {
  const match = /^\/p\/([^/]+)/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** `/o/<owner>/...` pins a stable owner id so a reconnect reclaims its tabs. */
export function parsePathOwner(pathname: string): string | null {
  const match = /(?:^|\/)o\/([^/]+)/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function stripPrefixes(pathname: string): string {
  return pathname.replace(/^\/p\/[^/]+/, "").replace(/^\/o\/[^/]+/, "") || "/";
}

export function createDaemon(options: DaemonOptions): BrowserPersonasDaemon {
  return new BrowserPersonasDaemon(options);
}

export { CDP_SERVER_ERROR };
export type { DaemonStatus } from "./status.js";
