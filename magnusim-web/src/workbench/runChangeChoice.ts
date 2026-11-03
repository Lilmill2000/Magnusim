/**
 * The question when a stopped run's change is only of its Max Courant, outer correctors,
 * pressure correctors or Max time step (run health spec A2, Daniel 2026-11-03): one dialog
 * with three answers, in the app's one-at-a-time dialog queue (dialogs.ts), as
 * src/workspace/linkChoice.ts asks its question. #modal-run-change in shell.html.
 *
 * - "Start over" (danger): its results are deleted now and Start solves it again from t = 0.
 * - "Use when continuing": its results stay; Continue goes on with the new values, and the run
 *   records the change.
 * - "Cancel" has the focus: Enter and Escape answer Cancel, as does the backdrop.
 *
 * The words come from runReopen.ts (continueChoiceWords), shared with the server and the
 * Assistant.
 */
import { queueDialog, type DialogOpts } from './dialogs';
import type { ChoiceWords } from './runReopen';

/** The answer: start over, wait for Continue, or null (Cancel, or the dialog was dropped). */
export type RunChangeAnswer = 'over' | 'continue' | null;

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function showRunChangeNow(w: ChoiceWords, o: DialogOpts): Promise<RunChangeAnswer> {
  const modal = el('modal-run-change');
  if (!modal) return Promise.resolve(null);
  const heading = el('rcc-heading');
  const copy = el('rcc-copy');
  const over = el<HTMLButtonElement>('rcc-over');
  const overLine = el('rcc-over-line');
  const cont = el<HTMLButtonElement>('rcc-continue');
  const contLine = el('rcc-continue-line');
  const cancel = el<HTMLButtonElement>('rcc-cancel');
  const backdrop = el('rcc-backdrop');
  if (heading) heading.textContent = w.title;
  if (copy) copy.textContent = w.copy;
  if (over) over.textContent = w.over.label;
  if (overLine) overLine.textContent = w.over.line;
  if (cont) cont.textContent = w.cont.label;
  if (contLine) contLine.textContent = w.cont.line;
  if (cancel) cancel.textContent = w.cancel;
  modal.hidden = false;
  return new Promise<RunChangeAnswer>((resolve) => {
    const done = (answer: RunChangeAnswer) => {
      modal.hidden = true;
      over?.removeEventListener('click', onOver);
      cont?.removeEventListener('click', onContinue);
      cancel?.removeEventListener('click', onCancel);
      backdrop?.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      o.signal?.removeEventListener('abort', onCancel);
      resolve(answer);
    };
    const onOver = () => done('over');
    const onContinue = () => done('continue');
    const onCancel = () => done(null);
    const onKey = (e: KeyboardEvent) => {
      // A key the dialog before this one already took is not an answer here.
      if (e.defaultPrevented) return;
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      // Handled: no keypress follows to click the button that has focus. Both answer Cancel:
      // only a click says Start over or Use when continuing.
      e.preventDefault();
      onCancel();
    };
    over?.addEventListener('click', onOver);
    cont?.addEventListener('click', onContinue);
    cancel?.addEventListener('click', onCancel);
    backdrop?.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
    o.signal?.addEventListener('abort', onCancel);
    try {
      cancel?.focus();
    } catch {
      /* not focusable */
    }
  });
}

/** Ask the question (queued with the app's other dialogs); null for Cancel or a dropped dialog. */
export function askRunChange(words: ChoiceWords, opts?: DialogOpts): Promise<RunChangeAnswer> {
  return queueDialog<DialogOpts, RunChangeAnswer>(opts, (o) => showRunChangeNow(words, o), null);
}
