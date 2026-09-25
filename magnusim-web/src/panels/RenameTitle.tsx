import { useEffect, useState } from 'react';

/** Panel title with the pencil rename control (mesh, run and study panels share the look). */
export function RenameTitle({
  name,
  label,
  onRename,
  canRename = true,
}: {
  name: string;
  /** What is being renamed, e.g. "simulation" (used in the button title and input label). */
  label: string;
  onRename: (next: string) => Promise<unknown> | void;
  canRename?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);
  function stop(commit: boolean) {
    setEditing(false);
    const next = draft.trim();
    if (commit && next && next !== name) void onRename(next);
    else setDraft(name);
  }
  const noun = label.charAt(0).toUpperCase() + label.slice(1);
  return (
    <div className="mat-panel-head">
      <div className="mesh-title-row">
        {editing ? (
          <input
            type="text"
            className="mesh-rename-input"
            maxLength={64}
            aria-label={`${noun} name`}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => stop(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                stop(true);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                stop(false);
              }
            }}
          />
        ) : (
          <>
            <span className="mat-panel-title" data-panel-title="1">
              {name}
            </span>
            {canRename ? (
              <button
                type="button"
                className="mesh-rename"
                title={`Rename ${label}`}
                aria-label={`Rename ${label}`}
                onClick={() => setEditing(true)}
              >
                <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
                  <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 16.8V20h3.2L18.4 8.8l-3.2-3.2L4 16.8z" />
                    <path d="M13.8 6.9l3.2 3.2" />
                  </g>
                </svg>
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
