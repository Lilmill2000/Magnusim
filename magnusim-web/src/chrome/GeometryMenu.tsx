import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { geometryActionNotice, openGeometryAction, type GeometryActionEntry } from '../workspace/geometryActions';

export interface GeometryMenuExtra {
  key: string;
  label: string;
  /** Data attributes on its button (tests and styling). */
  attrs?: Record<string, string>;
  onPick: () => void;
}

export interface GeometryMenuProps {
  /** Where it opens (client pixels): the right-click, or the row for the keyboard. */
  x: number;
  y: number;
  projectId: string;
  geometryId: string;
  geometryName: string;
  entries: GeometryActionEntry[];
  /** The view's own items above the actions (a body row's "Hide body"), each one closing the menu. */
  extra?: GeometryMenuExtra[];
  /** Closed (Escape, a click outside, an action that opened); `refocus` gives the row its focus back. */
  onClose: (refocus: boolean) => void;
}

/**
 * A geometry's right-click menu in the tree (host API 1.7): one item per geometry action
 * ("Edit in CAD"), its hint under it, or the reason it is off. Up, Down, Home and End
 * move; Enter opens; Escape closes and gives the row its focus back. An item stays
 * disabled ("Opening…") until its workspace opens or the app's notice says why not.
 */
export function GeometryMenu({ x, y, projectId, geometryId, geometryName, entries, extra = [], onClose }: GeometryMenuProps) {
  const list = useRef<HTMLUListElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  const items = (): HTMLButtonElement[] => Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || []);

  useEffect(() => {
    // Inside the window: a menu near the right or bottom edge opens the other way.
    const el = list.current;
    if (el) {
      const r = el.getBoundingClientRect();
      const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4));
      const top = y + r.height > window.innerHeight - 4 ? Math.max(4, y - r.height) : y;
      if (left !== pos.left || top !== pos.top) setPos({ left, top });
    }
    // The first action, or (every action off) the menu itself: Tab and Escape then reach it,
    // and a screen reader lands on the reasons.
    (items()[0] || list.current)?.focus();
    const outside = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node)) onClose(false);
    };
    const away = () => onClose(false);
    // Escape also when no item can take the focus (every action is off).
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose(true);
      }
    };
    document.addEventListener('keydown', esc);
    document.addEventListener('mousedown', outside, true);
    window.addEventListener('blur', away);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('keydown', esc);
      document.removeEventListener('mousedown', outside, true);
      window.removeEventListener('blur', away);
      window.removeEventListener('resize', away);
    };
  }, []);

  const pick = async (entry: GeometryActionEntry) => {
    if (!entry.enabled || busy) return;
    const key = `${entry.plugin}|${entry.studyKind}`;
    setBusy(key);
    const answer = await openGeometryAction(projectId, geometryId, entry);
    setBusy(null);
    onClose(false);
    if (!answer.ok) await geometryActionNotice(answer.title || `Couldn't open ${geometryName}`, answer.message || '');
  };

  const onKey = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => all[(i + all.length) % all.length]?.focus();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      go(at + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      go(at < 0 ? all.length - 1 : at - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      go(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      go(all.length - 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    } else if (e.key === 'Tab') {
      onClose(false);
    }
  };

  return createPortal(
    <ul
      ref={list}
      className="ws-menu-list geom-action-menu"
      role="menu"
      aria-label={`${geometryName}: actions`}
      tabIndex={-1}
      data-geom-menu={geometryId}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      {extra.map((item) => (
        <li key={`extra:${item.key}`} role="none">
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={!!busy}
            {...(item.attrs || {})}
            onClick={() => {
              onClose(false);
              item.onPick();
            }}
          >
            <span className="geom-action-label">{item.label}</span>
          </button>
        </li>
      ))}
      {extra.length && entries.length ? <li role="separator" className="ws-menu-sep" /> : null}
      {entries.map((entry) => {
        const key = `${entry.plugin}|${entry.studyKind}`;
        const opening = busy === key;
        const sub = entry.enabled ? entry.hint : entry.reason;
        return (
          <li key={key} role="none">
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={!entry.enabled || !!busy}
              aria-describedby={sub ? `geom-action-sub-${key.replace(/[^A-Za-z0-9_-]/g, '_')}` : undefined}
              data-geom-action={entry.studyKind}
              data-geom-action-plugin={entry.plugin}
              onClick={() => void pick(entry)}
            >
              <span className="geom-action-label">{opening ? 'Opening…' : entry.label}</span>
              {sub ? (
                <span
                  className={entry.enabled ? 'geom-action-sub' : 'geom-action-sub geom-action-reason'}
                  id={`geom-action-sub-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`}
                  data-geom-action-reason={entry.enabled ? undefined : '1'}
                >
                  {sub}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>,
    document.body,
  );
}
