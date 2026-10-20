/**
 * What the shown conversation puts in the dock (phase 4 spec 2-4, 6, 7): DockShell's content.
 * It keeps the conversation store in step with where the person is (context.ts), reads the
 * conversation list when the dock opens and after each request ends, follows the shown
 * conversation's newest requests (10, "Show earlier requests" for 10 more), and builds the
 * header's menu and the transcript.
 */
import { useEffect, useState } from 'react';
import { useAssistantStatus } from '../status';
import type { ConversationRow, ConversationTurn } from '../wire';
import { Composer } from './Composer';
import { INTRO_HOME, INTRO_PROJECT, introCad, introWorkspace, NEW_CONVERSATION, OPEN_PROJECT, readOnlyConversation } from './copy';
import { useDockPlace, type DockPlace } from './context';
import { ConversationMenu } from './ConversationMenu';
import { useDock } from './dockState';
import type { DockContent } from './DockShell';
import { setShownTurn } from './follow';
import { stopDockTurn } from './send';
import { keptTurns, localPicturesOf, refreshConversations, retainTurns, setDockContext, setTurnStopper, showConversation, useDockStore, watchTurn } from './store';
import { Transcript, type TranscriptTurn } from './Transcript';
import { emptyTurnView, isEnded } from './turnView';

/** Requests shown at first, and added by each "Show earlier requests". */
export const TURNS_PAGE = 10;

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
  const visibleKey = visible.map((t) => `${t.id}:${TERMINAL.has(t.state) ? 1 : 0}`).join(',');

  // Follow what is shown (an ended request only for its snapshot); stop following the rest.
  useEffect(() => {
    for (const t of visible) watchTurn(t.id, { ended: TERMINAL.has(t.state) });
    // This tab's own running requests stay followed (the pill shows them) in another conversation too.
    retainTurns([...visible.map((t) => t.id), ...keptTurns()]);
  }, [visibleKey]);

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

  if (status.state !== 'ready') return null;

  const state: DockContent['state'] = store.questions.length ? 'question' : running.length ? 'running' : turns.length ? 'ready' : 'empty';
  const onNew = () => showConversation(null);
  const elsewhereProject = !!row && (row.project_id ?? null) !== place.projectId;
  return {
    state,
    header: <ConversationMenu list={list} shown={row} projectId={place.projectId} onPick={(id) => showConversation(id)} onNew={onNew} />,
    log: (
      <Transcript
        turns={turns}
        hasEarlier={rows.length > visible.length}
        onEarlier={() => setPage((n) => n + TURNS_PAGE)}
        intro={introOf(place)}
        status={status.status}
        workspace={place.workspace?.name ?? ''}
        stops={store.stops}
        localPictures={localPicturesOf}
      />
    ),
    composer:
      elsewhereProject && row ? (
        <ReadOnly row={row} onNew={onNew} />
      ) : (
        <Composer place={place} status={status.status} conversation={row} conversationId={store.shown} running={newestRunning} onNew={onNew} />
      ),
  };
}
