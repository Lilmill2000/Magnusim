/**
 * What the shown conversation puts in the dock (phase 4 spec 2-4, 6, 7): DockShell's content.
 * It keeps the conversation store in step with where the person is (context.ts), reads the
 * conversation list when the dock opens and after each request ends, follows the shown
 * conversation's newest requests (10, "Show earlier requests" for 10 more), and builds the
 * header's menu, the transcript and the composer.
 *
 * A saved chat picked in History shows read only in the transcript's place (SavedChat.tsx), with
 * its line and Continue in a new chat in the composer's.
 *
 * Questions (spec 4): a card of a request shown here sits under it; any other card in the
 * questions strip at the top. Requests of other origins bound to this tab (the command line),
 * and those whose card shows here, show read-only under "Elsewhere". After a reload, a running
 * request this tab started (its answer key kept) shows its open questions here again (POST
 * /turns/:id/show). While a request this tab started runs, the relay's link is held.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { holdAssistantLink, relayTurnsSnapshot, subscribeRelayTurns } from '../relay';
import { useAssistantStatus } from '../status';
import type { ConversationRow, ConversationTurn } from '../wire';
import { Composer } from './Composer';
import {
  ASKED_BY_APP,
  askedOutside,
  INTRO_HOME,
  INTRO_PROJECT,
  introCad,
  introWorkspace,
  NEW_CONVERSATION,
  OPEN_PROJECT,
  QUESTION_ELSEWHERE,
  QUESTIONS_ELSEWHERE,
  readOnlyConversation,
  STOP_THAT_REQUEST,
  tabBusy,
} from './copy';
import { useDockPlace, type DockPlace } from './context';
import { ConversationMenu } from './ConversationMenu';
import { SavedBar, SavedChat } from './SavedChat';
import { useDock } from './dockState';
import type { DockContent } from './DockShell';
import { setShownTurn } from './follow';
import { GateCard } from './GateCard';
import { useGateCards, type OpenCard } from './gates';
import { showHere, startedHere, stopDockTurn } from './send';
import { answerKeyOf, keptTurns, localPicturesOf, refreshConversations, retainTurns, setDockContext, setTurnStopper, showConversation, useDockStore, watchTurn } from './store';
import { Transcript, type TranscriptTurn } from './Transcript';
import { UndoChanges } from './Undo';
import { emptyTurnView, isEnded } from './turnView';

/** Requests shown at first, and added by each "Show earlier requests". */
export const TURNS_PAGE = 10;
/** Requests of other origins shown under "Elsewhere" at most. */
export const ELSEWHERE_MAX = 3;

const TERMINAL: ReadonlySet<string> = new Set(['done', 'stopped', 'failed', 'capped']);

/** The intro of an empty conversation where the person is (spec 7). */
export function introOf(place: DockPlace): string {
  const ws = place.workspace;
  if (ws && ws.state === 'tools') return ws.plugin === 'cad' ? introCad(ws.name) : introWorkspace(ws.name);
  return place.projectId ? INTRO_PROJECT : INTRO_HOME;
}

/** A conversation of another project (spec 2.2): read here, continued there. */
function ReadOnly({ row, onNew }: { row: ConversationRow; onNew: () => void }) {
  return (
    <div className="dock-readonly" data-dock-readonly="1">
      <p className="dock-muted">{readOnlyConversation(row.project_title ?? row.project_id ?? '')}</p>
      <div className="dock-readonly-actions">
        <button
          type="button"
          className="home-btn"
          data-dock-open-project="1"
          onClick={() => {
            if (row.project_id) location.hash = `#/p/${encodeURIComponent(row.project_id)}`;
          }}
        >
          {OPEN_PROJECT}
        </button>
        <button type="button" className="home-btn" data-dock-new-line="1" onClick={onNew}>
          {NEW_CONVERSATION}
        </button>
      </div>
    </div>
  );
}

export function useDockContent(): DockContent | null {
  const place = useDockPlace();
  const store = useDockStore();
  const status = useAssistantStatus();
  const dock = useDock();
  const [page, setPage] = useState(TURNS_PAGE);
  // The pill's Stop is the composer's.
  useEffect(() => {
    setTurnStopper((turn) => void stopDockTurn(turn));
    return () => setTurnStopper(null);
  }, []);

  const wsName = place.workspace?.name ?? null;
  useEffect(() => setDockContext({ project_id: place.projectId, workspace: wsName }), [place.projectId, wsName]);
  // Read at the page's start too, with the dock closed (it no longer reopens by itself): a
  // request still at work after a reload is followed again, so its open question comes back and
  // opens the dock, and the corner button says it is working.
  useEffect(() => {
    void refreshConversations();
  }, []);
  useEffect(() => {
    if (dock.open) void refreshConversations();
  }, [dock.open]);

  const list = store.conversations.list;
  const row = list.find((r) => r.id === store.shown) ?? null;
  useEffect(() => setPage(TURNS_PAGE), [store.shown]);

  // The list's turns, then this tab's own it doesn't name yet.
  const listed: ConversationTurn[] = row ? row.turns : [];
  const mine = store.shown ? (store.local[store.shown] ?? []) : [];
  const rows: Array<ConversationTurn | { id: string; state: 'starting'; title: ''; started_at: ''; ended_at: null; started_by: 'window' }> = [
    ...listed,
    ...mine.filter((id) => !listed.some((t) => t.id === id)).map((id) => ({ id, state: 'starting' as const, title: '' as const, started_at: '' as const, ended_at: null, started_by: 'window' as const })),
  ];
  const visible = rows.slice(-page);
  const visibleIds = new Set(visible.map((t) => t.id));

  // Requests bound to this tab from elsewhere, and the requests of cards not shown here.
  const relayTurns = useSyncExternalStore(subscribeRelayTurns, relayTurnsSnapshot, relayTurnsSnapshot);
  const cards = useGateCards();
  const [elsewhere, setElsewhere] = useState<string[]>([]);
  useEffect(() => setElsewhere([]), [store.shown, place.projectId]);
  const wantElsewhere = [...relayTurns.map((t) => t.id), ...cards.map((c) => c.gate.turn ?? '')].filter((id) => id && !visibleIds.has(id));
  const wantKey = wantElsewhere.join(',');
  useEffect(() => {
    if (!wantKey) return;
    setElsewhere((had) => {
      const next = [...had.filter((id) => !wantKey.split(',').includes(id)), ...wantKey.split(',')];
      return next.slice(-ELSEWHERE_MAX);
    });
  }, [wantKey]);
  const elsewhereShown = elsewhere.filter((id) => !visibleIds.has(id));

  const visibleKey = visible.map((t) => `${t.id}:${TERMINAL.has(t.state) ? 1 : 0}`).join(',');
  const elsewhereKey = elsewhereShown.join(',');
  const keptKey = keptTurns().join(',');
  // Follow what is shown (an ended request only for its snapshot); stop following the rest.
  useEffect(() => {
    for (const t of visible) watchTurn(t.id, { ended: TERMINAL.has(t.state) });
    for (const id of elsewhereShown) watchTurn(id);
    // This tab's own running requests stay followed (the pill shows them) in another conversation
    // too, and until their end lets their key (and the link's hold) go.
    for (const id of keptTurns()) watchTurn(id);
    retainTurns([...visible.map((t) => t.id), ...elsewhereShown, ...keptTurns()]);
  }, [visibleKey, elsewhereKey, keptKey]);

  // While a request this tab started runs, its questions come on the relay's link: held.
  useEffect(() => (keptKey ? holdAssistantLink() : undefined), [keptKey]);

  // After a reload: a running request this tab started shows its open questions here again.
  const showTried = useRef(new Set<string>());
  useEffect(() => {
    for (const r of list) {
      for (const t of r.turns) {
        if (TERMINAL.has(t.state) || showTried.current.has(t.id) || startedHere(t.id)) continue;
        const key = answerKeyOf(t.id);
        if (!key) continue;
        showTried.current.add(t.id);
        void showHere(t.id, key);
      }
    }
  }, [list]);

  const turns: TranscriptTurn[] = visible.map((t) => ({ id: t.id, row: t.started_at ? t : null, view: store.turns[t.id] ?? emptyTurnView(t.id) }));
  const running = turns.filter((t) => !isEnded(t.view) && !(t.row && TERMINAL.has(t.row.state) && !t.view.summary && t.view.lastSeq === 0));
  const newestRunning = running.length ? running[running.length - 1].id : null;
  useEffect(() => setShownTurn(newestRunning), [newestRunning]);

  // The list again after a request ended (its state, the conversation's title and use).
  const endedKey = turns
    .filter((t) => isEnded(t.view))
    .map((t) => t.id)
    .join(',');
  useEffect(() => {
    if (endedKey) void refreshConversations();
  }, [endedKey]);

  const saved = store.saved;
  const state: DockContent['state'] = store.questions.length ? 'question' : running.length ? 'running' : turns.length || saved ? 'ready' : 'empty';
  const onNew = () => showConversation(null);
  const elsewhereProject = !!row && (row.project_id ?? null) !== place.projectId;

  // Who asks a card's question: a request of another origin, another app, or (none) this window.
  const whoOf = (c: OpenCard): string | null => {
    if (!c.gate.turn) return ASKED_BY_APP;
    const v = store.turns[c.gate.turn];
    if (v?.summary?.started_by !== 'program') return null;
    const title = v.summary.title || relayTurns.find((t) => t.id === c.gate.turn)?.title || '';
    return askedOutside(title);
  };
  const cardList = (list: readonly OpenCard[]) => (list.length ? list.map((c) => <GateCard key={c.gate.id} card={c} who={whoOf(c)} first={c === cards[0]} />) : null);
  // The status not read, the server not answering, or the Assistant off: the shell shows its
  // own state, and a question of another app (MCP) that runs here still shows as a card.
  if (status.state !== 'ready') return { state: 'empty', questions: cardList(cards) };
  const strip = cards.filter((c) => !c.gate.turn || !visibleIds.has(c.gate.turn));
  // A running request another window started: its questions show there.
  const noteFor = (turn: string): string | null => {
    const v = store.turns[turn];
    if (!v || isEnded(v) || answerKeyOf(turn) || cards.some((c) => c.gate.turn === turn)) return null;
    if (v.summary?.started_by !== 'window') return null;
    return v.openGates.length ? QUESTION_ELSEWHERE : QUESTIONS_ELSEWHERE;
  };
  // Another request works in this workspace (tab_busy): wait for it, or stop it.
  const ws = place.workspace;
  const other = ws && ws.state === 'tools' ? relayTurns.find((t) => t.id !== newestRunning && !visibleIds.has(t.id)) : undefined;
  const busy = other && ws ? { line: tabBusy(ws.name), onStop: () => void stopDockTurn(other.id), stopLabel: STOP_THAT_REQUEST } : null;
  const elsewhereTurns: TranscriptTurn[] = elsewhereShown.map((id) => ({ id, row: null, view: store.turns[id] ?? emptyTurnView(id) }));
  return {
    state,
    header: (
      <ConversationMenu
        list={list}
        shown={row}
        projectId={place.projectId}
        onPick={(id) => showConversation(id)}
        onNew={onNew}
        shownTitle={saved ? saved.chat?.title || NEW_CONVERSATION : null}
      />
    ),
    questions: cardList(strip),
    log: saved ? (
      <SavedChat saved={saved} />
    ) : (
      <Transcript
        turns={turns}
        elsewhere={elsewhereTurns}
        cardsFor={(turn) => cardList(cards.filter((c) => c.gate.turn === turn && visibleIds.has(turn)))}
        noteFor={noteFor}
        endExtraFor={(turn) => (store.turns[turn] ? <UndoChanges view={store.turns[turn]} /> : null)}
        hasEarlier={rows.length > visible.length}
        onEarlier={() => setPage((n) => n + TURNS_PAGE)}
        intro={introOf(place)}
        status={status.status}
        workspace={place.workspace?.name ?? ''}
        stops={store.stops}
        localPictures={localPicturesOf}
        room={row && !row.running ? (row.room ?? null) : null}
        agentContext={row && !row.running ? (row.context ?? null) : null}
      />
    ),
    composer: saved ? (
      <SavedBar saved={saved} />
    ) : elsewhereProject && row ? (
      <ReadOnly row={row} onNew={onNew} />
    ) : (
      <Composer place={place} status={status.status} conversation={row} conversationId={store.shown} running={newestRunning} onNew={onNew} carry={store.carry} busy={busy} />
    ),
  };
}
