/**
 * The dock header's conversation menu and New (phase 4 spec 2.1, 2.2, 6.2): a button with the
 * shown conversation's title (else "New conversation") that opens the list the server keeps,
 * grouped "Here" (this project, or Home), "Home" and "Other projects", newest use first. Each
 * row: its title, its provider and the time it was last used, a dot while it works, and
 * Forget (asked first with the app's own dialog; 409 says a request runs in it).
 *
 * The list is read again when the menu opens. It traps nothing: Escape closes it and gives the
 * keyboard back to its button; so does picking a row.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { confirmAction } from '../../workbench/dialogs';
import { AssistantApiError, assistantPost } from '../api';
import type { ConversationRow } from '../wire';
import {
  CONVERSATIONS_EMPTY,
  CONVERSATIONS_LABEL,
  conversationMeta,
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
  NEW_CONVERSATION,
  NEW_SHORT,
  WORKING_DOT,
} from './copy';
import { refreshConversations } from './store';

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
}: {
  list: readonly ConversationRow[];
  shown: ConversationRow | null;
  projectId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const close = (focus = true) => {
    setOpen(false);
    setError(null);
    if (focus) button.current?.focus({ preventScroll: true });
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
            setOpen(true);
          }
        }}
      >
        <span className="dock-menu-title">{conversationName(shown)}</span>
        <span aria-hidden="true"> ▾</span>
      </button>
      <button type="button" className="dock-new" aria-label={NEW_CONVERSATION} title={NEW_CONVERSATION} data-dock-new="1" onClick={onNew}>
        {NEW_SHORT}
      </button>
      {open ? (
        <div className="dock-menu" ref={pop} role="group" aria-label={CONVERSATIONS_LABEL} data-dock-menu-list="1">
          {!list.length ? <p className="dock-muted dock-menu-empty">{CONVERSATIONS_EMPTY}</p> : null}
          {groups.map(([name, rows]) =>
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
        </div>
      ) : null}
    </div>
  );
}
