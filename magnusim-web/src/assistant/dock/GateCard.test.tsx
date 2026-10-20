// The Assistant's questions as cards in the dock (phase 4 spec 4.3, 4.4, 4.6): the presenter the
// relay hands them to, the card's content, its keys, the guarded Yes, the keyboard's way, the
// privacy card, and the document title while questions wait.
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GateView } from '../wire';
import { resetDockForTests } from './dockState';
import { GateCard, minutesLeft } from './GateCard';
import { presentInDock, resetGateCardsForTests, useGateCards } from './gates';
import { dockStoreSnapshot, resetDockStoreForTests } from './store';
import { YES_GUARD_MS } from '../../workbench/guardedYes';

const wizard = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../wizard/controller', () => ({ openSetupWizard: wizard.open }));

const gate = (over: Partial<GateView> = {}): GateView => ({
  id: 'g-1',
  kind: 'confirm',
  turn: null,
  title: 'Allow the Assistant to reset the counter?',
  copy: 'Workspace demo (Counter) · Sets the counter to 0. Nothing runs until you choose.',
  yes: 'Allow',
  no: "Don't",
  risk: 'destructive',
  opened_at: '2026-10-20T10:00:00Z',
  expires_at: new Date(Date.now() + 9.5 * 60_000).toISOString(),
  ...over,
});

function Dock() {
  const cards = useGateCards();
  return (
    <aside id="assistant-dock">
      {cards.map((c) => (
        <GateCard key={c.gate.id} card={c} first={c === cards[0]} who={c.gate.turn ? null : 'Asked by another app on this PC.'} />
      ))}
      <footer className="assistant-dock-composer">
        <textarea aria-label="Message to the Assistant" />
      </footer>
    </aside>
  );
}

/** Shows `g` as the relay does: a promise of the answer, and its abort. */
function ask(g: GateView) {
  const ctl = new AbortController();
  let answer: boolean | null | undefined;
  const p = presentInDock(g, { signal: ctl.signal }).then((v) => {
    answer = v;
    return v;
  });
  return { ctl, p, answer: () => answer };
}

const frames = async (n = 3) => {
  for (let i = 0; i < n; i += 1) {
    await act(async () => {
      vi.advanceTimersByTime(20);
    });
  }
};
const card = (id = 'g-1') => document.querySelector(`[data-gate="${id}"]`) as HTMLElement;
const btn = (which: 'yes' | 'no', id = 'g-1') => card(id).querySelector(`[data-gate-answer="${which}"]`) as HTMLButtonElement;

let outside: HTMLButtonElement;
beforeEach(() => {
  vi.useFakeTimers();
  resetDockForTests();
  resetDockStoreForTests();
  resetGateCardsForTests();
  document.title = 'Magnusim';
  outside = document.createElement('button');
  outside.textContent = 'outside';
  document.body.appendChild(outside);
  outside.focus();
});
afterEach(() => {
  resetGateCardsForTests();
  resetDockStoreForTests();
  outside.remove();
  vi.useRealTimers();
});

describe('a question card', () => {
  it('opens the dock, shows its parts, and No takes the keyboard from wherever it was', async () => {
    render(<Dock />);
    act(() => void ask(gate({ detail: [{ label: 'Cells', value: '1.2 M' }] })));
    await frames();
    const c = card();
    expect(c.getAttribute('role')).toBe('alertdialog');
    expect(c.getAttribute('data-gate-kind')).toBe('confirm');
    expect(document.getElementById(c.getAttribute('aria-labelledby') as string)?.textContent).toBe('Allow the Assistant to reset the counter?');
    expect(document.getElementById(c.getAttribute('aria-describedby') as string)?.textContent).toContain('Sets the counter to 0.');
    expect([...c.querySelectorAll('[data-gate-badge]')].map((b) => b.textContent)).toEqual(["Can't be undone"]);
    expect([...c.querySelectorAll('dt, dd')].map((x) => x.textContent)).toEqual(['Cells', '1.2 M']);
    expect(c.querySelector('.dock-gate-footer')?.textContent).toBe('Asked by another app on this PC. · Closes in 9 min');
    expect(c.querySelector('.dock-gate-help')?.textContent).toBe('Enter or Escape answers “Don\'t”. “Allow” takes a click, or Tab then Space.');
    expect([...c.querySelectorAll('[data-gate-answer]')].map((b) => b.textContent)).toEqual(["Don't", 'Allow']);
    expect(document.activeElement).toBe(btn('no'));
    expect(dockStoreSnapshot().questions).toEqual(['g-1']);
    expect(document.title).toBe('(1) Magnusim');
  });

  it.each([
    ['No', 'no', 'Enter'],
    ['Yes', 'yes', 'Enter'],
    ['the copy', 'copy', 'Escape'],
    ['No', 'no', 'Escape'],
  ] as const)('%s with %s: answers No and goes no further', async (_name, where, key) => {
    const outer = vi.fn();
    render(
      <div onKeyDown={(e) => outer(e.defaultPrevented)}>
        <Dock />
      </div>,
    );
    let q!: ReturnType<typeof ask>;
    act(() => {
      q = ask(gate());
    });
    await frames();
    await act(async () => {
      vi.advanceTimersByTime(YES_GUARD_MS);
    });
    const target = where === 'copy' ? (card().querySelector('.dock-gate-copy') as HTMLElement) : btn(where);
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    await act(async () => {
      target.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    expect(await q.p).toBe(false);
    expect(card()).toBeNull();
    expect(document.title).toBe('Magnusim');
  });

  it(`Yes is guarded: off for ${YES_GUARD_MS} ms; a press that began before, or a double-click's second click, never answers; Tab then Space does`, async () => {
    render(<Dock />);
    let q!: ReturnType<typeof ask>;
    act(() => {
      q = ask(gate());
    });
    await frames();
    expect(btn('yes').disabled).toBe(true);
    // A press before it is enabled, its click after: no answer.
    fireEvent.pointerDown(btn('yes'));
    await act(async () => {
      vi.advanceTimersByTime(YES_GUARD_MS);
    });
    expect(btn('yes').disabled).toBe(false);
    fireEvent.click(btn('yes'), { detail: 1 });
    // The second click of a double-click: no answer either.
    fireEvent.pointerDown(btn('yes'));
    fireEvent.click(btn('yes'), { detail: 2 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(q.answer()).toBeUndefined();
    // Tab, then Space: a click with detail 0.
    await act(async () => {
      fireEvent.click(btn('yes'), { detail: 0 });
    });
    expect(await q.p).toBe(true);
  });

  it('a deliberate click answers Yes; the keyboard then goes back where it was', async () => {
    render(<Dock />);
    let q!: ReturnType<typeof ask>;
    act(() => {
      q = ask(gate());
    });
    await frames();
    await act(async () => {
      vi.advanceTimersByTime(YES_GUARD_MS);
    });
    fireEvent.pointerDown(btn('yes'));
    await act(async () => {
      fireEvent.click(btn('yes'), { detail: 1 });
    });
    expect(await q.p).toBe(true);
    await frames();
    expect(document.activeElement).toBe(outside);
  });

  it('a second card never takes the keyboard from the first; answering the first gives it to the second', async () => {
    render(<Dock />);
    let a!: ReturnType<typeof ask>;
    let b!: ReturnType<typeof ask>;
    act(() => {
      a = ask(gate());
    });
    await frames();
    act(() => {
      b = ask(gate({ id: 'g-2', title: 'Second?' }));
    });
    await frames();
    expect(document.activeElement).toBe(btn('no', 'g-1'));
    expect(document.title).toBe('(2) Magnusim');
    // Opening the dock gives the keyboard to the oldest card's No (DockShell's marked entry).
    expect([btn('no', 'g-1').dataset.dockAutofocus, btn('no', 'g-2').dataset.dockAutofocus]).toEqual(['1', undefined]);
    await act(async () => {
      fireEvent.click(btn('no', 'g-1'));
    });
    expect(await a.p).toBe(false);
    await frames();
    expect(document.activeElement).toBe(btn('no', 'g-2'));
    // Closed unanswered (the relay's signal): gone, and the keyboard goes to the composer.
    act(() => b.ctl.abort());
    expect(await b.p).toBeNull();
    await frames();
    expect(card('g-2')).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Message to the Assistant');
    expect(dockStoreSnapshot().questions).toEqual([]);
  });

  it("a privacy card: its badge, its buttons and Privacy settings, which leaves the question open", async () => {
    render(<Dock />);
    let q!: ReturnType<typeof ask>;
    act(() => {
      q = ask(gate({ kind: 'privacy', risk: undefined, title: 'Send project "Wing" to Cloud A?', yes: 'Send', no: "Don't send", link_only: true }));
    });
    await frames();
    expect(card().getAttribute('data-gate-kind')).toBe('privacy');
    expect([...card().querySelectorAll('[data-gate-badge]')].map((b) => b.textContent)).toEqual(['Project data', 'Answer here only']);
    fireEvent.click(card().querySelector('[data-gate-privacy-settings]') as HTMLElement);
    expect(wizard.open).toHaveBeenCalledWith({ required: false, step: 'assistant' });
    expect(card()).not.toBeNull();
    expect(q.answer()).toBeUndefined();
    expect([btn('no').textContent, btn('yes').textContent]).toEqual(["Don't send", 'Send']);
  });

  it('closes in whole minutes, under a minute said so', () => {
    const now = Date.parse('2026-10-20T10:00:00Z');
    expect(minutesLeft('2026-10-20T10:09:59Z', now)).toBe(9);
    expect(minutesLeft('2026-10-20T10:00:30Z', now)).toBe(0);
    expect(minutesLeft('', now)).toBeNull();
  });
});
