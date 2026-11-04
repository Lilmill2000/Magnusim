/**
 * The question when a run's Continue would go on with numerics its study no longer has (run
 * health spec 5.3, RH3): the study's numerics changed after the run started. One dialog with three
 * answers, in the app's one-at-a-time dialog queue (dialogs.ts), as runChangeChoice.ts asks its
 * question. #modal-run-continue in shell.html.
 *
 * - "Continue with the new numerics": it goes on with the study's numerics now, and the run
 *   records the change.
 * - "Continue as it was": it goes on with the numerics it started with; the study keeps the new
 *   values for new runs.
 * - "Cancel" has the focus: Enter and Escape answer Cancel, as does the backdrop. Nothing is posted.
 *
 * A run whose saved results come after it became unhealthy (its health's from_zero) gets its
 * health first in the same dialog: one question, never two.
 *
 * The words come from runReopen.ts (continueNumericsWords), shared with the server and the
 * Assistant.
 */
import { queueDialog, type DialogOpts } from './dialogs';
import type { ContinueNumericsWords } from './runReopen';

/** The answer: the study's new numerics, as it was, or null (Cancel, or the dialog was dropped). */
export type RunContinueAnswer = 'new' | 'as_was' | null;

function el<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function showRunContinueNow(w: ContinueNumericsWords, o: DialogOpts): Promise<RunContinueAnswer> {
  const modal = el('modal-run-continue');
  if (!modal) return Promise.resolve(null);
  const heading = el('rcn-heading');
  const health = el('rcn-health');
  const copy = el('rcn-copy');
  const fresh = el<HTMLButtonElement>('rcn-new');
  const freshLine = el('rcn-new-line');
  const asWas = el<HTMLButtonElement>('rcn-as-was');
  const asWasLine = el('rcn-as-was-line');
  const cancel = el<HTMLButtonElement>('rcn-cancel');
  const backdrop = el('rcn-backdrop');
  if (heading) heading.textContent = w.title;
  if (health) {
    health.textContent = w.health;
    health.hidden = !w.health;
  }
  if (copy) copy.textContent = w.copy;
  if (fresh) fresh.textContent = w.fresh.label;
  if (freshLine) freshLine.textContent = w.fresh.line;
  if (asWas) asWas.textContent = w.asWas.label;
  if (asWasLine) asWasLine.textContent = w.asWas.line;
  if (cancel) cancel.textContent = w.cancel;
  modal.hidden = false;
  return new Promise<RunContinueAnswer>((resolve) => {
    const done = (answer: RunContinueAnswer) => {
      modal.hidden = true;
      fresh?.removeEventListener('click', onNew);
      asWas?.removeEventListener('click', onAsWas);
      cancel?.removeEventListener('click', onCancel);
      backdrop?.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      o.signal?.removeEventListener('abort', onCancel);
      resolve(answer);
    };
    const onNew = () => done('new');
    const onAsWas = () => done('as_was');
    const onCancel = () => done(null);
    const onKey = (e: KeyboardEvent) => {
      // A key the dialog before this one already took is not an answer here.
      if (e.defaultPrevented) return;
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      // Handled: no keypress follows to click the button that has focus. Both answer Cancel:
      // only a click says which numerics it goes on with.
      e.preventDefault();
      onCancel();
    };
    fresh?.addEventListener('click', onNew);
    asWas?.addEventListener('click', onAsWas);
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
export function askRunContinue(words: ContinueNumericsWords, opts?: DialogOpts): Promise<RunContinueAnswer> {
  return queueDialog<DialogOpts, RunContinueAnswer>(opts, (o) => showRunContinueNow(words, o), null);
}
