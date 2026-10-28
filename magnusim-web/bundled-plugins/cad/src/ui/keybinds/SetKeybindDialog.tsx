// "Set keybind": the dialog a command's right-click opens (Daniel: "it has an option that is set
// keybind that shows the current keybind and also lets me change it"). It shows the command's
// keys now, waits for the new ones ("Press the new keys", read by their place on the keyboard),
// and sets them at once; a combo another command has asks Replace or Cancel; a combo the browser
// or Magnusim keeps is refused and says why (the Assistant panel's key the person chose in the
// app's Settings too: pressed in the field it is refused and stays there, the panel does not open
// over the dialog; a key of the command it took says so, the menu item's hint too); Reset to
// default and Clear; Done closes it. Every change goes through the keybinds model
// (src/app/keybinds.ts): stored in the person's prefs and applied live. openSetKeybind(services,
// id) opens it; keybindMenuItem(services, id) is the menu item that opens it (the toolbar's
// right-click menu adds it with one line).
// An in-frame modal <dialog> (lib/modal.ts): no workspace shortcut runs behind it; Tab goes round
// its controls; Escape closes it.
// Owner: INTEGRATE.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { keybindsFor, type KeybindResult, type Keybinds } from '../../app/keybinds';
import { cycleDialogFocus } from '../../lib/modal';
import { uiFor } from '../controller';
import type { AppServices } from '../../types/app';
import { buttonClass } from '../kit/Button';
import type { MenuItem } from '../kit/ContextMenu';
import './keybinds.css';

/** The menu item's label. */
export const SET_KEYBIND_LABEL = 'Set keybind…';

type Status =
  | { kind: 'idle' }
  | { kind: 'partial'; words: string }
  | { kind: 'refused'; words: string }
  | { kind: 'conflict'; combo: string; reset: boolean; words: string }
  | { kind: 'done'; words: string };

/** "A", "A and B", "A, B and C". */
const listWords = (names: readonly string[]) => (names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * The words of a command's keys ("Shift+R", "Ctrl+Y or Ctrl+Shift+Z"), or "None"; a command whose
 * tooltip shows another one's key says so ("None of its own (Enter runs Place or finish)").
 */
export function keysWords(k: Keybinds, id: string): string {
  const keys = k.current(id);
  if (keys.length) return keys.map((c) => k.display(c)).join(' or ');
  const v = k.via(id);
  return v ? `None of its own (${v.shown} runs ${v.label})` : 'None';
}

/** What a keybind change says, done or not: a conflict names every command Replace takes the key from, and where each works. */
export function resultWords(k: Keybinds, r: KeybindResult): string {
  if (r.ok) {
    const label = k.entry(r.id)?.label ?? r.id;
    const now = r.keys.length ? r.keys.map((c) => k.display(c)).join(' or ') : 'no key';
    const took = r.took?.length ? `; taken from ${listWords(r.took.map((t) => t.name))}` : '';
    return `${label}: ${now}${took}`;
  }
  if (r.reason === 'conflict') {
    const n = r.conflicts.length;
    return `${k.display(r.combo)} is the key of ${listWords(r.conflicts.map((c) => c.name))}. Replace ${n === 1 ? 'it' : n === 2 ? 'both' : 'all of them'}?`;
  }
  return r.message;
}

export interface SetKeybindDialogProps {
  keybinds: Keybinds;
  commandId: string;
  onClose(): void;
}

export function SetKeybindDialog({ keybinds: k, commandId, onClose }: SetKeybindDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const captureRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  // Changes made elsewhere (Settings, another tab) show at once too, the Assistant panel's key too.
  const version = useSyncExternalStore(
    (fn) => k.subscribe(fn),
    () => JSON.stringify([k.current(commandId), k.appClashes()]),
  );
  const entry = k.entry(commandId);
  const current = keysWords(k, commandId);
  // A key of this command the app has now (the Assistant panel's key the person chose): its press
  // goes to the app, so the dialog says so rather than show the key as if it worked.
  const taken = k.appClashes().filter((c) => c.id === commandId);
  void version;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (typeof d.showModal === 'function' && !d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute('open', '');
      }
    } else if (!d.open) d.setAttribute('open', '');
    captureRef.current?.focus();
    // The saved keybinds first: a key is never worked out from the defaults (an unreadable read is tried again).
    let live = true;
    if (k.known() !== true) {
      setStatus({ kind: 'refused', words: 'Reading your keybinds…' });
      void k.load().then((r) => {
        if (live) setStatus(r === true ? { kind: 'idle' } : { kind: 'refused', words: r[0].toUpperCase() + r.slice(1) });
      });
    }
    return () => {
      live = false;
    };
  }, [k]);

  const apply = (r: KeybindResult, reset = false) => {
    if (r.ok) {
      const words = resultWords(k, r);
      setStatus({ kind: 'done', words });
      // Kept in the person's preferences, or said honestly that it was not.
      void k.flush().then((saved) => {
        if (saved !== true) setStatus((s) => (s.kind === 'done' && s.words === words ? { kind: 'refused', words: `${words}. Not saved: ${saved}` } : s));
      });
    } else if (r.reason === 'conflict') setStatus({ kind: 'conflict', combo: r.combo, reset, words: resultWords(k, r) });
    else setStatus({ kind: 'refused', words: r.reason === 'unread' ? r.message[0].toUpperCase() + r.message.slice(1) : r.message });
  };

  const onDialogKey = (e: ReactKeyboardEvent<HTMLDialogElement>) => {
    // No key reaches the workspace's shortcuts behind the dialog.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab' && ref.current) {
      e.preventDefault();
      cycleDialogFocus(ref.current, e.shiftKey);
    }
  };

  const onCaptureKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Tab moves on and Escape closes (the dialog's own keys); every other key is the new keybind.
    if (e.key === 'Tab' || e.key === 'Escape') return;
    e.preventDefault();
    const c = k.capture(e.nativeEvent);
    if (c.kind === 'modifier') setStatus(c.partial ? { kind: 'partial', words: `${c.partial}+…` } : { kind: 'idle' });
    else if (c.kind === 'refused') setStatus({ kind: 'refused', words: c.reason });
    else apply(k.setKeybind(commandId, c.combo));
  };

  const label = entry?.label ?? commandId;
  return (
    <dialog
      ref={ref}
      className="cad-dialog cad-keybind-dialog"
      aria-modal="true"
      aria-labelledby="cad-keybind-title"
      data-cad-keybind-dialog={commandId}
      onKeyDown={onDialogKey}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="cad-dialog-card">
        <h2 id="cad-keybind-title">Set keybind: {label}</h2>
        <p className="cad-keybind-current">
          Current: <kbd data-keybind-current="1">{current}</kbd>
          {entry && !k.isDefault(commandId) ? <span className="cad-keybind-default"> (default {entry.keys.length ? entry.keys.map((c) => k.display(c)).join(' or ') : 'none'})</span> : null}
        </p>
        {taken.map((c) => (
          <p key={c.combo} className="cad-keybind-taken" data-keybind-taken={c.combo}>
            {c.by}, so it does not run {entry?.label ?? commandId} here
          </p>
        ))}
        <div
          ref={captureRef}
          className="cad-keybind-capture"
          role="textbox"
          aria-label={`Press the new keys for ${label}`}
          tabIndex={0}
          data-keybind-capture="1"
          onKeyDown={onCaptureKey}
          onKeyUp={(e) => {
            if (status.kind === 'partial' && !(e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)) setStatus({ kind: 'idle' });
          }}
        >
          {status.kind === 'partial' ? status.words : 'Press the new keys'}
        </div>
        <p className={`cad-keybind-status${status.kind === 'refused' || status.kind === 'conflict' ? ' is-problem' : ''}`} role="status" aria-live="polite" data-keybind-status={status.kind}>
          {status.kind === 'idle' || status.kind === 'partial' ? ' ' : status.words}
        </p>
        <div className="cad-dialog-actions">
          {status.kind === 'conflict' ? (
            <>
              <button
                type="button"
                className={buttonClass('primary')}
                data-keybind-action="replace"
                onClick={() => apply(status.reset ? k.resetToDefault(commandId, { replace: true }) : k.replace(commandId, status.combo))}
              >
                Replace
              </button>
              <button type="button" className={buttonClass('secondary')} data-keybind-action="cancel" onClick={() => setStatus({ kind: 'idle' })}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className={buttonClass('secondary')} data-keybind-action="reset" disabled={k.isDefault(commandId)} onClick={() => apply(k.resetToDefault(commandId), true)}>
                Reset to default
              </button>
              <button type="button" className={buttonClass('secondary')} data-keybind-action="clear" disabled={!k.current(commandId).length} onClick={() => apply(k.clear(commandId))}>
                Clear
              </button>
              <button type="button" className={buttonClass('done')} data-keybind-action="done" onClick={onClose}>
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}

let open: { root: Root; host: HTMLElement; close(): void } | null = null;

/** Opens the Set keybind dialog for a command (one at a time). Returns its close. */
export function openSetKeybind(services: AppServices, commandId: string, doc: Document = document): () => void {
  open?.close();
  const back = doc.activeElement as HTMLElement | null;
  const host = doc.createElement('div');
  host.setAttribute('data-cad-keybind-host', '1');
  doc.body.appendChild(host);
  const root = createRoot(host);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (open?.root === root) open = null;
    // After React is done with this render (a click's handler closes it).
    queueMicrotask(() => {
      root.unmount();
      host.remove();
      if (back && back.isConnected && typeof back.focus === 'function') back.focus({ preventScroll: true });
    });
  };
  open = { root, host, close };
  root.render(<SetKeybindDialog keybinds={keybindsFor(services)} commandId={commandId} onClose={close} />);
  return close;
}

/**
 * The menu item that opens Set keybind for a command: its label, the command's key now, a hint.
 * `label` names the command when the menu is another's ("Set keybind for Delete…" in a tree row's).
 */
export function keybindMenuItem(services: AppServices, commandId: string, label?: string): MenuItem {
  const k = keybindsFor(services);
  const now = k.current(commandId);
  // A key of it the Assistant panel's key the person chose took: its press opens the panel, as the dialog says too.
  const taken = k.appClashes().flatMap((c) => (c.id === commandId ? [k.display(c.combo)] : []));
  const app = taken.length ? ` (${listWords(taken)} ${taken.length === 1 ? 'opens' : 'open'} the app's Assistant panel instead)` : '';
  return {
    id: label ? `set-keybind-${commandId}` : 'set-keybind',
    label: label ?? SET_KEYBIND_LABEL,
    hint: now.length ? `Now ${keysWords(k, commandId)}${app}: press new keys, Reset to default or Clear` : 'No key now: press the keys you want',
    disabled: k.entry(commandId) ? null : 'This command has no keybind',
    run: () => void openSetKeybind(services, commandId),
  };
}

/**
 * A right-click on an arrow that collapses or opens the design tree or the Sketch panel: Set keybind
 * for that toggle (ui.toggle-rail, Ctrl+\ by default), whose key has no button of its own.
 */
export function railKeybindMenu(services: AppServices, e: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number }): void {
  e.preventDefault();
  e.stopPropagation();
  uiFor(services).showMenu(e.clientX, e.clientY, [keybindMenuItem(services, 'ui.toggle-rail', 'Set keybind…')], 'Collapse or open');
}

/** A command's key as a tooltip shows it, kept up to date (undefined: none). */
export function useKeyLabel(services: AppServices, id: string): string | undefined {
  const k = keybindsFor(services);
  return useSyncExternalStore(
    (fn) => k.subscribe(fn),
    () => k.shown(id),
  );
}
