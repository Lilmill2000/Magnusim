import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmAction, dialogBusy, promptName } from './dialogs';

// The two dialogs as shell.html has them.
const MODALS = `
  <div id="modal-confirm" class="cfd-modal" hidden role="dialog" aria-modal="true" aria-labelledby="cf-heading">
    <div class="cfd-modal-backdrop" id="cf-backdrop"></div>
    <div class="cfd-modal-card">
      <h2 id="cf-heading">Delete?</h2>
      <p class="home-detail-desc" id="cf-copy"></p>
      <div class="np-actions">
        <button type="button" class="home-btn" id="cf-cancel">Cancel</button>
        <button type="button" class="home-btn home-btn-danger" id="cf-confirm">Delete</button>
      </div>
    </div>
  </div>
  <div id="modal-prompt" class="cfd-modal" hidden role="dialog" aria-modal="true" aria-labelledby="pm-heading">
    <div class="cfd-modal-backdrop" id="pm-backdrop"></div>
    <div class="cfd-modal-card">
      <h2 id="pm-heading">Save view</h2>
      <p class="home-detail-desc" id="pm-copy"></p>
      <label class="np-field"><span id="pm-label">Name</span><input type="text" id="pm-input" maxlength="64" autocomplete="off" /></label>
      <div class="np-actions">
        <button type="button" class="home-btn" id="pm-cancel">Cancel</button>
        <button type="button" class="home-btn home-btn-primary" id="pm-confirm">Save</button>
      </div>
    </div>
  </div>`;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const shown = (id: string) => !$(id).hidden;
const heading = () => $('cf-heading').textContent;
/** Long enough for every task the dialogs queue (the next one's turn) to have run. */
const later = () => new Promise((r) => setTimeout(r, 10));
/** Every pending promise reaction, as a browser runs them between two event listeners. */
async function microtasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** What a promise has settled to so far ('pending' if not yet). */
function track<T>(p: Promise<T>): { value: T | 'pending' } {
  const box: { value: T | 'pending' } = { value: 'pending' };
  void p.then((v) => (box.value = v));
  return box;
}

/**
 * Enter as Chromium delivers it: a keydown to the focused element, then, as
 * its own task and only if the keydown was not handled (preventDefault), a
 * keypress whose default clicks a focused button. The keypress may come after
 * anything the keydown queued, so it is sent last.
 */
async function pressEnter(): Promise<KeyboardEvent> {
  const target = document.activeElement || document.body;
  const down = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  target.dispatchEvent(down);
  await later();
  const focused = document.activeElement;
  if (!down.defaultPrevented && focused instanceof HTMLButtonElement) focused.click();
  return down;
}

beforeEach(async () => {
  document.body.innerHTML = MODALS;
  // Whatever the test before left waiting has had its turn.
  await later();
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Nothing a test left open holds up the next one.
  for (let i = 0; i < 20 && dialogBusy(); i++) {
    if (shown('modal-confirm')) $('cf-cancel').click();
    if (shown('modal-prompt')) $('pm-cancel').click();
    await later();
  }
});

describe('the app dialogs, one at a time', () => {
  it('open in the order asked: the next only after the one before it closed', async () => {
    expect(dialogBusy()).toBe(false);
    const a = track(confirmAction({ title: 'First question', yes: 'Yes' }));
    const b = track(confirmAction({ title: 'Second question', yes: 'Yes' }));
    const c = track(promptName({ title: 'Third: a name', value: 'Wing' }));
    expect(heading()).toBe('First question');
    expect(dialogBusy()).toBe(true);
    await later();
    expect([a.value, b.value, c.value]).toEqual(['pending', 'pending', 'pending']);
    expect(shown('modal-prompt')).toBe(false);

    $('cf-confirm').click();
    await later();
    expect(a.value).toBe(true);
    expect(shown('modal-confirm')).toBe(true);
    expect(heading()).toBe('Second question');
    $('cf-cancel').click();
    await later();
    expect(b.value).toBe(false);
    expect(shown('modal-confirm')).toBe(false);
    expect(shown('modal-prompt')).toBe(true);
    expect($('pm-heading').textContent).toBe('Third: a name');
    expect(dialogBusy()).toBe(true);
    $('pm-confirm').click();
    await later();
    expect(c.value).toBe('Wing');
    expect(dialogBusy()).toBe(false);
  });

  it('ask skipIf when the turn comes, not when queued; true drops the dialog unseen', async () => {
    let gone = false;
    const skipIf = vi.fn(() => gone);
    const first = track(confirmAction({ title: 'First question' }));
    const dropped = track(promptName({ title: 'From a page that is gone', skipIf }));
    const kept = track(confirmAction({ title: 'Still wanted', skipIf: () => false }));
    await later();
    expect(skipIf).not.toHaveBeenCalled();
    gone = true;
    $('cf-confirm').click();
    await later();
    expect(first.value).toBe(true);
    expect(skipIf).toHaveBeenCalledTimes(1);
    expect(dropped.value).toBeNull();
    expect(shown('modal-prompt')).toBe(false);
    expect(heading()).toBe('Still wanted');
    $('cf-confirm').click();
    await later();
    expect(kept.value).toBe(true);
    expect(dialogBusy()).toBe(false);
  });

  it('a dialog that cannot show resolves as dropped, and the next one still opens', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const modal = $('modal-prompt');
    Object.defineProperty(modal, 'hidden', {
      configurable: true,
      get: () => true,
      set: () => {
        throw new Error('broken dialog');
      },
    });
    const broken = track(promptName({ title: 'Name' }));
    const after = track(confirmAction({ title: 'After it' }));
    await later();
    expect(broken.value).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(heading()).toBe('After it');
    $('cf-cancel').click();
    await later();
    expect(after.value).toBe(false);
  });

  it('Enter answers Yes and Escape Cancel', async () => {
    const yes = track(confirmAction({ title: 'Delete the view?' }));
    expect(document.activeElement).toBe($('cf-confirm'));
    await pressEnter();
    await later();
    expect(yes.value).toBe(true);
    const no = track(confirmAction({ title: 'Delete the filter?' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await later();
    expect(no.value).toBe(false);
    const named = track(promptName({ title: 'Rename study', value: 'Wing' }));
    expect(document.activeElement).toBe($('pm-input'));
    await pressEnter();
    await later();
    expect(named.value).toBe('Wing');
  });
});

describe('a question whose Yes discards work (safe)', () => {
  const LEAVE = { title: 'Leave without saving?', yes: 'Leave', no: 'Stay', safe: true };
  const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

  it('starts on Stay and Enter answers Stay; the next plain question is as before (Cancel, Yes focused, Enter answers Yes)', async () => {
    const left = track(confirmAction(LEAVE));
    expect(heading()).toBe('Leave without saving?');
    expect($('cf-cancel').textContent).toBe('Stay');
    expect($('cf-confirm').textContent).toBe('Leave');
    expect(document.activeElement).toBe($('cf-cancel'));
    const down = await pressEnter();
    await later();
    expect(down.defaultPrevented).toBe(true);
    expect(left.value).toBe(false);
    expect(shown('modal-confirm')).toBe(false);
    expect($('cf-cancel').textContent).toBe('Cancel');

    const replaced = track(confirmAction({ title: 'Replace the mesh?', yes: 'Replace' }));
    expect($('cf-cancel').textContent).toBe('Cancel');
    expect($('cf-cancel').hidden).toBe(false);
    expect(document.activeElement).toBe($('cf-confirm'));
    await pressEnter();
    await later();
    expect(replaced.value).toBe(true);
    expect(dialogBusy()).toBe(false);
  });

  it('Enter answers Stay even with the focus moved to Leave; Escape answers Stay; only a click on Leave leaves', async () => {
    const tabbed = track(confirmAction(LEAVE));
    $('cf-confirm').focus();
    await pressEnter();
    await later();
    expect(tabbed.value).toBe(false);
    const escaped = track(confirmAction(LEAVE));
    escape();
    await later();
    expect(escaped.value).toBe(false);
    const clicked = track(confirmAction(LEAVE));
    $('cf-confirm').click();
    await later();
    expect(clicked.value).toBe(true);
    expect($('cf-cancel').textContent).toBe('Cancel');
    // Turn off: the Cancel button keeps its own label.
    const off = track(confirmAction({ title: 'Turn off Workspace demo?', yes: 'Turn off', no: 'Cancel', safe: true }));
    expect($('cf-cancel').textContent).toBe('Cancel');
    expect(document.activeElement).toBe($('cf-cancel'));
    await pressEnter();
    await later();
    expect(off.value).toBe(false);
  });

  it('a key something else already handled is no answer', async () => {
    const taken = (e: Event) => e.preventDefault();
    window.addEventListener('keydown', taken, { capture: true });
    try {
      const asked = track(confirmAction(LEAVE));
      for (const key of ['Enter', 'Escape']) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      }
      await later();
      expect(asked.value).toBe('pending');
      expect(shown('modal-confirm')).toBe(true);
      expect($('cf-cancel').textContent).toBe('Stay');
    } finally {
      window.removeEventListener('keydown', taken, { capture: true });
    }
  });

  it('closed as Cancel when its asker is gone, the Cancel label is back for the next one', async () => {
    const ended = new AbortController();
    const asked = track(confirmAction({ ...LEAVE, signal: ended.signal }));
    expect($('cf-cancel').textContent).toBe('Stay');
    ended.abort();
    await later();
    expect(asked.value).toBe(false);
    expect($('cf-cancel').textContent).toBe('Cancel');
  });
});

describe('a notice (one button)', () => {
  it('hides Cancel, has its button focused for Enter, and shows Cancel again after', async () => {
    const seen = track(confirmAction({ title: 'Study deleted', yes: 'OK', notice: true }));
    expect($('cf-cancel').hidden).toBe(true);
    expect(document.activeElement).toBe($('cf-confirm'));
    await pressEnter();
    await later();
    expect(seen.value).toBe(true);
    expect($('cf-cancel').hidden).toBe(false);
    expect($('cf-cancel').textContent).toBe('Cancel');
  });

  it('safe does not apply: its one button keeps the focus and Enter answers it', async () => {
    const seen = track(confirmAction({ title: 'Study deleted', yes: 'OK', notice: true, safe: true }));
    expect($('cf-cancel').hidden).toBe(true);
    expect(document.activeElement).toBe($('cf-confirm'));
    await pressEnter();
    await later();
    expect(seen.value).toBe(true);
    expect(shown('modal-confirm')).toBe(false);
  });
});

describe('one key press answers one dialog', () => {
  it('Enter on a question leaves the one queued behind it open and unanswered', async () => {
    const first = track(confirmAction({ title: 'First question', yes: 'Leave' }));
    const second = track(confirmAction({ title: 'Replace the mesh?', yes: 'Replace' }));
    await pressEnter();
    await later();
    expect(first.value).toBe(true);
    expect(shown('modal-confirm')).toBe(true);
    expect(heading()).toBe('Replace the mesh?');
    expect(second.value).toBe('pending');
    $('cf-cancel').click();
    await later();
    expect(second.value).toBe(false);
  });

  it('a key something else already handled is no answer', async () => {
    const taken = (e: Event) => e.preventDefault();
    window.addEventListener('keydown', taken, { capture: true });
    try {
      const asked = track(confirmAction({ title: 'Replace the mesh?', yes: 'Replace' }));
      for (const key of ['Enter', 'Escape']) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      }
      await later();
      expect(asked.value).toBe('pending');
      expect(shown('modal-confirm')).toBe(true);
    } finally {
      window.removeEventListener('keydown', taken, { capture: true });
    }
  });

  it('Enter in a name prompt leaves the question queued behind it open and unanswered', async () => {
    const named = track(promptName({ title: 'Rename study', value: 'Wing' }));
    const asked = track(confirmAction({ title: 'Replace the mesh?', yes: 'Replace' }));
    // The key reaches the prompt's input; the browser runs pending reactions before the
    // listeners further up (the document), where a question opened meanwhile listens.
    const down = new KeyboardEvent('keydown', { key: 'Enter', bubbles: false, cancelable: true });
    $('pm-input').dispatchEvent(down);
    await microtasks();
    document.dispatchEvent(down);
    await later();
    if (!down.defaultPrevented && document.activeElement instanceof HTMLButtonElement) document.activeElement.click();
    await later();
    expect(named.value).toBe('Wing');
    expect(shown('modal-confirm')).toBe(true);
    expect(heading()).toBe('Replace the mesh?');
    expect(asked.value).toBe('pending');
    $('cf-cancel').click();
    await later();
    expect(asked.value).toBe(false);
  });
});

describe('a dialog whose asker is gone', () => {
  it('closes as Cancel when its signal ends while it is open, and is dropped unseen while it waits', async () => {
    const ended = new AbortController();
    const open = track(confirmAction({ title: 'Replace the mesh?', signal: ended.signal }));
    const queued = track(promptName({ title: 'Name the polar', value: 'Polar 1', signal: ended.signal }));
    const other = track(confirmAction({ title: 'Delete the view?' }));
    expect(heading()).toBe('Replace the mesh?');
    ended.abort();
    await later();
    expect(open.value).toBe(false);
    expect(queued.value).toBeNull();
    expect(shown('modal-prompt')).toBe(false);
    expect(heading()).toBe('Delete the view?');
    $('cf-confirm').click();
    await later();
    expect(other.value).toBe(true);
    // An open prompt closes as null.
    const gone = new AbortController();
    const named = track(promptName({ title: 'Name the polar', value: 'Polar 1', signal: gone.signal }));
    expect(shown('modal-prompt')).toBe(true);
    gone.abort();
    await later();
    expect(named.value).toBeNull();
    expect(shown('modal-prompt')).toBe(false);
    expect(dialogBusy()).toBe(false);
  });

  it('the next one opens only after what the answer set off has run (its skipIf sees it)', async () => {
    let leaving = false;
    // The leave question's answer approves the leave a few reactions later.
    void (async () => {
      const ok = await confirmAction({ title: 'Leave without saving?', yes: 'Leave' });
      await Promise.resolve();
      leaving = ok;
    })();
    const page = track(confirmAction({ title: 'Replace the mesh?', skipIf: () => leaving }));
    $('cf-confirm').click();
    await later();
    expect(leaving).toBe(true);
    expect(page.value).toBe(false);
    expect(shown('modal-confirm')).toBe(false);
    expect(dialogBusy()).toBe(false);
  });
});
