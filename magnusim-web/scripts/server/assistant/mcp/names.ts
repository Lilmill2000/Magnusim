/**
 * Tool names as MCP clients see them (phase 3 spec 3.4).
 *
 * A client prefixes a server's tools with the server's name (`mcp__<server>__<tool>`), and the
 * providers behind it cap a name at 64 characters. Magnusim's server is `magnusim` in its coding
 * agents' sessions (acp.ts MCP_SERVER_NAME: `mcp__magnusim__`, 15 characters) and
 * `magnusim-apps` in the config Settings gives other apps (MCP_SERVER_KEY: 20 characters), while
 * a workspace tool's name reaches 58 (registry.ts TOOL_NAME_MAX). So a served name is at most 64
 * less the longer prefix, 44 characters: a longer name is served as its first 39, `_` and 4 hex
 * of its SHA-256. Both forms match the provider rule `^[A-Za-z0-9_-]{1,64}$`, prefix included.
 * (An app whose entry the person renamed to something longer than `magnusim-apps` may get names
 * past 64; the snippet is what Magnusim can hold to.) Two tools of one list with the same served
 * name: the later one is dropped (and logged), never served under a name that runs the other.
 */
import { createHash } from 'node:crypto';
import { MCP_SERVER_NAME } from '../agents/acp.ts';
import type { ToolDef } from '../registry.ts';

/** The key the Settings snippet gives Magnusim's entry (never `magnusim`: the agents' own server is named that). */
export const MCP_SERVER_KEY = 'magnusim-apps';
/** The longest tool name a provider takes, the client's prefix included. */
export const PROVIDER_NAME_MAX = 64;
/** What a client puts before each tool of the server it calls `server`. */
export const clientPrefix = (server: string): string => `mcp__${server}__`;
/** The longest name a client is served: what the longer of the two prefixes leaves (44). */
export const MCP_NAME_MAX = PROVIDER_NAME_MAX - Math.max(clientPrefix(MCP_SERVER_NAME).length, clientPrefix(MCP_SERVER_KEY).length);
const HASH_HEX = 4;
const KEEP = MCP_NAME_MAX - 1 - HASH_HEX;

/** The name `name` is served under. */
export function mcpName(name: string): string {
  if (name.length <= MCP_NAME_MAX) return name;
  return `${name.slice(0, KEEP)}_${createHash('sha256').update(name).digest('hex').slice(0, HASH_HEX)}`;
}

/**
 * A list as served: served name -> its tool, in the list's order. A name a tool earlier in
 * the list already took drops the later tool (`dropped(name, served)` hears each).
 */
export function servedMap(defs: readonly ToolDef[], dropped?: (name: string, served: string) => void): Map<string, ToolDef> {
  const out = new Map<string, ToolDef>();
  for (const def of defs) {
    const served = mcpName(def.name);
    if (out.has(served)) {
      dropped?.(def.name, served);
      continue;
    }
    out.set(served, def);
  }
  return out;
}
