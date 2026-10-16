/**
 * The page's relay between the open workspace's tools and the Assistant on the server
 * (Foundation spec 8.4; its questions as in 6.4, "Presentation without a dock").
 *
 * Idle until a workspace offers tools (src/workspace/assistantTools.ts): no channel, no
 * request. Then it reads the Assistant's status once: a page from another PC (403 remote)
 * answers every list {available:false, reason:'remote'} and opens nothing for its lifetime.
 * On this PC it opens one channel on the tab's event stream (kind `assistant`, role `relay`)
 * and waits for its first frame, `linked {link}`; every POST carries that link.
 *
 * Registrations: one POST in flight per tab, the newest list next (an older one is
 * superseded). Every POST takes the next page-wide rev, a re-POST and a withdrawal too. A
 * list whose 5 s bound ran out (abandoned) is never sent; if it was out already and the
 * server took it, `tools: []` follows at once (or the newer list that replaces it). A
 * refusal as plugin_off or plugin_changed, or an `unregistered` frame, makes the frame dead:
 * its lists are never sent again. Every new `linked` (a reconnect) sends the live list again.
 *
 * Tool calls: `invoke` is acknowledged from the frame's handler before the frame is asked
 * (the server's ack window catches a connection that is only half open), its progress goes
 * on at most 4 times a second, its end as the result; `abort` stops it. When the list goes
 * while a call runs, that call's result is sent first (at most 3 s), then `tools: []`, then
 * the channel closes. A dropped stream ends this page's calls on the server at once, so
 * they are stopped here too.
 *
 * Questions (`gate`): out of the workspace's full screen, then the app's own confirm dialog
 * with No focused (Enter and Escape answer No: a key meant for the workspace never allows),
 * then POST /api/assistant/gates/:id {allow}. `gate_closed` closes it unanswered.
 *
 * The tab's stream stays while it is hidden (pinned) while the server says turns are bound
 * to this tab or holds its link for a while after (`active {turns, hold_until}`), while a
 * call runs and while a question is open; otherwise a hidden tab lets it go as usual.
 */
import { openChannel, type ChannelHandle } from '../api/eventHub';
import type { AssistantRegistration } from '../plugin-sdk/workspace';
import { confirmAction } from '../workbench/dialogs';
import {
  markWorkspaceFrameDead,
  nextWorkspaceToolsRev,
  pinWorkspaceFrameEpoch,
  settleWorkspaceTools,
  subscribeWorkspaceTools,
  workspaceFrameEpoch,
  workspaceToolsSnapshot,
  type PublishedTools,
} from '../workspace/assistantTools';
import type { AssistantCallOutcome } from '../workspace/bridge';
import { exitFrameFullscreen } from '../workspace/leaveGuard';
import { refreshStatus, statusSnapshot, subscribeStatus, type StatusSnapshot } from './status';
import type { GateView, RelayFrameData, RelayFrameType, RelayProgressBody, RelayResultBody, RelayTool, RelayToolsBody } from './wire';

/** The channel's name on the tab's event stream (no such route: src/api/eventHub.ts). */
export const RELAY_CHANNEL_URL = '/api/assistant/events?role=relay';
const TOOLS_PATH = '/api/assistant/relay/tools';
const PROGRESS_PATH = '/api/assistant/relay/progress';
const RESULT_PATH = '/api/assistant/relay/result';
/** A running call's result is waited for this long before its list is withdrawn. */
export const RESULT_BEFORE_UNREGISTER_MS = 3000;
/** Progress goes on at most this often (4 a second). */
export const PROGRESS_INTERVAL_MS = 250;
/** The longest hold this page keeps its stream for after the server's word (it says 10 min). */
export const HOLD_MAX_MS = 15 * 60_000;
/** A withdrawal that got no answer is tried again after this long. */
const RETRY_MS = 1000;

/** What the frame hears for an empty list, or when nothing of this page is on the server. */
const NOTHING_HELD: AssistantRegistration = { available: true, accepted: [], refused: [] };
const refusal = (reason: string): AssistantRegistration => ({ available: false, accepted: [], refused: [], reason });

interface Invoke {
  link: string;
  ctl: AbortController;
  /** Settles once its result was sent and answered (or could not be). */
  done: Promise<void>;
}

interface Relay {
  /** idle: nothing offered yet (no request); checking: reading the status; remote: never opens. */
  mode: 'idle' | 'checking' | 'local' | 'remote';
  ch: ChannelHandle | null;
  link: string | null;
  /** The list (by its rev) last answered on a link: a new link sends the live list again. */
  postedOn: { link: string; rev: number } | null;
  pumping: boolean;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** The server may hold a list of this page (live, or dormant after a drop). */
  maybeHeld: boolean;
  /** The list the server took last (its scope and frame, for the withdrawal; its invoke). */
  held: PublishedTools | null;
  /** The server took a list this page no longer offers (abandoned, superseded, dead, gone). */
  heldStale: boolean;
  /** A channel refused (or ended by the server) opens again only for a newer list. */
  refusedRev: number;
  invokes: Map<string, Invoke>;
  gates: Map<string, AbortController>;
  turns: number;
  holdUntil: number;
  holdTimer: ReturnType<typeof setTimeout> | null;
  pinned: boolean;
  kickQueued: boolean;
  unsubscribe: () => void;
  statusOff: (() => void) | null;
}

let R: Relay | null = null;

type Answer = { status: number; body: Record<string, unknown> } | null;

/** A POST of the relay: its status and JSON body, or null when no answer came. */
async function post(path: string, body: unknown): Promise<Answer> {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    const j = (await r.json().catch(() => ({}))) as unknown;
    return { status: r.status, body: j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : {} };
  } catch {
    return null;
  }
}

const codeOf = (a: Answer): string => (a && typeof a.body.code === 'string' ? a.body.code : '');

/**
 * A list the server may be given: with tools, not abandoned, not dead, and not refused (a list
 * the frame was told was not taken is never sent again: the frame registers again instead).
 */
function live(p: PublishedTools | null): boolean {
  return !!p && p.tools.length > 0 && !p.abandoned && !p.dead && (!p.settled || p.taken);
}

/** The live list has not been answered on this link yet. */
function pendingOn(r: Relay, cur: PublishedTools | null, link: string): boolean {
  return !!cur && live(cur) && !(r.postedOn && r.postedOn.link === link && r.postedOn.rev === cur.rev);
}

/** The server holds a list of this page that must go before anything else is sent. */
function needsWithdraw(r: Relay, cur: PublishedTools | null, link: string): boolean {
  if (!r.maybeHeld) return false;
  if (!cur || cur.tools.length === 0) return true;
  return r.heldStale && !pendingOn(r, cur, link);
}

function kick(): void {
  const r = R;
  if (!r || r.kickQueued) return;
  r.kickQueued = true;
  queueMicrotask(() => {
    r.kickQueued = false;
    if (R === r) run(r);
  });
}

function run(r: Relay): void {
  const cur = workspaceToolsSnapshot().current;
  if (r.mode === 'remote') {
    if (cur && !cur.settled) settleWorkspaceTools(cur.rev, refusal('remote'));
    return;
  }
  if (r.mode === 'idle') {
    if (!cur || cur.settled) return;
    // Nothing of this page was ever sent: an empty list needs no request.
    if (cur.tools.length === 0) settleWorkspaceTools(cur.rev, NOTHING_HELD);
    else void checkStatus(r);
    return;
  }
  if (r.mode === 'checking') return;
  // A channel the server ended (it said `_closed`): as refused.
  if (r.ch && r.ch.readyState === r.ch.CLOSED) channelGone(r, cur);
  if (cur && !cur.settled && cur.tools.length === 0 && !r.maybeHeld && !r.pumping) settleWorkspaceTools(cur.rev, NOTHING_HELD);
  if (!r.ch && cur && live(cur) && cur.rev > r.refusedRev) openRelay(r);
  if (r.ch && r.link) void pump(r);
  updatePin(r);
  maybeClose(r);
}

/** The status once read (a remote page answers 403 remote). */
function statusSettled(r: Relay): Promise<StatusSnapshot> {
  const now = statusSnapshot();
  if (now.state !== 'loading') return Promise.resolve(now);
  return new Promise((resolve) => {
    const off = subscribeStatus(() => {
      const s = statusSnapshot();
      if (s.state === 'loading') return;
      off();
      r.statusOff = null;
      resolve(s);
    });
    r.statusOff = off;
    void refreshStatus();
  });
}

async function checkStatus(r: Relay): Promise<void> {
  r.mode = 'checking';
  const s = await statusSettled(r);
  if (R !== r) return;
  r.mode = s.state === 'remote' ? 'remote' : 'local';
  kick();
}

function openRelay(r: Relay): void {
  const ch = openChannel(RELAY_CHANNEL_URL);
  r.ch = ch;
  r.link = null;
  r.postedOn = null;
  r.pinned = false;
  const on = <K extends RelayFrameType>(type: K, fn: (d: RelayFrameData[K]) => void) =>
    ch.addEventListener(type, (ev) => {
      if (R !== r || r.ch !== ch) return;
      let d: unknown;
      try {
        d = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (d && typeof d === 'object') fn(d as RelayFrameData[K]);
    });
  on('linked', (d) => onLinked(r, d));
  on('active', (d) => onActive(r, d));
  on('invoke', (d) => onInvoke(r, d));
  on('abort', (d) => {
    if (typeof d.call === 'string') r.invokes.get(d.call)?.ctl.abort();
  });
  on('gate', (d) => onGate(r, d));
  on('gate_closed', (d) => {
    if (typeof d.gate === 'string') r.gates.get(d.gate)?.abort();
  });
  on('unregistered', (d) => onUnregistered(r, d));
  ch.addEventListener('error', () => {
    if (R === r && r.ch === ch) onChannelError(r, ch);
  });
}

function onLinked(r: Relay, d: RelayFrameData['linked']): void {
  const link = typeof d.link === 'string' ? d.link : '';
  if (!link || link.length > 128 || link === r.link) return;
  // Calls that came over an earlier link are gone on the server.
  for (const inv of r.invokes.values()) if (inv.link !== link) inv.ctl.abort();
  r.link = link;
  kick();
}

function onChannelError(r: Relay, ch: ChannelHandle): void {
  r.link = null;
  // The server failed this page's calls when the stream went (tab_disconnected): stop them here too.
  for (const inv of r.invokes.values()) inv.ctl.abort();
  if (ch.readyState === ch.CLOSED) channelGone(r, workspaceToolsSnapshot().current);
  kick();
}

/** The channel was refused, or ended by the server: nothing of this page is on the server through it. */
function channelGone(r: Relay, cur: PublishedTools | null): void {
  for (const inv of r.invokes.values()) inv.ctl.abort();
  r.ch = null;
  r.link = null;
  r.postedOn = null;
  r.pinned = false;
  r.maybeHeld = false;
  r.heldStale = false;
  r.held = null;
  r.turns = 0;
  r.holdUntil = 0;
  if (cur) {
    r.refusedRev = Math.max(r.refusedRev, cur.rev);
    if (!cur.settled) settleWorkspaceTools(cur.rev, refusal('not_connected'));
  }
}

function onUnregistered(r: Relay, d: RelayFrameData['unregistered']): void {
  const reason = typeof d.reason === 'string' && d.reason ? d.reason.slice(0, 64) : 'plugin_off';
  const frame = r.held ? r.held.frameId : workspaceToolsSnapshot().current?.frameId;
  // The server dropped it: nothing to withdraw, and that frame never registers again.
  r.maybeHeld = false;
  r.heldStale = false;
  r.held = null;
  if (frame) markWorkspaceFrameDead(frame, reason);
  kick();
}

/** One registration POST at a time: a withdrawal first when one is due, then the live list. */
async function pump(r: Relay): Promise<void> {
  if (r.pumping) return;
  r.pumping = true;
  let sent = false;
  try {
    for (;;) {
      if (R !== r || !r.ch || !r.link || r.retryTimer) break;
      const link = r.link;
      const cur = workspaceToolsSnapshot().current;
      if (needsWithdraw(r, cur, link)) {
        sent = true;
        await withdraw(r, link);
        continue;
      }
      if (pendingOn(r, cur, link)) {
        sent = true;
        await register(r, link, cur as PublishedTools);
        continue;
      }
      break;
    }
  } finally {
    r.pumping = false;
  }
  // What was held back while a POST was out (an empty list's answer, closing the channel).
  if (sent) kick();
}

function toolsOf(p: PublishedTools): RelayTool[] {
  return p.tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, risk: t.risk, timeoutS: t.timeoutS }));
}

async function register(r: Relay, link: string, pub: PublishedTools): Promise<void> {
  const epoch = workspaceFrameEpoch(pub.frameId);
  const body: RelayToolsBody = {
    link,
    rev: nextWorkspaceToolsRev(),
    ...(epoch ? { epoch } : {}),
    workspace: { ...pub.scope },
    tools: toolsOf(pub),
    ...(pub.guide ? { guide: pub.guide } : {}),
  };
  const a = await post(TOOLS_PATH, body);
  if (R !== r) return;
  r.postedOn = { link, rev: pub.rev };
  const code = codeOf(a);
  if (!a) {
    // No answer: the server may have it, and the frame is told it does not (it registers again
    // later): withdrawn in a moment.
    r.maybeHeld = true;
    r.held = pub;
    r.heldStale = true;
    settleWorkspaceTools(pub.rev, refusal('not_connected'));
    return;
  }
  if (a.status === 200) {
    if (typeof a.body.epoch === 'string') pinWorkspaceFrameEpoch(pub.frameId, a.body.epoch);
    const cur = workspaceToolsSnapshot().current;
    const still = !!cur && cur.rev === pub.rev && live(cur);
    r.maybeHeld = true;
    r.held = pub;
    // Abandoned, superseded or gone meanwhile: the server must not keep it (withdrawn, or replaced next).
    r.heldStale = !still;
    if (still) {
      const accepted = Array.isArray(a.body.accepted) ? a.body.accepted.filter((n): n is string => typeof n === 'string') : [];
      const refused = Array.isArray(a.body.refused) ? (a.body.refused as AssistantRegistration['refused']) : [];
      settleWorkspaceTools(pub.rev, { available: true, accepted, refused });
    }
    return;
  }
  if (a.status === 409 && code === 'no_channel') {
    // The link went before this arrived: the next `linked` sends it again.
    r.postedOn = null;
    if (r.link === link) r.link = null;
    return;
  }
  if (a.status === 409 && (code === 'plugin_off' || code === 'plugin_changed')) {
    // Its plugin was turned off or replaced: the server dropped this tab's lists of it.
    r.maybeHeld = false;
    r.heldStale = false;
    r.held = null;
    markWorkspaceFrameDead(pub.frameId, code);
    return;
  }
  settleWorkspaceTools(pub.rev, refusal(code || `http_${a.status}`));
}

/** `tools: []`, once the calls still running sent their results (at most 3 s). */
async function withdraw(r: Relay, link: string): Promise<void> {
  await resultsFirst(r);
  if (R !== r || r.link !== link) return;
  const held = r.held;
  const cur = workspaceToolsSnapshot().current;
  const scope = (held || cur)?.scope;
  const epoch = held ? workspaceFrameEpoch(held.frameId) : null;
  const a = await post(TOOLS_PATH, {
    link,
    rev: nextWorkspaceToolsRev(),
    ...(epoch ? { epoch } : {}),
    workspace: scope ? { ...scope } : { project_id: '', plugin: '', workspace: '', study_id: '' },
    tools: [],
  } satisfies RelayToolsBody);
  if (R !== r) return;
  if (!a) {
    // No answer: again in a moment (a dropped stream gives a new link meanwhile).
    r.retryTimer = setTimeout(() => {
      r.retryTimer = null;
      kick();
    }, RETRY_MS);
    return;
  }
  if (a.status === 409 && codeOf(a) === 'no_channel') {
    if (r.link === link) r.link = null;
    return;
  }
  // Gone (200), or nothing the server could keep (its plugin went, or a refusal for good).
  r.maybeHeld = false;
  r.heldStale = false;
  r.held = null;
  const now = workspaceToolsSnapshot().current;
  if (now && !now.settled && now.tools.length === 0) settleWorkspaceTools(now.rev, NOTHING_HELD);
}

function resultsFirst(r: Relay): Promise<void> {
  const running = [...r.invokes.values()].map((inv) => inv.done);
  if (!running.length) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, RESULT_BEFORE_UNREGISTER_MS);
    void Promise.all(running).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Progress of one call, at most 4 a second: the newest waits for its turn. */
function progressSender(link: string, call: string): { push(fraction: number | null, label: string): void; stop(): void } {
  let last = Number.NEGATIVE_INFINITY;
  let pending: { fraction: number | null; label: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ended = false;
  const send = () => {
    timer = null;
    if (ended || !pending) return;
    const p = pending;
    pending = null;
    last = Date.now();
    const body: RelayProgressBody = { link, call, ...(p.fraction !== null ? { fraction: p.fraction } : {}), ...(p.label ? { label: p.label } : {}) };
    void post(PROGRESS_PATH, body);
  };
  return {
    push(fraction, label) {
      if (ended) return;
      pending = { fraction: typeof fraction === 'number' && Number.isFinite(fraction) ? fraction : null, label: typeof label === 'string' ? label : '' };
      if (timer) return;
      const wait = last + PROGRESS_INTERVAL_MS - Date.now();
      if (wait <= 0) send();
      else timer = setTimeout(send, wait);
    },
    stop() {
      ended = true;
      pending = null;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function onInvoke(r: Relay, d: RelayFrameData['invoke']): void {
  const call = typeof d.call === 'string' ? d.call : '';
  const link = r.link;
  if (!call || call.length > 128 || !link || r.invokes.has(call)) return;
  // The ack first, from this handler, before the frame is asked.
  void post(PROGRESS_PATH, { link, call, ack: true } satisfies RelayProgressBody);
  const ctl = new AbortController();
  // The frame whose list the server took (its answer may still be on its way: the open frame's).
  const pub = r.held ?? workspaceToolsSnapshot().current;
  const progress = progressSender(link, call);
  const inv: Invoke = { link, ctl, done: Promise.resolve() };
  r.invokes.set(call, inv);
  updatePin(r);
  const timeoutS = typeof d.timeout_s === 'number' && d.timeout_s > 0 ? d.timeout_s : Number.NaN;
  inv.done = (async () => {
    let out: AssistantCallOutcome;
    try {
      out = pub
        ? await pub.invoke({ call, turn: typeof d.turn === 'string' ? d.turn : '', tool: String(d.tool ?? ''), input: d.input, timeoutS, signal: ctl.signal, onProgress: progress.push })
        : { ok: false, code: 'closed', message: 'its page is not open' };
    } catch (e) {
      out = { ok: false, code: 'failed', message: e instanceof Error ? e.message : String(e) };
    }
    progress.stop();
    await postResult(link, call, out);
  })().finally(() => {
    if (r.invokes.get(call) === inv) r.invokes.delete(call);
    if (R === r) {
      updatePin(r);
      kick();
    }
  });
}

async function postResult(link: string, call: string, out: AssistantCallOutcome): Promise<void> {
  const body: RelayResultBody = out.ok ? { link, call, ok: true, result: out.result } : { link, call, ok: false, error: { code: out.code, message: out.message } };
  const a = await post(RESULT_PATH, body);
  if (a && a.status === 413) {
    await post(RESULT_PATH, { link, call, ok: false, error: { code: 'too_large', message: "The tool's result is too large for the app to take." } } satisfies RelayResultBody);
  }
}

/** A gate's copy for the app's dialog: the host's text, then its detail rows. */
function gateCopy(g: GateView): string {
  const rows = Array.isArray(g.detail) ? g.detail.filter((x) => x && typeof x.label === 'string' && typeof x.value === 'string').map((x) => `${x.label}: ${x.value}`) : [];
  return [typeof g.copy === 'string' ? g.copy : '', ...rows].filter(Boolean).join(' · ');
}

function onGate(r: Relay, d: RelayFrameData['gate']): void {
  const g = d.gate;
  if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !g.id || r.gates.has(g.id)) return;
  const ctl = new AbortController();
  r.gates.set(g.id, ctl);
  updatePin(r);
  void (async () => {
    try {
      await exitFrameFullscreen();
      // Every assistant question is safe: No has the focus, Enter and Escape answer No.
      const allow = await confirmAction({ title: g.title, copy: gateCopy(g), yes: g.yes, no: g.no, safe: true, signal: ctl.signal });
      // Closed on the server meanwhile (answered elsewhere, timed out, stopped): nothing to send.
      if (ctl.signal.aborted) return;
      await post(`/api/assistant/gates/${encodeURIComponent(g.id)}`, { allow: allow === true });
    } catch (e) {
      console.warn('[CFD] assistant question', e);
    } finally {
      if (r.gates.get(g.id) === ctl) r.gates.delete(g.id);
      if (R === r) {
        updatePin(r);
        kick();
      }
    }
  })();
}

/** ms since 1970 from a number or an ISO date; 0 for none. */
function timeOf(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

function onActive(r: Relay, d: RelayFrameData['active']): void {
  const n = Number(d.turns);
  r.turns = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  r.holdUntil = Math.min(timeOf(d.hold_until), Date.now() + HOLD_MAX_MS);
  updatePin(r);
}

/** Pinned while turns are bound here or held, a call runs or a question is open. */
function updatePin(r: Relay): void {
  if (r.holdTimer) clearTimeout(r.holdTimer);
  r.holdTimer = null;
  const now = Date.now();
  const holding = r.holdUntil > now;
  if (holding) {
    r.holdTimer = setTimeout(() => {
      r.holdTimer = null;
      if (R === r) updatePin(r);
    }, r.holdUntil - now);
  }
  const want = r.turns > 0 || holding || r.invokes.size > 0 || r.gates.size > 0;
  if (r.ch && want !== r.pinned) {
    r.pinned = want;
    r.ch.pin(want);
  }
}

/** Nothing offered, nothing on the server, nothing open: the channel goes (the relay is idle again). */
function maybeClose(r: Relay): void {
  if (!r.ch || r.pumping || r.maybeHeld || r.gates.size) return;
  const cur = workspaceToolsSnapshot().current;
  if (live(cur) || (cur && !cur.settled)) return;
  const ch = r.ch;
  r.ch = null;
  r.link = null;
  r.postedOn = null;
  r.pinned = false;
  r.turns = 0;
  r.holdUntil = 0;
  if (r.holdTimer) clearTimeout(r.holdTimer);
  r.holdTimer = null;
  ch.close();
}

/**
 * Starts the page's relay (once per page; AppShell does it). It does nothing until a workspace
 * offers tools. Answers how to stop it (tests, and the shell going away).
 */
export function startAssistantRelay(): () => void {
  if (!R) {
    const r: Relay = {
      mode: 'idle',
      ch: null,
      link: null,
      postedOn: null,
      pumping: false,
      retryTimer: null,
      maybeHeld: false,
      held: null,
      heldStale: false,
      refusedRev: 0,
      invokes: new Map(),
      gates: new Map(),
      turns: 0,
      holdUntil: 0,
      holdTimer: null,
      pinned: false,
      kickQueued: false,
      unsubscribe: () => undefined,
      statusOff: null,
    };
    R = r;
    r.unsubscribe = subscribeWorkspaceTools(kick);
    kick();
  }
  return stopAssistantRelay;
}

/** Stops the relay: its channel closes, its questions close unanswered, its calls stop. */
export function stopAssistantRelay(): void {
  const r = R;
  if (!r) return;
  R = null;
  r.unsubscribe();
  r.statusOff?.();
  for (const ctl of r.gates.values()) ctl.abort();
  for (const inv of r.invokes.values()) inv.ctl.abort();
  if (r.holdTimer) clearTimeout(r.holdTimer);
  if (r.retryTimer) clearTimeout(r.retryTimer);
  r.ch?.close();
  r.ch = null;
}
