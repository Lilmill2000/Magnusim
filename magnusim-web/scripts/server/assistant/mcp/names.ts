/**
 * Tool names as MCP clients see them (phase 3 spec 3.4).
 *
 * Coding agents prefix a server's tools (`mcp__magnusim__<tool>`, 15 characters) and their
 * own providers cap a name at 64 characters, while a workspace tool's name reaches 58
 * (registry.ts TOOL_NAME_MAX). So a name longer than 46 characters is served as its first
 * 41, `_` and 4 hex of its SHA-256. Both forms match the provider rule
 * `^[A-Za-z0-9_-]{1,64}$`. Two tools of one list with the same served name: the later one
 * is dropped (and logged), never served under a name that runs the other.
 */
import { createHash } from 'node:crypto';
import type { ToolDef } from '../registry.ts';

/** The longest name a client is served. */
export const MCP_NAME_MAX = 46;
const KEEP = 41;

/** The name `name` is served under. */
export function mcpName(name: string): string {
  if (name.length <= MCP_NAME_MAX) return name;
  return `${name.slice(0, KEEP)}_${createHash('sha256').update(name).digest('hex').slice(0, 4)}`;
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
