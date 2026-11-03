// A stopped run's change of only Max Courant, the correctors or Max time step (run health spec
// A2): one dialog, three answers. Cancel has the focus, and Enter and Escape answer Cancel (only a
// click says Start over or Use when continuing); the words come from runReopen.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askRunChange } from './runChangeChoice';
import { continueChoiceWords } from './runReopen';

const MARKUP = `
  <div id="modal-run-change" hidden>
    <div id="rcc-backdrop"></div>
    <h2 id="rcc-heading"></h2><p id="rcc-copy"></p>
    <button id="rcc-over"></button><p id="rcc-over-line"></p>
    <button id="rcc-continue"></button><p id="rcc-continue-line"></p>
    <button id="rcc-cancel"></button>
  </div>`;

const RUN = {
  name: 'Run 1',
  status: 'stopped',
  time_dependency: 'Transient',
  has_results: true,
  n_saved_times: 12,
  last_saved_iteration: 0.45,
  sim_time: 0.47,
  transient: { max_co: 100 },
};
const WORDS = continueChoiceWords(RUN, [{ key: 'transient.max_co', from: 100, to: 5 }]);

const modal = () => document.getElementById('modal-run-change') as HTMLElement;
const text = (id: string) => document.getElementById(id)?.textContent;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = MARKUP;
});
afterEach(() => {
  document.body.innerHTML = '';
});

/** Opens the dialog; resolves once it shows, with its answer still to come (not awaited here). */
async function opened(): Promise<{ answer: Promise<unknown> }> {
  const answer = askRunChange(WORDS);
  await tick();
  expect(modal().hidden).toBe(false);
  return { answer };
}

describe('the Change "Run 1"? dialog', () => {
  it('shows the words, with Cancel focused', async () => {
    const { answer } = await opened();
    expect(text('rcc-heading')).toBe('Change "Run 1"?');
    expect(text('rcc-copy')).toBe('Max Courant 100 → 5. "Run 1" has results up to t = 0.45 s.');
    expect(text('rcc-over')).toBe('Start over');
    expect(text('rcc-over-line')).toBe('Deletes its results (12 saved, up to t = 0.45 s) now. Start solves it again from t = 0.');
    expect(text('rcc-continue')).toBe('Use when continuing');
    expect(text('rcc-continue-line')).toBe('Keeps its results. Continue goes on from t = 0.45 s with the new value, and the run records the change.');
    expect(text('rcc-cancel')).toBe('Cancel');
    expect(document.activeElement?.id).toBe('rcc-cancel');
    (document.getElementById('rcc-cancel') as HTMLButtonElement).click();
    expect(await answer).toBeNull();
    expect(modal().hidden).toBe(true);
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
    (document.getElementById('rcc-backdrop') as HTMLElement).click();
    expect(await answer).toBeNull();
  });

  it('a click answers Start over or Use when continuing', async () => {
    let { answer } = await opened();
    (document.getElementById('rcc-over') as HTMLButtonElement).click();
    expect(await answer).toBe('over');
    ({ answer } = await opened());
    (document.getElementById('rcc-continue') as HTMLButtonElement).click();
    expect(await answer).toBe('continue');
    expect(modal().hidden).toBe(true);
  });

  it('closes as Cancel when its asker goes away', async () => {
    const ac = new AbortController();
    const answer = askRunChange(WORDS, { signal: ac.signal });
    await tick();
    ac.abort();
    expect(await answer).toBeNull();
    expect(modal().hidden).toBe(true);
  });
});
