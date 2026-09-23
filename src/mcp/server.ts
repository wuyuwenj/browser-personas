import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  addPersona,
  listPersonas,
  manifestFromArgs,
  notePersona,
  removePersona,
  text,
  verifyPersona,
  type RegistryDeps,
} from "./registryTools.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonStatus } from "../proxy/status.js";

const REGISTRY_TOOLS = [
  {
    name: "list_personas",
    description:
      "List the browser identities available to you: who each one is, what it may reach, " +
      "whether another agent is already using it (a shared login means your actions are " +
      "attributed to the same user), and any notes agents have left. Call this before " +
      "browsing when the task needs a particular signed-in user.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "use_persona",
    description:
      "Browse as a persona from now on. Every page you open after this call is signed in as " +
      "that identity; pages already open stay as they were. Call list_personas first to see " +
      "who is available. Use \"default\" to go back to the shared, anonymous browser.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Persona name, or \"default\"" } },
      required: ["name"],
    },
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
      "someone signs it in from the console or with `browser-personas login NAME --url URL`.",
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

export type RegistryOptions = {
  personasDir: string;
  configDir: string;
  owner: string;
  daemonUrl: string;
};

/**
 * The daemon's state endpoint is token-gated, because the console writes credentials
 * through the same surface. This server runs as the same user on the same machine, so it
 * reads the token from the config directory rather than being handed one.
 */
function consoleToken(configDir: string): string | null {
  try {
    return readFileSync(join(configDir, "run", "console.token"), "utf8").trim();
  } catch {
    return null;
  }
}

async function daemonFetch(
  options: RegistryOptions,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response | null> {
  const token = consoleToken(options.configDir);
  try {
    return await fetch(`${options.daemonUrl}${path}`, {
      method: init.method ?? "GET",
      signal: AbortSignal.timeout(20_000),
      headers: {
        ...(token ? { "x-console-token": token } : {}),
        ...(init.body !== undefined ? { "content-type": "application/json", origin: options.daemonUrl } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    return null;
  }
}

/**
 * The registry: six tools and one prompt, nothing else.
 *
 * It used to re-export chrome-devtools-mcp's whole toolset as well, so one entry could
 * carry everything. That doubled the schema every agent loads on every session and tied
 * this project to each upstream tool change, for one feature — a notice that is now
 * carried by `list_personas` instead. Browsing stays with chrome-devtools-mcp, unchanged,
 * through the shim. This server is optional and small.
 */
export async function startRegistry(options: RegistryOptions): Promise<void> {
  const deps: RegistryDeps = {
    personasDir: options.personasDir,
    owner: options.owner,
    status: async () => {
      const res = await daemonFetch(options, "/status");
      if (!res?.ok) return null;
      return (await res.json()) as DaemonStatus;
    },
    // The daemon probes from inside the persona's own browser context, which is the only
    // place the persona's cookies exist. This server has no browser of its own.
    probe: async (_url, persona) => {
      const res = await daemonFetch(options, `/api/personas/${encodeURIComponent(persona)}/verify`, {
        method: "POST",
        body: {},
      });
      if (!res?.ok) return null;
      const json = (await res.json()) as { status?: number | null };
      return typeof json.status === "number" ? json.status : null;
    },
  };

  const server = new Server(
    { name: "browser-personas", version: "0.9.0" },
    { capabilities: { tools: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...REGISTRY_TOOLS] }));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      { name: "personas", description: "Show the browser identities available to you and who is using them." },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async () => {
    const listing = await listPersonas(deps);
    return {
      messages: [{ role: "user" as const, content: { type: "text" as const, text: listing.content[0]?.text ?? "" } }],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    switch (request.params.name) {
      case "list_personas":
        return listPersonas(deps);
      case "use_persona": {
        const name = String(args["name"] ?? "");
        const res = await daemonFetch(options, `/api/owners/${encodeURIComponent(options.owner)}/persona`, {
          method: "POST",
          body: { persona: name },
        });
        if (!res) return text("The browser-personas daemon is not running. Start it with: browser-personas start", true);
        const json = (await res.json()) as {
          error?: string;
          persona?: string;
          previous?: string;
          sharedWith?: string[];
        };
        if (!res.ok) return text(json.error ?? "Could not switch persona.", true);
        const shared = json.sharedWith?.length
          ? ` Shared login: ${json.sharedWith.join(", ")} also hold "${json.persona}", so every action is ` +
            `attributed to the same signed-in user, and a sign-out by any of you signs out all of you.`
          : "";
        return text(
          `Now browsing as "${json.persona}" (was "${json.previous}"). New pages open signed in as ` +
            `this persona; pages already open are unchanged.${shared}`,
        );
      }
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
        return text(`Unknown tool: ${request.params.name}`, true);
    }
  });

  await server.connect(new StdioServerTransport());
}

export { text };
