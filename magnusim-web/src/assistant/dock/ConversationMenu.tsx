/**
 * The dock header's conversation menu and New (phase 4 spec 2.1, 2.2, 6.2): a button with the
 * shown conversation's title (else "New conversation") that opens the list the server keeps,
 * grouped "Here" (this project, or Home), "Home" and "Other projects", newest use first. Each
 * row: its title, its provider and the time it was last used, a dot while it works, and
 * Forget (asked first with the app's own dialog; 409 says a request runs in it).
 *
 * Under them, History and Clear history (Daniel: "save 31 days"): History lists the chats saved
 * here (this project's, or Home's), newest first, each with its title, provider, when and its
 * first prompt; a pick shows it (a conversation still open, live; any other read only: the
 * store's showSavedChat). Clear history, asked first, deletes this place's saved chats.
 *
 * The list is read again when the menu opens, History each time it is shown. It traps nothing:
 * Escape closes it and gives the keyboard back to its button; so does picking a row.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { confirmAction } from '../../workbench/dialogs';
import { AssistantApiError, assistantGet, assistantPost } from '../api';
import type { ConversationRow, HistoryAnswer, HistoryChat } from '../wire';
import {
  BACK,
  CLEAR_HISTORY,
  CLEAR_HISTORY_COPY,
  CLEAR_HISTORY_KEEP,
  clearedChats,
  clearHistoryTitle,
  CONVERSATIONS_EMPTY,
  CONVERSATIONS_LABEL,
  conversationMeta,
  dayTime,
  FORGET,
  FORGET_BUSY,
  FORGET_COPY,
  FORGET_KEEP,
  FORGET_TITLE,
  forgetLabel,
  GROUP_HERE,
  GROUP_HOME,
  GROUP_OTHER_PROJECTS,
  hhmm,
  HISTORY,
  HISTORY_EMPTY,
  HISTORY_LOADING,
  historyMore,
  historyOf,
  NEW_CONVERSATION,
  NEW_SHORT,
  WORKING_DOT,
} from './copy';
import { HISTORY_PATH, historyCleared, historyProject, refreshConversations, showSavedChat } from './store';

export interface MenuGroups {
  here: ConversationRow[];
  home: ConversationRow[];
  other: ConversationRow[];
}

/** The list in its three groups for `projectId` (null: Home), each newest use first. */
export function groupConversations(list: readonly ConversationRow[], projectId: string | null): MenuGroups {
  const sorted = [...list].sort((a, b) => Date.parse(b.last_used_at) - Date.parse(a.last_used_at));
  const here = sorted.filter((r) => (r.project_id ?? null) === projectId);
  const home = projectId === null ? [] : sorted.filter((r) => !r.project_id);
  const other = sorted.filter((r) => r.project_id && r.project_id !== projectId);
  return { here, home, other };
}

/** A conversation's name in the menu: its title, else its project's, else "New conversation". */
export const conversationName = (row: ConversationRow | null | undefined): string => (row && row.title) || NEW_CONVERSATION;

/** History as the menu shows it: read when shown. */
interface HistoryView {
  state: 'loading' | 'ready' | 'error';
  chats: HistoryChat[];
  total: number;
  error: string | null;
}

/** The chats saved here (null: Home), newest end first. */
export async function readHistory(projectId: string | null): Promise<HistoryView> {
  try {
    const r = await assistantGet<HistoryAnswer>(`${HISTORY_PATH}?project=${historyProject(projectId)}`);
    const chats = Array.isArray(r.chats) ? r.chats.filter((c) => !!c && typeof c.id === 'string') : [];
    return { state: 'ready', chats, total: typeof r.total === 'number' ? r.total : chats.length, error: null };
  } catch (err) {
    return { state: 'error', chats: [], total: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Clear history, asked first: 'kept' (the person said Keep), how many went, or the line to show why not. */
export async function clearHistory(projectId: string | null): Promise<'kept' | number | { error: string }> {
  const ok = await confirmAction({ title: clearHistoryTitle(projectId === null), copy: CLEAR_HISTORY_COPY, yes: CLEAR_HISTORY, no: CLEAR_HISTORY_KEEP, safe: true });
  if (!ok) return 'kept';
  try {
    const r = await assistantPost<{ removed?: number }>(`${HISTORY_PATH}/clear`, { project: projectId ?? 'home' });
    historyCleared(projectId);
    return typeof r.removed === 'number' ? r.removed : 0;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Forget, asked first: 'kept' (the person said Keep), 'gone', or the line to show why not. */
export async function forgetConversation(id: string): Promise<'kept' | 'gone' | { error: string }> {
  const ok = await confirmAction({ title: FORGET_TITLE, copy: FORGET_COPY, yes: FORGET, no: FORGET_KEEP, safe: true });
  if (!ok) return 'kept';
  try {
    await assistantPost(`/api/assistant/conversations/${encodeURIComponent(id)}/forget`, {});
  } catch (err) {
    if (err instanceof AssistantApiError && err.status === 409) return { error: FORGET_BUSY };
    return { error: err instanceof Error ? err.message : String(err) };
  }
  await refreshConversations();
  return 'gone';
}

export function ConversationMenu({
  list,
  shown,
  projectId,
  onPick,
  onNew,
  shownTitle = null,
}: {
  list: readonly ConversationRow[];
  shown: ConversationRow | null;
  projectId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  /** The button's title in place of the shown conversation's (a saved chat shown read only). */
  shownTitle?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryView | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const historySeq = useRef(0);
  const close = (focus = true) => {
    setOpen(false);
    setError(null);
    setNotice(null);
    setHistory(null);
    if (focus) button.current?.focus({ preventScroll: true });
  };
  const showHistory = () => {
    const seq = ++historySeq.current;
    setError(null);
    setNotice(null);
    setHistory({ state: 'loading', chats: [], total: 0, error: null });
    void readHistory(projectId).then((h) => {
      if (seq === historySeq.current) setHistory(h);
    });
  };
  const pickSaved = (c: HistoryChat) => {
    // A conversation still open shows live; any other read only.
    if (list.some((r) => r.id === c.id)) onPick(c.id);
    else void showSavedChat(projectId, c.id);
    close();
  };
  const onClear = () => {
    const wasHistory = history !== null;
    void clearHistory(projectId).then((out) => {
      if (out === 'kept') return;
      // The confirm dialog's click closed the menu: it opens again to say what happened.
      setOpen(true);
      if (typeof out === 'object') {
        setError(out.error);
        return;
      }
      if (wasHistory) showHistory();
      setNotice(clearedChats(out));
    });
  };
  useEffect(() => {
    if (!open) return;
    void refreshConversations();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (pop.current?.contains(t) || button.current?.contains(t))) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    close();
  };
  const g = groupConversations(list, projectId);
  const groups: Array<[string, ConversationRow[]]> = [
    [GROUP_HERE, g.here],
    [GROUP_HOME, g.home],
    [GROUP_OTHER_PROJECTS, g.other],
  ];
  return (
    <div className="dock-menu-wrap" onKeyDown={open ? onKeyDown : undefined}>
      <button
        type="button"
        ref={button}
        className="dock-menu-button"
        aria-haspopup="true"
        aria-expanded={open ? 'true' : 'false'}
        data-dock-menu="1"
        onClick={() => {
          if (open) close(false);
          else {
            setError(null);
            setNotice(null);
            setHistory(null);
            setOpen(true);
          }
        }}
      >
        <span className="dock-menu-title">{shownTitle ?? conversationName(shown)}</span>
        <span aria-hidden="true"> ▾</span>
      </button>
      <button type="button" className="dock-new" aria-label={NEW_CONVERSATION} title={NEW_CONVERSATION} data-dock-new="1" onClick={onNew}>
        {NEW_SHORT}
      </button>
      {open ? (
        <div className="dock-menu" ref={pop} role="group" aria-label={history ? HISTORY : CONVERSATIONS_LABEL} data-dock-menu-list="1">
          {history ? (
            <section className="dock-menu-group" data-dock-group={HISTORY} data-dock-history-list={history.state}>
              <div className="dock-menu-history-head">
                <h3 className="dock-subhead">{historyOf(projectId === null)}</h3>
                <button type="button" className="dock-link-button" data-dock-history-back="1" onClick={() => setHistory(null)}>
                  {BACK}
                </button>
              </div>
              {history.state === 'loading' ? <p className="dock-muted dock-menu-empty">{HISTORY_LOADING}</p> : null}
              {history.state === 'ready' && !history.chats.length ? (
                <p className="dock-muted dock-menu-empty" data-dock-history-empty="1">
                  {HISTORY_EMPTY}
                </p>
              ) : null}
              {history.error ? (
                <p className="dock-alert" role="alert">
                  {history.error}
                </p>
              ) : null}
              <ul>
                {history.chats.map((c) => (
                  <li key={c.id} data-dock-saved-chat={c.id}>
                    <button type="button" className="dock-menu-row" onClick={() => pickSaved(c)}>
                      <span className="dock-menu-row-title">{c.title || NEW_CONVERSATION}</span>
                      <span className="dock-muted dock-menu-row-meta">{conversationMeta(c.label, dayTime(c.ended_at))}</span>
                      {c.first_prompt ? <span className="dock-muted dock-menu-row-prompt">{c.first_prompt}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
              {history.total > history.chats.length ? <p className="dock-muted dock-menu-empty">{historyMore(history.total - history.chats.length)}</p> : null}
            </section>
          ) : null}
          {!history && !list.length ? <p className="dock-muted dock-menu-empty">{CONVERSATIONS_EMPTY}</p> : null}
          {(history ? [] : groups).map(([name, rows]) =>
            rows.length ? (
              <section key={name} className="dock-menu-group" data-dock-group={name}>
                <h3 className="dock-subhead">{name}</h3>
                <ul>
                  {rows.map((row) => (
                    <li key={row.id} className={row.id === shown?.id ? 'current' : undefined} data-dock-conversation={row.id}>
                      <button
                        type="button"
                        className="dock-menu-row"
                        aria-current={row.id === shown?.id ? 'true' : undefined}
                        onClick={() => {
                          onPick(row.id);
                          close();
                        }}
                      >
                        <span className="dock-menu-row-title">{conversationName(row)}</span>
                        <span className="dock-muted dock-menu-row-meta">
                          {conversationMeta(row.label, hhmm(row.last_used_at))}
                          {row.running ? (
                            <span className="dock-working-dot" data-dock-working="1">
                              <span className="dock-sr">{WORKING_DOT}</span>
                            </span>
                          ) : null}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="dock-link-button"
                        aria-label={forgetLabel(conversationName(row))}
                        data-dock-forget={row.id}
                        onClick={() => {
                          void forgetConversation(row.id).then((out) => {
                            setError(typeof out === 'object' ? out.error : null);
                            // The confirm dialog's click closed the menu: it opens again to say why not.
                            if (typeof out === 'object') setOpen(true);
                            if (out === 'gone' && row.id === shown?.id) onNew();
                          });
                        }}
                      >
                        {FORGET}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null,
          )}
          {error ? (
            <p className="dock-alert" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="dock-muted" role="status" data-dock-history-notice="1">
              {notice}
            </p>
          ) : null}
          <div className="dock-menu-foot">
            {history ? null : (
              <button type="button" className="dock-link-button" data-dock-history="1" onClick={showHistory}>
                {HISTORY}
              </button>
            )}
            <button type="button" className="dock-link-button" data-dock-clear-history="1" onClick={onClear}>
              {CLEAR_HISTORY}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
