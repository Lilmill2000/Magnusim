/**
 * The `ui` channel: what a host tool changed reaches the open windows of its project
 * (Assistant phase 5, C2 §6.1). The emitter is ui-sync.ts (uiSync.emit, called by host tools
 * after a write their route answered 2xx); this carries its events to the pages.
 *
 * The hub channel kind `ui` (event-hub.ts), params {project_id}, for this PC only (meta.local).
 * Each event goes to every `ui` channel of its project as `event: sync` with {c, d: UiSync}. A
 * page opens one on every project open and closes it when the project changes
 * (src/workbench/uiSync.ts). Missed frames are not replayed: a page whose hidden tab comes back
 * reloads its setup once.
 *
 * MAGNUSIM_TEST_UI_SYNC=1 (read when the routes are registered) also registers, for the browser
 * tests, POST /api/test/ui-sync {…UiSyncInput}: emits it as a tool would (this PC only).
 *
 * The channels are on globalThis, and the emitter is heard once per process, so a Vite
 * re-import of this module shares them.
 */
import { isLocalOperator } from './http.ts';
import { registerChannelKind, type ChannelOpened, type ChannelSend, type ChannelMeta } from './event-hub.ts';
import type { Router } from './router.ts';
import { uiSync, type UiSync, type UiSyncInput } from './ui-sync.ts';
import { sameProjectFolder } from '../compute-slot.js';

const ID_RE = /^[A-Za-z0-9._ -]{1,128}$/;
const KEY = Symbol.for('magnusim.ui-channel');

interface Channel {
  projectId: string;
  send: ChannelSend;
}

interface ChannelState {
  channels: Set<Channel>;
  /** The emitter is heard (once per process). */
  heard: boolean;
}

function state(): ChannelState {
  const g = globalThis as unknown as Record<symbol, ChannelState | undefined>;
  let s = g[KEY];
  if (!s) {
    s = { channels: new Set(), heard: false };
    g[KEY] = s;
  }
  return s;
}

/** An event to every open channel of its project; a channel whose frame can never arrive goes. */
function deliver(ev: UiSync): void {
  const s = state();
  for (const ch of [...s.channels]) {
    if (!sameProjectFolder(ch.projectId, ev.project_id)) continue;
    if (!ch.send('sync', ev)) s.channels.delete(ch);
  }
}

function hearEmitter(): void {
  const s = state();
  if (s.heard) return;
  s.heard = true;
  uiSync.subscribe(deliver);
}

/** The `ui` channels open now, per project (tests). */
export function uiSyncChannelsOpen(projectId?: string): number {
  let n = 0;
  for (const ch of state().channels) if (!projectId || sameProjectFolder(ch.projectId, projectId)) n += 1;
  return n;
}

/** One `ui` channel: params {project_id}; this PC only. */
export function openUiChannel(params: Record<string, unknown>, send: ChannelSend, _done: () => void, meta: Pick<ChannelMeta, 'local'>): ChannelOpened {
  if (!meta.local) return { ok: false, status: 403, error: 'This is only available on this PC.' };
  const projectId = String(params.project_id || '').trim();
  if (!ID_RE.test(projectId)) return { ok: false, status: 400, error: 'project_id required' };
  hearEmitter();
  const ch: Channel = { projectId, send };
  state().channels.add(ch);
  return {
    ok: true,
    cleanup: () => {
      state().channels.delete(ch);
    },
  };
}

/** The `ui` channel kind, and with MAGNUSIM_TEST_UI_SYNC=1 its test route. */
export function registerUiSyncRoutes(router: Router): void {
  hearEmitter();
  registerChannelKind('ui', openUiChannel);
  if (process.env.MAGNUSIM_TEST_UI_SYNC !== '1') return;
  router.post('/api/test/ui-sync', async (ctx) => {
    if (!isLocalOperator(ctx.req)) return ctx.sendJson(403, { ok: false, error: 'This is only available on this PC.' });
    const body = (await ctx.readJsonBody()) as Partial<UiSyncInput>;
    const ev = uiSync.emit({
      project_id: String(body.project_id || ''),
      simulation_id: body.simulation_id ?? null,
      kinds: body.kinds ?? [],
      ids: body.ids ?? {},
      revs: body.revs ?? {},
      ...(body.active ? { active: body.active } : {}),
      ...(body.names ? { names: body.names } : {}),
      by: body.by === 'app' ? 'app' : 'assistant',
      turn: body.turn ?? null,
      tool: body.tool || 'test',
    });
    return ctx.sendJson(ev ? 200 : 400, ev ? { ok: true, sync: ev } : { ok: false, error: 'project_id and a known kind required' });
  });
}
