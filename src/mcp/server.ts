import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { UpstreamMcp } from "./upstream.js";
import {
  addPersona,
  listPersonas,
  manifestFromArgs,
  notePersona,
  removePersona,
  text,
  verifyPersona,
  type RegistryDeps,
  type ToolText,
} from "./registryTools.js";
import type { DaemonStatus } from "../proxy/status.js";

const REGISTRY_TOOLS = [
  {
    name: "list_personas",
    description:
      "List the browser identities available to you: who each one is, what it may reach, " +
      "whether another agent is already using it, and any notes agents have left. Call this " +
      "before opening a page when the task needs a particular signed-in user.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "verify_persona",
    description:
      "Check whether a persona is still signed in, by fetching its probe page through its own " +
      "cookies. Use it when a page unexpectedly shows a login screen.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Persona name" } },
      required: ["name"],
    },
  },
  {
    name: "note_persona",
    description:
      "Leave a note on a persona for whoever uses it next. Give ttl_hours for anything about " +
      "DATA state (a fixture you consumed, a record mid-flow); leave it off for facts about " +
      "who the persona is.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        note: { type: "string" },
        ttl_hours: { type: "number", description: "Expire the note after this many hours" },
      },
      required: ["name", "note"],
    },
  },
  {
    name: "add_persona",
    description:
      "Register a new persona. This creates its definition only — it has no login until " +
      "someone runs `browser-personas login NAME --url URL` in a terminal.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        origin: { type: "string", description: "The app this persona signs in to" },
        username: { type: "string" },
        probe: { type: "string", description: "Path that returns 200 only when signed in" },
        env: { type: "string" },
        exclusive: { type: "boolean" },
        read_only: { type: "string", enum: ["strict", "inspect", "cooperative"] },
      },
      required: ["name", "origin"],
    },
  },
  {
    name: "remove_persona",
    description: "Delete a persona and shred its cookie jar. Refused while an agent is using it.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
] as const;

export type WrapperOptions = {
  personasDir: string;
  persona: string;
  owner: string;
  daemonUrl: string;
  upstreamCommand: string;
  upstreamArgs: string[];
};

async function fetchStatus(daemonUrl: string): Promise<DaemonStatus | null> {
  try {
    const res = await fetch(`${daemonUrl}/status`, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return null;
    return (await res.json()) as DaemonStatus;
  } catch {
    return null;
  }
}

/**
 * The wrapper server: chrome-devtools-mcp's whole toolset, plus the persona registry, plus
 * one sentence appended the first time this agent opens a page on a persona somebody else
 * is also holding. That sentence is the only way an agent learns it is sharing a login,
 * because nothing in the CDP protocol carries a note to the model.
 */
export async function startWrapper(options: WrapperOptions): Promise<void> {
  const upstream = await UpstreamMcp.start(options.upstreamCommand, options.upstreamArgs);

  const deps: RegistryDeps = {
    personasDir: options.personasDir,
    owner: options.owner,
    status: () => fetchStatus(options.daemonUrl),
    probe: async (url) => {
      const result = (await upstream
        .request("tools/call", { name: "new_page", arguments: { url } })
        .catch(() => null)) as { content?: { text?: string }[] } | null;
      if (!result) return null;
      const body = (result.content ?? []).map((c) => c.text ?? "").join(" ");
      return /\b(4\d\d|5\d\d)\b/.test(body) ? 401 : 200;
    },
  };

  const server = new Server(
    { name: "browser-personas", version: "0.3.0" },
    { capabilities: { tools: {}, prompts: {} } },
  );

  let coTenancyAnnounced = false;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const upstreamTools = (await upstream.request("tools/list", {})) as { tools?: unknown[] };
    return { tools: [...(upstreamTools.tools ?? []), ...REGISTRY_TOOLS] };
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "personas",
        description: "Show the browser identities available to you and who is using them.",
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async () => {
    const listing = await listPersonas(deps);
    return {
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: listing.content[0]?.text ?? "" },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    switch (name) {
      case "list_personas":
        return listPersonas(deps);
      case "verify_persona":
        return verifyPersona(deps, String(args["name"] ?? ""));
      case "note_persona":
        return notePersona(
          deps,
          String(args["name"] ?? ""),
          String(args["note"] ?? ""),
          typeof args["ttl_hours"] === "number" ? args["ttl_hours"] : undefined,
        );
      case "add_persona":
        return addPersona(deps, manifestFromArgs(args));
      case "remove_persona":
        return removePersona(deps, String(args["name"] ?? ""));
      default:
        break;
    }

    const result = (await upstream.request("tools/call", request.params)) as ToolText;

    if (name === "new_page" && !coTenancyAnnounced) {
      coTenancyAnnounced = true;
      const notice = await coTenancyNotice(deps, options.persona, options.owner);
      if (notice) {
        return { ...result, content: [...(result.content ?? []), { type: "text" as const, text: notice }] };
      }
    }
    return result;
  });

  await server.connect(new StdioServerTransport());
}

/** One sentence, once, and only when somebody else really is on this persona. */
async function coTenancyNotice(
  deps: RegistryDeps,
  persona: string,
  owner: string,
): Promise<string | null> {
  const status = await deps.status();
  const record = status?.personas.find((p) => p.name === persona);
  if (!record) return null;
  const others = record.holders.filter((h) => h.owner !== owner);
  if (others.length === 0) return null;
  return (
    `Shared login: ${others.length} other agent${others.length === 1 ? "" : "s"} ` +
    `(${others.map((o) => o.owner).join(", ")}) hold "${persona}". ` +
    `Your tabs are yours, but every action is attributed to the same signed-in user, and a ` +
    `sign-out by any of you signs out all of you.`
  );
}

export { text };
