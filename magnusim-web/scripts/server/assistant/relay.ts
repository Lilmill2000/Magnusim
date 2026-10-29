/**
 * The page relay, on the server (Foundation spec 8.4, 7.5): how the Assistant reaches the
 * workspace open in an app tab.
 *
 * A tab's page opens one channel of kind `assistant` on its event stream (event-hub.ts),
 * params {role:'relay'}, from this PC only: 403 when the stream or the subscribe came from
 * elsewhere, 400 for another role. (Role 'turn' is a window following one turn's events:
 * turn-channel.ts, dispatched from open.) Frames to the page:
 *   linked {link}                  always the channel's first frame: 24 random hex, new at
 *                                  each open. Every relay POST carries it (the page never
 *                                  needs its tab id), and the page registers again on each.
 *                                  It is also the page's proof of this account for a coding
 *                                  agent's start, Test, connect and sign-in, a custom agent
 *                                  added and an allow switch turned on (isLiveLink): a tab
 *                                  with no workspace opens its channel for that alone.
 *   active {turns, hold_until}     always the second frame, and again whenever the number of
 *                                  running turns bound to the tab changes. hold_until: ms
 *                                  since 1970, 10 minutes after the tab's last bound turn
 *                                  ended (null before any, and once it passed). The page keeps
 *                                  its channel while turns > 0 or until then; the one at an
 *                                  open tells a page that last heard of a turn (before a
 *                                  restart or a long drop) that none run.
 *   turn {id, state, title, local, context_tokens, images, used, end?}   a turn bound to the tab
 *                                  (turns.ts TurnPageView): state 'running' as it starts and after
 *                                  each change (at most once a second), 'ended' once with `end`
 *                                  {state, reason}; each running one again right after `active` on
 *                                  every new link (as many as its `turns`). Sent before the
 *                                  `active` its start or end changes.
 *   invoke {call, turn, tool, input, timeout_s}   run the page's tool `tool` (its own name)
 *   abort {call}                   Stop, a turn limit, or the call stalled
 *   gate {gate}                    a question (GateView) of a turn bound to this tab, or of
 *                                  an MCP call that ran in it
 *   gate_closed {gate, answer, by} that question was answered, timed out or withdrawn
 *   unregistered {reason}          'plugin_off': the tab's tools are gone; that publication
 *                                  must not register again (a new frame may)
 * POSTs from the page (assistant-routes.ts; each 409 no_channel without a live link):
 *   /relay/tools    {link, rev, slot?, epoch?, workspace:{project_id, plugin, workspace, title?,
 *                   study_id}, place?, tools, guide?, review?:{rounds 1-5, prompt ≤ 1500}} → {ok,
 *                   available:true, accepted, refused, epoch}; tools []
 *                   withdraws them. 409 stale_rev (a lower rev than the slot's last; the same
 *                   rev is taken again, e.g. on a new link), plugin_changed (the frame's pinned
 *                   epoch is no longer its plugin's), plugin_off (a fresh frame, no epoch,
 *                   while the live registry says the plugin is not loaded); 400.
 *                   slot 'core' (core host tools spec C7, 11.2): the tab's core page, beside its
 *                   workspace (slot 'workspace', the default), each with its own rev. Its plugin
 *                   is "core" and `place` says where the tab is (home, workbench, workspace); no
 *                   plugin or epoch check (its epoch is the fixed token `core`). Its calls come
 *                   as `invoke {…, slot:'core'}`, one at a time per tab with the workspace's.
 *   /relay/progress {link, call, ack?, fraction?, label?, waiting?} → {ok} | {ok, stale:true}
 *   /relay/result   {link, call, ok, result? | error?}    → {ok} | {ok, stale:true}
 *   /relay/gate     {link, gate, allow} → {ok}: the person's answer to a question this link
 *                   was sent (the tab that shows it). 403 not_shown (never sent on this link,
 *                   or not this tab's), 409 {already}, 400.
 * And GET /relay/attachment ?call&id, the link in x-magnusim-link: a file attached in the
 *                   conversation of the workspace call running on that link (attachmentCall says
 *                   which conversation, or why none; the route reads the file).
 *
 * - Registrations go into the tool registry (one per tab), so a turn bound to the tab is
 *   offered only that tab's tools. Each accepted one has its own id: a tool of an earlier
 *   one (still in a step's offered list) never reaches the page. The epoch token answered on
 *   acceptance is the server's boot id, the plugin's epoch and a hash of its key: a later
 *   POST of the frame carries it, a changed epoch is refused (`plugin_changed`), and after
 *   a server restart (another boot id) the POST counts as fresh again.
 * - While the live registry can't say yet whether a plugin is loaded (none is loaded, or a
 *   registry-changing worker call answered and the registry has not been read again since:
 *   a plugin just turned off may still be listed), a registration is kept but offered to
 *   nobody; once the registry is read it is offered, or goes as on a bump (`unregistered`)
 *   when its plugin is not loaded.
 * - A link that goes leaves its tab's registration dormant (connected:false, offered to
 *   nobody) for the hold time (the dormant time under its test switch); the same tab's next
 *   link and re-POST bring it back.
 * - One call at a time per tab (`busy`). An invoke whose frame can't be sent fails at once
 *   (`tab_disconnected`); one the page doesn't acknowledge in 10 s too (a half-open
 *   connection), and its link then counts as silent: not connected (offered to nobody, a
 *   turn on it 409 tab_hidden, its questions unseen) until any POST on it shows the page is
 *   there, or it ends (dormant for the hold). The stall window is the runner's (runner.ts),
 *   reset by progress: a bare one ({fraction: null}) is the page's sign of life while its
 *   frame waits on a call to the app (the bridge's onAlive); `waiting: true` says the call
 *   waits for the person (the runner stops the turn's minutes until a progress without it).
 *   Stop sends `abort` and waits up to 2 s for the page's last answer; the runner giving up on the call (its `released`)
 *   frees the tab at once.
 * - The page withdraws its tools (tools []) after a call's result; a withdrawal that finds a
 *   call still running gives its result 2 s (then `closed`). A channel or stream that just
 *   ends fails the call at once (`tab_disconnected`): its cleanup can't tell why it ended.
 * - A plugin turned off, swapped or reset (foam-runner.js bumpPluginEpoch) drops its
 *   registrations in every tab, fails their calls (`plugin_off`) and tells each page
 *   `unregistered`, synchronously, before the worker answers.
 * - Gates of a turn shown in a tab (its showTab: the window that started it, else its bound
 *   tab), and of an MCP call that ran in one (any owner gates.ts tabOf gives a tab), are shown
 *   there (the GateBroker's presenter): sent to its
 *   live link, sent again when its link returns; the broker notes an unseen one after 15 s.
 *   Each link remembers the gates it was sent: the page answers one only on such a link,
 *   while it is its tab's live link (the turn's answer key is the other way, turns.ts).
 * - The relay closing (its server's close) ends the running turns its manager started that
 *   are bound to a tab, before it lets go of their links: after a Vite restart the new
 *   server's relay could neither hear them end nor show their questions.
 *
 * The relay's links and registrations belong to the server that made it (as the registry's
 * do); a test reset of the Assistant's state leaves them, so open pages stay linked.
 */
import { createHash, randomBytes } from 'node:crypto';
import { onPluginEpochBump } from '../../foam-runner.js';
import { liveRegistryLoaded, mesherEntries, pluginLoaded as livePluginLoaded } from '../../registry-defaults.js';
import type { ChannelMeta, ChannelOpened, ChannelSend } from '../event-hub.ts';
import { assistantAccess, REMOTE_MESSAGE } from './access.ts';
import { NO_SUCH_ATTACHMENT_TEXT } from './attachments.ts';
import { MCP_NO_ATTACHMENT } from './host/import-file.ts';
import { realClock, tabOf, type Clock, type GateAnswer, type GateClosedBy, type GateOwner, type GatePresenter, type GateView } from './gates.ts';
import { assistantHomeIsOverridden } from './home.ts';
import { alog } from './log.ts';
import { REVIEW_PROMPT_MAX, REVIEW_ROUNDS_MAX, reviewOf, type CoreEscalation, type CorePlace, type ProgressOptions, type Registry, type StepInfo, type ToolOutcome } from './registry.ts';
import { rememberJob } from './host/turn-jobs.ts';
import { leaveTargetOf, type LeaveTargetFn } from './link-target.ts';
import { ABORT_GRACE_MS } from './runner.ts';
import { cleanText, ERROR_DETAIL_BYTES, IMAGE_CAPS, TEXT_CAPS } from './sanitize.ts';
import { assistantState } from './state.ts';
import { NOT_SHOWN_TEXT, type Turn, type TurnManager } from './turns.ts';
import { openTurnChannel } from './turn-channel.ts';
import type { ImagePart } from './types.ts';

export const LINK_RE = /^[0-9a-f]{24}$/;
/** An invoke the page doesn't acknowledge this soon fails `tab_disconnected` (a half-open connection). */
export const RELAY_ACK_MS = 10_000;
/** How long a tab is held after its last bound turn, and a dropped link's registration kept. */
export const ASSISTANT_HOLD_MS = 10 * 60_000;
/** A withdrawal (tools []) that finds a call running gives its result this long. */
export const UNREGISTER_GRACE_MS = 2_000;
/**
 * How long, after a registry-changing worker call answered, registrations wait for the live
 * registry to be read again (index.ts reads it then, within its 60 s bound); after that the
 * copy in place decides.
 */
export const REGISTRY_REFRESH_WAIT_MS = 2 * 60_000;
/**
 * What a page's tool result may hold (as the bridge checks it in the page): its text and data
 * (bytes), images, a summary (characters), and an error's hint (characters) and detail (bytes).
 */
export const RESULT_CAPS = Object.freeze({
  text: 64 * 1024,
  data: 256 * 1024,
  images: IMAGE_CAPS.perResult,
  imageBytes: IMAGE_CAPS.bytes,
  summary: 160,
  hint: 500,
  detail: ERROR_DETAIL_BYTES,
});
/** The codes a page's error may carry (the page's own and the host bridge's); anything else is `failed`. */
export const PAGE_RESULT_CODES: ReadonlySet<string> = new Set([
  'invalid_input',
  'busy',
  'not_ready',
  'failed',
  'no_tool',
  'aborted',
  'closed',
  'stalled',
  'leaving',
  'too_large',
  'bad_result',
]);
/**
 * The codes a core page tool's error may carry besides those (core host tools spec 2.6, 5); the
 * keybind tools' (src/assistant/keybindTools.ts) are the CAD Part's own keybind tools' words.
 */
export const CORE_RESULT_CODES: ReadonlySet<string> = new Set([
  'person_busy',
  'cancelled_by_person',
  'not_found',
  'deferred',
  'no_project',
  'unavailable',
  'not_asked',
  'step_declined',
  'key_taken',
  'changed',
]);
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp']);
const PLUGIN_KEY = /^[A-Za-z0-9._-]{1,64}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CALL = /^[A-Za-z0-9._:-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const TOKEN = /^([0-9a-f]{8,64}):([0-9]{1,15}\.[0-9]{1,15}):([0-9a-f]{8})$/;
const SWITCH_MAX_MS = 60 * 60_000;

export const NO_CHANNEL_TEXT = "This page's assistant channel is not open (it closed, or the server restarted). Wait for its next linked frame.";

// ---------------------------------------------------------------- test switches

/** The relay's test switches (null: not in use). */
export interface RelaySwitches {
  holdMs: number | null;
  ackMs: number | null;
  dormantMs: number | null;
}

/**
 * MAGNUSIM_TEST_ASSISTANT_HOLD_MS, MAGNUSIM_TEST_ASSISTANT_ACK_MS and
 * MAGNUSIM_TEST_ASSISTANT_DORMANT_MS (whole milliseconds, 1 to 3600000): the hold, the ack
 * window, and how long a dropped link's registration is kept (the hold otherwise), for browser
 * tests. A test with a short hold keeps a dropped tab dormant long enough to look at it.
 * Honoured only with MAGNUSIM_TEST_ASSISTANT=1 in a test home, like every Assistant test switch.
 */
export function resolveRelaySwitches(env: NodeJS.ProcessEnv): RelaySwitches & { ignored: string[] } {
  const out: RelaySwitches & { ignored: string[] } = { holdMs: null, ackMs: null, dormantMs: null, ignored: [] };
  const names = [
    ['MAGNUSIM_TEST_ASSISTANT_HOLD_MS', 'holdMs'],
    ['MAGNUSIM_TEST_ASSISTANT_ACK_MS', 'ackMs'],
    ['MAGNUSIM_TEST_ASSISTANT_DORMANT_MS', 'dormantMs'],
  ] as const;
  for (const [name, field] of names) {
    const raw = String(env[name] ?? '').trim();
    if (!raw) continue;
    if (env.MAGNUSIM_TEST_ASSISTANT !== '1') {
      out.ignored.push(`${name} is ignored without MAGNUSIM_TEST_ASSISTANT=1`);
      continue;
    }
    if (!assistantHomeIsOverridden({ env })) {
      out.ignored.push(`${name} is ignored outside a test home (MAGNUSIM_ASSISTANT_HOME or MAGNUSIM_LOCAL_JSON)`);
      continue;
    }
    const n = Number(raw);
    if (!/^[0-9]{1,7}$/.test(raw) || n < 1 || n > SWITCH_MAX_MS) {
      out.ignored.push(`${name} is ignored: it needs a whole number of milliseconds from 1 to ${SWITCH_MAX_MS}`);
      continue;
    }
    out[field] = n;
  }
  return out;
}

let switches: RelaySwitches | null = null;

/** The relay's test switches, read once (null when not in use). */
export function relaySwitches(): RelaySwitches {
  if (!switches) {
    const r = resolveRelaySwitches(process.env);
    for (const why of r.ignored) alog('warn', why);
    switches = { holdMs: r.holdMs, ackMs: r.ackMs, dormantMs: r.dormantMs };
  }
  return switches;
}

// ---------------------------------------------------------------- texts

const disconnectedText = (ws: string) =>
  `The page hosting ${ws} disconnected while the tool ran; it may or may not have finished. Read its state again before retrying.`;
const notSentText = (ws: string) => `The page hosting ${ws} isn't connected, so the tool did not run.`;
const pluginOffText = (name: string) => `${name} was turned off or replaced while the tool ran; it may or may not have finished.`;
const closedText = (ws: string) => `${ws}: its page closed before the tool finished; it may or may not have finished.`;
const busyText = (ws: string) => `${ws} is already running a tool call; wait for its result, then call again.`;
const OTHER_TOOLS_TEXT = "This tab's workspace offered other tools since this one was offered; use the tools offered now.";

// ---------------------------------------------------------------- the relay

type Answer = { status: number; body: Record<string, unknown> };

const ok = (body: Record<string, unknown> = {}): Answer => ({ status: 200, body: { ok: true, ...body } });
const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Answer => ({
  status,
  body: { ok: false, code, error, ...extra },
});

function fail(code: string, message: string): ToolOutcome {
  return { ok: false, error: { code, message }, summary: message };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const pluginHash = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 8);

/** A loaded plugin's row (registry-defaults.js pluginLoaded), or null when it is off, failed or unknown. */
export type PluginLoaded = (key: string) => { name?: unknown } | null | undefined;

/**
 * The live registry read in place, as a value that changes at each read: its mesher list is
 * a new array every time setLiveRegistry installs a doc (registry-defaults.js). Null while
 * none is loaded.
 */
function liveRegistryRead(): object | null {
  return liveRegistryLoaded() ? (mesherEntries() as object) : null;
}

interface LinkRec {
  link: string;
  tab: string;
  cid: string;
  send: ChannelSend;
  done: () => void;
  open: boolean;
  /** An invoke on it went unacknowledged: nothing goes to it until the page is heard again. */
  silent: boolean;
  /** The gates sent on it (oldest first, at most GATES_SENT_MAX): only these may be answered on it. */
  gatesSent: Set<string>;
}

/** The most gate ids one link remembers having been sent. */
const GATES_SENT_MAX = 500;

interface Pending {
  call: string;
  tab: string;
  link: string;
  /** The registration it runs in: the workspace's (plugin and epoch checks), or the core page's. */
  slot: 'workspace' | 'core';
  plugin: string;
  pluginName: string;
  epoch: string;
  workspace: string;
  /** The call's turn (`mcp:<connection>` for an MCP call) and its conversation (null: none, so no attachments). */
  turn: string | null;
  conversation: string | null;
  progress(fraction: number | null, label: string, opts?: ProgressOptions): void;
  resolve(o: ToolOutcome): void;
  acked: boolean;
  aborted: boolean;
  unregistering: boolean;
  done: boolean;
  ackTimer: unknown;
  abortTimer: unknown;
  unregisterTimer: unknown;
  offAbort: (() => void) | null;
}

interface TabRec {
  tab: string;
  /** The live link (the newest channel of the tab), or null. */
  link: LinkRec | null;
  /** The highest rev taken. */
  rev: number;
  /**
   * The registration in the registry: its id, the link it came on and what it is (`workspace`:
   * its title, for the texts). unverified: made while the live registry could not say whether
   * its plugin is loaded.
   */
  reg: { id: number; link: string; plugin: string; pluginName: string; workspace: string; epoch: string; unverified: boolean } | null;
  /** Its link went: kept, offered to nobody, until dormantTimer. */
  dormant: boolean;
  dormantTimer: unknown;
  /** When the registration became connected or dormant (ms since 1970). */
  since: number;
  pending: Pending | null;
  /** Running turns bound to the tab, as last sent. */
  turns: number;
  holdUntil: number | null;
  holdTimer: unknown;
  /** The core page's registration (C7): the link it came on; dormant while that link is gone (kept for the dormant time). */
  core: { link: string; dormant: boolean } | null;
  /** The highest core rev taken. */
  coreRev: number;
  coreTimer: unknown;
}

/** A tab as the test state route shows it (Relay.snapshot). */
export interface RelayTabSnapshot {
  connected: boolean;
  dormant: boolean;
  tools: number;
  pending: number;
  rev: number;
  turns: number;
  hold_until: number | null;
  /** What is left of its hold now, on the relay's own clock (null: none). */
  hold_left_ms: number | null;
  /** Its core page's registration is there and connected (C7). */
  core: boolean;
}

/** One call of a page's tool, as the registry asks for it. */
export interface InvokeCall {
  tool: string;
  input: Record<string, unknown>;
  timeoutS: number;
  signal: AbortSignal;
  /** The runner stopped waiting for the call (runner.ts): the tab is free at once. */
  released?: AbortSignal;
  turn: string | null;
  /** The turn's conversation: its attachments are what the page may read while the call runs (none when absent or null). */
  conversation?: string | null;
  /** Its place in its step (a turn's own calls): the page hears step, calls_left_in_step and edits_left_in_step. */
  step?: StepInfo;
  progress(fraction: number | null, label: string, opts?: ProgressOptions): void;
}

export interface RelayOptions {
  registry: Registry;
  turns: TurnManager;
  clock?: Clock;
  holdMs?: number;
  ackMs?: number;
  /** How long a dropped link's registration is kept (the hold when left out). */
  dormantMs?: number;
  unregisterGraceMs?: number;
  abortGraceMs?: number;
  pluginLoaded?: PluginLoaded;
  /** The live registry read in place (changes at each read; null while none is loaded). */
  liveRegistry?: () => object | null;
  /** Hears the worker's 'registry-changed': a registry-changing call answered, and the live registry is read again after it. */
  onRegistryChanged?: (fn: () => void) => () => void;
  /** foam-runner.js onPluginEpochBump (tests may pass their own). */
  onEpochBump?: (fn: (key: string) => void) => () => void;
  /** Leave the turns' gate presenter as it is (a test gave its own). */
  keepPresenter?: boolean;
  /** Where a Back from a workspace sends its design (the leave card's names); link-target.ts when left out. */
  leaveTarget?: LeaveTargetFn;
}

/**
 * A core__show that left a workspace and answered its link job (`data.job: 'link.<gl-...>'`):
 * recorded for the turn with the workspace's plugin and study, so `wait` can follow it and the
 * turn's end names it while it runs.
 */
function rememberLinkJob(turn: string | null, out: ToolOutcome, reg: { plugin: string; pluginName?: string; workspace: string; workspaceName?: string; projectId: string; studyId: string }, since: string): void {
  const data = out.ok && out.data && typeof out.data === 'object' ? (out.data as Record<string, unknown>) : null;
  const job = typeof data?.job === 'string' ? data.job : '';
  const m = /^link\.(gl-[A-Za-z0-9._-]{1,90})$/.exec(job);
  if (!m || !reg.projectId || !reg.studyId) return;
  const from = cleanText(`${reg.pluginName || reg.plugin} ${reg.workspaceName || reg.workspace}`, 80);
  rememberJob(turn, {
    job_id: job,
    kind: 'link',
    id: m[1],
    name: `Geometry update from ${from}`,
    project_id: reg.projectId,
    simulation_id: '',
    plugin: reg.plugin,
    study_id: reg.studyId,
    since,
    last: 'running',
  });
}

export class Relay {
  readonly holdMs: number;
  readonly ackMs: number;
  readonly dormantMs: number;
  readonly presenter: GatePresenter;
  private readonly registry: Registry;
  private readonly turns: TurnManager;
  private readonly clock: Clock;
  private readonly graceMs: number;
  private readonly abortGraceMs: number;
  private readonly pluginLoaded: PluginLoaded;
  private readonly leaveTarget: LeaveTargetFn;
  private readonly liveRegistry: () => object | null;
  private readonly links = new Map<string, LinkRec>();
  private readonly tabs = new Map<string, TabRec>();
  private readonly offBump: () => void;
  private readonly offTurns: () => void;
  private readonly offRegistry: () => void;
  /** A registry-changing worker call answered while this read was in place. */
  private refresh: { read: object | null; at: number } | null = null;
  private serial = 0;
  private regSerial = 0;
  private closed = false;

  constructor(o: RelayOptions) {
    const sw = relaySwitches();
    this.registry = o.registry;
    this.turns = o.turns;
    this.clock = o.clock ?? realClock;
    this.holdMs = o.holdMs ?? sw.holdMs ?? ASSISTANT_HOLD_MS;
    this.ackMs = o.ackMs ?? sw.ackMs ?? RELAY_ACK_MS;
    this.dormantMs = o.dormantMs ?? sw.dormantMs ?? this.holdMs;
    this.graceMs = o.unregisterGraceMs ?? UNREGISTER_GRACE_MS;
    this.abortGraceMs = o.abortGraceMs ?? ABORT_GRACE_MS;
    this.pluginLoaded = o.pluginLoaded ?? ((key: string) => livePluginLoaded(key));
    this.liveRegistry = o.liveRegistry ?? liveRegistryRead;
    this.leaveTarget = o.leaveTarget ?? leaveTargetOf;
    this.presenter = Object.freeze({
      present: (view: GateView, owner: GateOwner) => this.presentGate(view, owner),
      withdraw: (view: GateView, owner: GateOwner, closed: { answer: GateAnswer; by: GateClosedBy }) => this.withdrawGate(view, owner, closed),
    });
    if (!o.keepPresenter) this.turns.gates.setPresenter(this.presenter);
    this.turns.setTabInfo((tab) => this.tabInfo(tab));
    this.offTurns = this.turns.onTurnChange((t, change) => {
      if (!t.tab) return;
      // Its page hears the turn first, then the tab's count its start or end changed.
      this.sendTurn(t.tab, t);
      if (change !== 'updated') this.turnsChanged(t.tab);
    });
    this.offBump = (o.onEpochBump ?? onPluginEpochBump)((key: string) => this.onEpochBump(key));
    this.offRegistry = o.onRegistryChanged ? o.onRegistryChanged(() => this.registryChanged()) : () => {};
  }

  // ------------------------------------------------------------ the channel

  /** Opens the `assistant` channel of a tab (event-hub.ts's open for that kind). */
  open(params: Record<string, unknown>, send: ChannelSend, done: () => void, meta: ChannelMeta): ChannelOpened {
    // Both the tab's stream and this subscribe, through the Assistant's one access predicate.
    if (!assistantAccess(meta.streamReq) || !assistantAccess(meta.req)) return { ok: false, status: 403, error: REMOTE_MESSAGE };
    // A window following a turn (turn-channel.ts): its own checks, its own frames.
    if (params.role === 'turn') return openTurnChannel(this.turns, params, send, done, meta);
    if (params.role !== 'relay') return { ok: false, status: 400, error: "The assistant channel's role must be 'relay' or 'turn'." };
    if (this.closed) return { ok: false, status: 503, error: 'The Assistant is stopping.' };
    // A newer channel of the same tab takes over from an older one still open.
    const old = this.tabs.get(meta.tab)?.link;
    if (old) this.linkGone(old);
    const t = this.tabRec(meta.tab);
    const rec: LinkRec = { link: randomBytes(12).toString('hex'), tab: meta.tab, cid: meta.cid, send, done, open: true, silent: false, gatesSent: new Set() };
    this.links.set(rec.link, rec);
    t.link = rec;
    send('linked', { link: rec.link });
    const n = this.turns.activeForTab(meta.tab);
    t.turns = n;
    // Always, none and no hold too: a page that last heard of a bound turn (before a server
    // restart, or a drop longer than the hold) learns that none run and lets its channel go.
    send('active', { turns: n, hold_until: this.liveHold(t) });
    // Its running turns again, right after: one the page knew of and does not hear now ended meanwhile.
    for (const turn of this.turns.runningForTab(meta.tab)) send('turn', turn.pageView());
    // Questions of its turns that waited for it are shown now.
    this.turns.gates.tabLinked(meta.tab);
    return { ok: true, cleanup: () => this.linkEnded(rec) };
  }

  private tabRec(tab: string): TabRec {
    let t = this.tabs.get(tab);
    if (!t) {
      t = { tab, link: null, rev: 0, reg: null, dormant: false, dormantTimer: null, since: this.clock.now(), pending: null, turns: 0, holdUntil: null, holdTimer: null, core: null, coreRev: 0, coreTimer: null };
      this.tabs.set(tab, t);
    }
    return t;
  }

  private liveLink(link: unknown): LinkRec | null {
    if (typeof link !== 'string' || !LINK_RE.test(link)) return null;
    const rec = this.links.get(link);
    if (!rec || !rec.open || this.tabs.get(rec.tab)?.link !== rec) return null;
    return rec;
  }

  /** The hub ended the channel (unsubscribe, a new stream, the stream closed). */
  private linkEnded(rec: LinkRec): void {
    if (!rec.open) return;
    this.linkGone(rec);
  }

  private linkGone(rec: LinkRec): void {
    rec.open = false;
    this.links.delete(rec.link);
    const t = this.tabs.get(rec.tab);
    if (!t) return;
    const p = t.pending;
    if (p && p.link === rec.link && !p.done) {
      // A withdrawal already said the page is closing; else the channel just went.
      this.finish(p, p.unregistering ? fail('closed', closedText(p.workspace)) : fail('tab_disconnected', disconnectedText(p.workspace)));
    }
    if (t.reg && t.reg.link === rec.link && !t.dormantTimer) {
      // A silent link's registration is already not connected: its hold starts now.
      if (!t.dormant) {
        this.registry.setConnected(t.tab, rec.link, false);
        t.dormant = true;
        t.since = this.clock.now();
      }
      t.dormantTimer = this.clock.setTimeout(() => this.expireDormant(t), this.dormantMs);
    }
    if (t.core && t.core.link === rec.link && !t.coreTimer) {
      if (!t.core.dormant) {
        this.registry.setCoreConnected(t.tab, rec.link, false);
        t.core.dormant = true;
      }
      t.coreTimer = this.clock.setTimeout(() => this.expireCore(t), this.dormantMs);
    }
    if (t.link === rec) {
      t.link = null;
      this.turns.gates.tabUnlinked(t.tab);
    }
    this.maybeForget(t);
  }

  /**
   * An invoke on the link went unacknowledged (a half-open connection, or a page that can't
   * answer): its registration is not connected and its questions count as unseen until a
   * POST on the link shows the page is there (heard), or the link ends (linkGone: the hold).
   */
  private linkSilent(rec: LinkRec): void {
    const t = this.tabs.get(rec.tab);
    if (!rec.open || rec.silent || !t || t.link !== rec) return;
    rec.silent = true;
    if (t.reg && t.reg.link === rec.link && !t.dormant) {
      this.registry.setConnected(t.tab, rec.link, false);
      t.dormant = true;
      t.since = this.clock.now();
    }
    if (t.core && t.core.link === rec.link && !t.core.dormant) {
      this.registry.setCoreConnected(t.tab, rec.link, false);
      t.core.dormant = true;
    }
    this.turns.gates.tabUnlinked(t.tab);
  }

  /** A POST on a link: its page is there. A silent link is connected again and its questions shown. */
  private heard(rec: LinkRec): void {
    if (!rec.silent) return;
    rec.silent = false;
    const t = this.tabs.get(rec.tab);
    if (!t || t.link !== rec) return;
    if (t.reg && t.reg.link === rec.link && t.dormant) {
      this.clearDormant(t);
      this.registry.setConnected(t.tab, rec.link, true);
      t.since = this.clock.now();
    }
    if (t.core && t.core.link === rec.link && t.core.dormant) {
      this.clock.clearTimeout(t.coreTimer);
      t.coreTimer = null;
      t.core.dormant = false;
      this.registry.setCoreConnected(t.tab, rec.link, true);
    }
    this.turns.gates.tabLinked(t.tab);
  }

  private expireDormant(t: TabRec): void {
    t.dormantTimer = null;
    if (t.reg && t.dormant) {
      this.registry.setWorkspace(t.tab, t.reg.link, null);
      t.reg = null;
      t.dormant = false;
    }
    this.maybeForget(t);
  }

  /** A core registration dormant for its whole time goes. */
  private expireCore(t: TabRec): void {
    t.coreTimer = null;
    if (t.core && t.core.dormant) {
      this.registry.setCore(t.tab, t.core.link, null);
      t.core = null;
    }
    this.maybeForget(t);
  }

  private clearDormant(t: TabRec): void {
    this.clock.clearTimeout(t.dormantTimer);
    t.dormantTimer = null;
    t.dormant = false;
  }

  /** Forgets a tab with nothing left: no link, registration, call, bound turn or hold. */
  private maybeForget(t: TabRec): void {
    if (t.link || t.reg || t.core || t.pending || t.turns > 0 || this.tabs.get(t.tab) !== t) return;
    if (this.liveHold(t) !== null) return;
    this.clock.clearTimeout(t.holdTimer);
    this.clock.clearTimeout(t.dormantTimer);
    this.clock.clearTimeout(t.coreTimer);
    this.tabs.delete(t.tab);
  }

  private liveHold(t: TabRec): number | null {
    return t.holdUntil !== null && t.holdUntil > this.clock.now() ? t.holdUntil : null;
  }

  // ------------------------------------------------------------ the live registry

  private registryChanged(): void {
    this.refresh = { read: this.liveRegistry(), at: this.clock.now() };
  }

  /**
   * Whether the live registry may not say yet which plugins are loaded: none is loaded, or a
   * registry-changing worker call answered and the registry has not been read again since
   * (bounded, in case that read failed).
   */
  private registryUnsure(): boolean {
    const read = this.liveRegistry();
    if (read === null) return true;
    const r = this.refresh;
    if (!r) return false;
    if (r.read !== read || this.clock.now() - r.at >= REGISTRY_REFRESH_WAIT_MS) {
      this.refresh = null;
      return false;
    }
    return true;
  }

  /**
   * Whether the tab's registration `id` may be offered and run now. One made while the live
   * registry could not say waits for it; then it is confirmed, or, its plugin not loaded,
   * goes as on a bump: at once with `dropNow`, else just after (the registry asks this while
   * it reads its own tables, in toolsFor).
   */
  private regReady(tab: string, id: number, dropNow = false): true | { code: string; message: string } {
    const reg = this.tabs.get(tab)?.reg;
    if (!reg || reg.id !== id) return { code: 'unavailable', message: OTHER_TOOLS_TEXT };
    if (!reg.unverified) return true;
    if (this.registryUnsure()) return { code: 'unavailable', message: `${reg.pluginName} is still being loaded; its tools are offered once it is.` };
    if (this.pluginLoaded(reg.plugin)) {
      reg.unverified = false;
      return true;
    }
    const drop = () => {
      const t = this.tabs.get(tab);
      if (!t || t.reg !== reg) return;
      this.dropReg(t);
      this.maybeForget(t);
    };
    if (dropNow) drop();
    else queueMicrotask(drop);
    return { code: 'plugin_off', message: `${reg.pluginName} is not turned on.` };
  }

  /** The tab's registration goes because its plugin did: its call fails and its page hears `unregistered`. */
  private dropReg(t: TabRec): void {
    const reg = t.reg;
    if (!reg) return;
    const p = t.pending;
    if (p && !p.done && p.slot === 'workspace' && p.plugin === reg.plugin) this.finish(p, fail('plugin_off', pluginOffText(p.pluginName)));
    this.registry.setWorkspace(t.tab, reg.link, null);
    t.reg = null;
    this.clearDormant(t);
    const l = t.link;
    if (l && l.open) l.send('unregistered', { reason: 'plugin_off' });
  }

  // ------------------------------------------------------------ registrations

  /** POST /api/assistant/relay/tools. */
  register(body: Record<string, unknown>): Answer {
    if (typeof body.link !== 'string') return refuse(400, 'bad_request', "link is the channel's link (its linked frame).");
    const rec = this.closed ? null : this.liveLink(body.link);
    if (!rec) return refuse(409, 'no_channel', NO_CHANNEL_TEXT);
    this.heard(rec);
    const rev = body.rev;
    if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 1) return refuse(400, 'bad_request', 'rev is a whole number from 1.');
    if (!Array.isArray(body.tools)) return refuse(400, 'bad_request', 'tools is a list ([] withdraws them).');
    if (body.guide !== undefined && body.guide !== null && typeof body.guide !== 'string') return refuse(400, 'bad_request', 'guide is text.');
    if (body.slot !== undefined && body.slot !== null && body.slot !== 'workspace' && body.slot !== 'core') return refuse(400, 'bad_request', "slot is 'workspace' or 'core'.");
    if (body.slot === 'core') return this.registerCore(rec, rev, body);
    // A review the page's bridge checked: {rounds 1-5, prompt}, the prompt text of at most 1500 characters.
    const askedReview = body.review !== undefined && body.review !== null;
    const rawPrompt = askedReview && typeof body.review === 'object' ? (body.review as { prompt?: unknown }).prompt : undefined;
    const review = askedReview && typeof rawPrompt === 'string' && rawPrompt.length <= REVIEW_PROMPT_MAX ? reviewOf(body.review) : null;
    if (askedReview && !review) return refuse(400, 'bad_request', `review is {rounds: 1 to ${REVIEW_ROUNDS_MAX}, prompt: text of at most ${REVIEW_PROMPT_MAX} characters}.`);
    if (body.epoch !== undefined && body.epoch !== null && typeof body.epoch !== 'string') return refuse(400, 'bad_request', 'epoch is the token an earlier answer gave.');
    const t = this.tabRec(rec.tab);
    if (rev < t.rev) return refuse(409, 'stale_rev', 'A newer list of this page was already received.', { rev: t.rev });
    if (body.tools.length === 0) {
      t.rev = rev;
      this.withdraw(t);
      return ok({ available: true, accepted: [], refused: [], epoch: typeof body.epoch === 'string' && body.epoch ? body.epoch : null });
    }
    const ws = parseWorkspace(body.workspace);
    if (typeof ws === 'string') return refuse(400, 'bad_request', ws);

    // The frame's plugin, still the one it pinned (or, for a fresh frame, loaded now).
    const current = this.registry.currentEpoch(ws.plugin);
    const boot = assistantState().bootId;
    const loaded = this.pluginLoaded(ws.plugin) ?? null;
    const pluginName = cleanText(typeof loaded?.name === 'string' && loaded.name ? loaded.name : ws.plugin, TEXT_CAPS.name) || ws.plugin;
    let pinned = false;
    if (typeof body.epoch === 'string' && body.epoch) {
      const m = TOKEN.exec(body.epoch);
      if (!m) return refuse(400, 'bad_request', 'epoch is the token an earlier answer gave.');
      if (m[1] === boot) {
        if (m[2] !== current || m[3] !== pluginHash(ws.plugin)) {
          return refuse(409, 'plugin_changed', `${pluginName} was turned off, replaced or reset since this page offered its tools; it can offer them again only when the workspace opens again.`);
        }
        pinned = true;
      }
      // Another boot id: this server restarted since; the POST counts as fresh.
    }
    // The live registry may not say yet (none loaded, or being read again after a plugin
    // change): kept, offered to nobody until it does (regReady).
    const unsure = this.registryUnsure();
    if (!pinned && !loaded && !unsure) return refuse(409, 'plugin_off', `${pluginName} is not turned on, so its workspace can't offer tools to the Assistant.`);

    t.rev = rev;
    const link = rec.link;
    const tab = rec.tab;
    const id = ++this.regSerial;
    const verdict = this.registry.setWorkspace(tab, link, {
      plugin: ws.plugin,
      pluginName,
      workspace: ws.workspace,
      workspaceName: ws.title,
      projectId: ws.projectId,
      studyId: ws.studyId,
      epoch: current,
      tools: body.tools,
      guide: typeof body.guide === 'string' ? body.guide : '',
      review,
      invoke: (c) => this.invoke(tab, link, id, c),
      ready: () => {
        const r = this.regReady(tab, id);
        return r === true ? true : r.message;
      },
    });
    const wasLive = !!t.reg && t.reg.link === link && !t.dormant;
    this.clearDormant(t);
    t.reg = { id, link, plugin: ws.plugin, pluginName, workspace: ws.title, epoch: current, unverified: unsure };
    if (!wasLive) t.since = this.clock.now();
    return ok({ available: true, accepted: verdict.accepted, refused: verdict.refused, epoch: `${boot}:${current}:${pluginHash(ws.plugin)}` });
  }

  /**
   * A core page's registration (slot 'core', C7): where the tab is and the core tools, in the
   * registry's core slot of the tab. No plugin or epoch check: the page is the app's own. tools []
   * withdraws it.
   */
  private registerCore(rec: LinkRec, rev: number, body: Record<string, unknown>): Answer {
    const t = this.tabRec(rec.tab);
    if (rev < t.coreRev) return refuse(409, 'stale_rev', 'A newer list of this page was already received.', { rev: t.coreRev });
    const tools = body.tools as unknown[];
    if (tools.length === 0) {
      t.coreRev = rev;
      this.clock.clearTimeout(t.coreTimer);
      t.coreTimer = null;
      if (t.core) this.registry.setCore(t.tab, t.core.link, null);
      t.core = null;
      return ok({ available: true, accepted: [], refused: [], epoch: CORE_EPOCH });
    }
    const where = parseCore(body.workspace, body.place);
    if (typeof where === 'string') return refuse(400, 'bad_request', where);
    t.coreRev = rev;
    const tab = rec.tab;
    const link = rec.link;
    const verdict = this.registry.setCore(tab, link, {
      projectId: where.projectId,
      studyId: where.studyId,
      place: where.place,
      tools,
      guide: typeof body.guide === 'string' ? body.guide : '',
      invoke: (c) => this.invokeCore(tab, link, c),
      escalate: (tool, input) => this.coreEscalate(tab, tool, input),
    });
    this.clock.clearTimeout(t.coreTimer);
    t.coreTimer = null;
    t.core = { link, dormant: false };
    return ok({ available: true, accepted: verdict.accepted, refused: verdict.refused, epoch: CORE_EPOCH });
  }

  /**
   * core__show leaving a workspace whose plugin links geometry sends its design to the simulation
   * (§0.4, §5.1): a computation, asked first. Null for any other call.
   */
  private async coreEscalate(tab: string, tool: string, input: Record<string, unknown>): Promise<CoreEscalation | null> {
    if (tool !== 'show') return null;
    const core = this.registry.coreOf(tab);
    const w = this.registry.workspaceOf(tab);
    if (!core || core.place !== 'workspace' || !w) return null;
    // Opening the same workspace again leaves nothing.
    if (input.target === 'workspace' && (input.id === '' || input.id === w.reg.studyId)) return null;
    const row = (this.pluginLoaded(w.reg.plugin) ?? null) as { links_geometry?: unknown } | null;
    if (!row || row.links_geometry !== true) return null;
    const name = cleanText(w.reg.workspaceName || w.reg.workspace, TEXT_CAPS.name) || 'workspace';
    const plugin = cleanText(w.reg.pluginName || w.reg.plugin, TEXT_CAPS.name) || 'the plugin';
    const title = 'Allow the Assistant to send your design to the simulation?';
    const note = 'sends the design to the simulation';
    // The geometry it updates and its studies, as the person's own Back would (spec 14.2).
    const at = await this.leaveTarget(w.reg.projectId, w.reg.plugin, w.reg.studyId).catch(() => null);
    if (!at) {
      return { risk: 'compute', note, title, copy: `Leaves ${plugin}'s ${name} and sends its design to this project: it updates the geometry it links, or adds a new one. You may be asked how to update it.` };
    }
    const q = (s: string) => `"${cleanText(s, 80)}"`;
    const what = at.study ? `the ${plugin} ${name} ${q(at.study)}` : `${plugin}'s ${name}`;
    const where = at.project ? `project ${q(at.project)}` : 'this project';
    const g = at.geometry;
    const uses = g ? `${g.studies} ${g.studies === 1 ? 'study uses' : 'studies use'} it` : '';
    return {
      risk: 'compute',
      note,
      title,
      copy: g
        ? `Leaves ${what} and sends its design to ${where}: it updates geometry ${q(g.name)} (${uses}). You may be asked how to update it.`
        : `Leaves ${what} and sends its design to ${where} as a new geometry.`,
      detail: g
        ? [
            { label: 'Geometry', value: cleanText(g.name, 80) },
            { label: 'Studies using it', value: String(g.studies) },
          ]
        : [{ label: 'Geometry', value: 'a new one' }],
    };
  }

  /** tools []: the registration goes; a call still running gets the grace for its result. */
  private withdraw(t: TabRec): void {
    if (t.reg) {
      this.registry.setWorkspace(t.tab, t.reg.link, null);
      t.reg = null;
    }
    this.clearDormant(t);
    const p = t.pending;
    if (p && !p.done && !p.unregistering && p.slot === 'workspace') {
      p.unregistering = true;
      p.unregisterTimer = this.clock.setTimeout(() => this.finish(p, fail('closed', closedText(p.workspace))), this.graceMs);
    }
  }

  /** A plugin was turned off, swapped or reset ('*': every plugin): its registrations and calls go now. */
  private onEpochBump(key: string): void {
    const hit = (plugin: string) => key === '*' || plugin === key;
    for (const t of [...this.tabs.values()]) {
      const p = t.pending;
      if (p && !p.done && p.slot === 'workspace' && hit(p.plugin)) this.finish(p, fail('plugin_off', pluginOffText(p.pluginName)));
      if (t.reg && hit(t.reg.plugin)) this.dropReg(t);
      this.maybeForget(t);
    }
  }

  // ------------------------------------------------------------ calls

  /** Runs one call in the tab's page (the registry's invoke of a workspace tool). */
  invoke(tab: string, link: string, id: number, c: InvokeCall): Promise<ToolOutcome> {
    const t = this.tabs.get(tab);
    const reg = t?.reg ?? null;
    const ws = reg?.workspace ?? 'the workspace';
    if (!t || !reg || reg.link !== link) return Promise.resolve(fail('unavailable', `${ws} is no longer open.`));
    // A tool of an earlier registration of this tab (even on this link): never sent.
    if (reg.id !== id) return Promise.resolve(fail('unavailable', OTHER_TOOLS_TEXT));
    if (this.registry.currentEpoch(reg.plugin) !== reg.epoch) return Promise.resolve(fail('plugin_off', `${reg.pluginName} was turned off or replaced.`));
    const ready = this.regReady(tab, id);
    if (ready !== true) return Promise.resolve(fail(ready.code, ready.message));
    const live = t.link;
    if (this.closed || !live || !live.open || live.link !== link || live.silent || t.dormant) return Promise.resolve(fail('tab_disconnected', notSentText(ws)));
    return this.startCall(t, live, { slot: 'workspace', plugin: reg.plugin, pluginName: reg.pluginName, epoch: reg.epoch, workspace: ws }, c);
  }

  /** Runs one core tool call in the tab's page (the registry's invoke of a core tool, C7). */
  invokeCore(tab: string, link: string, c: InvokeCall): Promise<ToolOutcome> {
    const t = this.tabs.get(tab);
    const ws = 'The Magnusim window';
    if (!t || !t.core || t.core.link !== link) return Promise.resolve(fail('unavailable', 'This Magnusim window is no longer open.'));
    const live = t.link;
    if (this.closed || !live || !live.open || live.link !== link || live.silent || t.core.dormant) return Promise.resolve(fail('tab_disconnected', notSentText(ws)));
    // The workspace a core__show may leave: a Back that sends its design answers the link job
    // (link.<gl-...>), which wait follows by its plugin and study (spec 8.1).
    const from = c.tool === 'show' ? this.registry.workspaceOf(tab) : null;
    const since = new Date(this.clock.now()).toISOString();
    return this.startCall(t, live, { slot: 'core', plugin: 'core', pluginName: 'Magnusim', epoch: CORE_EPOCH, workspace: ws }, c).then((out) => {
      if (from) rememberLinkJob(c.turn, out, from.reg, since);
      return out;
    });
  }

  /** One call sent to the page on its live link: one at a time per tab, acknowledged, abortable. */
  private startCall(
    t: TabRec,
    live: LinkRec,
    meta: { slot: 'workspace' | 'core'; plugin: string; pluginName: string; epoch: string; workspace: string },
    c: InvokeCall,
  ): Promise<ToolOutcome> {
    const ws = meta.workspace;
    const tab = t.tab;
    const link = live.link;
    if (t.pending) return Promise.resolve(fail('busy', busyText(ws)));
    if (c.signal.aborted) return Promise.resolve(fail('aborted', 'It was stopped before it started.'));
    this.serial += 1;
    const call = `rc-${this.serial.toString(36)}-${randomBytes(3).toString('hex')}`;
    return new Promise<ToolOutcome>((resolve) => {
      const p: Pending = {
        call,
        tab,
        link,
        slot: meta.slot,
        plugin: meta.plugin,
        pluginName: meta.pluginName,
        epoch: meta.epoch,
        workspace: ws,
        turn: c.turn,
        conversation: typeof c.conversation === 'string' && c.conversation ? c.conversation : null,
        progress: c.progress,
        resolve,
        acked: false,
        aborted: false,
        unregistering: false,
        done: false,
        ackTimer: null,
        abortTimer: null,
        unregisterTimer: null,
        offAbort: null,
      };
      t.pending = p;
      const sent = live.send('invoke', {
        call,
        turn: c.turn,
        tool: c.tool,
        input: c.input,
        timeout_s: c.timeoutS,
        ...(meta.slot === 'core' ? { slot: 'core' } : {}),
        ...(c.step ? { step: c.step.n, calls_left_in_step: c.step.callsLeft, edits_left_in_step: c.step.editsLeft } : {}),
      });
      // The channel or its stream is gone (its cleanup may not have run yet): it never reached the page.
      if (!sent) {
        this.finish(p, fail('tab_disconnected', notSentText(ws)));
        return;
      }
      p.ackTimer = this.clock.setTimeout(() => {
        p.ackTimer = null;
        if (p.acked || p.done) return;
        this.finish(p, fail('tab_disconnected', disconnectedText(ws)));
        // Nothing more goes to that page until it is heard again.
        this.linkSilent(live);
      }, this.ackMs);
      const onAbort = () => this.abortCall(p);
      // The runner gave up on the call: the tab is free before its next call can start.
      const onReleased = () => this.finish(p, fail('aborted', 'It was stopped; its page gave no last answer.'));
      c.signal.addEventListener('abort', onAbort, { once: true });
      c.released?.addEventListener('abort', onReleased, { once: true });
      p.offAbort = () => {
        c.signal.removeEventListener('abort', onAbort);
        c.released?.removeEventListener('abort', onReleased);
      };
    });
  }

  /** Stop, a limit or a stall: the page is told, and has a moment for its last answer. */
  private abortCall(p: Pending): void {
    if (p.done || p.aborted) return;
    p.aborted = true;
    const l = this.tabs.get(p.tab)?.link;
    if (l && l.open && l.link === p.link) l.send('abort', { call: p.call });
    p.abortTimer = this.clock.setTimeout(() => this.finish(p, fail('aborted', 'It was stopped; its page gave no last answer.')), this.abortGraceMs);
  }

  private finish(p: Pending, outcome: ToolOutcome): void {
    if (p.done) return;
    p.done = true;
    this.clock.clearTimeout(p.ackTimer);
    this.clock.clearTimeout(p.abortTimer);
    this.clock.clearTimeout(p.unregisterTimer);
    p.offAbort?.();
    p.offAbort = null;
    const t = this.tabs.get(p.tab);
    if (t && t.pending === p) t.pending = null;
    p.resolve(outcome);
    if (t) this.maybeForget(t);
  }

  private pendingFor(rec: LinkRec, call: unknown): Pending | null {
    const p = this.tabs.get(rec.tab)?.pending;
    return p && !p.done && p.call === call && p.link === rec.link ? p : null;
  }

  /** POST /api/assistant/relay/progress: the page's ack, then how far it is. */
  progress(body: Record<string, unknown>): Answer {
    if (typeof body.link !== 'string' || typeof body.call !== 'string' || !CALL.test(body.call)) return refuse(400, 'bad_request', 'link and call are required.');
    const rec = this.closed ? null : this.liveLink(body.link);
    if (!rec) return refuse(409, 'no_channel', NO_CHANNEL_TEXT);
    this.heard(rec);
    const p = this.pendingFor(rec, body.call);
    if (!p) return ok({ stale: true });
    const moved = body.fraction !== undefined || body.label !== undefined || body.waiting === true;
    if (body.ack === true || moved) {
      p.acked = true;
      this.clock.clearTimeout(p.ackTimer);
      p.ackTimer = null;
    }
    if (moved && !p.aborted) {
      const f = typeof body.fraction === 'number' && Number.isFinite(body.fraction) ? Math.min(1, Math.max(0, body.fraction)) : null;
      try {
        if (body.waiting === true) p.progress(f, cleanText(body.label, 120), { waiting: true });
        else p.progress(f, cleanText(body.label, 120));
      } catch {
        /* the turn's log never breaks the page's call */
      }
    }
    return ok();
  }

  /** POST /api/assistant/relay/result: the page's answer, checked; stale when its call is over. */
  result(body: Record<string, unknown>): Answer {
    if (typeof body.link !== 'string' || typeof body.call !== 'string' || !CALL.test(body.call)) return refuse(400, 'bad_request', 'link and call are required.');
    const rec = this.closed ? null : this.liveLink(body.link);
    if (!rec) return refuse(409, 'no_channel', NO_CHANNEL_TEXT);
    this.heard(rec);
    const p = this.pendingFor(rec, body.call);
    if (!p) return ok({ stale: true });
    // The plugin changed under it: its answer is not taken (a core call has no plugin).
    if (p.slot === 'workspace' && this.registry.currentEpoch(p.plugin) !== p.epoch) {
      this.finish(p, fail('plugin_off', pluginOffText(p.pluginName)));
      return ok({ stale: true });
    }
    this.finish(p, pageOutcome(body, p.slot));
    return ok();
  }

  /**
   * GET /api/assistant/relay/attachment: the conversation whose attached files the page's running
   * workspace call `call` may read (the frame's assistant.attachment), asked on the link the call
   * was sent on. 400 for a call that is no id; 409 no_channel without a live link; 409 not_allowed
   * when that call is not running there (it ended, or it is another's); 403 not_allowed for a core
   * call (the app's own page reads none); 404 not_found for an MCP call or a turn with no
   * conversation (neither has attachments).
   */
  attachmentCall(link: unknown, call: unknown): Answer | { conversation: string } {
    if (typeof call !== 'string' || !CALL.test(call)) return refuse(400, 'bad_request', 'call is the running call it reads for.');
    const rec = this.closed ? null : this.liveLink(link);
    if (!rec) return refuse(409, 'no_channel', NO_CHANNEL_TEXT);
    this.heard(rec);
    const p = this.pendingFor(rec, call);
    if (!p) return refuse(409, 'not_allowed', 'That tool call is not running in this page: a file is read only while its call runs.');
    if (p.slot !== 'workspace') return refuse(403, 'not_allowed', "Only a workspace tool's call reads an attached file.");
    if (typeof p.turn === 'string' && p.turn.startsWith('mcp:')) return refuse(404, 'not_found', MCP_NO_ATTACHMENT);
    if (!p.conversation) return refuse(404, 'not_found', NO_SUCH_ATTACHMENT_TEXT);
    return { conversation: p.conversation };
  }

  // ------------------------------------------------------------ turns and gates

  /** A turn bound to the tab started, changed or ended: its page hears it on the live link. */
  private sendTurn(tab: string, turn: Turn): void {
    if (this.closed) return;
    const l = this.tabs.get(tab)?.link;
    if (l && l.open) l.send('turn', turn.pageView());
  }

  private turnsChanged(tab: string): void {
    if (this.closed) return;
    const n = this.turns.activeForTab(tab);
    let t = this.tabs.get(tab);
    if (!t) {
      if (n === 0) return;
      t = this.tabRec(tab);
    }
    if (n === t.turns) return;
    const before = t.turns;
    t.turns = n;
    if (n === 0 && before > 0) {
      t.holdUntil = this.clock.now() + this.holdMs;
      this.clock.clearTimeout(t.holdTimer);
      const held = t;
      t.holdTimer = this.clock.setTimeout(() => {
        held.holdTimer = null;
        this.maybeForget(held);
      }, this.holdMs);
    }
    const l = t.link;
    if (l && l.open) l.send('active', { turns: n, hold_until: this.liveHold(t) });
    this.maybeForget(t);
  }

  /** Any owner with a tab (a turn bound to it, or an MCP call that ran in it): its live link shows the question. */
  private presentGate(view: GateView, owner: GateOwner): boolean {
    const tab = tabOf(owner);
    if (this.closed || !tab) return false;
    const l = this.tabs.get(tab)?.link;
    if (!l || !l.open || l.silent) return false;
    const sent = l.send('gate', { gate: view });
    if (sent) {
      l.gatesSent.delete(view.id);
      l.gatesSent.add(view.id);
      if (l.gatesSent.size > GATES_SENT_MAX) l.gatesSent.delete(l.gatesSent.values().next().value as string);
    }
    return sent;
  }

  /**
   * POST /api/assistant/relay/gate: the person answered a question in the tab that shows it.
   * Taken only on its tab's live link, and only for a gate sent on that link; the manager then
   * checks that the gate's owner is bound to this tab (turns.ts answerGate).
   */
  answer(link: unknown, gate: unknown, allow: unknown): Answer {
    if (typeof link !== 'string' || typeof gate !== 'string' || !ID.test(gate)) return refuse(400, 'bad_request', 'link and gate are required.');
    if (typeof allow !== 'boolean') return refuse(400, 'bad_answer', 'allow must be true or false.');
    const rec = this.closed ? null : this.liveLink(link);
    if (!rec) return refuse(409, 'no_channel', NO_CHANNEL_TEXT);
    // Read before the POST is heard: on a silent link, being heard sends its questions again,
    // and one sent only now was never on the page this answer came from.
    const sent = rec.gatesSent.has(gate);
    this.heard(rec);
    if (!sent) return refuse(403, 'not_shown', NOT_SHOWN_TEXT);
    return this.turns.answerGate(gate, allow, { kind: 'link', tab: rec.tab });
  }

  private withdrawGate(view: GateView, owner: GateOwner, closed: { answer: GateAnswer; by: GateClosedBy }): void {
    const tab = tabOf(owner);
    if (this.closed || !tab) return;
    const l = this.tabs.get(tab)?.link;
    if (!l || !l.open) return;
    l.send('gate_closed', { gate: view.id, answer: closed?.answer ?? 'deny', by: closed?.by ?? 'stop' });
  }

  /** The app tab whose live relay link `link` is now (its newest, open, not silent), or null. */
  liveLinkTab(link: unknown): string | null {
    const rec = this.closed ? null : this.liveLink(link);
    return rec && !rec.silent ? rec.tab : null;
  }

  /** Whether `tab` has a live relay link now (a window that shows it). */
  tabLive(tab: string): boolean {
    const l = this.closed ? null : this.tabs.get(tab)?.link;
    return !!l && l.open && !l.silent;
  }

  /** Whether `link` is `tab`'s live relay link now (tests: which tab a link belongs to). */
  isLiveLinkOf(tab: string, link: unknown): boolean {
    const rec = this.closed ? null : this.liveLink(link);
    return !!rec && rec.tab === tab && !rec.silent;
  }

  /**
   * Whether `link` is a live relay link of any app tab now (its tab's newest, open, not silent):
   * the page's proof of this account (TurnManager.launchProven, phase 3 spec 5.2), whichever tab
   * sends it. A tab opens its channel for that alone when no workspace did
   * (src/assistant/relay.ts withAssistantLink).
   */
  isLiveLink(link: unknown): boolean {
    const rec = this.closed ? null : this.liveLink(link);
    return !!rec && !rec.silent;
  }

  // ------------------------------------------------------------ views

  /**
   * /tabs (asked before the registry's row): since when the tab's registration is connected
   * or dormant, and its hold. One the live registry could not confirm yet is decided first,
   * so one whose plugin turned out off is gone before it is listed.
   */
  tabInfo(tab: string): { since: number | null; hold_until: number | null } | null {
    const t = this.tabs.get(tab);
    if (!t) return null;
    if (t.reg?.unverified) this.regReady(tab, t.reg.id, true);
    return { since: t.reg ? t.since : null, hold_until: this.liveHold(t) };
  }

  /**
   * The test state route: each tab the relay knows. hold_left_ms is what is left of its hold now
   * on the relay's own clock (a test times it on its own clock, never against hold_until).
   */
  snapshot(): Record<string, RelayTabSnapshot> {
    const out: Record<string, RelayTabSnapshot> = {};
    const now = this.clock.now();
    for (const t of this.tabs.values()) {
      const w = this.registry.workspaceOf(t.tab);
      const hold = this.liveHold(t);
      out[t.tab] = {
        connected: !!t.link?.open && !t.link.silent,
        dormant: t.dormant,
        tools: w && t.reg ? w.tools.length : 0,
        pending: t.pending ? 1 : 0,
        rev: t.rev,
        turns: t.turns,
        hold_until: hold,
        hold_left_ms: hold === null ? null : Math.max(0, hold - now),
        core: !!t.core && !t.core.dormant,
      };
    }
    return out;
  }

  /** The server is closing: its turns bound to a tab end, its timers stop and calls still out fail. */
  shutdown(): void {
    if (this.closed) return;
    // Their pages hear it while the links last (gate_closed, active).
    this.turns.shutdownTabTurns();
    this.closed = true;
    this.offBump();
    this.offTurns();
    this.offRegistry();
    this.turns.setTabInfo(null);
    for (const t of this.tabs.values()) {
      const p = t.pending;
      if (p && !p.done) this.finish(p, fail('tab_disconnected', 'The server stopped while the tool ran; it may or may not have finished.'));
      this.clock.clearTimeout(t.dormantTimer);
      this.clock.clearTimeout(t.holdTimer);
      this.clock.clearTimeout(t.coreTimer);
    }
  }
}

/**
 * The workspace a registration names (the host's own scope for the frame): `workspace` is its
 * key, as the page's route names it; `title`, when the page gives it (from the host's plugin
 * row), is how the person reads it in the texts, else the key.
 */
function parseWorkspace(raw: unknown): { plugin: string; workspace: string; title: string; projectId: string; studyId: string } | string {
  if (!isRecord(raw)) return 'workspace is {project_id, plugin, workspace, title?, study_id}.';
  const plugin = raw.plugin;
  if (typeof plugin !== 'string' || !PLUGIN_KEY.test(plugin)) return 'workspace.plugin is a plugin key.';
  const workspace = raw.workspace;
  if (typeof workspace !== 'string' || !workspace || workspace.length > TEXT_CAPS.name) return "workspace.workspace is the workspace's key.";
  if (raw.title !== undefined && raw.title !== null && typeof raw.title !== 'string') return "workspace.title is the workspace's title.";
  const id = (v: unknown) => (v === undefined || v === null || v === '' ? '' : typeof v === 'string' && ID.test(v) ? v : null);
  const projectId = id(raw.project_id);
  const studyId = id(raw.study_id);
  if (projectId === null || studyId === null) return 'workspace.project_id and workspace.study_id are ids.';
  const title = cleanText(raw.title, TEXT_CAPS.name) || cleanText(workspace, TEXT_CAPS.name) || 'the workspace';
  return { plugin, workspace, title, projectId, studyId };
}

/** The fixed epoch token of a core registration: no plugin's, it never bumps. */
export const CORE_EPOCH = 'core';

/**
 * Where a core page says its tab is (slot 'core'): plugin "core", and Home with no project, or the
 * workbench or a workspace with one.
 */
function parseCore(raw: unknown, place: unknown): { projectId: string; studyId: string; place: CorePlace } | string {
  if (!isRecord(raw)) return 'workspace is {project_id, plugin: "core", workspace, study_id}.';
  if (raw.plugin !== 'core') return 'A core registration names the plugin "core".';
  if (place !== 'home' && place !== 'workbench' && place !== 'workspace') return 'place is home, workbench or workspace.';
  const id = (v: unknown) => (v === undefined || v === null || v === '' ? '' : typeof v === 'string' && ID.test(v) ? v : null);
  const projectId = id(raw.project_id);
  const studyId = id(raw.study_id);
  if (projectId === null || studyId === null) return 'workspace.project_id and workspace.study_id are ids.';
  if (place === 'home' && projectId) return 'Home shows no project: project_id is "" there.';
  if (place !== 'home' && !projectId) return 'The workbench and a workspace name their project.';
  return { projectId, studyId, place };
}

/**
 * A page's error as the call's outcome: a code from the page's and the bridge's lists (else
 * `failed`), its message, its hint (≤ 500 characters) and its detail (≤ 4 KB as JSON, else
 * dropped with " (detail too large)", or " (detail not plain JSON)", on the message), as the
 * bridge keeps them.
 */
function pageError(raw: unknown, slot: 'workspace' | 'core' = 'workspace'): ToolOutcome {
  const e = isRecord(raw) ? raw : {};
  const known = (c: string) => PAGE_RESULT_CODES.has(c) || (slot === 'core' && CORE_RESULT_CODES.has(c));
  const code = typeof e.code === 'string' && known(e.code) ? e.code : 'failed';
  let note = '';
  let detail: unknown;
  if (e.detail !== undefined && e.detail !== null) {
    let json: string | undefined;
    try {
      json = JSON.stringify(e.detail);
    } catch {
      json = undefined;
    }
    if (json === undefined) note = ' (detail not plain JSON)';
    else if (Buffer.byteLength(json, 'utf8') > RESULT_CAPS.detail) note = ' (detail too large)';
    else detail = JSON.parse(json);
  }
  const out = fail(code, `${cleanText(e.message, TEXT_CAPS.other - note.length) || 'The tool failed.'}${note}`);
  const hint = typeof e.hint === 'string' ? cleanText(e.hint, RESULT_CAPS.hint) : '';
  if (out.error && hint) out.error.hint = hint;
  if (out.error && detail !== undefined) out.error.detail = detail;
  return out;
}

/**
 * The page's answer as the call's outcome: its error (above), or its result shape-checked and
 * capped as the bridge does (`bad_result`, `too_large`); images go on as base64 for the
 * runner's own checks. The page's summary (≤ 160 characters) is the log's line, else "Done".
 */
export function pageOutcome(body: Record<string, unknown>, slot: 'workspace' | 'core' = 'workspace'): ToolOutcome {
  const bad = (why: string) => fail('bad_result', `The tool's result was refused: ${why}.`);
  const big = (why: string) => fail('too_large', `The tool's result is too large: ${why}.`);
  if (body.ok === false) return pageError(body.error, slot);
  if (body.ok !== true) return bad('it says neither ok nor not ok');
  const raw = body.result;
  if (raw === undefined || raw === null) return { ok: true, summary: 'Done' };
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > RESULT_CAPS.text) return big('its text is over 64 KB');
    return { ok: true, text: raw, summary: 'Done' };
  }
  if (!isRecord(raw)) return bad('it is not text or {text, data, images}');
  const out: ToolOutcome = { ok: true, summary: 'Done' };
  if (raw.text !== undefined && raw.text !== null) {
    if (typeof raw.text !== 'string') return bad('its text is not text');
    if (Buffer.byteLength(raw.text, 'utf8') > RESULT_CAPS.text) return big('its text is over 64 KB');
    out.text = raw.text;
  }
  let summary = '';
  if (raw.summary !== undefined && raw.summary !== null) {
    if (typeof raw.summary !== 'string') return bad('its summary is not text');
    summary = cleanText(raw.summary, RESULT_CAPS.summary);
  }
  if (raw.data !== undefined) {
    let json: string | undefined;
    try {
      json = JSON.stringify(raw.data);
    } catch {
      return bad('its data is not plain JSON');
    }
    if (json !== undefined && Buffer.byteLength(json, 'utf8') > RESULT_CAPS.data) return big('its data is over 256 KB as JSON');
    if (json !== undefined) out.data = JSON.parse(json);
  }
  if (raw.images !== undefined && raw.images !== null) {
    if (!Array.isArray(raw.images)) return bad('its images are not a list');
    if (raw.images.length > RESULT_CAPS.images) return big(`it has more than ${RESULT_CAPS.images} images`);
    const images: ImagePart[] = [];
    for (const im of raw.images as unknown[]) {
      const m = isRecord(im) ? im : {};
      const data = typeof m.data === 'string' ? m.data : typeof m.base64 === 'string' ? m.base64 : null;
      const mediaType = m.mediaType;
      if (typeof mediaType !== 'string' || !IMAGE_TYPES.has(mediaType) || data === null || !BASE64.test(data)) {
        return bad('each image is {mediaType: image/png, image/jpeg or image/webp, data: base64}');
      }
      if (Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) > RESULT_CAPS.imageBytes) return big('an image is over 1.5 MB');
      images.push({ type: 'image', mediaType: mediaType as ImagePart['mediaType'], base64: data, width: 0, height: 0 });
    }
    if (images.length) out.images = images;
  }
  if (summary) out.summary = summary;
  else if (out.images?.length) out.summary = `Done (${out.images.length} image${out.images.length === 1 ? '' : 's'})`;
  return out;
}

export function createRelay(o: RelayOptions): Relay {
  return new Relay(o);
}
