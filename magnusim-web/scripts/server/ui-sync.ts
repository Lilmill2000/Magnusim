/**
 * `ui_sync`: what a host tool changed, so the open workbench reloads it (core host tools spec
 * C2, §6.1). This module is the emitter's interface only: a host tool calls uiSync.emit() after
 * a write its route answered 2xx; the `ui` channel that carries the events to the page
 * subscribes here (registerChannelKind('ui', …), event-hub.ts).
 *
 * - Host tools emit; route handlers never do (a person's own save already updated the page
 *   that made it). The same call serves in-app turns, MCP calls and coding agents' calls.
 * - `seq` increases per server boot (per process); a listener that missed one reloads in full.
 * - An event with no project or no known kind is not sent (emit answers null).
 * - On globalThis, so a Vite re-import of this module shares one emitter (as event-hub.ts does).
 */
export type UiSyncKind = 'project' | 'geometry' | 'study' | 'materials' | 'bcs' | 'bc_defaults' | 'mesh' | 'refinements' | 'runs' | 'plugin_studies' | 'active' | 'tree';

export const UI_SYNC_KINDS: readonly UiSyncKind[] = Object.freeze([
  'project',
  'geometry',
  'study',
  'materials',
  'bcs',
  'bc_defaults',
  'mesh',
  'refinements',
  'runs',
  'plugin_studies',
  'active',
  'tree',
]);

export interface UiSync {
  /** Per server boot, increasing. */
  seq: number;
  project_id: string;
  simulation_id: string | null;
  kinds: UiSyncKind[];
  /** The ids changed, by record kind: {bc: ['bc-7']}. */
  ids: Record<string, string[]>;
  /** The new rev of each record written, by id. */
  revs: Record<string, number>;
  active?: { geometry?: string; study?: string; mesh?: string; run?: string };
  /** The records' names as the person reads them, by id ({'bc-7': 'Inlet'}): the dock's "Updated" line. */
  names?: Record<string, string>;
  /** 'app': another app on this PC (MCP) or a coding agent. */
  by: 'assistant' | 'app';
  turn: string | null;
  /** The tool and action, e.g. "setup_edit.bc.update". */
  tool: string;
}

export type UiSyncInput = Omit<UiSync, 'seq'>;

export interface UiSyncEmitter {
  /** Sends `e` to every listener with the next seq; null (and nothing sent) when it names no project or no known kind. */
  emit(e: UiSyncInput): UiSync | null;
  /** Hears every event emitted from now on; returns the unsubscribe. */
  subscribe(fn: (e: UiSync) => void): () => void;
}

const KEY = Symbol.for('magnusim.ui-sync');

interface SyncState {
  seq: number;
  listeners: Set<(e: UiSync) => void>;
}

function state(): SyncState {
  const g = globalThis as unknown as Record<symbol, SyncState | undefined>;
  let s = g[KEY];
  if (!s) {
    s = { seq: 0, listeners: new Set() };
    g[KEY] = s;
  }
  return s;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function cleanIds(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!isRecord(v)) return out;
  for (const [k, list] of Object.entries(v)) {
    if (!Array.isArray(list)) continue;
    const ids = list.filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (ids.length) Object.defineProperty(out, k, { value: ids, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function cleanNames(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(v)) return out;
  for (const [k, n] of Object.entries(v)) {
    const name = typeof n === 'string' ? n.trim().slice(0, 120) : '';
    if (name) Object.defineProperty(out, k, { value: name, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function cleanRevs(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(v)) return out;
  for (const [k, n] of Object.entries(v)) {
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0) Object.defineProperty(out, k, { value: n, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

export const uiSync: UiSyncEmitter = Object.freeze({
  emit(e: UiSyncInput): UiSync | null {
    if (!e || typeof e.project_id !== 'string' || !e.project_id) return null;
    const kinds = [...new Set((Array.isArray(e.kinds) ? e.kinds : []).filter((k) => UI_SYNC_KINDS.includes(k)))];
    if (!kinds.length) return null;
    const s = state();
    s.seq += 1;
    const out: UiSync = {
      seq: s.seq,
      project_id: e.project_id,
      simulation_id: typeof e.simulation_id === 'string' && e.simulation_id ? e.simulation_id : null,
      kinds,
      ids: cleanIds(e.ids),
      revs: cleanRevs(e.revs),
      ...(isRecord(e.active) ? { active: { ...e.active } } : {}),
      ...(Object.keys(cleanNames(e.names)).length ? { names: cleanNames(e.names) } : {}),
      by: e.by === 'app' ? 'app' : 'assistant',
      turn: typeof e.turn === 'string' && e.turn ? e.turn : null,
      tool: typeof e.tool === 'string' ? e.tool.slice(0, 120) : '',
    };
    for (const fn of [...s.listeners]) {
      try {
        fn(out);
      } catch {
        /* a listener's failure never stops the others or the tool */
      }
    }
    return out;
  },
  subscribe(fn: (e: UiSync) => void): () => void {
    const s = state();
    s.listeners.add(fn);
    return () => {
      s.listeners.delete(fn);
    };
  },
});

/**
 * Who made a change, as UiSync has it, from a tool call's context (ToolRunContext): another
 * app's call (MCP, `mcp:<connection>`) and a coding agent's turn are 'app'; the Assistant's
 * own turn is 'assistant'.
 */
export function uiSyncOrigin(rt: { turn: string | null; ctx: { assistant?: { provider: string } } }): { by: 'assistant' | 'app'; turn: string | null } {
  const turn = typeof rt.turn === 'string' && rt.turn ? rt.turn : null;
  // A coding agent's provider is `agent:<id>` (agents/known.ts agentIdOf).
  const provider = rt.ctx.assistant?.provider;
  const app = !turn || turn.startsWith('mcp:') || (typeof provider === 'string' && provider.startsWith('agent:'));
  return { by: app ? 'app' : 'assistant', turn };
}
