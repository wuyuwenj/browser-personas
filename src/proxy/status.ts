import type { ReadOnlyLevel } from "../personas/manifest.js";

/** One shape for what the daemon knows, read by both the dashboard and the registry MCP. */
export type PersonaStatus = {
  name: string;
  description?: string;
  env?: string;
  exclusive: boolean;
  readOnly: ReadOnlyLevel;
  origins: string[];
  /** Identity-provider origins learned from a real login, allowed so re-auth works. */
  authOrigins: string[];
  accounts: { origin: string; username?: string; role?: string }[];
  leaseHolder: string | null;
  /** Agents connected on this persona right now. This is the co-tenancy signal. */
  holders: { owner: string; tabs: number; since: string }[];
};

export type OwnerStatus = {
  id: string;
  persona: string;
  connected: boolean;
  tabs: { id: string; url: string }[];
};

export type DaemonStatus = {
  port: number;
  chromeAlive: boolean;
  personas: PersonaStatus[];
  owners: OwnerStatus[];
};
