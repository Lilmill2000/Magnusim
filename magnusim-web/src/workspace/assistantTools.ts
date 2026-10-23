/**
 * The open workspace's tools for the app's Assistant, as this page offers them (Foundation
 * spec 8.4): one module store, read with useSyncExternalStore, that the bridge's
 * hooks.assistantTools fills and the page relay (src/assistant/relay.ts) takes to the server.
 *
 * - Each list a frame offers is a publication with the next page-wide `rev`, the frame's id (one
 *   per WorkspaceBridge instance), the workspace it belongs to as the host's route names it
 *   (never as the frame says), the call that runs a tool in that frame (`invoke`, the
 *   bridge's invokeTool), and the one that tells it of the turns bound to this tab
 *   (`tellTurn`, the bridge's assistantTurn).
 * - Only the newest publication counts: an older one still waiting for its verdict is answered
 *   `superseded` at once (available:false, so neither the bridge nor the page keeps it).
 * - The bridge waits 5 s for a verdict, then calls `abandon()`: that publication is never sent
 *   to the server, and the relay withdraws it if the server accepted it meanwhile.
 * - A frame's accepted registration pins its plugin's epoch; every later one of that frame
 *   carries it (within a server boot the answer is the same token; after a restart the new
 *   boot's replaces it). A frame whose plugin was turned off or replaced is dead: its lists are
 *   refused here and never sent again (only a new frame registers that plugin again).
 * - A frame keeps its last taken list (its verdict said available) while a newer one of it
 *   is not taken (refused, abandoned, superseded): the bridge and the SDK keep that list's
 *   tools and handler, so the relay keeps it on the server (workspaceFrameKept).
 * - null (the frame's page went away) withdraws that frame's list; a newer frame's stays. A
 *   frame's page that loads again (a reload keeps the frame and its bridge) offers its lists
 *   under the same frame id with the next `load`: a new page there.
 * - Undo from the app's Assistant panel (the dock; Phase 4 spec 8.2): each frame's offers to undo
 *   a turn's changes as one step (the bridge's hooks.assistantUndoable: only turns told to that
 *   frame's page, withdrawn with null and when its channel ends) are in the snapshot's `undo`, by
 *   turn; undoWorkspaceTurn(turn) asks the frame that offers it (the bridge's assistantUndo). A
 *   frame that goes (withdrawWorkspaceTools) takes its offers with it.
 * - The dock registers itself (setWorkspaceDock): a page that connects while one is set hears
 *   `docked` in its welcome, and its Ctrl+/ (assistant.dock) reaches the dock's `key()`.
 * - A second slot, `core` (core host tools spec C7, 11.1): the app page's own tools (core__show,
 *   core__view, src/assistant/coreTools.ts) and where the tab is (Home, a project's workbench, a
 *   workspace; its project and study). One publication per slot, and only the newest of each
 *   counts; the relay sends both, each with its own rev. A publication of the same place and
 *   tools again changes nothing (no rev, no POST).
 *
 * The state is on globalThis, so a hot swap of this module keeps the revs going up.
 */
import { useSyncExternalStore } from 'react';
import type { AssistantRegistration, AssistantTurn, AssistantUndoAnswer } from '../plugin-sdk/workspace';
import type { RelayTool } from '../assistant/wire';
import type { AssistantCallOutcome, AssistantInvoke, AssistantPublication, CheckedAssistantTools, CheckedReview, CheckedTool } from './bridge';

/** The workspace a list belongs to, from the host's route (and its title from the host's plugin row). */
export interface WorkspaceToolsScope {
  project_id: string;
  plugin: string;
  /** Its key, as the route names it. */
  workspace: string;
  /** Its title, for the texts the person reads (the server names it by its key without one). */
  title?: string;
  study_id: string;
}

/** Runs one call in the frame that offered the tools (WorkspaceBridge.invokeTool). */
export type ToolInvoke = (req: AssistantInvoke) => Promise<AssistantCallOutcome>;

/** Tells the frame that offered the tools of a turn bound to this tab (WorkspaceBridge.assistantTurn). */
export type TurnTell = (turn: AssistantTurn) => void;

/** One list of tools a frame offered. Replaced (never changed) when its state changes. */
export interface PublishedTools {
  /** Page-wide, only ever going up. */
  readonly rev: number;
  /** The frame (WorkspaceBridge instance) that offered it. */
  readonly frameId: string;
  /** Which load of that frame's page offered it: one more each time a page of the frame went away (its list withdrawn). */
  readonly load: number;
  readonly scope: WorkspaceToolsScope;
  readonly tools: readonly CheckedTool[];
  readonly guide: string;
  /** The review rounds the frame asked for (null: none). */
  readonly review: CheckedReview | null;
  readonly invoke: ToolInvoke;
  /** Tells its frame of the assistant's turns bound to this tab (the page relay calls it); null: none. */
  readonly tellTurn: TurnTell | null;
  /** Its 5 s bound ran out: never sent to the server, withdrawn if the server took it. */
  readonly abandoned: boolean;
  /** Its frame's plugin was turned off or replaced: never sent again. */
  readonly dead: boolean;
  /** Its verdict reached the frame (or it was dropped). */
  readonly settled: boolean;
  /** Its verdict said available: the frame keeps it (only such a list is sent again after a reconnect). */
  readonly taken: boolean;
}

/** Asks the frame that offered it to undo a turn's changes (WorkspaceBridge.assistantUndo). */
export type UndoRun = (turn: string) => Promise<AssistantUndoAnswer>;

/** A frame's offer to undo a turn's changes as one step (the dock's "Undo these changes"). */
export interface WorkspaceUndoOffer {
  readonly turn: string;
  /** What the page calls that step ("Assistant: <title>"), cleaned, at most 120 characters. */
  readonly label: string;
  /** The frame (WorkspaceBridge instance) that offers it. */
  readonly frameId: string;
  /** The workspace that frame shows, as the host's route names it (with its title when known). */
  readonly scope: WorkspaceToolsScope;
}

/** Where this tab is, as its core page tells the Assistant (core host tools spec C7; project_id '' on Home). */
export interface CoreToolsScope {
  project_id: string;
  study_id: string;
  place: 'home' | 'workbench' | 'workspace';
}

/** The core page's publication (C7): its place and tools, and the call that runs one in this page. */
export interface PublishedCore {
  /** Page-wide, only ever going up (shared with the workspace slot's revs). */
  readonly rev: number;
  readonly scope: CoreToolsScope;
  readonly tools: readonly RelayTool[];
  readonly guide: string;
  readonly invoke: ToolInvoke;
}

export interface WorkspaceToolsSnapshot {
  /** The page's newest list, or null when the frame withdrew it (or none was offered). */
  readonly current: PublishedTools | null;
  /** The turns whose changes an open frame offers to undo now, by turn id (empty when none). */
  readonly undo: ReadonlyMap<string, WorkspaceUndoOffer>;
  /** The core page's newest publication (C7), or null while none is (another PC, a test page). */
  readonly core: PublishedCore | null;
}

/** The app's Assistant panel, as it registers itself (setWorkspaceDock). */
export interface WorkspaceDock {
  /** Ctrl+/ typed in a workspace frame (assistant.dock): as the same key in the app's page. */
  key(): void;
}

interface Rec {
  view: PublishedTools;
  resolve: (r: AssistantRegistration) => void;
}

interface UndoRec {
  view: WorkspaceUndoOffer;
  run: UndoRun;
}

interface ToolsState {
  rev: number;
  frames: number;
  current: Rec | null;
  /** Lists still waiting for their verdict. */
  waiting: Set<Rec>;
  /** Each frame's pinned epoch (its last accepted registration's). */
  epochs: Map<string, string>;
  /** Each frame's last taken list (the one its bridge and SDK keep). */
  kept: Map<string, Rec>;
  /** Frames whose plugin went, with the reason. */
  dead: Map<string, string>;
  /** How many times each frame's page went away (its next page's `load`). */
  loads: Map<string, number>;
  /** The undo offers, by turn (a newer offer of the same turn replaces the older). */
  undo: Map<string, UndoRec>;
  /** The undo offers as the snapshot gives them, replaced when they change. */
  undoView: ReadonlyMap<string, WorkspaceUndoOffer>;
  /** The dock, while one is set. */
  dock: WorkspaceDock | null;
  /** The core slot's newest publication (C7). */
  core: PublishedCore | null;
  snap: WorkspaceToolsSnapshot;
  listeners: Set<() => void>;
}

const KEY = Symbol.for('magnusim.workspaceTools');

const NO_UNDO: ReadonlyMap<string, WorkspaceUndoOffer> = new Map();

function fresh(): ToolsState {
  return {
    rev: 0,
    frames: 0,
    current: null,
    waiting: new Set(),
    epochs: new Map(),
    kept: new Map(),
    dead: new Map(),
    loads: new Map(),
    undo: new Map(),
    undoView: NO_UNDO,
    dock: null,
    core: null,
    snap: { current: null, undo: NO_UNDO, core: null },
    listeners: new Set(),
  };
}

function st(): ToolsState {
  const g = globalThis as unknown as Record<symbol, ToolsState | undefined>;
  let s = g[KEY];
  if (!s) {
    s = fresh();
    g[KEY] = s;
  }
  // A state an older copy of this module made (a hot swap) has none of these yet.
  s.loads ??= new Map();
  s.undo ??= new Map();
  s.undoView ??= NO_UNDO;
  s.dock ??= null;
  s.core ??= null;
  return s;
}

const refusal = (reason: string): AssistantRegistration => ({ available: false, accepted: [], refused: [], reason });

function emit(): void {
  const s = st();
  const view = s.current ? s.current.view : null;
  if (s.snap.current !== view || s.snap.undo !== s.undoView || s.snap.core !== s.core) s.snap = { current: view, undo: s.undoView, core: s.core };
  for (const fn of [...s.listeners]) {
    try {
      fn();
    } catch (e) {
      console.warn('[CFD] workspace tools listener', e);
    }
  }
}

function update(rec: Rec, patch: Partial<Pick<PublishedTools, 'abandoned' | 'dead' | 'settled' | 'taken'>>): void {
  rec.view = Object.freeze({ ...rec.view, ...patch });
}

/** Answers the bridge (once) and stops waiting. The caller emits. */
function settleRec(rec: Rec, verdict: AssistantRegistration): void {
  const s = st();
  if (!s.waiting.delete(rec)) return;
  update(rec, { settled: true, taken: verdict.available === true });
  if (verdict.available === true) s.kept.set(rec.view.frameId, rec);
  rec.resolve(verdict);
}

function abandonRec(rec: Rec): void {
  if (rec.view.abandoned) return;
  update(rec, { abandoned: true });
  settleRec(rec, refusal('not_connected'));
  emit();
}

/** A new frame's id (one per WorkspaceBridge instance). */
export function newWorkspaceFrameId(): string {
  return `frame-${++st().frames}`;
}

/** The next page-wide rev (the relay takes one for each registration it sends). */
export function nextWorkspaceToolsRev(): number {
  return ++st().rev;
}

/**
 * hooks.assistantTools: a frame's checked tools (null: its page went away). Answers the
 * verdict the relay gets for them, with `abandon()` for the bridge's 5 s bound. `tellTurn`
 * tells that frame of the turns bound to this tab.
 */
export function publishWorkspaceTools(
  scope: WorkspaceToolsScope,
  frameId: string,
  reg: CheckedAssistantTools | null,
  invoke: ToolInvoke,
  tellTurn: TurnTell | null = null,
): AssistantPublication {
  if (reg === null) {
    withdrawWorkspaceTools(frameId);
    return Object.assign(Promise.resolve(refusal('closed')), { abandon: () => undefined });
  }
  const s = st();
  // An older list still waiting is no one's any more: neither side keeps it.
  for (const old of [...s.waiting]) settleRec(old, refusal('superseded'));
  let resolve: (r: AssistantRegistration) => void = () => undefined;
  const verdict = new Promise<AssistantRegistration>((done) => {
    resolve = done;
  });
  const deadReason = s.dead.get(frameId);
  const rec: Rec = {
    view: Object.freeze({
      rev: ++s.rev,
      frameId,
      load: s.loads.get(frameId) ?? 0,
      scope: Object.freeze({
        project_id: scope.project_id,
        plugin: scope.plugin,
        workspace: scope.workspace,
        ...(scope.title ? { title: scope.title } : {}),
        study_id: scope.study_id,
      }),
      tools: Object.freeze([...reg.tools]),
      guide: typeof reg.guide === 'string' ? reg.guide : '',
      review: reg.review ? Object.freeze({ rounds: reg.review.rounds, prompt: reg.review.prompt }) : null,
      invoke,
      tellTurn,
      abandoned: false,
      dead: deadReason !== undefined,
      settled: false,
      taken: false,
    }),
    resolve,
  };
  s.current = rec;
  s.waiting.add(rec);
  // A frame whose plugin went never registers again: refused here, never sent.
  if (deadReason !== undefined) settleRec(rec, refusal(deadReason));
  emit();
  return Object.assign(verdict, { abandon: () => abandonRec(rec) });
}

/**
 * The core page's tools and where this tab is (core host tools spec C7): a new publication with
 * the next rev, unless it is the same place, tools and guide as the newest (then that one stays).
 */
export function publishCoreTools(scope: CoreToolsScope, tools: readonly RelayTool[], guide: string, invoke: ToolInvoke): PublishedCore {
  const s = st();
  const cur = s.core;
  if (
    cur &&
    cur.scope.project_id === scope.project_id &&
    cur.scope.study_id === scope.study_id &&
    cur.scope.place === scope.place &&
    cur.tools === tools &&
    cur.guide === guide &&
    cur.invoke === invoke
  ) {
    return cur;
  }
  s.core = Object.freeze({
    rev: ++s.rev,
    scope: Object.freeze({ project_id: scope.project_id, study_id: scope.study_id, place: scope.place }),
    tools,
    guide,
    invoke,
  });
  emit();
  return s.core;
}

/** The core page went (the shell unmounted): the relay withdraws its tools. */
export function withdrawCoreTools(): void {
  const s = st();
  if (!s.core) return;
  s.core = null;
  emit();
}

/** The undo offers changed: a new view for the snapshot. The caller emits. */
function undoChanged(): void {
  const s = st();
  s.undoView = Object.freeze(new Map([...s.undo].map(([turn, rec]) => [turn, rec.view]))) as ReadonlyMap<string, WorkspaceUndoOffer>;
}

/**
 * hooks.assistantUndoable: a frame offers to undo a turn's changes as one step (`label`), or no
 * longer does (null: only that frame's own offer of the turn goes). `run` asks that frame.
 */
export function offerWorkspaceUndo(scope: WorkspaceToolsScope, frameId: string, turn: string, label: string | null, run: UndoRun): void {
  const s = st();
  if (!turn) return;
  if (label === null) {
    if (s.undo.get(turn)?.view.frameId !== frameId) return;
    s.undo.delete(turn);
  } else {
    if (s.dead.has(frameId)) return;
    s.undo.delete(turn);
    s.undo.set(turn, {
      view: Object.freeze({
        turn,
        label,
        frameId,
        scope: Object.freeze({
          project_id: scope.project_id,
          plugin: scope.plugin,
          workspace: scope.workspace,
          ...(scope.title ? { title: scope.title } : {}),
          study_id: scope.study_id,
        }),
      }),
      run,
    });
  }
  undoChanged();
  emit();
}

/** Drop every undo offer of a frame; true when there was one. The caller emits. */
function dropFrameUndo(frameId: string): boolean {
  const s = st();
  let changed = false;
  for (const [turn, rec] of [...s.undo]) {
    if (rec.view.frameId !== frameId) continue;
    s.undo.delete(turn);
    changed = true;
  }
  if (changed) undoChanged();
  return changed;
}

/**
 * The dock's "Undo these changes": asks the frame that offers that turn's undo. `not_offered` when
 * none does; else the frame's answer (`undone`, or `not_newest`, `busy`, `no_answer`, `closed`, ...).
 */
export async function undoWorkspaceTurn(turn: string): Promise<AssistantUndoAnswer> {
  const rec = st().undo.get(turn);
  if (!rec) return { undone: false, reason: 'not_offered' };
  try {
    return await rec.run(turn);
  } catch (e) {
    console.warn('[CFD] workspace undo', e);
    return { undone: false, reason: 'failed' };
  }
}

/** The dock sets itself (null: it went). Returns a function that clears it while it is still this one. */
export function setWorkspaceDock(dock: WorkspaceDock | null): () => void {
  const s = st();
  s.dock = dock;
  return () => {
    if (st().dock === dock) st().dock = null;
  };
}

/** The dock, while one is set. */
export function workspaceDock(): WorkspaceDock | null {
  return st().dock;
}

/** The frame's page went away (detach, the plugin-off card): its list goes; a newer frame's stays. */
export function withdrawWorkspaceTools(frameId: string): void {
  const s = st();
  s.kept.delete(frameId);
  // What the frame offers next comes from a new page.
  s.loads.set(frameId, (s.loads.get(frameId) ?? 0) + 1);
  let changed = dropFrameUndo(frameId);
  for (const rec of [...s.waiting]) {
    if (rec.view.frameId !== frameId) continue;
    update(rec, { abandoned: true });
    settleRec(rec, refusal('not_connected'));
    changed = true;
  }
  if (s.current && s.current.view.frameId === frameId) {
    s.current = null;
    changed = true;
  }
  if (changed) emit();
}

/** The relay's verdict for a list (once; a list already answered keeps its answer). */
export function settleWorkspaceTools(rev: number, verdict: AssistantRegistration): void {
  const s = st();
  for (const rec of s.waiting) {
    if (rec.view.rev !== rev) continue;
    settleRec(rec, verdict);
    emit();
    return;
  }
}

/** The frame's plugin was turned off or replaced (plugin_off, plugin_changed, `unregistered`). */
export function markWorkspaceFrameDead(frameId: string, reason: string): void {
  const s = st();
  if (!s.dead.has(frameId)) s.dead.set(frameId, reason || 'plugin_off');
  s.kept.delete(frameId);
  const why = s.dead.get(frameId) as string;
  for (const rec of [...s.waiting]) if (rec.view.frameId === frameId) settleRec(rec, refusal(why));
  if (s.current && s.current.view.frameId === frameId && !s.current.view.dead) update(s.current, { dead: true });
  dropFrameUndo(frameId);
  emit();
}

export function workspaceFrameDead(frameId: string): boolean {
  return st().dead.has(frameId);
}

/**
 * The frame's last taken list, which it keeps while a newer one of it is not taken (its bridge
 * and SDK keep that list's tools and handler); null for none, an empty one, or a dead frame.
 */
export function workspaceFrameKept(frameId: string): PublishedTools | null {
  const s = st();
  const rec = s.kept.get(frameId);
  return rec && rec.view.tools.length > 0 && !s.dead.has(frameId) ? rec.view : null;
}

/**
 * Pins the frame's epoch from an accepted registration. Within a server boot every answer of
 * the frame echoes the pinned token (a changed plugin is refused plugin_changed); a different
 * one follows only a restart, and replaces it so the fence holds for the new boot too.
 */
export function pinWorkspaceFrameEpoch(frameId: string, epoch: string): void {
  const s = st();
  if (!epoch || s.dead.has(frameId)) return;
  s.epochs.set(frameId, epoch);
}

export function workspaceFrameEpoch(frameId: string): string | null {
  return st().epochs.get(frameId) ?? null;
}

export function workspaceToolsSnapshot(): WorkspaceToolsSnapshot {
  return st().snap;
}

export function subscribeWorkspaceTools(fn: () => void): () => void {
  const s = st();
  s.listeners.add(fn);
  return () => {
    s.listeners.delete(fn);
  };
}

export function useWorkspaceTools(): WorkspaceToolsSnapshot {
  return useSyncExternalStore(subscribeWorkspaceTools, workspaceToolsSnapshot, workspaceToolsSnapshot);
}

/** Tests only: a fresh page (no lists, revs from 0); listeners stay. */
export function resetWorkspaceToolsForTests(): void {
  const g = globalThis as unknown as Record<symbol, ToolsState | undefined>;
  const listeners = g[KEY]?.listeners ?? new Set<() => void>();
  g[KEY] = { ...fresh(), listeners };
}
