/**
 * The open workspace's tools for the app's Assistant, as this page offers them (Foundation
 * spec 8.4): one module store, read with useSyncExternalStore, that the bridge's
 * hooks.assistantTools fills and the page relay (src/assistant/relay.ts) takes to the server.
 *
 * - Each list a frame offers is a publication with the next page-wide `rev`, the frame's id (one
 *   per WorkspaceBridge instance), the workspace it belongs to as the host's route names it
 *   (never as the frame says), and the call that runs a tool in that frame (`invoke`, the
 *   bridge's invokeTool).
 * - Only the newest publication counts: an older one still waiting for its verdict is answered
 *   `superseded` at once (available:false, so neither the bridge nor the page keeps it).
 * - The bridge waits 5 s for a verdict, then calls `abandon()`: that publication is never sent
 *   to the server, and the relay withdraws it if the server accepted it meanwhile.
 * - A frame's accepted registration pins its plugin's epoch; every later one of that frame
 *   carries it (within a server boot the answer is the same token; after a restart the new
 *   boot's replaces it). A frame whose plugin was turned off or replaced is dead: its lists are
 *   refused here and never sent again (only a new frame registers that plugin again).
 * - null (the frame's page went away) withdraws that frame's list; a newer frame's stays.
 *
 * The state is on globalThis, so a hot swap of this module keeps the revs going up.
 */
import { useSyncExternalStore } from 'react';
import type { AssistantRegistration } from '../plugin-sdk/workspace';
import type { AssistantCallOutcome, AssistantInvoke, AssistantPublication, CheckedTool } from './bridge';

/** The workspace a list belongs to, from the host's route. */
export interface WorkspaceToolsScope {
  project_id: string;
  plugin: string;
  workspace: string;
  study_id: string;
}

/** Runs one call in the frame that offered the tools (WorkspaceBridge.invokeTool). */
export type ToolInvoke = (req: AssistantInvoke) => Promise<AssistantCallOutcome>;

/** One list of tools a frame offered. Replaced (never changed) when its state changes. */
export interface PublishedTools {
  /** Page-wide, only ever going up. */
  readonly rev: number;
  /** The frame (WorkspaceBridge instance) that offered it. */
  readonly frameId: string;
  readonly scope: WorkspaceToolsScope;
  readonly tools: readonly CheckedTool[];
  readonly guide: string;
  readonly invoke: ToolInvoke;
  /** Its 5 s bound ran out: never sent to the server, withdrawn if the server took it. */
  readonly abandoned: boolean;
  /** Its frame's plugin was turned off or replaced: never sent again. */
  readonly dead: boolean;
  /** Its verdict reached the frame (or it was dropped). */
  readonly settled: boolean;
  /** Its verdict said available: the frame keeps it (only such a list is sent again after a reconnect). */
  readonly taken: boolean;
}

export interface WorkspaceToolsSnapshot {
  /** The page's newest list, or null when the frame withdrew it (or none was offered). */
  readonly current: PublishedTools | null;
}

interface Rec {
  view: PublishedTools;
  resolve: (r: AssistantRegistration) => void;
}

interface ToolsState {
  rev: number;
  frames: number;
  current: Rec | null;
  /** Lists still waiting for their verdict. */
  waiting: Set<Rec>;
  /** Each frame's pinned epoch (its last accepted registration's). */
  epochs: Map<string, string>;
  /** Frames whose plugin went, with the reason. */
  dead: Map<string, string>;
  snap: WorkspaceToolsSnapshot;
  listeners: Set<() => void>;
}

const KEY = Symbol.for('magnusim.workspaceTools');

function fresh(): ToolsState {
  return { rev: 0, frames: 0, current: null, waiting: new Set(), epochs: new Map(), dead: new Map(), snap: { current: null }, listeners: new Set() };
}

function st(): ToolsState {
  const g = globalThis as unknown as Record<symbol, ToolsState | undefined>;
  let s = g[KEY];
  if (!s) {
    s = fresh();
    g[KEY] = s;
  }
  return s;
}

const refusal = (reason: string): AssistantRegistration => ({ available: false, accepted: [], refused: [], reason });

function emit(): void {
  const s = st();
  const view = s.current ? s.current.view : null;
  if (s.snap.current !== view) s.snap = { current: view };
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
 * verdict the relay gets for them, with `abandon()` for the bridge's 5 s bound.
 */
export function publishWorkspaceTools(
  scope: WorkspaceToolsScope,
  frameId: string,
  reg: { tools: CheckedTool[]; guide: string } | null,
  invoke: ToolInvoke,
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
      scope: Object.freeze({ project_id: scope.project_id, plugin: scope.plugin, workspace: scope.workspace, study_id: scope.study_id }),
      tools: Object.freeze([...reg.tools]),
      guide: typeof reg.guide === 'string' ? reg.guide : '',
      invoke,
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

/** The frame's page went away (detach, the plugin-off card): its list goes; a newer frame's stays. */
export function withdrawWorkspaceTools(frameId: string): void {
  const s = st();
  let changed = false;
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
  const why = s.dead.get(frameId) as string;
  for (const rec of [...s.waiting]) if (rec.view.frameId === frameId) settleRec(rec, refusal(why));
  if (s.current && s.current.view.frameId === frameId && !s.current.view.dead) update(s.current, { dead: true });
  emit();
}

export function workspaceFrameDead(frameId: string): boolean {
  return st().dead.has(frameId);
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
