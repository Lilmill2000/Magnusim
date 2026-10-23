// A request in the dock's transcript (phase 4 spec 2.4-2.10, 4.5): the person's message, the
// model's text, tool steps with their pictures, a coding agent's rows, review rounds, questions
// as lines, the footer with its counters, the end and the meter; and the transcript around them
// (Show earlier, the intro, the picture viewer).
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantStatus, TurnEvent, TurnSummary } from '../wire';
import { Transcript } from './Transcript';
import { OPEN_STEPS, TurnBlock } from './TurnBlock';
import { applyEvents, applySummary, emptyTurnView, markGone, type TurnView } from './turnView';

let seq = 0;
const e = (x: Record<string, unknown>): TurnEvent => ({ seq: ++seq, at: 0, ...x }) as TurnEvent;
const view = (events: Array<Record<string, unknown>>, summary?: Partial<TurnSummary>): TurnView => {
  let v = applyEvents(emptyTurnView('t1'), events.map(e));
  if (summary) v = applySummary(v, { id: 't1', conversation: 'c1', state: 'model', ...summary } as TurnSummary);
  return v;
};
const STATUS = { caps: { turn_usd: 8, day_usd: 15, steps: 120, turn_minutes: 60, turn_tokens: 1e7 }, spent_today_usd: 3.1 } as unknown as AssistantStatus;
const USED = { steps: 3, steps_cap: 120, changes: 0, changes_cap: 0, usd: 0.42, usd_cap: 8, active_ms: 125_000, minutes_cap: 60 };

const block = (v: TurnView, extra: Partial<Parameters<typeof TurnBlock>[0]> = {}) =>
  render(<TurnBlock view={v} newest status={STATUS} workspace="Counter" {...extra} />).container;

const call = (id: string, title = 'Add to the counter', risk = 'edit') => ({ type: 'tool_call', step: 1, call: id, tool: 'ai__add', title, risk, source: 'Counter', input_preview: '{"by":2}' });

describe('the person\'s message', () => {
  it('shows the request, its pictures from the turn, and who started it', () => {
    const c = block(view([], { prompt: 'Add two\nthen stop', started_by: 'program', prompt_images: [{ n: 'p1', media_type: 'image/png', width: 10, height: 10 }] }));
    expect(c.querySelector('[data-dock-prompt]')?.textContent).toBe('Add two\nthen stop');
    const img = c.querySelector('.dock-you img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/assistant/turns/t1/images/p1');
    expect(img.alt).toBe('Your picture 1 of 1');
    expect(screen.getByText('From the command line or another program')).toBeTruthy();
  });

  it("this tab's own copies win over the server's", () => {
    const c = block(view([], { prompt: 'x', started_by: 'window', prompt_images: [{ n: 'p1', media_type: 'image/png', width: 1, height: 1 }] }), { localPictures: ['blob:here/1'] });
    expect((c.querySelector('.dock-you img') as HTMLImageElement).getAttribute('src')).toBe('blob:here/1');
    expect(screen.queryByText('From the command line or another program')).toBeNull();
  });

  it('its attached files, by name and size (core host tools spec 13.1); none, no list', () => {
    const c = block(view([], { prompt: 'Import these', attachments: [{ id: 'att-0000000000000001', name: 'bracket.step', bytes: 4.2 * 1024 * 1024 }, { id: 'att-0000000000000002', name: 'wing.stl', bytes: 134 }] }));
    const list = screen.getByRole('list', { name: 'Attached files' });
    expect(Array.from(list.querySelectorAll('[data-dock-you-file]')).map((li) => li.textContent)).toEqual(['bracket.step · 4.2 MB', 'wing.stl · 134 bytes']);
    expect(c.querySelector('.dock-you')?.contains(list)).toBe(true);
    const none = block(view([], { prompt: 'x', attachments: [] }));
    expect(none.querySelector('.dock-you-files')).toBeNull();
  });
});

describe('what a call changed (phase 5, C2)', () => {
  const sync = (x: Record<string, unknown>) => ({ type: 'ui_sync', project_id: 'p1', kinds: ['bcs'], ids: { bc: ['bc-7'] }, names: { 'bc-7': 'Inlet' }, ...x });

  it('shows "Updated: …" under the call that wrote, with the names of its records', () => {
    const c = block(view([call('a', 'Change the setup'), sync({ call: 'a' }), sync({ call: 'a', kinds: ['mesh', 'active'], ids: { mesh: ['m1'] }, names: { m1: 'Mesh 1' } }), { type: 'tool_result', call: 'a', ok: true, summary: 'Saved', ms: 300 }]));
    const step = c.querySelector('[data-dock-step="a"]') as HTMLDetailsElement;
    expect(step.querySelector('[data-dock-updated]')?.textContent).toBe('Updated: Boundary conditions (Inlet); Mesh (Mesh 1)');
  });

  it('a kind with no names given is named alone; a sync with no open call is a line of its own', () => {
    const c = block(view([call('a'), sync({ call: 'a', kinds: ['materials'], ids: {}, names: {} }), sync({ kinds: ['refinements'], ids: { refinement: ['r1'] }, names: { r1: 'Wall' } })]));
    expect(c.querySelector('[data-dock-step="a"] [data-dock-updated]')?.textContent).toBe('Updated: Materials');
    expect(c.querySelector('[data-dock-line="updated"]')?.textContent).toBe('Updated: Mesh refinements (Wall)');
  });

  it('only how the window follows (active, tree): no line', () => {
    const c = block(view([call('a'), sync({ call: 'a', kinds: ['active', 'tree'], ids: {}, names: {} })]));
    expect(c.querySelector('[data-dock-updated]')).toBeNull();
  });
});

describe('tool steps', () => {
  it('title, source, risk badge, what it sent, the result and its time', () => {
    const c = block(view([call('a'), { type: 'tool_result', call: 'a', ok: true, summary: 'Counter is 2', ms: 812 }]));
    const step = c.querySelector('[data-dock-step="a"]') as HTMLDetailsElement;
    expect(step.querySelector('.dock-step-title')?.textContent).toBe('Add to the counter');
    expect(step.querySelector('.dock-step-source')?.textContent).toBe('Counter');
    expect(step.querySelector('[data-dock-risk]')?.textContent).toBe('Changes');
    expect(step.querySelector('.dock-sent summary')?.textContent).toBe('What it sent');
    expect((step.querySelector('.dock-sent') as HTMLDetailsElement).open).toBe(false);
    expect(step.querySelector('[data-dock-result]')?.textContent).toBe('✓ Counter is 2 · 0.8 s');
  });

  it('a failed call: its summary, how to fix it, its code; the risk badges', () => {
    const c = block(
      view([
        call('a', 'Reset the counter', 'destructive'),
        { type: 'tool_result', call: 'a', ok: false, summary: 'No such counter', ms: 5, code: 'not_found', hint: 'Open the counter first.' },
        call('b', 'Run', 'compute'),
      ]),
    );
    const a = c.querySelector('[data-dock-step="a"]') as HTMLElement;
    expect(a.querySelector('[data-dock-result]')?.textContent).toBe('✗ No such counter');
    expect(a.querySelector('.dock-step-hint')?.textContent).toBe('How to fix: Open the counter first.');
    expect(a.querySelector('.dock-step-code')?.textContent).toBe('not_found');
    expect(a.querySelector('[data-dock-risk]')?.className).toContain('danger');
    expect(c.querySelector('[data-dock-step="b"] [data-dock-risk]')?.textContent).toBe('Runs a computation');
  });

  it('progress, and a call that waits for the person in its workspace', () => {
    const c = block(view([call('a'), { type: 'state', state: 'tools' }, { type: 'tool_progress', call: 'a', fraction: 0.5, label: 'Half' }]));
    expect(c.querySelector('[data-dock-progress] [role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
    expect(c.querySelector('[data-dock-phase]')?.textContent).toBe('Working: Add to the counter · Half');
    const w = block(view([call('a'), { type: 'state', state: 'tools' }, { type: 'tool_progress', call: 'a', fraction: null, label: 'Paused by the person', waiting: true }]));
    expect(w.querySelector('[data-dock-progress="waiting"]')?.textContent).toBe('Waits for you in Counter: Paused by the person');
    expect(w.querySelector('[data-dock-phase]')?.textContent).toBe('Waits for you in Counter: Paused by the person');
    expect(w.querySelector('.dock-progress-bar')?.className).toContain('indeterminate');
  });

  it('pictures as thumbnails with their alt; one no longer kept says so', () => {
    const images = [
      { n: '1', media_type: 'image/png', width: 64, height: 64 },
      { n: '2', media_type: 'image/png', width: 64, height: 64 },
    ];
    const c = block(view([call('a', 'Picture the counter', 'read'), { type: 'tool_result', call: 'a', ok: true, summary: 'A picture', ms: 3, images }]));
    const imgs = [...c.querySelectorAll('[data-dock-step="a"] .dock-step-pictures img')] as HTMLImageElement[];
    expect(imgs.map((i) => [i.getAttribute('src'), i.alt])).toEqual([
      ['/api/assistant/turns/t1/images/1', 'Picture 1 of 2 from Picture the counter'],
      ['/api/assistant/turns/t1/images/2', 'Picture 2 of 2 from Picture the counter'],
    ]);
    fireEvent.error(imgs[1]);
    expect(c.querySelector('[data-dock-picture-gone]')?.textContent).toBe('Picture no longer kept');
  });

  it("a finished export's Download link: the person's click saves the file (spec 06 §8.6)", () => {
    const href = '/api/results/export-vtk/job-x1/file?project_id=p1';
    const c = block(view([call('w', 'Wait for jobs', 'read'), { type: 'tool_result', call: 'w', ok: true, summary: 'VTK export done', ms: 3, links: [{ label: 'Download Run_1-vtk-0.5.zip', href }] }]));
    const a = c.querySelector('[data-dock-step="w"] a[data-dock-download]') as HTMLAnchorElement;
    expect(a.textContent).toBe('Download Run_1-vtk-0.5.zip');
    expect(a.getAttribute('href')).toBe(href);
    expect(a.hasAttribute('download')).toBe(true);
    expect(a.title).toBe('Save the file on this PC');
    // A failed call shows none, nor does a result without links.
    const f = block(view([call('x'), { type: 'tool_result', call: 'x', ok: false, summary: 'No', ms: 1, links: [{ label: 'Download', href }] }]));
    expect(f.querySelector('a[data-dock-download]')).toBeNull();
  });

  it(`only the newest ${OPEN_STEPS} steps show open; the person may open any`, () => {
    const events: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 5; i += 1) events.push(call(`c${i}`), { type: 'tool_result', call: `c${i}`, ok: true, summary: `s${i}`, ms: 1 });
    const c = block(view(events));
    const open = () => [...c.querySelectorAll<HTMLDetailsElement>('.dock-step')].map((d) => d.open);
    expect(open()).toEqual([false, false, true, true, true]);
    const first = c.querySelector<HTMLDetailsElement>('[data-dock-step="c1"]') as HTMLDetailsElement;
    first.open = true;
    fireEvent(first, new Event('toggle'));
    expect(open()).toEqual([true, false, true, true, true]);
  });
});

describe('text, questions, rounds and notes', () => {
  it('streams text per step with a caret; questions are lines, never cards', () => {
    const gate = { id: 'g1', kind: 'confirm', turn: 't1', title: 'Reset the counter?', copy: 'c', yes: 'Allow', no: "Don't", opened_at: '', expires_at: '' };
    const c = block(
      view([
        { type: 'state', state: 'model' },
        { type: 'text', step: 1, text: 'Hello ' },
        { type: 'gate', gate },
        { type: 'gate_closed', gate: 'g1', answer: 'deny', by: 'user' },
        { type: 'review', round: 1, of: 3 },
        { type: 'note', text: 'A note' },
        { type: 'fallback', step: 1, from: 'm-a', to: 'm-b' },
        { type: 'text', step: 2, text: 'and **more**' },
      ]),
    );
    expect(c.querySelectorAll('[data-gate]')).toHaveLength(0);
    expect([...c.querySelectorAll('[data-dock-line]')].map((p) => p.textContent)).toEqual([
      'Asked: Reset the counter?',
      'You chose “Don\'t”: Reset the counter?',
      'ⓘ A note',
      'Answered by m-b after m-a declined the request.',
    ]);
    expect(c.querySelector('[data-dock-review]')?.textContent).toBe('Checking its work · round 1 of 3');
    const texts = c.querySelectorAll('[data-dock-text]');
    expect(texts[0].getAttribute('aria-busy')).toBeNull();
    expect(texts[1].getAttribute('aria-busy')).toBe('true');
    expect(c.querySelector('[data-dock-phase]')?.textContent).toBe('Checking its work (round 1 of 3)…');
  });
});

describe("a coding agent's rows", () => {
  it('its line, its plan replaced in place, its own tools by call, permission, mode and model', () => {
    const c = block(
      view(
        [
          { type: 'state', state: 'model' },
          { type: 'agent', name: 'Helper', version: '1.2', own_tools: 'off' },
          { type: 'plan', entries: [{ content: 'Look', status: 'pending', priority: 'high' }] },
          { type: 'agent_tool', call: 'x', title: 'Read file', kind: 'read', status: 'in_progress' },
          { type: 'plan', entries: [{ content: 'Look', status: 'completed', priority: 'high' }, { content: 'Build', status: 'in_progress', priority: 'low' }] },
          { type: 'agent_tool', call: 'x', title: 'Read file', kind: 'read', status: 'completed' },
          { type: 'agent_permission', title: 'Add', outcome: 'auto_allowed', by: 'magnusim' },
          { type: 'agent_mode', mode: 'ask', label: 'Ask' },
          { type: 'agent_model', model: 'big', label: 'Big' },
        ],
        { billing: 'agent_account', used: { ...USED, changes: 1, changes_cap: 24, steps: 4, steps_cap: 400 } },
      ),
    );
    expect(c.querySelector('[data-dock-agent]')?.textContent).toBe('Helper 1.2 · its own tools are off');
    expect(c.querySelectorAll('[data-dock-plan]')).toHaveLength(1);
    expect([...c.querySelectorAll('[data-dock-plan-entry]')].map((li) => [li.getAttribute('data-dock-plan-entry'), li.className])).toEqual([
      ['completed', 'high'],
      ['in_progress', ''],
    ]);
    expect(c.querySelector('[data-dock-plan] h4')?.textContent).toBe('Its plan');
    expect(c.querySelectorAll('[data-dock-agent-tool]')).toHaveLength(1);
    expect(c.querySelector('[data-dock-agent-tool="completed"]')?.textContent).toContain('Read file · read');
    expect([...c.querySelectorAll('[data-dock-line]')].map((p) => p.textContent)).toEqual([
      'Auto-allowed: Add. Magnusim asks you itself when one of its tools needs it.',
      'Mode: Ask',
      'Model: Big',
    ]);
    expect(c.querySelector('[data-dock-phase]')?.textContent).toBe('Helper is working…');
    expect(c.querySelector('[data-dock-counters]')?.textContent).toBe('1 of 24 changes · 4 of 400 tool calls · 2 of 60 min');
    expect(c.querySelector('[data-dock-meter]')?.textContent).toBe("Billed to your Helper account (Magnusim can't see the cost)");
  });
});

describe('the footer, the end and the meter', () => {
  it('counters and the $ meter while it runs; warning from 80%', () => {
    const c = block(view([{ type: 'state', state: 'model' }], { billing: 'usd', used: USED, usd: 0.42 }));
    expect(c.querySelector('[data-dock-counters]')?.textContent).toBe('3 of 120 steps · 2 of 60 min');
    expect(c.querySelector('[data-dock-meter]')?.textContent).toBe('This request: $0.42 of $8.00 · Today: $3.10 of $15.00');
    expect(c.querySelector('[data-dock-meter]')?.className).not.toContain('warn');
    const hot = block(view([{ type: 'state', state: 'model' }, { type: 'usage', usd: 0.1, estimated: true, turn_usd: 6.5, day_usd: 7, tokens: 1 }], { billing: 'usd', used: USED }));
    expect(hot.querySelector('[data-dock-meter]')?.textContent).toBe('This request: about $6.50 of $8.00 · Today: $7.00 of $15.00');
    expect(hot.querySelector('[data-dock-meter]')?.className).toContain('warn');
    const free = block(view([], { billing: 'free' }));
    expect(free.querySelector('[data-dock-meter]')?.textContent).toBe('Local server · no cost');
    expect(block(view([], { billing: 'free' }), { newest: false }).querySelector('[data-dock-meter]')).toBeNull();
  });

  it('every end: its label and body, and no footer', () => {
    const end = (state: string, message: string | null, summary: Partial<TurnSummary> = {}) =>
      block(view([{ type: 'end', state, reason: 'x', message }], { state: state as TurnSummary['state'], ...summary }));
    const done = end('done', null, { billing: 'usd', usd: 0.42, used: USED });
    expect(done.querySelector('[data-turn-end="done"]')?.textContent).toBe('3 steps · $0.42');
    expect(done.querySelector('[data-dock-phase]')).toBeNull();
    expect(end('stopped', 'Nothing was sent.').querySelector('[data-turn-end="stopped"]')?.textContent).toBe('StoppedNothing was sent.');
    expect(end('capped', 'The step limit was reached.').querySelector('[data-turn-end="capped"]')?.textContent).toBe('Limit reachedThe step limit was reached. Send another message to carry on.');
    expect(end('failed', 'The model declined this request.').querySelector('[data-turn-end="failed"]')?.textContent).toBe("Didn't finishThe model declined this request.");
    expect(end('done', null, { log_dropped: true, billing: 'free', used: USED }).textContent).toContain("This request's details are no longer kept.");
    const gone = block(markGone(emptyTurnView('t1')));
    expect(gone.querySelector('[data-turn-end="gone"]')?.textContent).toBe("This request's record is gone: Magnusim keeps it while its conversation lives.");
  });

  it('Stopping…, then Still stopping… after 5 s', () => {
    vi.useFakeTimers();
    try {
      const now = performance.now();
      const c = block(view([{ type: 'state', state: 'model' }]), { stopSentAt: now });
      expect(c.querySelector('[data-dock-phase]')?.textContent).toBe('Stopping…');
      act(() => {
        vi.advanceTimersByTime(5100);
      });
      expect(c.querySelector('[data-dock-phase]')?.textContent).toBe('Still stopping…');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the transcript', () => {
  const t = (id: string, events: Array<Record<string, unknown>>) => ({ id, row: null, view: { ...applyEvents(emptyTurnView(id), events.map(e)) } });

  it('the intro while empty; Show earlier', () => {
    const onEarlier = vi.fn();
    const c = render(<Transcript turns={[]} hasEarlier onEarlier={onEarlier} intro="Ask the Assistant." status={null} workspace="" />).container;
    expect(c.querySelector('[data-dock-intro]')?.textContent).toBe('Ask the Assistant.');
    fireEvent.click(screen.getByText('Show earlier requests'));
    expect(onEarlier).toHaveBeenCalledTimes(1);
  });

  it('a picture opens in the viewer: arrows go through the turn, Escape closes it and gives the keyboard back', () => {
    const images = [1, 2].map((n) => ({ n: String(n), media_type: 'image/png', width: 64, height: 64 }));
    const turn = t('t9', [call('a', 'Snap', 'read'), { type: 'tool_result', call: 'a', ok: true, summary: 'ok', ms: 1, images }]);
    const outer = vi.fn();
    const c = render(
      <div onKeyDown={(ev) => outer(ev.defaultPrevented)}>
        <Transcript turns={[turn]} hasEarlier={false} onEarlier={() => undefined} intro={null} status={null} workspace="" />
      </div>,
    ).container;
    const thumb = c.querySelector('[data-dock-picture="1"]') as HTMLButtonElement;
    thumb.focus();
    fireEvent.click(thumb);
    const viewer = c.querySelector('[data-dock-viewer]') as HTMLElement;
    expect(viewer.querySelector('img')?.getAttribute('src')).toBe('/api/assistant/turns/t9/images/1');
    expect(document.activeElement?.getAttribute('data-dock-viewer-close')).toBe('1');
    fireEvent.keyDown(viewer, { key: 'ArrowRight' });
    expect(viewer.querySelector('img')?.getAttribute('alt')).toBe('Picture 2 of 2 from Snap');
    fireEvent.keyDown(viewer, { key: 'Escape' });
    expect(c.querySelector('[data-dock-viewer]')).toBeNull();
    // The dock's own Escape (close) sees it used.
    expect(outer).toHaveBeenLastCalledWith(true);
    expect(document.activeElement).toBe(thumb);
  });
});
