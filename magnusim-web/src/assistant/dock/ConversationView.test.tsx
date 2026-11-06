// The dock's "Elsewhere" section (phase 4 spec 4.7): a request of another origin bound to this
// tab, and a request whose question card shows here, each show once, in the order they came, even
// when a request is both (a command-line request on the open part asking a question).
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantStatus, GateView } from '../wire';
import type { DockPlace } from './context';
import { useDockContent } from './ConversationView';
import { resetDockForTests } from './dockState';
import { presentInDock, resetGateCardsForTests } from './gates';
import { resetDockStoreForTests } from './store';

const wizard = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../wizard/controller', () => ({ openSetupWizard: wizard.open }));
vi.mock('../../api/eventHub', () => ({
  openChannel: () => ({ CONNECTING: 0, OPEN: 1, CLOSED: 2, readyState: 0, addEventListener() {}, removeEventListener() {}, close() {}, pin() {} }),
}));
// The requests bound to this tab that the server says run.
const relay = vi.hoisted(() => ({ turns: [] as Array<{ id: string; title: string }>, listeners: new Set<() => void>() }));
vi.mock('../relay', () => ({
  relayTurnsSnapshot: () => relay.turns,
  subscribeRelayTurns: (fn: () => void) => {
    relay.listeners.add(fn);
    return () => relay.listeners.delete(fn);
  },
  holdAssistantLink: () => () => undefined,
}));
const STATUS = { provider: 'openai_compatible', default_provider: 'openai_compatible', providers_ready: {}, caps: { turn_usd: 8, day_usd: 15 } } as unknown as AssistantStatus;
vi.mock('../status', async (orig) => ({ ...(await orig<typeof import('../status')>()), useAssistantStatus: () => ({ state: 'ready', status: STATUS }) }));
// A CAD Part open with its tools, as for a request of the command line run with --tab auto.
const PLACE: DockPlace = { projectId: 'p1', projectTitle: 'Wing', simulationId: 's1', workspace: { plugin: 'cad', key: 'part', name: 'Part 1', state: 'tools' } };
vi.mock('./context', () => ({ useDockPlace: () => PLACE }));

const TURN = 't-mw4wme1d-d784ec73';
const gate = (id: string, turn: string): GateView => ({
  id,
  kind: 'confirm',
  turn,
  title: 'Allow the Assistant to delete the body?',
  copy: 'CAD (Part 1) · Deletes Body 1.',
  yes: 'Allow',
  no: "Don't",
  opened_at: '2026-11-06T10:00:00Z',
  expires_at: new Date(Date.now() + 9.5 * 60_000).toISOString(),
});

function Dock() {
  const c = useDockContent();
  return (
    <aside id="assistant-dock">
      <div className="assistant-dock-questions">{c?.questions}</div>
      <div className="assistant-dock-log">{c?.log}</div>
    </aside>
  );
}

const elsewhereRows = () => [...document.querySelectorAll('[data-dock-elsewhere] [data-dock-turn]')].map((el) => el.getAttribute('data-dock-turn'));
const ctls: AbortController[] = [];
const ask = (g: GateView) => {
  const ctl = new AbortController();
  ctls.push(ctl);
  void presentInDock(g, { signal: ctl.signal });
};
const keyErrors = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.filter((c) => c.some((a) => String(a).includes('two children with the same key')));

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetDockForTests();
  resetDockStoreForTests();
  resetGateCardsForTests();
  relay.turns = [];
  relay.listeners.clear();
  errors = vi.spyOn(console, 'error');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true, conversations: [] }), { status: 200 })),
  );
});
afterEach(() => {
  for (const c of ctls.splice(0)) c.abort();
  resetGateCardsForTests();
  resetDockStoreForTests();
  errors.mockRestore();
  vi.unstubAllGlobals();
});

describe('Elsewhere', () => {
  it('a request bound to this tab that also has an open question card shows once, with no duplicate key', async () => {
    relay.turns = [{ id: TURN, title: 'Set the width' }];
    act(() => ask(gate('g-1', TURN)));
    await act(async () => {
      render(<Dock />);
    });
    expect(document.querySelector('[data-gate="g-1"]')).not.toBeNull();
    expect(keyErrors(errors)).toEqual([]);
    expect(elsewhereRows()).toEqual([TURN]);
  });

  it('two open questions of one request show it once; the rows keep the order they came in', async () => {
    relay.turns = [
      { id: 't-a', title: 'A' },
      { id: 't-b', title: 'B' },
    ];
    act(() => {
      ask(gate('g-1', 't-b'));
      ask(gate('g-2', 't-c'));
      ask(gate('g-3', 't-c'));
    });
    await act(async () => {
      render(<Dock />);
    });
    expect(document.querySelectorAll('[data-gate]')).toHaveLength(3);
    expect(keyErrors(errors)).toEqual([]);
    expect(elsewhereRows()).toEqual(['t-a', 't-b', 't-c']);
  });
});
