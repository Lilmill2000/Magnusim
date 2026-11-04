// RH3 (run health spec 5.3): Continue once the study's numerics differ from what the run started
// with. One dialog, three answers: "Continue with the new numerics", "Continue as it was" or Cancel.
// Cancel has the focus, and Enter and Escape answer Cancel (only a click says which numerics);
// a run whose saved results come after it became unhealthy shows its health first, in the same
// dialog. The words come from runReopen.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askRunContinue } from './runContinueChoice';
import { continueNumericsWords, numericsDiff } from './runReopen';

const MARKUP = `
  <div id="modal-run-continue" hidden>
    <div id="rcn-backdrop"></div>
    <h2 id="rcn-heading"></h2><p id="rcn-health" hidden></p><p id="rcn-copy"></p>
    <button id="rcn-new"></button><p id="rcn-new-line"></p>
    <button id="rcn-as-was"></button><p id="rcn-as-was-line"></p>
    <button id="rcn-cancel"></button>
  </div>`;

const SCHEMA = { type: 'object', properties: { relax_p: { type: 'number', title: 'Relaxation p' }, relax_u: { type: 'number', title: 'Relaxation U' } } };
const RUN = {
  name: 'Run_2',
  status: 'stopped',
  time_dependency: 'Transient',
  continue_from: 0.1666667,
  numerics_used: { analysis: 'incompressible_transient', mode: 'transient', at: 'x', values: { relax_p: 0.3, relax_u: 0.7 } },
};
const WORDS = continueNumericsWords(RUN, numericsDiff(RUN, { relax_p: 0.2, relax_u: 0.5 }, SCHEMA));

const modal = () => document.getElementById('modal-run-continue') as HTMLElement;
const el = (id: string) => document.getElementById(id) as HTMLElement;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = MARKUP;
});
afterEach(() => {
  document.body.innerHTML = '';
});

async function opened(words = WORDS): Promise<{ answer: Promise<unknown> }> {
  const answer = askRunContinue(words);
  await tick();
  expect(modal().hidden).toBe(false);
  return { answer };
}

describe('the Continue "Run_2"? question', () => {
  it('shows the words, with Cancel focused and no health line', async () => {
    const { answer } = await opened();
    expect(el('rcn-heading').textContent).toBe('Continue "Run_2"?');
    expect(el('rcn-health').hidden).toBe(true);
    expect(el('rcn-copy').textContent).toBe("The study's numerics changed after \"Run_2\" started: Relaxation p 0.3 → 0.2, Relaxation U 0.7 → 0.5.");
    expect(el('rcn-new').textContent).toBe('Continue with the new numerics');
    expect(el('rcn-new-line').textContent).toBe("Goes on from t = 0.1667 s with the study's numerics now. The run records the change.");
    expect(el('rcn-as-was').textContent).toBe('Continue as it was');
    expect(el('rcn-as-was-line').textContent).toBe('Goes on with the numerics it started with. The study keeps the new values for new runs.');
    expect(el('rcn-cancel').textContent).toBe('Cancel');
    expect(document.activeElement?.id).toBe('rcn-cancel');
    (el('rcn-cancel') as HTMLButtonElement).click();
    expect(await answer).toBeNull();
    expect(modal().hidden).toBe(true);
  });

  it('a run whose saved results come after it became unhealthy: its health first, in the same dialog', async () => {
    const health = 'Its saved results (t = 0.167 s) are from after it became unhealthy (t = 0.0069 s); continuing carries that on. A new run from t = 0 is safer.';
    const { answer } = await opened({ ...WORDS, health });
    expect([el('rcn-health').hidden, el('rcn-health').textContent]).toEqual([false, health]);
    expect(el('rcn-health').compareDocumentPosition(el('rcn-copy')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(await answer).toBeNull();
    // The next question without health hides the line again.
    const again = await opened();
    expect(el('rcn-health').hidden).toBe(true);
    (el('rcn-backdrop') as HTMLElement).click();
    expect(await again.answer).toBeNull();
  });

  it('Enter answers Cancel, and so does Escape', async () => {
    let { answer } = await opened();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(await answer).toBeNull();
    ({ answer } = await opened());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(await answer).toBeNull();
    // A key the dialog before already took is not an answer here.
    ({ answer } = await opened());
    const taken = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    taken.preventDefault();
    document.dispatchEvent(taken);
    await tick();
    expect(modal().hidden).toBe(false);
    (el('rcn-backdrop') as HTMLElement).click();
    expect(await answer).toBeNull();
  });

  it('a click answers the new numerics or as it was', async () => {
    let { answer } = await opened();
    (el('rcn-new') as HTMLButtonElement).click();
    expect(await answer).toBe('new');
    ({ answer } = await opened());
    (el('rcn-as-was') as HTMLButtonElement).click();
    expect(await answer).toBe('as_was');
    expect(modal().hidden).toBe(true);
  });

  it('closes as Cancel when its asker goes away', async () => {
    const ac = new AbortController();
    const answer = askRunContinue(WORDS, { signal: ac.signal });
    await tick();
    ac.abort();
    expect(await answer).toBeNull();
    expect(modal().hidden).toBe(true);
  });
});
