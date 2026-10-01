/**
 * The app's own confirm dialog and name prompt (#modal-confirm and #modal-prompt
 * in shell.html), for the workbench and the plugin workspace bridge.
 *
 * One at a time: a dialog opens only after the one before it closed, on a new
 * task, so whatever its answer set off has run first. opts.skipIf() is asked
 * when its turn comes; true drops it unseen (confirm false, prompt null).
 * A key press answers one dialog only: Enter and Escape are handled once.
 */

/** What every dialog takes besides its text. */
export interface DialogOpts {
  /** Asked when the dialog's turn comes: true drops it unseen. */
  skipIf?: () => boolean;
  /** Its asker is gone: dropped unseen while it waits, closed as Cancel while it is open. */
  signal?: AbortSignal;
}

export interface ConfirmOpts extends DialogOpts {
  title?: string;
  copy?: string;
  yes?: string;
  /** An information dialog with one button (no Cancel). */
  notice?: boolean;
}

export interface PromptOpts extends DialogOpts {
  title?: string;
  copy?: string;
  label?: string;
  value?: string;
  yes?: string;
}

interface Waiting {
  opts: DialogOpts;
  show: () => Promise<unknown>;
  dropped: unknown;
  resolve: (value: unknown) => void;
}

const waiting: Waiting[] = [];
// A dialog is open, or the next one's turn has not come yet.
let open = false;

function queue<O extends DialogOpts, T>(opts: O | undefined, show: (o: O) => Promise<T>, dropped: T): Promise<T> {
  const o = (opts || {}) as O;
  return new Promise<T>((resolve) => {
    waiting.push({ opts: o, show: () => show(o), dropped, resolve: resolve as (value: unknown) => void });
    next();
  });
}

function skipped(d: Waiting): boolean {
  if (d.opts.signal?.aborted) return true;
  try {
    return typeof d.opts.skipIf === 'function' && !!d.opts.skipIf();
  } catch (e) {
    console.warn('[CFD] dialog skipIf', e);
    return false;
  }
}

function next(): void {
  while (!open && waiting.length) {
    const d = waiting.shift() as Waiting;
    if (skipped(d)) {
      d.resolve(d.dropped);
      continue;
    }
    open = true;
    let shown: Promise<unknown>;
    try {
      shown = Promise.resolve(d.show());
    } catch (e) {
      shown = Promise.reject(e);
    }
    shown.then(
      (v) => settle(d, v),
      (e) => {
        console.warn('[CFD] dialog', e);
        settle(d, d.dropped);
      },
    );
  }
}

function settle(d: Waiting, value: unknown): void {
  d.resolve(value);
  // The next one's turn is a new task: the answer's follow-up (a leave the user
  // just approved) runs first, and so does the rest of the key press that gave it.
  setTimeout(() => {
    open = false;
    next();
  }, 0);
}

/** A confirm or name prompt is open or waiting its turn. */
export function dialogBusy(): boolean {
  return open || waiting.length > 0;
}

/** Resolve true when confirmed. Used before any filter / view is deleted. */
export function confirmAction(opts?: ConfirmOpts): Promise<boolean> {
  return queue(opts, showConfirm, false);
}

/** Resolve with the entered (trimmed) text, or null when cancelled. */
export function promptName(opts?: PromptOpts): Promise<string | null> {
  return queue<PromptOpts, string | null>(opts, showPromptName, null);
}

function showConfirm(o: ConfirmOpts): Promise<boolean> {
  const modal = document.getElementById('modal-confirm');
  if (!modal) return Promise.resolve(window.confirm(o.copy || o.title || 'Delete?'));
  const heading = document.getElementById('cf-heading');
  const copy = document.getElementById('cf-copy');
  const yes = document.getElementById('cf-confirm');
  const no = document.getElementById('cf-cancel');
  const backdrop = document.getElementById('cf-backdrop');
  if (heading) heading.textContent = o.title || 'Delete?';
  if (copy) copy.textContent = o.copy || '';
  if (yes) yes.textContent = o.yes || 'Delete';
  // notice: an information dialog with one button (no Cancel).
  if (no) no.hidden = !!o.notice;
  modal.hidden = false;
  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      modal.hidden = true;
      if (no) no.hidden = false;
      yes?.removeEventListener('click', onYes);
      no?.removeEventListener('click', onNo);
      backdrop?.removeEventListener('click', onNo);
      document.removeEventListener('keydown', onKey);
      o.signal?.removeEventListener('abort', onNo);
      resolve(ok);
    };
    const onYes = () => done(true);
    const onNo = () => done(false);
    const onKey = (e: KeyboardEvent) => {
      // A key the dialog before this one already took is not an answer here.
      if (e.defaultPrevented) return;
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      // Handled: no keypress follows to click the button that has focus now.
      e.preventDefault();
      if (e.key === 'Escape') onNo();
      else onYes();
    };
    yes?.addEventListener('click', onYes);
    no?.addEventListener('click', onNo);
    backdrop?.addEventListener('click', onNo);
    document.addEventListener('keydown', onKey);
    o.signal?.addEventListener('abort', onNo);
    try {
      yes?.focus();
    } catch {
      /* not focusable */
    }
  });
}

function showPromptName(o: PromptOpts): Promise<string | null> {
  const modal = document.getElementById('modal-prompt');
  if (!modal) return Promise.resolve(window.prompt(o.title || 'Name', o.value || ''));
  const heading = document.getElementById('pm-heading');
  const copy = document.getElementById('pm-copy');
  const label = document.getElementById('pm-label');
  const input = document.getElementById('pm-input') as HTMLInputElement | null;
  const yes = document.getElementById('pm-confirm');
  const no = document.getElementById('pm-cancel');
  const backdrop = document.getElementById('pm-backdrop');
  if (heading) heading.textContent = o.title || 'Name';
  if (copy) copy.textContent = o.copy || '';
  if (label) label.textContent = o.label || 'Name';
  if (yes) yes.textContent = o.yes || 'Save';
  if (input) input.value = o.value || '';
  modal.hidden = false;
  return new Promise<string | null>((resolve) => {
    const done = (val: string | null) => {
      modal.hidden = true;
      yes?.removeEventListener('click', onYes);
      no?.removeEventListener('click', onNo);
      backdrop?.removeEventListener('click', onNo);
      input?.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', onEsc);
      o.signal?.removeEventListener('abort', onNo);
      resolve(val);
    };
    const onYes = () => {
      const v = String(input ? input.value : '').trim();
      if (!v) {
        try {
          input?.focus();
        } catch {
          /* not focusable */
        }
        return;
      }
      done(v);
    };
    const onNo = () => done(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.defaultPrevented) {
        e.preventDefault();
        onYes();
      }
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        onNo();
      }
    };
    yes?.addEventListener('click', onYes);
    no?.addEventListener('click', onNo);
    backdrop?.addEventListener('click', onNo);
    input?.addEventListener('keydown', onKey);
    document.addEventListener('keydown', onEsc);
    o.signal?.addEventListener('abort', onNo);
    try {
      input?.focus();
      input?.select();
    } catch {
      /* not focusable */
    }
  });
}
