/**
 * "Undo these changes" on an ended request (phase 4 spec 8.3): when the workspace open in this
 * tab offers to undo that request's changes as one step (bridge 1.9 assistant.undoable; CAD maps
 * it to the request's own undo group), the request's end block offers the button. It asks the
 * frame that offers it (undoWorkspaceTurn) and says what came of it:
 * - undone: "Undone. Redo (Ctrl+Y) in <Workspace> brings them back." (the button goes);
 * - not_newest: something changed after the request; the workspace's own Undo still works;
 * - busy: try again in a moment;
 * - anything else (no answer, the page closed): the workspace didn't answer.
 * While any request runs in this tab's workspace the button waits (disabled, saying why). With
 * no offer, a request that changed a CAD Part no longer open in this tab says the undo lasted
 * only while the Part stayed open.
 *
 * What came of an undo is kept for the page's life (the offer it spent is gone, the words stay).
 */
import { useState, useSyncExternalStore } from 'react';
import { undoWorkspaceTurn, useWorkspaceTools } from '../../workspace/assistantTools';
import { relayTurnsSnapshot, subscribeRelayTurns } from '../relay';
import { UNDO_CHANGES, UNDO_WAIT, UNDO_WHILE_OPEN, undoAsking, undoBusy, undone, undoNoAnswer, undoNotNewest, undoTitle } from './copy';
import { startedHereRunning, useDockStore } from './store';
import type { TurnView } from './turnView';

/** What an undo of a request said, by turn (kept while the page lives). */
const said = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
function sayFor(turn: string, line: string): void {
  said.set(turn, line);
  version += 1;
  for (const fn of [...listeners]) fn();
}
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const snapshot = () => version;

/** The line an undo's answer reads as. */
export function undoLine(reason: string | undefined, undoneNow: boolean, workspace: string): string {
  if (undoneNow) return undone(workspace);
  if (reason === 'not_newest') return undoNotNewest(workspace);
  if (reason === 'busy') return undoBusy(workspace);
  return undoNoAnswer(workspace);
}

/** Whether a request changed a CAD Part (an edit of one of CAD's tools). */
export function changedCad(v: TurnView): boolean {
  return v.items.some((it) => it.kind === 'tool' && it.risk !== 'read' && it.tool.startsWith('cad__') && !!it.result?.ok);
}

export function UndoChanges({ view }: { view: TurnView }) {
  const tools = useWorkspaceTools();
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const running = useSyncExternalStore(subscribeRelayTurns, relayTurnsSnapshot, relayTurnsSnapshot);
  // A request this tab just started counts before its relay frame says it runs.
  useDockStore();
  const [asking, setAsking] = useState(false);
  const offer = tools.undo.get(view.id) ?? null;
  const line = said.get(view.id) ?? null;
  const workspace = offer ? offer.scope.title || offer.scope.workspace : '';

  if (!offer) {
    if (line) return <p className="dock-muted" data-dock-undo-said="1">{line}</p>;
    // A Part's undo lasts while it stays open: said once it isn't open in this tab.
    const partOpen = !!tools.current && tools.current.scope.plugin === 'cad' && !tools.current.dead;
    return changedCad(view) && !partOpen ? <p className="dock-muted" data-dock-undo-later="1">{UNDO_WHILE_OPEN}</p> : null;
  }
  const busy = running.length > 0 || startedHereRunning();
  const ask = async () => {
    if (asking || busy) return;
    setAsking(true);
    try {
      const a = await undoWorkspaceTurn(view.id);
      sayFor(view.id, undoLine(a.reason, a.undone, workspace));
    } finally {
      setAsking(false);
    }
  };
  return (
    <div className="dock-undo">
      <button
        type="button"
        className="dock-undo-button"
        data-dock-undo={view.id}
        title={busy ? UNDO_WAIT : undoTitle(workspace)}
        disabled={busy || asking}
        aria-describedby={busy ? `dock-undo-why-${view.id}` : undefined}
        onClick={() => void ask()}
      >
        {UNDO_CHANGES}
      </button>
      {busy ? (
        <p className="dock-muted" id={`dock-undo-why-${view.id}`} data-dock-undo-wait="1">
          {UNDO_WAIT}
        </p>
      ) : asking ? (
        <p className="dock-muted" role="status" data-dock-undo-asking="1">
          {undoAsking(workspace)}
        </p>
      ) : null}
      {line ? (
        <p className="dock-muted" data-dock-undo-said="1">
          {line}
        </p>
      ) : null}
    </div>
  );
}
