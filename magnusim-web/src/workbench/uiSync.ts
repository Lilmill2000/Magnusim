/**
 * The open workbench repaints what the Assistant changed (Assistant phase 5, C2 §6.4).
 *
 * The server sends a `sync` frame on the tab's `ui` channel (scripts/server/ui-sync.ts) after
 * each write of a host tool: the kinds and ids it changed, their new revs, and what it made
 * active. This follows the open project's channel (followProject, from runtime.js on every
 * project open, and '' when the project goes) and reloads what each frame names through the
 * runtime's own functions (bindUiSyncHost):
 *
 * - a frame for another project is ignored;
 * - frames are coalesced for COALESCE_MS, then reloaded once;
 * - the reload is token-bound like reloadGeometryScopedSetup: it captures the study switch's
 *   token and drops its answers when a switch happened meanwhile (the host functions check it);
 * - a frame for a study other than the one shown refreshes the tree only: its records load on
 *   the person's next switch, as they always did;
 * - `active` follows the switch as the person's own (a study or geometry switch loads the rest).
 * - A hidden tab that comes back (cfd:events-resumed) reloads its setup once: missed frames
 *   are not replayed.
 *
 * Before reloading it says `cfd:ui-sync` on the window (detail: the merged frame), for a panel
 * that keeps its own state (the Mesh panel forgets its edits of what changed). It remembers who
 * wrote which record for HEARD_MS (heardWrite): a save of the person's refused as stale names
 * the Assistant then (staleNotice.ts).
 */
import { openChannel, type ChannelHandle } from '../api/eventHub';

export type UiSyncKind =
  | 'project'
  | 'geometry'
  | 'study'
  | 'materials'
  | 'bcs'
  | 'bc_defaults'
  | 'mesh'
  | 'refinements'
  | 'runs'
  | 'plugin_studies'
  | 'active'
  | 'tree';

export interface UiSyncFrame {
  seq: number;
  project_id: string;
  simulation_id: string | null;
  kinds: UiSyncKind[];
  ids: Record<string, string[]>;
  revs: Record<string, number>;
  active?: { geometry?: string; study?: string; mesh?: string; run?: string };
  names?: Record<string, string>;
  by: 'assistant' | 'app';
  turn: string | null;
  tool: string;
}

/** Frames merged for one reload: their kinds, ids and studies together; the last active wins. */
export interface UiSyncBatch {
  project_id: string;
  /** The studies the frames named ('' for a frame that named none). */
  studies: string[];
  kinds: UiSyncKind[];
  ids: Record<string, string[]>;
  revs: Record<string, number>;
  active: { geometry?: string; study?: string; mesh?: string; run?: string };
}

/** What the runtime lends this (runtime.js bindUiSyncHost). Each reload takes the switch token it must still match. */
export interface UiSyncHost {
  currentProjectId(): string;
  currentStudyId(): string;
  currentGeometryId(): string;
  switchGen(): number;
  reloadProjectShell(gen: number): Promise<unknown>;
  reloadGeometries(gen: number): Promise<unknown>;
  reloadStudies(gen: number): Promise<unknown>;
  reloadMaterials(gen: number): Promise<unknown>;
  reloadBcs(gen: number): Promise<unknown>;
  reloadMesh(gen: number, ids: string[]): Promise<unknown>;
  reloadRefinements(gen: number): Promise<unknown>;
  reloadRuns(gen: number, ids: string[]): Promise<unknown>;
  activateGeometry(id: string): Promise<unknown>;
  activateStudy(id: string): Promise<unknown>;
  activateMesh(id: string): Promise<unknown>;
  activateRun(id: string): Promise<unknown>;
  /** The whole setup again (a hidden tab that came back). */
  reloadAll(): Promise<unknown>;
  /** The project tree reads the server again (cfd:tree-sync). */
  syncTree(): void;
}

export const COALESCE_MS = 150;
/** A write heard this long ago still names the Assistant in a stale notice. */
export const HEARD_MS = 60_000;

const noop = async () => undefined;
const host: UiSyncHost = {
  currentProjectId: () => '',
  currentStudyId: () => '',
  currentGeometryId: () => '',
  switchGen: () => 0,
  reloadProjectShell: noop,
  reloadGeometries: noop,
  reloadStudies: noop,
  reloadMaterials: noop,
  reloadBcs: noop,
  reloadMesh: noop,
  reloadRefinements: noop,
  reloadRuns: noop,
  activateGeometry: noop,
  activateStudy: noop,
  activateMesh: noop,
  activateRun: noop,
  reloadAll: noop,
  syncTree: () => undefined,
};

export function bindUiSyncHost(api: Partial<UiSyncHost>): void {
  Object.assign(host, api || {});
}

/** The record kind a frame's kind writes (the key of its `ids`, and of heardWrite). */
const RECORD_OF: Partial<Record<UiSyncKind, string>> = {
  materials: 'material',
  bcs: 'bc',
  bc_defaults: 'bc_defaults',
  mesh: 'mesh',
  refinements: 'refinement',
  runs: 'run',
};

interface State {
  projectId: string;
  channel: ChannelHandle | null;
  pending: UiSyncFrame[];
  timer: ReturnType<typeof setTimeout> | null;
  /** `<record kind>:<id>` (or `<record kind>:*`) → when and by whom it was last written. */
  heard: Map<string, { at: number; by: 'assistant' | 'app' }>;
  running: Promise<void>;
  applied: number;
}

const state: State = {
  projectId: '',
  channel: null,
  pending: [],
  timer: null,
  heard: new Map(),
  running: Promise.resolve(),
  applied: 0,
};

let resumeWired = false;
let now: () => number = () => Date.now();

/** Follow `projectId`'s `ui` channel ('' : none). The channel of a project shown before closes. */
export function followProject(projectId: string): void {
  const pid = String(projectId || '');
  if (pid === state.projectId && (state.channel || !pid)) return;
  if (state.channel) state.channel.close();
  state.channel = null;
  state.projectId = pid;
  state.pending = [];
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (!pid) return;
  const ch = openChannel(`/api/ui/events?project_id=${encodeURIComponent(pid)}`);
  ch.addEventListener('sync', (ev) => {
    let frame: UiSyncFrame | null = null;
    try {
      frame = JSON.parse(String(ev.data)) as UiSyncFrame;
    } catch {
      frame = null;
    }
    if (frame && state.channel === ch) receive(frame);
  });
  state.channel = ch;
  if (!resumeWired && typeof window !== 'undefined') {
    resumeWired = true;
    window.addEventListener('cfd:events-resumed', () => {
      if (state.projectId && state.projectId === String(host.currentProjectId() || '')) void host.reloadAll();
    });
  }
}

/** A frame heard (the channel's, or a test's): remembered, then reloaded with the others within COALESCE_MS. */
export function receive(frame: UiSyncFrame): void {
  if (!frame || typeof frame !== 'object') return;
  const pid = String(frame.project_id || '');
  if (!pid || pid !== String(host.currentProjectId() || '') || pid !== state.projectId) return;
  remember(frame);
  state.pending.push(frame);
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    const frames = state.pending;
    state.pending = [];
    if (!frames.length) return;
    state.running = state.running.then(() => apply(merge(frames))).catch((e) => console.warn('[CFD] ui sync', e));
  }, COALESCE_MS);
}

function remember(frame: UiSyncFrame): void {
  const by = frame.by === 'app' ? 'app' : 'assistant';
  const at = now();
  for (const kind of frame.kinds || []) {
    const rec = RECORD_OF[kind];
    if (!rec) continue;
    const ids = (frame.ids && frame.ids[rec]) || [];
    if (!ids.length) state.heard.set(`${rec}:*`, { at, by });
    for (const id of ids) state.heard.set(`${rec}:${id}`, { at, by });
  }
  // The defaults are one record per study.
  if ((frame.kinds || []).includes('bc_defaults')) state.heard.set('bc_defaults:*', { at, by });
}

/**
 * Who wrote this record within HEARD_MS, as this window heard it ('assistant' or 'app'), or
 * null: another window, as far as this one knows.
 */
export function heardWrite(kind: string, id: string): 'assistant' | 'app' | null {
  const t = now();
  for (const key of [`${kind}:${id}`, `${kind}:*`]) {
    const h = state.heard.get(key);
    if (h && t - h.at <= HEARD_MS) return h.by;
  }
  return null;
}

/** The frames as one reload. */
export function merge(frames: UiSyncFrame[]): UiSyncBatch {
  const out: UiSyncBatch = { project_id: frames[0]?.project_id || '', studies: [], kinds: [], ids: {}, revs: {}, active: {} };
  for (const f of frames) {
    const sid = String(f.simulation_id || '');
    if (!out.studies.includes(sid)) out.studies.push(sid);
    for (const k of f.kinds || []) if (!out.kinds.includes(k)) out.kinds.push(k);
    for (const [k, list] of Object.entries(f.ids || {})) {
      const have = out.ids[k] || (out.ids[k] = []);
      for (const id of list || []) if (!have.includes(id)) have.push(id);
    }
    Object.assign(out.revs, f.revs || {});
    Object.assign(out.active, f.active || {});
  }
  return out;
}

/** Reload what a batch names, in order, while the switch token it started with still holds. */
export async function apply(b: UiSyncBatch): Promise<void> {
  const pid = String(host.currentProjectId() || '');
  if (!b.project_id || b.project_id !== pid) return;
  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('cfd:ui-sync', { detail: b }));
    } catch {
      /* a listener's failure never stops the reload */
    }
  }
  const has = (k: UiSyncKind) => b.kinds.includes(k);
  const gen = host.switchGen();
  const live = () => host.switchGen() === gen && String(host.currentProjectId() || '') === pid;
  const step = async (fn: () => Promise<unknown>) => {
    if (!live()) return;
    try {
      await fn();
    } catch (e) {
      console.warn('[CFD] ui sync reload', e);
    }
  };
  try {
    if (has('project')) await step(() => host.reloadProjectShell(gen));
    if (has('geometry')) await step(() => host.reloadGeometries(gen));
    // The person's view follows what the call made active: a geometry or study switch loads its setup itself.
    const a = b.active || {};
    if (has('active') && a.geometry && a.geometry !== String(host.currentGeometryId() || '')) {
      await step(() => host.activateGeometry(String(a.geometry)));
      return;
    }
    if (has('active') && a.study && a.study !== String(host.currentStudyId() || '')) {
      await step(() => host.activateStudy(String(a.study)));
      return;
    }
    const shown = String(host.currentStudyId() || '');
    const forShown = b.studies.includes('') || b.studies.includes(shown);
    if (forShown) {
      if (has('study')) await step(() => host.reloadStudies(gen));
      if (has('materials')) await step(() => host.reloadMaterials(gen));
      if (has('bcs') || has('bc_defaults')) await step(() => host.reloadBcs(gen));
      if (has('mesh')) await step(() => host.reloadMesh(gen, b.ids.mesh || []));
      if (has('refinements')) await step(() => host.reloadRefinements(gen));
      if (has('runs')) await step(() => host.reloadRuns(gen, b.ids.run || []));
      if (has('active') && a.mesh) await step(() => host.activateMesh(String(a.mesh)));
      if (has('active') && a.run) await step(() => host.activateRun(String(a.run)));
    }
    if (live()) host.syncTree();
  } finally {
    state.applied += 1;
    if (typeof window !== 'undefined') (window as unknown as { __CFD_UI_SYNCS__?: number }).__CFD_UI_SYNCS__ = state.applied;
  }
}

/** Tests: forget the project, the frames and what was heard; `clock` replaces Date.now. */
export function resetUiSyncForTests(clock?: () => number): void {
  if (state.channel) state.channel.close();
  if (state.timer) clearTimeout(state.timer);
  state.projectId = '';
  state.channel = null;
  state.pending = [];
  state.timer = null;
  state.heard.clear();
  state.running = Promise.resolve();
  state.applied = 0;
  now = clock ?? (() => Date.now());
}

/** Tests: the project followed now, and the reloads done. */
export function uiSyncState(): { projectId: string; following: boolean; applied: number; pending: number } {
  return { projectId: state.projectId, following: !!state.channel, applied: state.applied, pending: state.pending.length };
}

/** Tests: the reloads queued so far have run. */
export function uiSyncSettled(): Promise<void> {
  return state.running;
}
