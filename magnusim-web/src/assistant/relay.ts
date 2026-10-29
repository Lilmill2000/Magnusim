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
 * list whose 5 s bound ran out (abandoned) is never sent. A newer list that is not taken
 * (refused, abandoned, superseded, or no answer) changes nothing for its frame: the bridge
 * and the SDK keep the frame's earlier tools and handler, so the server keeps its earlier
 * list too (wanted()). That one is never withdrawn for the newer one: it goes again in place
 * of a newer one the server took late or did not answer, and on every new `linked` (a
 * reconnect), as the live list does. Only a list no frame offers any more is withdrawn
 * (`tools: []`). A refusal as plugin_off or plugin_changed, or an `unregistered` frame, makes
 * the frame dead: its lists are never sent again. plugin_off is final after a restart too: a
 * server that has not read its plugins yet keeps a list unverified instead of refusing it.
 *
 * Tool calls: `invoke` is acknowledged from the frame's handler before the frame is asked
 * (the server's ack window catches a connection that is only half open), its progress goes
 * on at most 4 times a second (and, while the frame waits on a call to the app, a bare
 * progress as a sign of life: the server's stall window waits too), its end as the result;
 * a progress that waits for the person goes `waiting: true` (CAD tools spec H7), and so
 * does each sign of life after it until a progress that doesn't wait (the turn's minutes stop
 * meanwhile);
 * `abort` stops it. When the list goes while a call runs, that call's result is sent first
 * (at most 3 s), then `tools: []`, then the channel closes. A dropped stream ends this page's calls on the server at once, so
 * they are stopped here too. A workspace frame's call may read a file attached in its turn's
 * conversation (the bridge's assistant.attachment): GET /api/assistant/relay/attachment with the
 * invoke's own link and call.
 *
 * Questions (`gate`): out of the workspace's full screen, then shown by the presenter the
 * dock set (setGatePresenter: its question card, chat dock spec 4.1), else the app's own
 * confirm dialog; either way with No focused (Enter and Escape answer No: a key meant for the
 * workspace never allows) and Allow guarded (a deliberate click only: never the second click of
 * a double-click on the question before it, which a model can ask right after another), then POST
 * /api/assistant/relay/gate {link, gate, allow} on the link it was shown on: the server takes
 * a tab's answer only through its live link, and only for a question sent on it (the turn's
 * answer key is for the program that started the turn, which this page is not). `gate_closed`
 * closes it unanswered, and so do its expires_at and a new link that does not show it again
 * (closed while the link was down).
 *
 * The tab's stream stays while it is hidden (pinned) while the server says turns are bound
 * to this tab or holds its link for a while after (`active {turns, hold_until}`), while a
 * call runs and while a question is open; otherwise a hidden tab lets it go as usual. A new
 * link starts with no turns and no hold: its server says `active` right after `linked` when
 * it has any.
 *
 * Turns (`turn`, CAD tools spec H3): each start, change and end of a turn bound to this tab goes
 * to the open workspace's frame (its publication's tellTurn), and a new page there (a new frame,
 * or the frame's page loaded again) hears the running ones once. The running ones are
 * remembered: a frame may stop only those (stopAnnouncedTurn, through the turn's own Stop
 * route). A new link's server sends its running turns again right after `active`, as many as
 * its `turns`: one this page knew of that does not come again ended while the link was down,
 * and a page told of it hears it ended (with no `end`). A new page is told only what a link
 * says runs: never while there is none, nor before a new one said which still run.
 *
 * The window's proof (withAssistantLink): the server takes this tab's live link, beside the
 * app's origin, as the proof that a request comes from a Magnusim window (a coding agent's
 * Test, connect and sign-in, a custom agent added, an allow switch turned on; phase 4's dock
 * starts agent turns with it, from Home too). A tab no workspace offers tools in opens its
 * channel for that alone (after the status says this PC), waits up to 5 s for `linked`, and
 * keeps the channel while the request is out and a minute after; it is not pinned. The dock
 * holds the channel (holdAssistantLink) while a request it started runs, since that request's
 * questions come on it; a hold pins it too.
 *
 * The dock reads the running turns bound to this tab (relayTurnsSnapshot, subscribeRelayTurns):
 * a request of the command line here shows in it, and its composer knows the tab is busy.
 *
 * The core page (core host tools spec C7, 11.1): every app tab publishes its own tools and where
 * it is (src/assistant/coreTools.ts, the `core` slot of src/workspace/assistantTools.ts), so the
 * relay opens its channel on every app tab on this PC (after the status says this PC; never on
 * another PC), not pinned. Its registration goes as `slot: 'core'` after the workspace's work, on
 * each new link and whenever the place, project or study changes (each with its own rev); its
 * calls come as `invoke {…, slot: 'core'}` and run in this page. coreRegisteredOn(link) says the
 * server holds it on that link: the dock then binds its turns to this window from Home and the
 * workbench too.
 */
import { openChannel, type ChannelHandle } from '../api/eventHub';
import type { AssistantRegistration, AssistantStopAnswer, AssistantTurn } from '../plugin-sdk/workspace';
import { confirmAction } from '../workbench/dialogs';
import {
  markWorkspaceFrameDead,
  nextWorkspaceToolsRev,
  pinWorkspaceFrameEpoch,
  settleWorkspaceTools,
  subscribeWorkspaceTools,
  workspaceFrameEpoch,
  workspaceFrameKept,
  workspaceToolsSnapshot,
  type PublishedCore,
  type PublishedTools,
} from '../workspace/assistantTools';
import type { AssistantAttachmentRead, AssistantCallOutcome } from '../workspace/bridge';
import { exitFrameFullscreen } from '../workspace/leaveGuard';
import { setAssistantLinkSource } from './api';
import { refreshStatus, statusSnapshot, subscribeStatus, type StatusSnapshot } from './status';
import type { GateView, RelayFrameData, RelayFrameType, RelayGateBody, RelayProgressBody, RelayResultBody, RelayTool, RelayToolsBody, RelayTurnFrame } from './wire';

/** The channel's name on the tab's event stream (no such route: src/api/eventHub.ts). */
export const RELAY_CHANNEL_URL = '/api/assistant/events?role=relay';
const TOOLS_PATH = '/api/assistant/relay/tools';
const PROGRESS_PATH = '/api/assistant/relay/progress';
const RESULT_PATH = '/api/assistant/relay/result';
const GATE_PATH = '/api/assistant/relay/gate';
const ATTACHMENT_PATH = '/api/assistant/relay/attachment';
/** A running call's result is waited for this long before its list is withdrawn. */
export const RESULT_BEFORE_UNREGISTER_MS = 3000;
/** Progress goes on at most this often (4 a second). */
export const PROGRESS_INTERVAL_MS = 250;
/** The longest hold this page keeps its stream for after the server's word (it says 10 min). */
export const HOLD_MAX_MS = 15 * 60_000;
/** A withdrawal, or a frame's kept list sent again, that got no answer is tried again after this long. */
const RETRY_MS = 1000;
/** A new link shows its open questions again at once: one not shown again by then was closed. */
export const GATE_RESHOWN_MS = 5000;
/** The longest a question stays open here when its expires_at is missing or far off. */
const GATE_MAX_MS = 60 * 60_000;
/** How long a request that needs the window's proof waits for this tab's link (the channel opening). */
export const PROOF_WAIT_MS = 5000;
/** A channel opened for the window's proof stays this long after its last request (Settings sends a few in a row). */
export const PROOF_KEEP_MS = 60_000;
/** How many ended turns this page remembers (a Stop of one answers `ended`). */
const TURNS_ENDED_KEPT = 16;
const TURN_END_STATES: ReadonlySet<string> = new Set(['done', 'stopped', 'failed', 'capped']);

/**
 * Shows a question and resolves with the person's answer, or null when it closed unanswered
 * (`signal`: answered elsewhere, timed out, stopped, or a new link that didn't show it again).
 */
export type GatePresenter = (g: GateView, o: { signal: AbortSignal }) => Promise<boolean | null>;

let presenter: GatePresenter | null = null;

/**
 * The dock shows this tab's questions (one place for them, chat dock spec 4.1); null: the app's
 * confirm dialog again (a page without the dock, unit tests). Answers go through the relay either way.
 */
export function setGatePresenter(fn: GatePresenter | null): void {
  presenter = fn;
}

/** The running turns bound to this tab change: the dock hears it. */
const turnListeners = new Set<() => void>();
let turnsSnap: readonly AssistantTurn[] = Object.freeze([]);

function turnsChanged(r: Relay | null): void {
  turnsSnap = Object.freeze(r ? [...r.turnsRunning.values()] : []);
  for (const fn of [...turnListeners]) {
    try {
      fn();
    } catch (e) {
      console.warn('[CFD] assistant turns', e);
    }
  }
}

/** The turns bound to this tab that the server says run (a request of the command line here too). */
export function relayTurnsSnapshot(): readonly AssistantTurn[] {
  return turnsSnap;
}

export function subscribeRelayTurns(fn: () => void): () => void {
  turnListeners.add(fn);
  return () => {
    turnListeners.delete(fn);
  };
}

/** What the frame hears for an empty list, or when nothing of this page is on the server. */
const NOTHING_HELD: AssistantRegistration = { available: true, accepted: [], refused: [] };
const refusal = (reason: string): AssistantRegistration => ({ available: false, accepted: [], refused: [], reason });

interface Invoke {
  link: string;
  ctl: AbortController;
  /** Settles once its result was sent and answered (or could not be). */
  done: Promise<void>;
}

interface OpenGate {
  ctl: AbortController;
  /** The link it was last shown on. */
  link: string | null;
  /** Closes it at its expires_at. */
  timer: ReturnType<typeof setTimeout>;
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
  gates: Map<string, OpenGate>;
  /** After a new link: closes the questions it did not show again. */
  gateCheck: ReturnType<typeof setTimeout> | null;
  turns: number;
  holdUntil: number;
  holdTimer: ReturnType<typeof setTimeout> | null;
  /** The turns bound to this tab that the server says run, by id (as the frame hears them). */
  turnsRunning: Map<string, AssistantTurn>;
  /** Turns this page heard end, newest last (at most TURNS_ENDED_KEPT). */
  turnsEnded: string[];
  /** After a new link: how many running turns its `active` says come again (null before it), and those that came. */
  relink: { need: number | null; seen: Set<string> } | null;
  /** The page (pageOf) told the running turns: a new one hears them once. */
  turnsToldTo: string | null;
  pinned: boolean;
  kickQueued: boolean;
  unsubscribe: () => void;
  statusOff: (() => void) | null;
  /** Requests waiting for, or sent with, this tab's link as the window's proof: the channel stays while any is. */
  proofs: number;
  /** Counts those requests; a channel is opened for the newest one at most once (a refused one isn't tried again in a loop). */
  proofEpoch: number;
  proofOpenedFor: number;
  /** After the last of them the channel stays until then (ms since 1970), then goes as usual. */
  proofUntil: number;
  proofTimer: ReturnType<typeof setTimeout> | null;
  /** Told whenever the link or the mode may have changed (linkFor). */
  linkWaiters: Set<() => void>;
  /** The dock's holds (holdAssistantLink): the channel stays, pinned, while any is. */
  keeps: number;
  /** The core publication (by its rev) last answered on a link. */
  corePostedOn: { link: string; rev: number } | null;
  /** The link the server took the core registration on (null: none now). */
  coreOn: string | null;
  /** The server may hold a core registration of this page (withdrawn once the page has none). */
  coreHeld: boolean;
  /** A channel refused (or ended by the server) opens again for the core only with a newer publication. */
  coreRefusedRev: number;
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

/**
 * The list the server should hold for this page: the newest one while it may be given; else,
 * while its frame still offers tools, the frame's last taken list (a newer one that was not
 * taken changed nothing for the frame: its bridge and SDK keep the earlier tools and handler).
 */
function wanted(cur: PublishedTools | null): PublishedTools | null {
  if (!cur) return null;
  if (live(cur)) return cur;
  if (cur.tools.length === 0 || cur.dead) return null;
  const kept = workspaceFrameKept(cur.frameId);
  return live(kept) ? kept : null;
}

/** The list wanted has not been answered on this link yet. */
function pendingOn(r: Relay, want: PublishedTools | null, link: string): boolean {
  return !!want && !(r.postedOn && r.postedOn.link === link && r.postedOn.rev === want.rev);
}

/** The server holds a list of this page that must go before anything else is sent. */
function needsWithdraw(r: Relay, want: PublishedTools | null, link: string): boolean {
  if (!r.maybeHeld) return false;
  if (!want) return true;
  return r.heldStale && !pendingOn(r, want, link);
}

/** Tries again in a moment what got no answer (a dropped stream gives a new link meanwhile). */
function retryLater(r: Relay): void {
  if (r.retryTimer) clearTimeout(r.retryTimer);
  r.retryTimer = setTimeout(() => {
    r.retryTimer = null;
    kick();
  }, RETRY_MS);
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
  runOnce(r);
  // A request waiting for the window's proof hears of each change (a link, the status read).
  for (const w of [...r.linkWaiters]) w();
}

function runOnce(r: Relay): void {
  const cur = workspaceToolsSnapshot().current;
  if (r.mode === 'remote') {
    if (cur && !cur.settled) settleWorkspaceTools(cur.rev, refusal('remote'));
    return;
  }
  if (r.mode === 'idle') {
    if (cur && !cur.settled) {
      // Nothing of this page was ever sent: an empty list needs no request.
      if (cur.tools.length === 0) settleWorkspaceTools(cur.rev, NOTHING_HELD);
      else {
        void checkStatus(r);
        return;
      }
    }
    // A request needs the window's proof, the dock holds the link, or the core page offers its
    // tools: the status first (a page from another PC opens nothing).
    if (r.proofs > 0 || r.keeps > 0 || workspaceToolsSnapshot().core) void checkStatus(r);
    return;
  }
  if (r.mode === 'checking') return;
  // A channel the server ended (it said `_closed`): as refused.
  if (r.ch && r.ch.readyState === r.ch.CLOSED) channelGone(r, cur);
  if (cur && !cur.settled && cur.tools.length === 0 && !r.maybeHeld && !r.pumping) settleWorkspaceTools(cur.rev, NOTHING_HELD);
  // Opened for a list to offer, or for the window's proof (once per request: a refused channel isn't asked again in a loop).
  const forProof = (r.proofs > 0 || r.keeps > 0) && r.proofOpenedFor < r.proofEpoch;
  const core = workspaceToolsSnapshot().core;
  const forCore = !!core && core.rev > r.coreRefusedRev;
  if (!r.ch && ((cur && live(cur) && cur.rev > r.refusedRev) || forProof || forCore)) {
    r.proofOpenedFor = r.proofEpoch;
    openRelay(r);
  }
  if (r.ch && r.link) void pump(r);
  tellNewFrame(r);
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
  on('turn', (d) => onTurn(r, d));
  on('invoke', (d) => onInvoke(r, d));
  on('abort', (d) => {
    if (typeof d.call === 'string') r.invokes.get(d.call)?.ctl.abort();
  });
  on('gate', (d) => onGate(r, d));
  on('gate_closed', (d) => {
    if (typeof d.gate === 'string') r.gates.get(d.gate)?.ctl.abort();
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
  // The core registration goes again on this link.
  r.coreOn = null;
  // A new link starts with nothing bound: the server says `active` right after `linked` when
  // turns are bound to this tab or its hold runs (a restarted one, or a hold that ran out while
  // the link was down, has none, and an old count would pin the stream for good).
  r.turns = 0;
  r.holdUntil = 0;
  // The running turns it knew of come again right after `active`: one that does not ended meanwhile.
  r.relink = r.turnsRunning.size ? { need: null, seen: new Set() } : null;
  // A fresh start: what waited for a retry goes now.
  if (r.retryTimer) clearTimeout(r.retryTimer);
  r.retryTimer = null;
  // The open questions are shown again right after `linked`: one that is not was closed meanwhile.
  if (r.gateCheck) clearTimeout(r.gateCheck);
  r.gateCheck = null;
  if (r.gates.size) {
    r.gateCheck = setTimeout(() => {
      r.gateCheck = null;
      if (R !== r || r.link !== link) return;
      for (const g of [...r.gates.values()]) if (g.link !== link) g.ctl.abort();
    }, GATE_RESHOWN_MS);
  }
  kick();
}

function onChannelError(r: Relay, ch: ChannelHandle): void {
  r.link = null;
  r.coreOn = null;
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
  r.corePostedOn = null;
  r.coreOn = null;
  r.coreHeld = false;
  r.coreRefusedRev = Math.max(r.coreRefusedRev, workspaceToolsSnapshot().core?.rev ?? 0);
  if (cur) {
    r.refusedRev = Math.max(r.refusedRev, cur.rev);
    if (!cur.settled) settleWorkspaceTools(cur.rev, refusal('not_connected'));
  }
}

function onUnregistered(r: Relay, d: RelayFrameData['unregistered']): void {
  const reason = typeof d.reason === 'string' && d.reason ? d.reason.slice(0, 64) : 'plugin_off';
  const frame = r.held ? r.held.frameId : workspaceToolsSnapshot().current?.frameId;
  // The server failed the call running here (plugin_off) when it dropped the tools: it stops here too.
  for (const inv of r.invokes.values()) inv.ctl.abort();
  // The server dropped it: nothing to withdraw, and that frame never registers again.
  r.maybeHeld = false;
  r.heldStale = false;
  r.held = null;
  if (frame) markWorkspaceFrameDead(frame, reason);
  kick();
}

/** One registration POST at a time: a withdrawal first when one is due, then the list wanted. */
async function pump(r: Relay): Promise<void> {
  if (r.pumping) return;
  r.pumping = true;
  let sent = false;
  try {
    for (;;) {
      if (R !== r || !r.ch || !r.link || r.retryTimer) break;
      const link = r.link;
      const want = wanted(workspaceToolsSnapshot().current);
      if (needsWithdraw(r, want, link)) {
        sent = true;
        await withdraw(r, link);
        continue;
      }
      if (pendingOn(r, want, link)) {
        sent = true;
        await register(r, link, want as PublishedTools);
        continue;
      }
      // The core page's registration (C7), after the workspace's: each new publication, and again on each link.
      const core = workspaceToolsSnapshot().core;
      if (core && !(r.corePostedOn && r.corePostedOn.link === link && r.corePostedOn.rev === core.rev)) {
        sent = true;
        await registerCore(r, link, core);
        continue;
      }
      if (!core && r.coreHeld) {
        sent = true;
        await withdrawCore(r, link);
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
  return p.tools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    risk: t.risk,
    timeoutS: t.timeoutS,
    ...(t.confirm ? { confirm: t.confirm } : {}),
    ...(typeof t.priority === 'number' ? { priority: t.priority } : {}),
  }));
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
    ...(pub.review ? { review: { rounds: pub.review.rounds, prompt: pub.review.prompt } } : {}),
  };
  // What the server had answered last: a refusal leaves it as it was.
  const before = r.postedOn;
  const a = await post(TOOLS_PATH, body);
  if (R !== r) return;
  const code = codeOf(a);
  if (!a) {
    // No answer: the server may have it or not. A new list's frame is told it was not taken (it
    // registers again later), so the list the frame keeps goes again in its place (or
    // `tools: []` when it keeps none); that list itself is tried again in a moment.
    r.maybeHeld = true;
    r.held = pub;
    settleWorkspaceTools(pub.rev, refusal('not_connected'));
    if (wanted(workspaceToolsSnapshot().current)?.rev === pub.rev) {
      r.postedOn = null;
      r.heldStale = false;
      retryLater(r);
    } else {
      r.postedOn = { link, rev: pub.rev };
      r.heldStale = true;
    }
    return;
  }
  if (a.status === 200) {
    r.postedOn = { link, rev: pub.rev };
    if (typeof a.body.epoch === 'string') pinWorkspaceFrameEpoch(pub.frameId, a.body.epoch);
    const still = wanted(workspaceToolsSnapshot().current)?.rev === pub.rev;
    r.maybeHeld = true;
    r.held = pub;
    // Not wanted any more (abandoned, superseded or gone meanwhile): the server must not keep it
    // (withdrawn, or replaced next by the list wanted).
    r.heldStale = !still;
    if (still) {
      // A frame's kept list that went again was answered long ago: nothing to settle then.
      const accepted = Array.isArray(a.body.accepted) ? a.body.accepted.filter((n): n is string => typeof n === 'string') : [];
      const refused = Array.isArray(a.body.refused) ? (a.body.refused as AssistantRegistration['refused']) : [];
      settleWorkspaceTools(pub.rev, { available: true, accepted, refused });
    }
    return;
  }
  if (a.status === 409 && code === 'no_channel') {
    // The link went before this arrived: the next `linked` sends the list wanted again.
    r.postedOn = null;
    if (r.link === link) r.link = null;
    return;
  }
  if (a.status === 409 && (code === 'plugin_off' || code === 'plugin_changed')) {
    // Its plugin was turned off or replaced: the server dropped this tab's lists of it. Final
    // after a restart too: one that has not read its plugins yet keeps a list unverified.
    r.maybeHeld = false;
    r.heldStale = false;
    r.held = null;
    markWorkspaceFrameDead(pub.frameId, code);
    return;
  }
  // Refused: the server kept what it held. A new list's frame is told (it keeps its earlier
  // list); a kept list sent again is not sent on this link again.
  r.postedOn = pub.taken ? { link, rev: pub.rev } : before;
  settleWorkspaceTools(pub.rev, refusal(code || `http_${a.status}`));
}

/** The core page's registration (slot 'core', C7): where this tab is and its tools. */
async function registerCore(r: Relay, link: string, pub: PublishedCore): Promise<void> {
  const body: RelayToolsBody = {
    link,
    rev: nextWorkspaceToolsRev(),
    slot: 'core',
    workspace: { project_id: pub.scope.project_id, plugin: 'core', workspace: 'app', title: 'Magnusim', study_id: pub.scope.study_id },
    place: pub.scope.place,
    tools: pub.tools.map((t) => ({ ...t })),
    ...(pub.guide ? { guide: pub.guide } : {}),
  };
  const a = await post(TOOLS_PATH, body);
  if (R !== r) return;
  if (!a) {
    // No answer: the server may have it or not; tried again in a moment.
    r.coreHeld = true;
    r.corePostedOn = null;
    retryLater(r);
    return;
  }
  if (a.status === 409 && codeOf(a) === 'no_channel') {
    r.corePostedOn = null;
    if (r.link === link) r.link = null;
    return;
  }
  // Answered: not sent again on this link until it changes (a refusal is the page's own bug, never a loop).
  r.corePostedOn = { link, rev: pub.rev };
  if (a.status === 200) {
    r.coreOn = link;
    r.coreHeld = true;
  } else {
    console.warn('[CFD] assistant core tools refused', codeOf(a) || a.status);
  }
}

/** The core page went: its registration is withdrawn (`tools: []`). */
async function withdrawCore(r: Relay, link: string): Promise<void> {
  const a = await post(TOOLS_PATH, {
    link,
    rev: nextWorkspaceToolsRev(),
    slot: 'core',
    workspace: { project_id: '', plugin: 'core', workspace: 'app', study_id: '' },
    place: 'home',
    tools: [],
  } satisfies RelayToolsBody);
  if (R !== r) return;
  if (!a) {
    retryLater(r);
    return;
  }
  if (a.status === 409 && codeOf(a) === 'no_channel' && r.link === link) r.link = null;
  r.coreHeld = false;
  r.coreOn = null;
  r.corePostedOn = null;
}

/**
 * Whether the server holds this tab's core registration on `link` (C7): a turn the dock starts
 * with that link may bind to this window (`tab: 'link'`), from Home and the workbench too.
 */
export function coreRegisteredOn(link: string | null): boolean {
  const r = R;
  return !!r && !!link && r.coreOn === link && r.link === link && !!workspaceToolsSnapshot().core;
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
    // No answer: again in a moment.
    retryLater(r);
    return;
  }
  if (a.status === 409 && codeOf(a) === 'no_channel') {
    if (r.link === link) r.link = null;
    return;
  }
  // Gone (200), or nothing the server could keep (its plugin went, or a refusal for good):
  // nothing of this page is there, so a list wanted after all goes again.
  r.maybeHeld = false;
  r.heldStale = false;
  r.held = null;
  r.postedOn = null;
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

/**
 * Progress of one call, at most 4 a second: the newest waits for its turn. `alive` is a bare
 * one (a call of the frame in flight), sent unless a progress waits to go anyway. `waiting`
 * is the frame's last progress's (it waits for the person): a sign of life keeps it.
 */
function progressSender(
  link: string,
  call: string,
): { push(fraction: number | null, label: string, opts?: { waiting?: boolean }): void; alive(): void; stop(): void } {
  let last = Number.NEGATIVE_INFINITY;
  let pending: { fraction: number | null; label: string; waiting: boolean } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ended = false;
  let waiting = false;
  const send = () => {
    timer = null;
    if (ended || !pending) return;
    const p = pending;
    pending = null;
    last = Date.now();
    // `fraction` always goes, null when the page gave none: a bare progress() is a sign of life
    // too, and the server counts as progress only a POST that carries a fraction or a label.
    const body: RelayProgressBody = { link, call, fraction: p.fraction, ...(p.label ? { label: p.label } : {}), ...(p.waiting ? { waiting: true as const } : {}) };
    void post(PROGRESS_PATH, body);
  };
  const queue = (fraction: number | null, label: string) => {
    pending = { fraction: typeof fraction === 'number' && Number.isFinite(fraction) ? fraction : null, label: typeof label === 'string' ? label : '', waiting };
    if (timer) return;
    const wait = last + PROGRESS_INTERVAL_MS - Date.now();
    if (wait <= 0) send();
    else timer = setTimeout(send, wait);
  };
  const push = (fraction: number | null, label: string, opts?: { waiting?: boolean }) => {
    if (ended) return;
    waiting = opts?.waiting === true;
    queue(fraction, label);
  };
  return {
    push,
    alive() {
      // A progress that waits to go is a sign of life too, and says more. One while the frame
      // waits for the person waits too: only the frame's own progress says it stopped waiting.
      if (!ended && !pending) queue(null, '');
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
  // A core call runs in this page (C7); else the frame whose list the server took (its answer may
  // still be on its way: the open frame's).
  const core = d.slot === 'core' ? workspaceToolsSnapshot().core : null;
  const pub = d.slot === 'core' ? core : (r.held ?? workspaceToolsSnapshot().current);
  const progress = progressSender(link, call);
  const inv: Invoke = { link, ctl, done: Promise.resolve() };
  r.invokes.set(call, inv);
  updatePin(r);
  const timeoutS = typeof d.timeout_s === 'number' && d.timeout_s > 0 ? d.timeout_s : Number.NaN;
  const turn = typeof d.turn === 'string' ? d.turn : '';
  // The call's place in its step, when the server says it (a turn's own calls).
  const count = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
  const step = count(d.step);
  const callsLeft = count(d.calls_left_in_step);
  const editsLeft = count(d.edits_left_in_step);
  const place = step !== null && step > 0 && callsLeft !== null && editsLeft !== null && editsLeft <= callsLeft ? { step, callsLeftInStep: callsLeft, editsLeftInStep: editsLeft } : {};
  inv.done = (async () => {
    let out: AssistantCallOutcome;
    try {
      out = pub
        ? await pub.invoke({
            call,
            turn,
            tool: String(d.tool ?? ''),
            input: d.input,
            timeoutS,
            signal: ctl.signal,
            onProgress: progress.push,
            onAlive: progress.alive,
            ...place,
            // A workspace frame's call reads its conversation's files on this invoke's own link and call.
            ...(d.slot === 'core' ? {} : { attachment: (id: string, signal: AbortSignal) => readAttachment(link, call, turn, id, signal) }),
          })
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
  // A page error's hint and detail go on as the bridge kept them (cleaned and capped there).
  const body: RelayResultBody = out.ok
    ? { link, call, ok: true, result: out.result }
    : {
        link,
        call,
        ok: false,
        error: { code: out.code, message: out.message, ...(out.hint ? { hint: out.hint } : {}), ...(out.detail !== undefined ? { detail: out.detail } : {}) },
      };
  const a = await post(RESULT_PATH, body);
  if (a && a.status === 413) {
    await post(RESULT_PATH, { link, call, ok: false, error: { code: 'too_large', message: "The tool's result is too large for the app to take." } } satisfies RelayResultBody);
  }
}

/** The server's words for an MCP call's read: it has no conversation, so no attached files. */
const MCP_NO_ATTACHMENT = "An app connected over MCP has no attached files: attachments belong to a conversation in Magnusim's Assistant panel.";

const readRefusal = (code: string, message: string): Error => Object.assign(new Error(message), { code });

/**
 * A file attached in the conversation of the call `call` that came on `link`, for its frame's
 * assistant.attachment: GET /relay/attachment on this invoke's own link and call, never the tab's
 * link now (a new link already stopped the call). A refusal keeps the server's code, but
 * no_channel (the link went, and the call with it) reads not_allowed. An MCP call (its turn
 * `mcp:…`) has no conversation: not_found at once.
 */
async function readAttachment(link: string, call: string, turn: string, id: string, signal: AbortSignal): Promise<AssistantAttachmentRead> {
  if (turn.startsWith('mcp:')) throw readRefusal('not_found', MCP_NO_ATTACHMENT);
  const r = await fetch(`${ATTACHMENT_PATH}?${new URLSearchParams({ call, id })}`, { headers: { 'x-magnusim-link': link }, cache: 'no-store', signal });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { code?: unknown; error?: unknown };
    const code = j.code === 'no_channel' ? 'not_allowed' : typeof j.code === 'string' ? j.code : 'failed';
    throw readRefusal(code, typeof j.error === 'string' && j.error ? j.error : `The file could not be read (${r.status}).`);
  }
  const blob = await r.blob();
  const total = Number(r.headers.get('Content-Length')) || 0;
  if (total && blob.size !== total) throw readRefusal('failed', 'The file did not arrive whole. Try again.');
  let fileName = 'attachment';
  try {
    fileName = decodeURIComponent(r.headers.get('X-File-Name') || '') || fileName;
  } catch {
    /* the default name */
  }
  return { blob, fileName, sha256: r.headers.get('X-Sha256') || '' };
}

/** A gate's copy for the app's dialog: the host's text, then its detail rows. */
function gateCopy(g: GateView): string {
  const rows = Array.isArray(g.detail) ? g.detail.filter((x) => x && typeof x.label === 'string' && typeof x.value === 'string').map((x) => `${x.label}: ${x.value}`) : [];
  return [typeof g.copy === 'string' ? g.copy : '', ...rows].filter(Boolean).join(' · ');
}

function onGate(r: Relay, d: RelayFrameData['gate']): void {
  const g = d.gate;
  if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !g.id) return;
  const known = r.gates.get(g.id);
  if (known) {
    // Shown again (a new link): still open there, one dialog here.
    known.link = r.link;
    return;
  }
  const ctl = new AbortController();
  // The server closes it at its expires_at; a link that is down then never says so.
  const expires = timeOf(g.expires_at);
  const left = expires ? Math.max(0, expires - Date.now()) : GATE_MAX_MS;
  const timer = setTimeout(() => ctl.abort(), Math.min(left, GATE_MAX_MS));
  const open: OpenGate = { ctl, link: r.link, timer };
  r.gates.set(g.id, open);
  updatePin(r);
  void (async () => {
    try {
      await exitFrameFullscreen();
      // Every assistant question is safe (No has the focus, Enter and Escape answer No) and
      // guarded: Allow takes a deliberate click only, never the second of a double-click. The
      // dock's card when it set itself (one place for questions), else the app's dialog.
      const show = presenter;
      const allow = show
        ? await show(g, { signal: ctl.signal })
        : await confirmAction({ title: g.title, copy: gateCopy(g), yes: g.yes, no: g.no, safe: true, guard: true, signal: ctl.signal });
      // Closed on the server meanwhile (answered elsewhere, timed out, stopped): nothing to send.
      if (ctl.signal.aborted) return;
      // Through the link it was (last) shown on: the server takes this tab's answer only there.
      const link = open.link ?? r.link;
      if (!link) return;
      await post(GATE_PATH, { link, gate: g.id, allow: allow === true } satisfies RelayGateBody);
    } catch (e) {
      console.warn('[CFD] assistant question', e);
    } finally {
      clearTimeout(timer);
      if (r.gates.get(g.id) === open) r.gates.delete(g.id);
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
  // A new link's first: this many running turns come again next.
  if (r.relink && r.relink.need === null) {
    r.relink.need = r.turns;
    checkRelink(r);
  }
  updatePin(r);
}

// ---------------------------------------------------------------- turns

/** A `turn` frame as the frame hears it (AssistantTurn), or null when it is not one. */
function turnOf(d: unknown): AssistantTurn | null {
  const x = d && typeof d === 'object' ? (d as Partial<RelayTurnFrame>) : null;
  if (!x || typeof x.id !== 'string' || !x.id || x.id.length > 128 || (x.state !== 'running' && x.state !== 'ended')) return null;
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const used: Partial<RelayTurnFrame['used']> = x.used && typeof x.used === 'object' ? x.used : {};
  const end = x.state === 'ended' && x.end && typeof x.end === 'object' && TURN_END_STATES.has(String(x.end.state)) ? x.end : null;
  return {
    id: x.id,
    state: x.state,
    title: typeof x.title === 'string' ? x.title.slice(0, 60) : '',
    conversation: typeof x.conversation === 'string' && x.conversation && x.conversation.length <= 128 ? x.conversation : null,
    local: x.local === true,
    contextTokens: typeof x.context_tokens === 'number' && Number.isSafeInteger(x.context_tokens) && x.context_tokens > 0 ? x.context_tokens : null,
    images: typeof x.images === 'boolean' ? x.images : null,
    used: {
      steps: count(used.steps),
      stepsCap: count(used.steps_cap),
      changes: count(used.changes),
      changesCap: count(used.changes_cap),
      usd: count(used.usd),
      usdCap: count(used.usd_cap),
      ...(typeof used.usd_left === 'number' && Number.isFinite(used.usd_left) ? { usdLeft: Math.max(0, used.usd_left) } : {}),
    },
    ...(end ? { end: { state: end.state, reason: typeof end.reason === 'string' ? end.reason.slice(0, 80) : '' } } : {}),
    ...reviewOf(x.review),
  };
}

/** A turn frame's review round, kept only when it reads as one (1 <= round <= of <= 5). */
function reviewOf(v: unknown): { review?: { round: number; of: number } } {
  const r = v && typeof v === 'object' ? (v as { round?: unknown; of?: unknown }) : null;
  if (!r || !Number.isInteger(r.round) || !Number.isInteger(r.of)) return {};
  const round = r.round as number;
  const of = r.of as number;
  return round >= 1 && round <= of && of <= 5 ? { review: { round, of } } : {};
}

function onTurn(r: Relay, d: RelayFrameData['turn']): void {
  const turn = turnOf(d);
  if (!turn) return;
  if (turn.state === 'ended') {
    turnEnded(r, turn);
    return;
  }
  r.turnsRunning.set(turn.id, turn);
  r.relink?.seen.add(turn.id);
  turnsChanged(r);
  // A page not told yet hears every running one now (this one too); a page told hears this one.
  if (!tellNewFrame(r)) tellTurn(r, turn);
  checkRelink(r);
}

function turnEnded(r: Relay, turn: AssistantTurn): void {
  r.turnsRunning.delete(turn.id);
  turnsChanged(r);
  r.turnsEnded = [...r.turnsEnded.filter((id) => id !== turn.id), turn.id].slice(-TURNS_ENDED_KEPT);
  tellTurn(r, turn);
}

/** Every running turn of a new link came again: the ones it knew of that did not ended while it was down. */
function checkRelink(r: Relay): void {
  const k = r.relink;
  if (!k || k.need === null || k.seen.size < k.need) return;
  r.relink = null;
  for (const [id, turn] of [...r.turnsRunning]) {
    if (!k.seen.has(id)) turnEnded(r, {
        id,
        state: 'ended',
        title: turn.title,
        conversation: turn.conversation,
        local: turn.local,
        contextTokens: turn.contextTokens,
        images: turn.images,
        used: turn.used,
      });
  }
  // What runs is known again: a page not told yet hears those that run (never the ones that ended meanwhile).
  tellNewFrame(r);
}

/** A publication's page: its frame, and which load of that frame's page (a reload keeps the frame). */
const pageOf = (p: PublishedTools): string => `${p.frameId}#${p.load}`;

/** The open workspace's frame, when it may hear turns (a dead frame, or none, hears nothing). */
function listening(): PublishedTools | null {
  const cur = workspaceToolsSnapshot().current;
  return cur && !cur.dead && cur.tellTurn ? cur : null;
}

function sendTurn(cur: PublishedTools, turn: AssistantTurn): void {
  try {
    cur.tellTurn?.({ ...turn, used: { ...turn.used } });
  } catch (e) {
    console.warn('[CFD] assistant turn', e);
  }
}

/** The open workspace's page hears a turn once it was told the running ones (tellNewFrame). */
function tellTurn(r: Relay, turn: AssistantTurn): void {
  const cur = listening();
  if (cur && pageOf(cur) === r.turnsToldTo) sendTurn(cur, turn);
}

/**
 * A page that offers tools and was not told the running turns yet (a new frame, or the frame's
 * page loaded again) hears them once, as soon as this page knows them: on a link that is not
 * waiting to hear which still run. True when it was told now.
 */
function tellNewFrame(r: Relay): boolean {
  const cur = listening();
  if (!cur || pageOf(cur) === r.turnsToldTo || !r.link || r.relink) return false;
  r.turnsToldTo = pageOf(cur);
  for (const turn of r.turnsRunning.values()) sendTurn(cur, turn);
  return true;
}

/**
 * A frame's Stop of a turn (the bridge's assistant.stop): only a turn the server told this tab of
 * is stopped, through its own Stop route, which answers once it ended (at most 5 s); one this tab
 * heard end, or one that ended another way before the Stop reached it, answers `ended`, any other
 * `not_this_tab`.
 */
export async function stopAnnouncedTurn(turn: string): Promise<AssistantStopAnswer> {
  const r = R;
  if (!r) return { stopped: false, reason: 'not_connected' };
  if (!r.turnsRunning.has(turn)) return { stopped: false, reason: r.turnsEnded.includes(turn) ? 'ended' : 'not_this_tab' };
  const a = await post(`/api/assistant/turns/${encodeURIComponent(turn)}/stop`, {});
  if (!a) return { stopped: false, reason: 'not_connected' };
  if (a.status === 200 && a.body.ok === true) {
    // Stopped (by this Stop or one before it), or still stopping after the route's 5 s. A turn
    // that ended another way first (done, failed, capped: its end still on its way here) was not.
    const turnState = a.body.turn && typeof a.body.turn === 'object' ? (a.body.turn as { state?: unknown }).state : undefined;
    return a.body.stopping === true || turnState === 'stopped' ? { stopped: true } : { stopped: false, reason: 'ended' };
  }
  return { stopped: false, reason: codeOf(a) || `http_${a.status}` };
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
  const want = r.turns > 0 || holding || r.invokes.size > 0 || r.gates.size > 0 || r.keeps > 0;
  if (r.ch && want !== r.pinned) {
    r.pinned = want;
    r.ch.pin(want);
  }
}

/** Nothing offered, nothing on the server, nothing open, no proof wanted: the channel goes (the relay is idle again). */
function maybeClose(r: Relay): void {
  if (!r.ch || r.pumping || r.maybeHeld || r.gates.size || r.proofs > 0 || r.keeps > 0 || Date.now() < r.proofUntil) return;
  // The core page's tools stay offered while this page publishes them (C7).
  if (workspaceToolsSnapshot().core || r.coreHeld) return;
  const cur = workspaceToolsSnapshot().current;
  if (wanted(cur) || (cur && !cur.settled)) return;
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
      gateCheck: null,
      turns: 0,
      holdUntil: 0,
      holdTimer: null,
      turnsRunning: new Map(),
      turnsEnded: [],
      relink: null,
      turnsToldTo: null,
      pinned: false,
      kickQueued: false,
      unsubscribe: () => undefined,
      statusOff: null,
      proofs: 0,
      proofEpoch: 0,
      proofOpenedFor: 0,
      proofUntil: 0,
      proofTimer: null,
      linkWaiters: new Set(),
      // The dock's holds taken before it started (it mounts before the shell starts the relay).
      keeps: dockHolds,
      corePostedOn: null,
      coreOn: null,
      coreHeld: false,
      coreRefusedRev: 0,
    };
    if (dockHolds > 0) r.proofEpoch += 1;
    R = r;
    r.unsubscribe = subscribeWorkspaceTools(kick);
    // The page's calls that need the window's proof get this tab's link from here (api.ts windowPost).
    setAssistantLinkSource(withAssistantLink);
    kick();
  }
  return stopAssistantRelay;
}

/** This tab's live link once there is one (not `avoid`, a link the server just refused), else null after `ms` or on another PC. */
function linkFor(r: Relay, avoid: string | null, ms: number): Promise<string | null> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = (): void => {
      if (R !== r || r.mode === 'remote') finish(null);
      else if (r.ch && r.link && r.link !== avoid) finish(r.link);
    };
    const finish = (link: string | null): void => {
      if (timer) clearTimeout(timer);
      r.linkWaiters.delete(check);
      resolve(link);
    };
    r.linkWaiters.add(check);
    timer = setTimeout(() => finish(null), ms);
    check();
  });
}

/**
 * Runs `use` with this tab's live relay link: the window's proof the server asks for, beside the
 * app's origin, before it adds a custom agent, turns an allow switch on, or tests, connects or
 * signs in a coding agent (and, in phase 4, starts an agent turn from the dock, Home included).
 * Opens the tab's channel for it when no workspace has (once this page's status says this PC),
 * and keeps it while `use` runs and PROOF_KEEP_MS after. `use` gets null when no link came within
 * PROOF_WAIT_MS (another PC, the relay not started, the channel refused): the request then goes
 * without one and the server refuses it. `avoid`: a link the server just refused (stale), never
 * handed out again.
 */
export async function withAssistantLink<T>(use: (link: string | null) => Promise<T>, avoid: string | null = null): Promise<T> {
  const r = R;
  if (!r) return use(null);
  r.proofs += 1;
  r.proofEpoch += 1;
  try {
    kick();
    return await use(await linkFor(r, avoid, PROOF_WAIT_MS));
  } finally {
    r.proofs -= 1;
    if (r.proofs === 0) {
      r.proofUntil = Date.now() + PROOF_KEEP_MS;
      if (r.proofTimer) clearTimeout(r.proofTimer);
      // Then the channel goes as usual (unless a workspace or a question keeps it).
      r.proofTimer = setTimeout(() => {
        r.proofTimer = null;
        if (R === r) kick();
      }, PROOF_KEEP_MS);
    }
    if (R === r) kick();
  }
}

/** The dock's holds (holdAssistantLink), kept apart from any relay: one taken before the relay starts (the dock mounts first) or across its restart still counts. */
let dockHolds = 0;

/**
 * The dock holds this tab's relay channel while a request it started runs (its questions come on
 * it): open (once the status says this PC) and pinned while any hold is. A hold taken before the
 * relay starts applies once it does. Answers its release (once; later calls change nothing).
 */
export function holdAssistantLink(): () => void {
  dockHolds += 1;
  const r = R;
  if (r) {
    r.keeps = dockHolds;
    // A hold opens the channel as the window's proof does (the status first), once per hold.
    r.proofEpoch += 1;
    kick();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    dockHolds = Math.max(0, dockHolds - 1);
    const now = R;
    if (now) {
      now.keeps = dockHolds;
      updatePin(now);
      kick();
    }
  };
}

/** Stops the relay: its channel closes, its questions close unanswered, its calls stop. */
export function stopAssistantRelay(): void {
  const r = R;
  if (!r) return;
  R = null;
  setAssistantLinkSource(null);
  r.unsubscribe();
  r.statusOff?.();
  if (r.proofTimer) clearTimeout(r.proofTimer);
  // A request waiting for the link goes without one.
  for (const w of [...r.linkWaiters]) w();
  for (const g of r.gates.values()) {
    clearTimeout(g.timer);
    g.ctl.abort();
  }
  for (const inv of r.invokes.values()) inv.ctl.abort();
  if (r.holdTimer) clearTimeout(r.holdTimer);
  if (r.retryTimer) clearTimeout(r.retryTimer);
  if (r.gateCheck) clearTimeout(r.gateCheck);
  r.ch?.close();
  r.ch = null;
  turnsChanged(null);
}
