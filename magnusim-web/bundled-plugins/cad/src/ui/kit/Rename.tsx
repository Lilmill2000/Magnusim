// Rename (core RenameTitle, src/panels/RenameTitle.tsx:1-77): a pencil swaps
// the title for an input (maxLength 64). Enter or blur commits, Escape
// cancels, empty or unchanged text is ignored. The CAD version also refuses
// names the document would not accept (duplicates): Enter keeps the input open
// with the reason; blur gives up and reports the reason.
// RenameTitle is the panel head; InlineRename is the tree-row variant.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { ICONS } from '../Icon';
import { IconButton } from './Button';

export const NAME_MAX = 64;

/** Returns null when renamed, or the reason it was refused. */
export type RenameFn = (next: string) => string | null;

function useRenameEditor(name: string, onRename: RenameFn, onGiveUp?: (reason: string) => void, startEditing = false) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);
  function start() {
    done.current = false;
    setDraft(name);
    setError(null);
    setEditing(true);
  }
  function stop() {
    done.current = true;
    setEditing(false);
    setDraft(name);
  }
  /** true when the editor closed. */
  function finish(commit: boolean, fromBlur: boolean): boolean {
    if (done.current) return true;
    const next = draft.trim();
    if (!commit || !next || next === name) {
      stop();
      setError(null);
      return true;
    }
    const why = onRename(next);
    if (!why) {
      stop();
      setError(null);
      return true;
    }
    if (fromBlur) {
      stop();
      setError(null);
      onGiveUp?.(why);
      return true;
    }
    setError(why);
    return false;
  }
  return { editing, draft, setDraft, error, setError, start, finish };
}

export function RenameTitle({
  name,
  label,
  onRename,
  canRename = true,
  onGiveUp,
}: {
  name: string;
  /** What is renamed: "feature" (button title "Rename feature"). */
  label: string;
  onRename: RenameFn;
  canRename?: boolean;
  /** Blur with a refused name: the reason (the panel shows it). */
  onGiveUp?: (reason: string) => void;
}) {
  const ed = useRenameEditor(name, onRename, onGiveUp);
  const noun = label.charAt(0).toUpperCase() + label.slice(1);
  return (
    <div className="mesh-title-row">
      {ed.editing ? (
        <span className="cad-rename-wrap">
          <input
            type="text"
            className={`mesh-rename-input${ed.error ? ' is-invalid' : ''}`}
            maxLength={NAME_MAX}
            aria-label={`${noun} name`}
            aria-invalid={ed.error ? true : undefined}
            autoFocus
            value={ed.draft}
            onChange={(e) => {
              ed.setDraft(e.target.value);
              ed.setError(null);
            }}
            onBlur={() => ed.finish(true, true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                ed.finish(true, false);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                ed.finish(false, false);
              }
            }}
          />
          {ed.error ? (
            <span className="cad-rename-err" role="alert">
              {ed.error}
            </span>
          ) : null}
        </span>
      ) : (
        <>
          <span className="mgk-panel-title" data-panel-title="1">
            {name}
          </span>
          {canRename ? <IconButton icon={ICONS.pencil} label={`Rename ${label}`} onClick={ed.start} data-rename-btn="1" /> : null}
        </>
      )}
    </div>
  );
}

/**
 * The tree-row rename input, in place of the row label. The row decides when
 * editing starts (context menu Rename, F2, the pencil) and ends (onDone).
 */
export function InlineRename({
  name,
  label,
  onRename,
  onDone,
  onGiveUp,
}: {
  name: string;
  label: string;
  onRename: RenameFn;
  onDone: () => void;
  onGiveUp?: (reason: string) => void;
}) {
  const ed = useRenameEditor(name, onRename, onGiveUp, true);
  const close = (closed: boolean) => {
    if (closed) onDone();
  };
  return (
    <span className="cad-rename-wrap is-inline" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <input
        type="text"
        className={`cad-row-rename${ed.error ? ' is-invalid' : ''}`}
        maxLength={NAME_MAX}
        aria-label={`${label} name`}
        aria-invalid={ed.error ? true : undefined}
        autoFocus
        value={ed.draft}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          ed.setDraft(e.target.value);
          ed.setError(null);
        }}
        onBlur={() => close(ed.finish(true, true))}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            close(ed.finish(true, false));
          } else if (e.key === 'Escape') {
            e.preventDefault();
            close(ed.finish(false, false));
          }
        }}
      />
      {ed.error ? (
        <span className="cad-rename-err" role="alert">
          {ed.error}
        </span>
      ) : null}
    </span>
  );
}
