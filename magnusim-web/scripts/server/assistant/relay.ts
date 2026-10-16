/**
 * The page relay, on the server (Foundation spec 8.4, 7.5): how the Assistant reaches the
 * workspace open in an app tab.
 *
 * A tab's page opens one channel of kind `assistant` on its event stream (event-hub.ts),
 * params {role:'relay'}, from this PC only: 403 when the stream or the subscribe came from
 * elsewhere, 400 for another role. Frames to the page:
 *   linked {link}                  always the channel's first frame: 24 random hex, new at
 *                                  each open. Every relay POST carries it (the page never
 *                                  needs its tab id), and the page registers again on each.
 *   active {turns, hold_until}     the number of running turns bound to the tab changed (and
 *                                  at an open, while there are some or a hold runs).
 *                                  hold_until: ms since 1970, 10 minutes after the tab's last
 *                                  bound turn ended (null before any). The page keeps its
 *                                  channel while turns > 0 or until then.
 *   invoke {call, turn, tool, input, timeout_s}   run the page's tool `tool` (its own name)
 *   abort {call}                   Stop, a turn limit, or the call stalled
 *   gate {gate}                    a question (GateView) of a turn bound to this tab
 *   gate_closed {gate, answer, by} that question was answered, timed out or withdrawn
 *   unregistered {reason}          'plugin_off': the tab's tools are gone; that publication
 *                                  must not register again (a new frame may)
 * POSTs from the page (assistant-routes.ts; each 409 no_channel without a live link):
 *   /relay/tools    {link, rev, epoch?, workspace:{project_id, plugin, workspace, study_id},
 *                   tools, guide?} → {ok, available:true, accepted, refused, epoch}; tools []
 *                   withdraws them. 409 stale_rev (a lower rev than the tab's last; the same
 *                   rev is taken again, e.g. on a new link), plugin_changed (the frame's pinned
 *                   epoch is no longer its plugin's), plugin_off (a fresh frame, no epoch,
 *                   while the plugin is not loaded); 400.
 *   /relay/progress {link, call, ack?, fraction?, label?} → {ok} | {ok, stale:true}
 *   /relay/result   {link, call, ok, result? | error?}    → {ok} | {ok, stale:true}
 *
 * - Registrations go into the tool registry (one per tab), so a turn bound to the tab is
 *   offered only that tab's tools. The epoch token answered on acceptance is the server's
 *   boot id, the plugin's epoch and a hash of its key: a later POST of the frame carries
 *   it, a changed epoch is refused (`plugin_changed`), and after a server restart (another
 *   boot id) the POST counts as fresh again.
 * - A link that goes leaves its tab's registration dormant (connected:false, offered to
 *   nobody) for the hold time; the same tab's next link and re-POST bring it back.
 * - One call at a time per tab (`busy`). An invoke whose frame can't be sent fails at once
 *   (`tab_disconnected`); one the page doesn't acknowledge in 10 s too (a half-open
 *   connection). The stall window is the runner's (runner.ts), reset by progress. Stop
 *   sends `abort` and waits up to 2 s for the page's last answer.
 * - The page withdraws its tools (tools []) after a call's result; a withdrawal that finds a
 *   call still running gives its result 2 s (then `closed`). A channel or stream that just
 *   ends fails the call at once (`tab_disconnected`): its cleanup can't tell why it ended.
 * - A plugin turned off, swapped or reset (foam-runner.js bumpPluginEpoch) drops its
 *   registrations in every tab, fails their calls (`plugin_off`) and tells each page
 *   `unregistered`, synchronously, before the worker answers.
 * - Gates of a turn bound to a tab are shown there (the GateBroker's presenter): sent to its
 *   live link, sent again when its link returns; the broker notes an unseen one after 15 s.
 *
 * The relay's links and registrations belong to the server that made it (as the registry's
 * do); a test reset of the Assistant's state leaves them, so open pages stay linked.
 */
import { createHash, randomBytes } from 'node:crypto';
import { onPluginEpochBump } from '../../foam-runner.js';
import { pluginLoaded as livePluginLoaded } from '../../registry-defaults.js';
import type { ChannelMeta, ChannelOpened, ChannelSend } from '../event-hub.ts';
import { REMOTE_MESSAGE } from './access.ts';
import { realClock, type Clock, type GateAnswer, type GateClosedBy, type GateOwner, type GatePresenter, type GateView } from './gates.ts';
import { assistantHomeIsOverridden } from './home.ts';
import { alog } from './log.ts';
import type { Registry, ToolOutcome } from './registry.ts';
import { ABORT_GRACE_MS } from './runner.ts';
import { cleanText, IMAGE_CAPS, TEXT_CAPS } from './sanitize.ts';
import { assistantState } from './state.ts';
import type { TurnManager } from './turns.ts';
import type { ImagePart } from './types.ts';

export const LINK_RE = /^[0-9a-f]{24}$/;
/** An invoke the page doesn't acknowledge this soon fails `tab_disconnected` (a half-open connection). */
export const RELAY_ACK_MS = 10_000;
/** How long a tab is held after its last bound turn, and a dropped link's registration kept. */
export const ASSISTANT_HOLD_MS = 10 * 60_000;
/** A withdrawal (tools []) that finds a call running gives its result this long. */
export const UNREGISTER_GRACE_MS = 2_000;
/** What a page's tool result may hold (as the bridge checks it in the page). */
export const RESULT_CAPS = Object.freeze({ text: 64 * 1024, data: 256 * 1024, images: IMAGE_CAPS.perResult, imageBytes: IMAGE_CAPS.bytes });
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
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp']);
const PLUGIN_KEY = /^[A-Za-z0-9._-]{1,64}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CALL = /^[A-Za-z0-9._:-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const TOKEN = /^([0-9a-f]{8,64}):([0-9]{1,15}\.[0-9]{1,15}):([0-9a-f]{8})$/;
const SWITCH_MAX_MS = 60 * 60_000;

export const NO_CHANNEL_TEXT = "This page's assistant channel is not open (it closed, or the server restarted). Wait for its next linked frame.";

// ---------------------------------------------------------------- test switches

/**
 * MAGNUSIM_TEST_ASSISTANT_HOLD_MS and MAGNUSIM_TEST_ASSISTANT_ACK_MS (whole milliseconds,
 * 1 to 3600000): the hold and the ack window for browser tests. Honoured only with
 * MAGNUSIM_TEST_ASSISTANT=1 in a test home, like every Assistant test switch.
 */
export function resolveRelaySwitches(env: NodeJS.ProcessEnv): { holdMs: number | null; ackMs: number | null; ignored: string[] } {
  const out: { holdMs: number | null; ackMs: number | null; ignored: string[] } = { holdMs: null, ackMs: null, ignored: [] };
  const names = [
    ['MAGNUSIM_TEST_ASSISTANT_HOLD_MS', 'holdMs'],
    ['MAGNUSIM_TEST_ASSISTANT_ACK_MS', 'ackMs'],
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

let switches: { holdMs: number | null; ackMs: number | null } | null = null;

/** The relay's test switches, read once (null when not in use). */
export function relaySwitches(): { holdMs: number | null; ackMs: number | null } {
  if (!switches) {
    const r = resolveRelaySwitches(process.env);
    for (const why of r.ignored) alog('warn', why);
    switches = { holdMs: r.holdMs, ackMs: r.ackMs };
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

interface LinkRec {
  link: string;
  tab: string;
  cid: string;
  send: ChannelSend;
  done: () => void;
  open: boolean;
}

interface Pending {
  call: string;
  tab: string;
  link: string;
  plugin: string;
  pluginName: string;
  epoch: string;
  workspace: string;
  progress(fraction: number | null, label: string): void;
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
  /** The registration in the registry: the link it came on and what it is. */
  reg: { link: string; plugin: string; pluginName: string; workspace: string; epoch: string } | null;
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
}

/** One call of a page's tool, as the registry asks for it. */
export interface InvokeCall {
  tool: string;
  input: Record<string, unknown>;
  timeoutS: number;
  signal: AbortSignal;
  turn: string | null;
  progress(fraction: number | null, label: string): void;
}

export interface RelayOptions {
  registry: Registry;
  turns: TurnManager;
  clock?: Clock;
  holdMs?: number;
  ackMs?: number;
  unregisterGraceMs?: number;
  abortGraceMs?: number;
  pluginLoaded?: PluginLoaded;
  /** foam-runner.js onPluginEpochBump (tests may pass their own). */
  onEpochBump?: (fn: (key: string) => void) => () => void;
  /** Leave the turns' gate presenter as it is (a test gave its own). */
  keepPresenter?: boolean;
}

export class Relay {
  readonly holdMs: number;
  readonly ackMs: number;
  readonly presenter: GatePresenter;
  private readonly registry: Registry;
  private readonly turns: TurnManager;
  private readonly clock: Clock;
  private readonly graceMs: number;
  private readonly abortGraceMs: number;
  private readonly pluginLoaded: PluginLoaded;
  private readonly links = new Map<string, LinkRec>();
  private readonly tabs = new Map<string, TabRec>();
  private readonly offBump: () => void;
  private readonly offTurns: () => void;
  private serial = 0;
  private closed = false;

  constructor(o: RelayOptions) {
    const sw = relaySwitches();
    this.registry = o.registry;
    this.turns = o.turns;
    this.clock = o.clock ?? realClock;
    this.holdMs = o.holdMs ?? sw.holdMs ?? ASSISTANT_HOLD_MS;
    this.ackMs = o.ackMs ?? sw.ackMs ?? RELAY_ACK_MS;
    this.graceMs = o.unregisterGraceMs ?? UNREGISTER_GRACE_MS;
    this.abortGraceMs = o.abortGraceMs ?? ABORT_GRACE_MS;
    this.pluginLoaded = o.pluginLoaded ?? ((key: string) => livePluginLoaded(key));
    this.presenter = Object.freeze({
      present: (view: GateView, owner: GateOwner) => this.presentGate(view, owner),
      withdraw: (view: GateView, owner: GateOwner, closed: { answer: GateAnswer; by: GateClosedBy }) => this.withdrawGate(view, owner, closed),
    });
    if (!o.keepPresenter) this.turns.gates.setPresenter(this.presenter);
    this.turns.setTabInfo((tab) => this.tabInfo(tab));
    this.offTurns = this.turns.onTurnChange((t) => {
      if (t.tab) this.turnsChanged(t.tab);
    });
    this.offBump = (o.onEpochBump ?? onPluginEpochBump)((key: string) => this.onEpochBump(key));
  }

  // ------------------------------------------------------------ the channel

  /** Opens the `assistant` channel of a tab (event-hub.ts's open for that kind). */
  open(params: Record<string, unknown>, send: ChannelSend, done: () => void, meta: ChannelMeta): ChannelOpened {
    if (!meta.local) return { ok: false, status: 403, error: REMOTE_MESSAGE };
    if (params.role !== 'relay') return { ok: false, status: 400, error: "The assistant channel's role must be 'relay'." };
    if (this.closed) return { ok: false, status: 503, error: 'The Assistant is stopping.' };
    // A newer channel of the same tab takes over from an older one still open.
    const old = this.tabs.get(meta.tab)?.link;
    if (old) this.linkGone(old);
    const t = this.tabRec(meta.tab);
    const rec: LinkRec = { link: randomBytes(12).toString('hex'), tab: meta.tab, cid: meta.cid, send, done, open: true };
    this.links.set(rec.link, rec);
    t.link = rec;
    send('linked', { link: rec.link });
    const n = this.turns.activeForTab(meta.tab);
    t.turns = n;
    const hold = this.liveHold(t);
    if (n > 0 || hold !== null) send('active', { turns: n, hold_until: hold });
    // Questions of its turns that waited for it are shown now.
    this.turns.gates.tabLinked(meta.tab);
    return { ok: true, cleanup: () => this.linkEnded(rec) };
  }

  private tabRec(tab: string): TabRec {
    let t = this.tabs.get(tab);
    if (!t) {
      t = { tab, link: null, rev: 0, reg: null, dormant: false, dormantTimer: null, since: this.clock.now(), pending: null, turns: 0, holdUntil: null, holdTimer: null };
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
    if (t.reg && t.reg.link === rec.link && !t.dormant) {
      this.registry.setConnected(t.tab, rec.link, false);
      t.dormant = true;
      t.since = this.clock.now();
      this.clock.clearTimeout(t.dormantTimer);
      t.dormantTimer = this.clock.setTimeout(() => this.expireDormant(t), this.holdMs);
    }
    if (t.link === rec) {
      t.link = null;
      this.turns.gates.tabUnlinked(t.tab);
    }
    this.maybeForget(t);
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

  private clearDormant(t: TabRec): void {
    this.clock.clearTimeout(t.dormantTimer);
    t.dormantTimer = null;
    t.dormant = false;
  }

  /** Forgets a tab with nothing left: no link, registration, call, bound turn or hold. */
  private maybeForget(t: TabRec): void {
    if (t.link || t.reg || t.pending || t.turns > 0 || this.tabs.get(t.tab) !== t) return;
    if (this.liveHold(t) !== null) return;
    this.clock.clearTimeout(t.holdTimer);
    this.clock.clearTimeout(t.dormantTimer);
    this.tabs.delete(t.tab);
  }

  private liveHold(t: TabRec): number | null {
    return t.holdUntil !== null && t.holdUntil > this.clock.now() ? t.holdUntil : null;
  }

  // ------------------------------------------------------------ registrations

  /** POST /api/assistant/relay/tools. */
  register(body: Record<string, unknown>): Answer {
    if (typeof body.link !== 'string') return refuse(400, 'bad_request', "link is the channel's link (its linked frame).");
    const rec = this.closed ? null : this.liveLink(body.link);
    if (!rec) return refuse(409, 'no_channel', NO_CHANNEL_TEXT);
    const rev = body.rev;
    if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 1) return refuse(400, 'bad_request', 'rev is a whole number from 1.');
    if (!Array.isArray(body.tools)) return refuse(400, 'bad_request', 'tools is a list ([] withdraws them).');
    if (body.guide !== undefined && body.guide !== null && typeof body.guide !== 'string') return refuse(400, 'bad_request', 'guide is text.');
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
    if (!pinned && !loaded) return refuse(409, 'plugin_off', `${pluginName} is not turned on, so its workspace can't offer tools to the Assistant.`);

    t.rev = rev;
    const link = rec.link;
    const tab = rec.tab;
    const verdict = this.registry.setWorkspace(tab, link, {
      plugin: ws.plugin,
      pluginName,
      workspace: ws.workspace,
      projectId: ws.projectId,
      studyId: ws.studyId,
      epoch: current,
      tools: body.tools,
      guide: typeof body.guide === 'string' ? body.guide : '',
      invoke: (c) => this.invoke(tab, link, c),
    });
    const wasLive = !!t.reg && t.reg.link === link && !t.dormant;
    this.clearDormant(t);
    t.reg = { link, plugin: ws.plugin, pluginName, workspace: cleanText(ws.workspace, TEXT_CAPS.name) || 'the workspace', epoch: current };
    if (!wasLive) t.since = this.clock.now();
    return ok({ available: true, accepted: verdict.accepted, refused: verdict.refused, epoch: `${boot}:${current}:${pluginHash(ws.plugin)}` });
  }

  /** tools []: the registration goes; a call still running gets the grace for its result. */
  private withdraw(t: TabRec): void {
    if (t.reg) {
      this.registry.setWorkspace(t.tab, t.reg.link, null);
      t.reg = null;
    }
    this.clearDormant(t);
    const p = t.pending;
    if (p && !p.done && !p.unregistering) {
      p.unregistering = true;
      p.unregisterTimer = this.clock.setTimeout(() => this.finish(p, fail('closed', closedText(p.workspace))), this.graceMs);
    }
  }

  /** A plugin was turned off, swapped or reset ('*': every plugin): its registrations and calls go now. */
  private onEpochBump(key: string): void {
    const hit = (plugin: string) => key === '*' || plugin === key;
    for (const t of [...this.tabs.values()]) {
      const p = t.pending;
      if (p && !p.done && hit(p.plugin)) this.finish(p, fail('plugin_off', pluginOffText(p.pluginName)));
      if (t.reg && hit(t.reg.plugin)) {
        this.registry.setWorkspace(t.tab, t.reg.link, null);
        t.reg = null;
        this.clearDormant(t);
        const l = t.link;
        if (l && l.open) l.send('unregistered', { reason: 'plugin_off' });
      }
      this.maybeForget(t);
    }
  }

  // ------------------------------------------------------------ calls

  /** Runs one call in the tab's page (the registry's invoke of a workspace tool). */
  invoke(tab: string, link: string, c: InvokeCall): Promise<ToolOutcome> {
    const t = this.tabs.get(tab);
    const reg = t?.reg ?? null;
    const ws = reg?.workspace ?? 'the workspace';
    if (!t || !reg || reg.link !== link) return Promise.resolve(fail('unavailable', `${ws} is no longer open.`));
    if (this.registry.currentEpoch(reg.plugin) !== reg.epoch) return Promise.resolve(fail('plugin_off', `${reg.pluginName} was turned off or replaced.`));
    const live = t.link;
    if (this.closed || !live || !live.open || live.link !== link || t.dormant) return Promise.resolve(fail('tab_disconnected', notSentText(ws)));
    if (t.pending) return Promise.resolve(fail('busy', busyText(ws)));
    if (c.signal.aborted) return Promise.resolve(fail('aborted', 'It was stopped before it started.'));
    this.serial += 1;
    const call = `rc-${this.serial.toString(36)}-${randomBytes(3).toString('hex')}`;
    return new Promise<ToolOutcome>((resolve) => {
      const p: Pending = {
        call,
        tab,
        link,
        plugin: reg.plugin,
        pluginName: reg.pluginName,
        epoch: reg.epoch,
        workspace: ws,
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
      const sent = live.send('invoke', { call, turn: c.turn, tool: c.tool, input: c.input, timeout_s: c.timeoutS });
      // The channel or its stream is gone (its cleanup may not have run yet): it never reached the page.
      if (!sent) {
        this.finish(p, fail('tab_disconnected', notSentText(ws)));
        return;
      }
      p.ackTimer = this.clock.setTimeout(() => {
        p.ackTimer = null;
        if (!p.acked) this.finish(p, fail('tab_disconnected', disconnectedText(ws)));
      }, this.ackMs);
      const onAbort = () => this.abortCall(p);
      c.signal.addEventListener('abort', onAbort, { once: true });
      p.offAbort = () => c.signal.removeEventListener('abort', onAbort);
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
    const p = this.pendingFor(rec, body.call);
    if (!p) return ok({ stale: true });
    const moved = body.fraction !== undefined || body.label !== undefined;
    if (body.ack === true || moved) {
      p.acked = true;
      this.clock.clearTimeout(p.ackTimer);
      p.ackTimer = null;
    }
    if (moved && !p.aborted) {
      const f = typeof body.fraction === 'number' && Number.isFinite(body.fraction) ? Math.min(1, Math.max(0, body.fraction)) : null;
      try {
        p.progress(f, cleanText(body.label, 120));
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
    const p = this.pendingFor(rec, body.call);
    if (!p) return ok({ stale: true });
    // The plugin changed under it: its answer is not taken.
    if (this.registry.currentEpoch(p.plugin) !== p.epoch) {
      this.finish(p, fail('plugin_off', pluginOffText(p.pluginName)));
      return ok({ stale: true });
    }
    this.finish(p, pageOutcome(body));
    return ok();
  }

  // ------------------------------------------------------------ turns and gates

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

  private presentGate(view: GateView, owner: GateOwner): boolean {
    if (this.closed || owner.kind !== 'turn' || !owner.tab) return false;
    const l = this.tabs.get(owner.tab)?.link;
    if (!l || !l.open) return false;
    return l.send('gate', { gate: view });
  }

  private withdrawGate(view: GateView, owner: GateOwner, closed: { answer: GateAnswer; by: GateClosedBy }): void {
    if (this.closed || owner.kind !== 'turn' || !owner.tab) return;
    const l = this.tabs.get(owner.tab)?.link;
    if (!l || !l.open) return;
    l.send('gate_closed', { gate: view.id, answer: closed?.answer ?? 'deny', by: closed?.by ?? 'stop' });
  }

  // ------------------------------------------------------------ views

  /** /tabs: since when the tab's registration is connected or dormant, and its hold. */
  tabInfo(tab: string): { since: number | null; hold_until: number | null } | null {
    const t = this.tabs.get(tab);
    if (!t) return null;
    return { since: t.reg ? t.since : null, hold_until: this.liveHold(t) };
  }

  /** The test state route: each tab the relay knows. */
  snapshot(): Record<string, { connected: boolean; dormant: boolean; tools: number; pending: number; rev: number; turns: number; hold_until: number | null }> {
    const out: Record<string, { connected: boolean; dormant: boolean; tools: number; pending: number; rev: number; turns: number; hold_until: number | null }> = {};
    for (const t of this.tabs.values()) {
      const w = this.registry.workspaceOf(t.tab);
      out[t.tab] = {
        connected: !!t.link?.open,
        dormant: t.dormant,
        tools: w && t.reg ? w.tools.length : 0,
        pending: t.pending ? 1 : 0,
        rev: t.rev,
        turns: t.turns,
        hold_until: this.liveHold(t),
      };
    }
    return out;
  }

  /** The server is closing: its timers stop and calls still out fail. */
  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.offBump();
    this.offTurns();
    this.turns.setTabInfo(null);
    for (const t of this.tabs.values()) {
      const p = t.pending;
      if (p && !p.done) this.finish(p, fail('tab_disconnected', 'The server stopped while the tool ran; it may or may not have finished.'));
      this.clock.clearTimeout(t.dormantTimer);
      this.clock.clearTimeout(t.holdTimer);
    }
  }
}

/** The workspace a registration names (the host's own scope for the frame). */
function parseWorkspace(raw: unknown): { plugin: string; workspace: string; projectId: string; studyId: string } | string {
  if (!isRecord(raw)) return 'workspace is {project_id, plugin, workspace, study_id}.';
  const plugin = raw.plugin;
  if (typeof plugin !== 'string' || !PLUGIN_KEY.test(plugin)) return 'workspace.plugin is a plugin key.';
  const workspace = raw.workspace;
  if (typeof workspace !== 'string' || !workspace || workspace.length > TEXT_CAPS.name) return "workspace.workspace is the workspace's name.";
  const id = (v: unknown) => (v === undefined || v === null || v === '' ? '' : typeof v === 'string' && ID.test(v) ? v : null);
  const projectId = id(raw.project_id);
  const studyId = id(raw.study_id);
  if (projectId === null || studyId === null) return 'workspace.project_id and workspace.study_id are ids.';
  return { plugin, workspace, projectId, studyId };
}

/**
 * The page's answer as the call's outcome: an error with a code from the page's and the
 * bridge's lists (else `failed`), or its result shape-checked and capped as the bridge does
 * (`bad_result`, `too_large`); images go on as base64 for the runner's own checks.
 */
export function pageOutcome(body: Record<string, unknown>): ToolOutcome {
  const bad = (why: string) => fail('bad_result', `The tool's result was refused: ${why}.`);
  const big = (why: string) => fail('too_large', `The tool's result is too large: ${why}.`);
  if (body.ok === false) {
    const e = isRecord(body.error) ? body.error : {};
    const code = typeof e.code === 'string' && PAGE_RESULT_CODES.has(e.code) ? e.code : 'failed';
    return fail(code, cleanText(e.message, TEXT_CAPS.other) || 'The tool failed.');
  }
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
  if (out.images?.length) out.summary = `Done (${out.images.length} image${out.images.length === 1 ? '' : 's'})`;
  return out;
}

export function createRelay(o: RelayOptions): Relay {
  return new Relay(o);
}
