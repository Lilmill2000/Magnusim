// The Assistant in the Part (CAD tools spec §2.1 install.ts): the page's state (runtime.ts), the
// page API other areas ask (services.apis.assistant: the camera gate, the chip's store), the
// host's turns heard before the tools are offered, and ONE registration of the 18 tools with the
// guide for the page's life (the grammar and the prompt cache stay stable; availability is
// answered per call). It registers again on visibilitychange after "not_connected" (a tab opened
// in the background), and stops for good on "remote", "no_assistant" or "not_allowed".
// The edits' state lives here too: the undo ledger, the person's pace, the person's input (the
// soft wait), and the pause, which a take-over or the person's undo of the Assistant's steps
// during a running turn starts, and the turn's end (or the next key) ends; the chip shows it.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AssistantRegistration } from '@magnusim/workspace';
import type { AppServices } from '../types/app';
import type { AssistantPageApi, TurnFacts } from '../types/assistant';
import { createPause, createSoftInput, EDIT_WAIT_MS, pauseNote } from './busy';
import { createCallHandler, isBuilt } from './call';
import { GUIDE } from './guide';
import { createLedger } from './ledger';
import { createPace } from './pace';
import { createRevTracker } from './rev';
import { setRuntime, type AssistantRuntime } from './runtime';
import { CAD_TOOLS, CORE_TOOLSET } from './schemas';
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
  const rev = createRevTracker({ doc: services.doc, bus: services.bus });
  const holds = createHoldPoints();
  const pause = createPause();
  const pace = createPace({ doc: services.doc, prefs: services.bridge.prefs, document: doc });
  const soft = createSoftInput(doc, o.now);
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
    waitCapMs: EDIT_WAIT_MS,
    seenKeys: new Set(),
    guideNoted: new Set(),
    title: () => title,
    isBuilt,
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
    const phase = phaseOf(s, running, lingering);
    if (phase !== s.phase) store.set({ phase });
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
    const facts = { id: t.id, title: t.title, steps: t.used.stepsCap ? t.used.steps : null, stepsCap: t.used.stepsCap || null };
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

  // ---- the pause: the chip shows it; it ends with its turn, or at the next key (busy.ts createPause)
  offs.push(
    pause.subscribe((p) => {
      if (p) store.set({ phase: 'paused', note: pauseNote(p) });
      else if (store.get().phase === 'paused') store.set({ phase: 'idle', note: null });
    }),
    turns.subscribe((t) => {
      if (t.state === 'ended') pause.turnEnded(t.id);
    }),
    // The person's undo or redo of the Assistant's steps while its turn runs: it waits for them.
    services.bus.on('assistant:person-undo', (e) => {
      if (!e.tag) return;
      const id = e.tag.startsWith('turn:') ? e.tag.slice('turn:'.length) : null;
      const facts = id ? turns.get(id) : null;
      if (facts) {
        if (facts.state === 'running') pause.set('undo', e.tag, facts.id);
        return;
      }
      // Without the host's turn events: while its calls still come (the chip's linger).
      if (!assistant?.onTurn && lastCallEnd > 0 && now() - lastCallEnd < LINGER_MS) pause.set('undo', e.tag, null);
    }),
    () => {
      pace.dispose();
      soft.dispose();
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
  const api: AssistantPageApi = {
    autoCamera(_reason, sessionId) {
      const s = services.doc.session();
      const own = !!s && s.id === sessionId && !!s.owner;
      if (!own) return true;
      // The Assistant's own session: never while the window is hidden (pace and the camera latch come with watch mode).
      return !(doc?.hidden ?? false);
    },
    state: store,
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

  // ---- one registration
  const handler = createCallHandler(rt);
  let disposed = false;
  let offered: readonly string[] = CAD_TOOLS.map((t) => t.name);
  let waitingForVisible = false;
  const register = async (): Promise<AssistantRegistration> => {
    const tools = CAD_TOOLS.filter((t) => offered.includes(t.name));
    let verdict: AssistantRegistration;
    try {
      verdict = await assistant.register(tools, handler, { guide: GUIDE });
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
      return [...offered];
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
    paused: () => pause.get(),
    async setToolset(set) {
      offered = set === 'core' ? [...CORE_TOOLSET] : CAD_TOOLS.map((t) => t.name);
      const v = await register();
      return { available: v.available, accepted: v.accepted, ...(v.reason ? { reason: v.reason } : {}) };
    },
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
