// The Assistant in the Part (CAD tools spec §2.1 install.ts): the page's state (runtime.ts), the
// page API other areas ask (services.apis.assistant: the camera gate, the chip's store), the
// host's turns heard before the tools are offered, and ONE registration of the 22 tools with the
// guide for the page's life (the grammar and the prompt cache stay stable; availability is
// answered per call). It registers again on visibilitychange after "not_connected" (a tab opened
// in the background), and stops for good on "remote", "no_assistant" or "not_allowed". The eval's
// A/B (the test handle's setToolset('core')) registers its 13 tools with a guide that names only
// them (guide.ts guideWithout); help's guide and features topics follow (rt.offered). The
// registration asks for review rounds (review.ts CAD_REVIEW: the app checks the Part with the model
// at the end of a turn that edited it); the eval can leave them out (setReview(false)).
// The edits' state lives here too: the undo ledger, the person's pace, the person's input (the
// soft wait), and the pause, which a take-over or the person's undo of the Assistant's steps
// during a running turn starts, and the turn's end (or the next key) ends; the chip shows it.
// Watch mode (§8): the camera latch (camera.ts) behind autoCamera, "Ask each step" (approval.ts),
// and the chip's buttons (AssistantActions): Pause and Resume, Stop (the running call reverts at
// once, later calls of the turn answer busy stopped, the host ends the turn), Keep and Discard,
// Fast / Watch, Ask each step, Pictures (pictures.ts), and Undo of an ended turn's group while it is the newest step.
// With the app's own Assistant panel (docked) the chip leaves Stop and Undo to it: the page offers
// the panel the undo of an ended turn while its group is the newest step (setUndo, withdrawn
// once it is not), and the panel's ask undoes that group (onUndo; not_newest otherwise).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantRegistration, AssistantTool } from '@magnusim/workspace';
import type { AppServices } from '../types/app';
import type { AssistantActions, AssistantPageApi, TurnFacts } from '../types/assistant';
import { createApprovals, createAskEach } from './approval';
import { createPause, createSoftInput, EDIT_WAIT_MS, pauseNote } from './busy';
import { createCallHandler, isBuilt } from './call';
import { createCameraLatch } from './camera';
import { ToolError } from './errors';
import { evalFacts, evalPicture, evalSetParam } from './eval-facts';
import { guideWithout } from './guide';
import { createLedger } from './ledger';
import { createPace } from './pace';
import { createPictures } from './pictures';
import { createRevTracker } from './rev';
import { CAD_REVIEW } from './review';
import { setRuntime, type AssistantRuntime } from './runtime';
import { cadToolsFor, CORE_TOOLSET, TOOL_NAMES } from './schemas';
import { createSessionKeys } from './session-key';
import { createAssistantStore, ENDED_MS, LINGER_MS, phaseOf } from './state';
import { createHoldPoints, type AssistantTestHandle } from './testing';
import { createTurnInfo } from './turn-info';

/** The verdicts after which the page never offers its tools again. */
const FINAL = new Set(['remote', 'no_assistant', 'not_allowed']);

const testHandles = new WeakMap<AppServices, AssistantTestHandle>();

/** window.__CAD__.assistant (src/app/debug.ts), or null before installAssistant. */
export function assistantTestHandle(services: AppServices): AssistantTestHandle | null {
  return testHandles.get(services) ?? null;
}

export interface InstallOptions {
  /** The page's document (tests pass jsdom's). */
  document?: Document;
  now?: () => number;
}

export function installAssistant(services: AppServices, o: InstallOptions = {}): () => void {
  const doc = o.document ?? (typeof document !== 'undefined' ? document : null);
  const assistant = services.bridge.assistant;
  const store = createAssistantStore();
  const turns = createTurnInfo();
  const keys = createSessionKeys({ committed: () => services.doc.committed(), now: o.now });
  const rev = createRevTracker({ doc: services.doc, bus: services.bus, projectLinks: () => services.bridge.projectLinks() });
  const holds = createHoldPoints();
  // A turn the host said has ended takes no pause (it would outlive the turn: nothing ends it).
  const pause = createPause({ isOver: (id) => turns.get(id)?.state === 'ended', sameSession: (a, b) => keys.sameSession(a, b) });
  const pace = createPace({ doc: services.doc, prefs: services.bridge.prefs, document: doc });
  const soft = createSoftInput(doc, o.now);
  const camera = createCameraLatch({ viewport: services.viewport, pace, soft });
  const askEach = createAskEach({ prefs: services.bridge.prefs });
  const approvals = createApprovals();
  const pictures = createPictures({ prefs: services.bridge.prefs });
  let title = services.bridge.context.study?.title ?? '';
  const offs: (() => void)[] = [];
  offs.push(services.bridge.onStudy((s) => void (title = s.title ?? title)));

  const rt: AssistantRuntime = {
    services,
    store,
    turns,
    keys,
    rev,
    holds,
    calls: [],
    madeBy: new Set(),
    brokenBy: new Set(),
    ledger: createLedger(),
    pause,
    pace,
    soft,
    camera,
    askEach,
    approvals,
    pictures,
    picturesOwed: new Set(),
    active: new Map(),
    stopped: new Set(),
    lastKey: null,
    paced: new Map(),
    waitCapMs: EDIT_WAIT_MS,
    seenKeys: new Set(),
    guideNoted: new Set(),
    title: () => title,
    isBuilt,
    offered: TOOL_NAMES,
    review: true,
    hostKeepsHints: !!assistant?.onTurn,
  };
  setRuntime(services, rt);

  // ---- the phase (state.ts): recomputed from the facts, the turns and two timers
  let lastCallEnd = 0;
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;
  let endedTimer: ReturnType<typeof setTimeout> | null = null;
  const now = o.now ?? (() => Date.now());
  const refresh = () => {
    const s = store.get();
    const running = turns.running().length > 0;
    const lingering = !assistant?.onTurn && lastCallEnd > 0 && now() - lastCallEnd < LINGER_MS;
    const p = pause.get();
    const phase = phaseOf(s, running, lingering, !!p);
    if (phase !== s.phase) store.set(phase === 'paused' && p ? { phase, note: pauseNote(p) } : { phase });
    else if (phase === 'paused' && p && s.note !== pauseNote(p)) store.set({ note: pauseNote(p) });
  };
  offs.push(store.subscribe(refresh));
  const onCall = services.bus.on('assistant:call', (e) => {
    if (e.phase !== 'end' || assistant?.onTurn) return;
    lastCallEnd = now();
    if (lingerTimer) clearTimeout(lingerTimer);
    lingerTimer = setTimeout(refresh, LINGER_MS + 10);
    refresh();
  });
  offs.push(onCall, () => {
    if (lingerTimer) clearTimeout(lingerTimer);
    if (endedTimer) clearTimeout(endedTimer);
  });

  // The turn the chip speaks of: the running one; an ended one until ENDED_MS or the next change.
  const showTurn = (t: TurnFacts) => {
    if (endedTimer) clearTimeout(endedTimer);
    endedTimer = null;
    const facts = {
      id: t.id,
      title: t.title,
      steps: t.used.stepsCap ? t.used.steps : null,
      stepsCap: t.used.stepsCap || null,
      changes: t.used.changesCap ? t.used.changes : null,
      changesCap: t.used.changesCap || null,
      ...(t.review ? { review: { ...t.review } } : {}),
    };
    if (t.state === 'running') {
      store.set({ turn: { ...facts, end: null } });
      return;
    }
    const shown = store.get().turn;
    // Another turn runs (one turn per tab: rare): the chip stays on it.
    if (shown && shown.id !== t.id && !shown.end && turns.get(shown.id)?.state === 'running') return;
    store.set({ turn: { ...facts, end: t.end?.state ?? 'ended' } });
    endedTimer = setTimeout(clearEnded, ENDED_MS);
  };
  const clearEnded = () => {
    if (store.get().turn?.end) store.set({ turn: null });
  };
  offs.push(turns.subscribe(showTurn));
  // The camera latch's baseline: the person's camera moves when the turn starts running.
  offs.push(
    turns.subscribe((t) => {
      if (t.state === 'running') camera.turnRuns(`turn:${t.id}`);
    }),
  );
  // The chip's toggles show the person's choices.
  store.set({ pace: pace.get(), askEach: askEach.get(), pictures: pictures.get(), canStop: !!assistant?.stop, docked: !!assistant?.docked });
  offs.push(
    pace.subscribe((p) => store.set({ pace: p })),
    askEach.subscribe((on) => store.set({ askEach: on })),
    pictures.subscribe((v) => store.set({ pictures: v })),
  );

  // ---- the pause: the chip shows it; it ends with its turn, or at the next key (busy.ts createPause)
  offs.push(
    pause.subscribe((p) => {
      // A step asking "keep it?" keeps its question (its Keep or Discard ends it; then the chip says paused).
      if (p) {
        if (store.get().phase !== 'approve') store.set({ phase: 'paused', note: pauseNote(p) });
      } else if (store.get().phase === 'paused') store.set({ phase: 'idle', note: null });
      // (A note that changed while paused, "· Plane 1 stayed", follows through refresh.)
    }),
    turns.subscribe((t) => {
      if (t.state === 'ended') pause.turnEnded(t.id);
    }),
    // The person's undo or redo of the Assistant's steps while its turn runs: it waits for them
    // (the chip says which: "you undid its steps", "you redid its steps").
    services.bus.on('assistant:person-undo', (e) => {
      if (!e.tag) return;
      const why = e.redo ? 'redo' : 'undo';
      const id = e.tag.startsWith('turn:') ? e.tag.slice('turn:'.length) : null;
      const facts = id ? turns.get(id) : null;
      if (facts) {
        if (facts.state === 'running') pause.set(why, e.tag, facts.id);
        return;
      }
      // Without the host's turn events: while its calls still come (the chip's linger).
      if (!assistant?.onTurn && lastCallEnd > 0 && now() - lastCallEnd < LINGER_MS) pause.set(why, e.tag, null);
    }),
    () => {
      pace.dispose();
      soft.dispose();
      askEach.dispose();
      pictures.dispose();
    },
  );
  // An ended turn's chip goes with the next change of the Part.
  let revSeen = rev.current();
  offs.push(
    services.doc.state.subscribe(() => {
      const r = rev.current();
      if (r === revSeen) return;
      revSeen = r;
      if (store.get().turn?.end) clearEnded();
    }),
  );

  // ---- the page API
  /** The running turn bound here (one turn per tab), else null. */
  const runningTurn = () => turns.running()[0] ?? null;
  const actions: AssistantActions = {
    pause() {
      const t = runningTurn();
      if (t) {
        pause.set('person', `turn:${t.id}`, t.id);
        return;
      }
      // No turn runs: the newest call's key, with its turn when the host told of it (one that
      // has ended takes no pause: review, it outlived the turn), else none (the next key ends it).
      const key = rt.lastKey;
      if (!key) return;
      pause.set('person', key, turns.forKey(key)?.id ?? null);
    },
    resume: () => pause.resume(),
    stop() {
      const t = runningTurn();
      if (!t || !assistant?.stop) return;
      const key = `turn:${t.id}`;
      rt.stopped.add(key);
      if (rt.stopped.size > 64) rt.stopped.delete(rt.stopped.values().next().value as string);
      // The call running now goes back at once (its abort handler reverts the step synchronously).
      const why = new ToolError('stopped', 'The person stopped the Assistant; nothing of this call was kept.');
      for (const a of [...rt.active.values()]) if (a.key === key) a.stop(why);
      void assistant.stop(t.id).catch((e) => console.warn('[cad] the Assistant could not be stopped', e));
    },
    keep: () => approvals.answer(true),
    discard: () => approvals.answer(false),
    undo() {
      const t = store.get().turn;
      if (!t?.end) return;
      const r = services.doc.assistant.undoGroup(`turn:${t.id}`);
      if (!r.ok) services.bridge.toast(`Undo: ${r.reason}`, 'error');
    },
    setPace: (p) => pace.set(p),
    setAskEach: (on) => askEach.set(on),
    setPictures: (v) => pictures.set(v),
  };
  const api: AssistantPageApi = {
    autoCamera(_reason, sessionId) {
      const s = services.doc.session();
      const own = !!s && s.id === sessionId && !!s.owner;
      if (!own) return true;
      // The Assistant's own session: its call's key (the camera latch), watch pace, the window shown, no pointer held.
      const callId = s.owner!.startsWith('assistant:') ? s.owner!.slice('assistant:'.length) : null;
      const key = (callId ? rt.active.get(callId)?.key : null) ?? null;
      return camera.allows(key);
    },
    autoFrame(owner) {
      if (!owner) return true;
      if (pace.hidden()) return false;
      const callId = owner.startsWith('assistant:') ? owner.slice('assistant:'.length) : null;
      const key = (callId ? rt.active.get(callId)?.key : null) ?? null;
      return !(key !== null && camera.latched(key));
    },
    state: store,
    actions,
  };
  services.apis.set({ assistant: api });

  if (!assistant) {
    store.set({ registration: 'off', reason: 'no_assistant' });
    return () => {
      for (const off of offs.splice(0)) off();
      rev.dispose();
      services.apis.set({ assistant: null });
      setRuntime(services, null);
    };
  }

  // ---- the turns, heard before the tools are offered (the running ones are told on registration)
  if (assistant.onTurn) offs.push(assistant.onTurn((t) => turns.take(t)));

  // ---- undo from the app's panel: an ended turn's group while it is the newest step
  const setUndo = assistant.setUndo;
  if (setUndo) {
    /** The turn offered now, and its label. */
    let offered: { id: string; label: string } | null = null;
    const tell = (id: string, label: string | null) => void setUndo(id, label).catch((e) => console.warn('[cad] the undo could not be offered', e));
    const sync = () => {
      const top = services.doc.assistant?.topGroup?.() ?? null;
      const id = top && top.tag.startsWith('turn:') ? top.tag.slice('turn:'.length) : null;
      // Only a turn the host told of, once it ended (the same group the chip's Undo takes back).
      const want = id && turns.get(id)?.state === 'ended' ? { id, label: top!.label } : null;
      if (offered && (!want || want.id !== offered.id)) tell(offered.id, null);
      if (want && (!offered || want.id !== offered.id || want.label !== offered.label)) tell(want.id, want.label);
      offered = want;
    };
    offs.push(
      services.doc.state.subscribe(sync),
      turns.subscribe(sync),
      () => {
        if (offered) tell(offered.id, null);
        offered = null;
      },
    );
    sync();
  }
  if (assistant.onUndo) {
    offs.push(
      assistant.onUndo((turn) => {
        const tag = `turn:${turn}`;
        if (services.doc.assistant?.topGroup?.()?.tag !== tag) return { undone: false, reason: 'not_newest' };
        // The newest step still, but the Part takes no undo now (a panel of the person's is open).
        return services.doc.assistant.undoGroup(tag).ok ? { undone: true } : { undone: false, reason: 'busy' };
      }),
    );
  }

  // ---- one registration
  const handler = createCallHandler(rt);
  let disposed = false;
  /** The tools as last registered (the test handle's `registered`). */
  let registered: readonly AssistantTool[] = [];
  let waitingForVisible = false;
  const register = async (): Promise<AssistantRegistration> => {
    const offered = rt.offered;
    // Magnusim CAD (no projects, no simulation): the body tool without its simulation field.
    const tools = cadToolsFor({ projectLinks: services.bridge.projectLinks() }).filter((t) => offered.includes(t.name));
    registered = tools;
    // The guide names only tools offered (the eval's core set leaves some out).
    const guide = guideWithout(TOOL_NAMES.filter((n) => !offered.includes(n)));
    let verdict: AssistantRegistration;
    try {
      verdict = await assistant.register(tools, handler, rt.review ? { guide, review: { ...CAD_REVIEW } } : { guide });
    } catch (e) {
      verdict = { available: false, accepted: [], refused: [], reason: 'failed' };
      console.warn('[cad] the Assistant tools could not be offered', e);
    }
    if (disposed) return verdict;
    if (verdict.available) {
      store.set({ registration: 'on', reason: null });
      if (verdict.refused.length) console.warn('[cad] the app refused Assistant tools', verdict.refused);
    } else {
      const reason = verdict.reason ?? 'unavailable';
      // A register superseded by a later one changes nothing here.
      if (reason !== 'superseded') store.set({ registration: 'off', reason });
      // Only "not_connected" may change (a tab opened in the background): offer again once it shows.
      waitingForVisible = reason === 'not_connected';
      if (FINAL.has(reason)) waitingForVisible = false;
    }
    return verdict;
  };
  const onVisible = () => {
    if (!waitingForVisible || disposed || doc?.visibilityState !== 'visible') return;
    waitingForVisible = false;
    void register();
  };
  doc?.addEventListener('visibilitychange', onVisible);
  offs.push(() => doc?.removeEventListener('visibilitychange', onVisible));
  void register();

  testHandles.set(services, {
    get tools() {
      return [...rt.offered];
    },
    get registered() {
      return JSON.parse(JSON.stringify(registered)) as AssistantTool[];
    },
    state: () => store.get(),
    get calls() {
      return rt.calls.map((c) => ({ ...c }));
    },
    turns: () => turns.all(),
    hold: (p) => holds.hold(p),
    release: (p) => holds.release(p),
    held: () => holds.held(),
    waiting: () => holds.waiting(),
    setHoldS(s) {
      rt.waitCapMs = s === null || !Number.isFinite(s) || s <= 0 ? EDIT_WAIT_MS : Math.round(s * 1000);
    },
    setPace(p, scale) {
      pace.force(p);
      pace.setScale(scale ?? null);
    },
    setAskEach: (on) => askEach.force(on),
    setPictures: (v) => pictures.force(v),
    approving: () => approvals.pending(),
    paused: () => pause.get(),
    async setToolset(set) {
      rt.offered = set === 'core' ? CORE_TOOLSET : TOOL_NAMES;
      const v = await register();
      return { available: v.available, accepted: v.accepted, ...(v.reason ? { reason: v.reason } : {}) };
    },
    async setReview(on) {
      rt.review = on;
      const v = await register();
      return { available: v.available, accepted: v.accepted, ...(v.reason ? { reason: v.reason } : {}) };
    },
    evalFacts: (ask) => evalFacts(services, ask),
    evalSetParam: (name, expr) => evalSetParam(services, name, expr),
    evalPicture: () => evalPicture(services),
  });

  return () => {
    disposed = true;
    for (const off of offs.splice(0)) off();
    holds.clear();
    rev.dispose();
    testHandles.delete(services);
    services.apis.set({ assistant: null });
    setRuntime(services, null);
    if (store.get().registration === 'on') void assistant.register([], null).catch(() => undefined);
  };
}
