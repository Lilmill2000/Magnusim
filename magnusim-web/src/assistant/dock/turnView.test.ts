// The dock's turn reducer (phase 4 spec 2.4-2.9, 4.5, 5.2): pure, idempotent on replays.
import { describe, expect, it } from 'vitest';
import type { GateView, TurnEvent, TurnSummary } from '../wire';
import { agentPermissionLine, endBody, endLabel, gateAsked, gateClosedLine, reviewDivider } from './copy';
import {
  applyEvents,
  applySummary,
  currentTool,
  downloadLinks,
  emptyTurnView,
  fillDroppedText,
  finalText,
  isEnded,
  markGone,
  STILL_STOPPING_MS,
  streamingStep,
  turnPhase,
  type TurnItem,
  type TurnView,
} from './turnView';

let seq = 0;
const ev = (body: Record<string, unknown>, at?: number): TurnEvent => ({ seq: at ?? ++seq, at: 0, ...body }) as TurnEvent;
const view = (events: TurnEvent[]): TurnView => applyEvents(emptyTurnView('t1'), events);
const kinds = (v: TurnView) => v.items.map((it) => it.kind);
const texts = (v: TurnView) => v.items.filter((it): it is Extract<TurnItem, { kind: 'text' }> => it.kind === 'text').map((it) => [it.step, it.text]);
const summary = (state: TurnSummary['state'], extra: Partial<TurnSummary> = {}): TurnSummary => ({
  id: 't1',
  conversation: 'c1',
  state,
  step: 1,
  started_at: '2026-10-20T10:00:00.000Z',
  ended_at: null,
  usd: 0,
  estimated: false,
  end_reason: null,
  message: null,
  open_gates: [],
  text_so_far: '',
  tab: null,
  project_id: null,
  served_by: null,
  ...extra,
});
const gate = (id: string, extra: Partial<GateView> = {}): GateView => ({
  id,
  kind: 'confirm',
  turn: 't1',
  title: 'Reset the counter?',
  copy: 'Sets the counter to 0.',
  yes: 'Reset',
  no: "Don't reset",
  opened_at: '2026-10-20T10:00:00.000Z',
  expires_at: '2026-10-20T10:10:00.000Z',
  ...extra,
});

describe('replay by seq', () => {
  it('drops events at or below the newest it has, so a replayed snapshot changes nothing', () => {
    seq = 0;
    const events = [ev({ type: 'state', state: 'model' }), ev({ type: 'text', step: 1, text: 'Hello' }), ev({ type: 'text', step: 1, text: ' there' })];
    const v = view(events);
    expect(v.lastSeq).toBe(3);
    expect(texts(v)).toEqual([[1, 'Hello there']]);
    // The same snapshot again (a reconnect from an older since): the same object.
    expect(applyEvents(v, events)).toBe(v);
    // An overlapping frame: only what is new counts, once.
    const more = applyEvents(v, [events[2], ev({ type: 'text', step: 1, text: '!' })]);
    expect(texts(more)).toEqual([[1, 'Hello there!']]);
    expect(more.lastSeq).toBe(4);
    // Any order within a batch; one seq twice counts once.
    const shuffled = view([events[2], events[0], events[1], events[1]]);
    expect(texts(shuffled)).toEqual([[1, 'Hello there']]);
    // A gap in seq is normal.
    expect(texts(applyEvents(more, [ev({ type: 'text', step: 2, text: 'Next' }, 40)]))).toEqual([
      [1, 'Hello there!'],
      [2, 'Next'],
    ]);
  });
});

describe('text', () => {
  it('groups by step where its first text came, and discard removes that step', () => {
    seq = 0;
    let v = view([ev({ type: 'text', step: 1, text: 'One' }), ev({ type: 'tool_call', step: 1, call: 'c1', tool: 'add', title: 'Add', risk: 'edit', source: 'Demo', input_preview: '{}' })]);
    v = applyEvents(v, [ev({ type: 'text', step: 2, text: 'Two' }), ev({ type: 'text', step: 2, text: ' more' })]);
    expect(kinds(v)).toEqual(['text', 'tool', 'text']);
    expect(texts(v)).toEqual([
      [1, 'One'],
      [2, 'Two more'],
    ]);
    v = applyEvents(v, [ev({ type: 'discard', step: 2 })]);
    expect(kinds(v)).toEqual(['text', 'tool']);
    // A new text of a discarded step starts its row again.
    v = applyEvents(v, [ev({ type: 'text', step: 2, text: 'Again' })]);
    expect(texts(v)).toEqual([
      [1, 'One'],
      [2, 'Again'],
    ]);
  });

  it('streams the newest step while the model writes', () => {
    seq = 0;
    const v = view([ev({ type: 'state', state: 'model' }), ev({ type: 'text', step: 3, text: 'Hi' })]);
    expect(streamingStep(v)).toBe(3);
    expect(streamingStep(applyEvents(v, [ev({ type: 'state', state: 'tools' })]))).toBeNull();
    expect(finalText(v)).toBe('Hi');
  });

  it("fills the log's dropped text from text_so_far, before the first text it has; the longer wins", () => {
    seq = 0;
    // Step 1's first chunk and all of step 0 were dropped from the log.
    let v = applyEvents(emptyTurnView('t1'), [ev({ type: 'text', step: 1, text: ' world' }, 3000), ev({ type: 'tool_call', step: 1, call: 'c1', tool: 'add', title: 'Add', risk: 'edit', source: 'Demo', input_preview: '{}' }, 3001), ev({ type: 'text', step: 2, text: 'Done.' }, 3002)]);
    v = fillDroppedText(v, 'Earlier step.\n\nHello world\n\nDone.');
    expect(v.items.map((it) => (it.kind === 'earlier_text' || it.kind === 'text' ? it.text : it.kind))).toEqual(['Earlier step.\n\nHello', ' world', 'tool', 'Done.']);
    // A shorter text_so_far, or one that doesn't end with what it has, changes nothing.
    expect(fillDroppedText(v, 'Hello world\n\nDone.')).toBe(v);
    expect(fillDroppedText(v, 'Something else entirely, longer than all of it')).toBe(v);
    // Nothing dropped: nothing filled.
    const whole = view([ev({ type: 'text', step: 1, text: 'All here' })]);
    expect(fillDroppedText(whole, 'All here')).toBe(whole);
    // All text dropped: the whole of it, at the top.
    const none = applyEvents(emptyTurnView('t1'), [ev({ type: 'note', text: 'n' })]);
    expect(fillDroppedText(none, 'Only this').items.map((it) => it.kind)).toEqual(['earlier_text', 'note']);
  });
});

describe('tool steps', () => {
  it('a call, its progress and its result, with the pictures it keeps', () => {
    seq = 0;
    let v = view([ev({ type: 'state', state: 'tools' }), ev({ type: 'tool_call', step: 1, call: 'c1', tool: 'extrude', title: 'Extrude', risk: 'edit', source: 'CAD', input_preview: '{"d":10}' })]);
    expect(currentTool(v)?.title).toBe('Extrude');
    expect(turnPhase(v)).toEqual({ kind: 'working', title: 'Extrude', label: null });
    v = applyEvents(v, [ev({ type: 'tool_progress', call: 'c1', fraction: 0.5, label: 'Meshing' })]);
    expect(turnPhase(v)).toEqual({ kind: 'working', title: 'Extrude', label: 'Meshing' });
    const images = [{ n: '1', media_type: 'image/png', width: 640, height: 480 }];
    v = applyEvents(v, [ev({ type: 'tool_result', call: 'c1', ok: true, summary: 'Extruded 10 mm', ms: 812, images })]);
    const step = v.items[0] as Extract<TurnItem, { kind: 'tool' }>;
    expect(step).toMatchObject({ kind: 'tool', call: 'c1', title: 'Extrude', source: 'CAD', risk: 'edit', input_preview: '{"d":10}', progress: null });
    expect(step.result).toEqual({ ok: true, summary: 'Extruded 10 mm', ms: 812, code: null, hint: null, images, links: [] });
    expect(currentTool(v)).toBeNull();
    // A late progress of a finished call changes nothing.
    const late = applyEvents(v, [ev({ type: 'tool_progress', call: 'c1', fraction: 0.9, label: 'late' })]);
    expect(late.items[0]).toBe(v.items[0]);
    // A failed call: its hint and code.
    v = applyEvents(v, [ev({ type: 'tool_call', step: 2, call: 'c2', tool: 'fillet', title: 'Fillet', risk: 'edit', source: 'CAD', input_preview: '{}' }), ev({ type: 'tool_result', call: 'c2', ok: false, code: 'bad_edge', hint: 'Pick an edge.', summary: 'No such edge', ms: 5 })]);
    expect((v.items[1] as Extract<TurnItem, { kind: 'tool' }>).result).toEqual({ ok: false, summary: 'No such edge', ms: 5, code: 'bad_edge', hint: 'Pick an edge.', images: [], links: [] });
  });

  it("a result's links: only the app's own export files reach the view", () => {
    seq = 0;
    const good = { label: 'Download Run_1.zip', href: '/api/results/export-vtk/job-a1/file?project_id=p1' };
    const v = view([
      ev({ type: 'tool_call', step: 1, call: 'w', tool: 'wait', title: 'Wait for jobs', risk: 'read', source: 'Magnusim', input_preview: '{}' }),
      ev({ type: 'tool_result', call: 'w', ok: true, summary: 'done', ms: 1, links: [good, { label: 'x', href: 'https://example.com/x' }, { label: 'y', href: '/api/assistant/key' }] }),
    ]);
    expect((v.items[0] as Extract<TurnItem, { kind: 'tool' }>).result?.links).toEqual([good]);
    expect(downloadLinks('nope')).toEqual([]);
  });

  it('a call waiting for the person reads as waiting until a progress without it', () => {
    seq = 0;
    let v = view([ev({ type: 'state', state: 'tools' }), ev({ type: 'tool_call', step: 1, call: 'c1', tool: 'extrude', title: 'Extrude', risk: 'edit', source: 'CAD', input_preview: '{}' })]);
    v = applyEvents(v, [ev({ type: 'tool_progress', call: 'c1', fraction: null, label: 'Paused by the person', waiting: true })]);
    expect(turnPhase(v)).toEqual({ kind: 'waiting', label: 'Paused by the person' });
    v = applyEvents(v, [ev({ type: 'tool_progress', call: 'c1', fraction: 0.2, label: 'Building' })]);
    expect(turnPhase(v)).toEqual({ kind: 'working', title: 'Extrude', label: 'Building' });
  });
});

describe('questions in the transcript', () => {
  it('a line when asked and one when closed, never a card; the open ones are listed', () => {
    seq = 0;
    let v = view([ev({ type: 'gate', gate: gate('g1') }), ev({ type: 'state', state: 'awaiting_confirmation' })]);
    expect(kinds(v)).toEqual(['gate']);
    expect(v.openGates).toEqual(['g1']);
    expect(turnPhase(v)).toEqual({ kind: 'answer_below' });
    v = applyEvents(v, [ev({ type: 'gate_closed', gate: 'g1', answer: 'deny', by: 'user' })]);
    expect(kinds(v)).toEqual(['gate', 'gate_closed']);
    expect(v.openGates).toEqual([]);
    const closed = v.items[1] as Extract<TurnItem, { kind: 'gate_closed' }>;
    expect(closed).toMatchObject({ title: 'Reset the counter?', yes: 'Reset', no: "Don't reset", answer: 'deny', by: 'user' });
    expect(gateAsked((v.items[0] as Extract<TurnItem, { kind: 'gate' }>).title)).toBe('Asked: Reset the counter?');
    expect(gateClosedLine(closed.answer, closed.by, closed.yes, closed.no, closed.title)).toBe('You chose “Don\'t reset”: Reset the counter?');
    // The same records replayed: no second line.
    expect(applyEvents(v, [ev({ type: 'gate', gate: gate('g1') }, 1)])).toBe(v);
  });
});

describe('review rounds', () => {
  it('a divider per round, and the footer checks its work while the model runs after one', () => {
    seq = 0;
    let v = view([ev({ type: 'state', state: 'model' }), ev({ type: 'review', round: 1, of: 2 })]);
    expect(v.items).toEqual([{ kind: 'review', key: 'review:2', round: 1, of: 2 }]);
    expect(reviewDivider(1, 2)).toBe('Checking its work · round 1 of 2');
    expect(turnPhase(v)).toEqual({ kind: 'reviewing', round: 1, of: 2 });
    v = applyEvents(v, [ev({ type: 'state', state: 'tools' }), ev({ type: 'tool_call', step: 4, call: 'c9', tool: 'fix', title: 'Fix', risk: 'edit', source: 'CAD', input_preview: '{}' })]);
    expect(turnPhase(v)).toEqual({ kind: 'working', title: 'Fix', label: null });
    v = applyEvents(v, [ev({ type: 'state', state: 'model' }), ev({ type: 'review', round: 2, of: 2 })]);
    expect(turnPhase(v)).toEqual({ kind: 'reviewing', round: 2, of: 2 });
    expect(kinds(v)).toEqual(['review', 'tool', 'review']);
  });
});

describe("a coding agent's events", () => {
  it('its line, its plan replaced in place, its own tools by call, permission lines, mode and model', () => {
    seq = 0;
    let v = view([ev({ type: 'agent', name: 'Helper', version: '1.2', own_tools: 'off' }), ev({ type: 'state', state: 'model' })]);
    expect(v.agent).toEqual({ name: 'Helper', version: '1.2', own_tools: 'off' });
    expect(turnPhase(v)).toEqual({ kind: 'agent_working', name: 'Helper' });
    v = applyEvents(v, [
      ev({ type: 'plan', entries: [{ content: 'Sketch', status: 'pending', priority: 'high' }] }),
      ev({ type: 'agent_tool', call: 'a1', title: 'Read file', kind: 'read', status: 'pending' }),
      ev({ type: 'note', text: 'between' }),
      ev({ type: 'plan', entries: [{ content: 'Sketch', status: 'completed', priority: 'high' }, { content: 'Extrude', status: 'in_progress', priority: 'medium' }] }),
      ev({ type: 'agent_tool', call: 'a1', title: 'Read file', kind: 'read', status: 'completed' }),
      ev({ type: 'agent_tool', call: 'a2', title: 'Run', kind: 'execute', status: 'failed' }),
      ev({ type: 'agent_permission', title: 'Extrude', outcome: 'auto_allowed', by: 'magnusim' }),
      ev({ type: 'agent_mode', mode: 'm', label: 'Ask' }),
      ev({ type: 'agent_model', model: 'x', label: 'Big' }),
    ]);
    expect(kinds(v)).toEqual(['plan', 'agent_tools', 'note', 'agent_permission', 'agent_mode', 'agent_model']);
    expect((v.items[0] as Extract<TurnItem, { kind: 'plan' }>).entries.map((e) => [e.content, e.status])).toEqual([
      ['Sketch', 'completed'],
      ['Extrude', 'in_progress'],
    ]);
    expect((v.items[1] as Extract<TurnItem, { kind: 'agent_tools' }>).tools.map((t) => [t.call, t.status])).toEqual([
      ['a1', 'completed'],
      ['a2', 'failed'],
    ]);
    expect(agentPermissionLine('Extrude', 'auto_allowed', 'magnusim')).toBe('Auto-allowed: Extrude. Magnusim asks you itself when one of its tools needs it.');
    // An agent turn known only from its summary still reads as the agent working.
    const fromSummary = applySummary(emptyTurnView('t1'), { ...summary('model'), agent: { id: 'h', name: 'Helper', version: null } });
    expect(turnPhase(fromSummary)).toEqual({ kind: 'agent_working', name: 'Helper' });
  });
});

describe('ends', () => {
  it('every end state: its label, its body and the phase', () => {
    for (const [state, label] of [
      ['done', null],
      ['stopped', 'Stopped'],
      ['capped', 'Limit reached'],
      ['failed', "Didn't finish"],
    ] as const) {
      seq = 0;
      const v = view([ev({ type: 'state', state: 'model' }), ev({ type: 'gate', gate: gate('g1') }), ev({ type: 'end', state, reason: state, message: 'Words.' })]);
      expect(isEnded(v)).toBe(true);
      expect(v.end).toEqual({ state, reason: state, message: 'Words.' });
      expect(v.openGates).toEqual([]);
      expect(turnPhase(v)).toEqual({ kind: 'ended', state });
      expect(endLabel(state)).toBe(label);
    }
    expect(endBody('capped', 'The step limit (120) is reached.')).toBe('The step limit (120) is reached. Send another message to carry on.');
    expect(endBody('stopped', 'Nothing was sent.')).toBe('Nothing was sent.');
    // A record the server no longer has.
    const gone = markGone(emptyTurnView('t1'));
    expect(gone.gone).toBe(true);
    expect(isEnded(gone)).toBe(true);
  });

  it('Stop sent: stopping, then still stopping after the route’s bound, until the end', () => {
    seq = 0;
    const v = view([ev({ type: 'state', state: 'tools' })]);
    expect(turnPhase(v, { sentAt: 1000, now: 1000 + STILL_STOPPING_MS - 1 })).toEqual({ kind: 'stopping', still: false });
    expect(turnPhase(v, { sentAt: 1000, now: 1000 + STILL_STOPPING_MS })).toEqual({ kind: 'stopping', still: true });
    const ended = applyEvents(v, [ev({ type: 'end', state: 'stopped', reason: 'user', message: 'Stopped.' })]);
    expect(turnPhase(ended, { sentAt: 1000, now: 1000 + STILL_STOPPING_MS })).toEqual({ kind: 'ended', state: 'stopped' });
  });
});

describe('summaries', () => {
  it("keep the person's text and pictures; the log's state wins over a summary's, except an end", () => {
    seq = 0;
    const pics = [{ n: 'p1', media_type: 'image/png', width: 100, height: 80 }];
    let v = applySummary(emptyTurnView('t1'), { ...summary('model'), prompt: 'Make a box', prompt_images: pics, text_so_far: 'x' });
    expect(v.prompt).toBe('Make a box');
    expect(v.promptImages).toEqual(pics);
    expect(v.state).toBe('model');
    expect(v.summary).not.toHaveProperty('text_so_far');
    v = applyEvents(v, [ev({ type: 'state', state: 'tools' })]);
    // A summary frame without the prompt keeps it; a stale state doesn't move the log's.
    v = applySummary(v, summary('model'));
    expect(v.prompt).toBe('Make a box');
    expect(v.state).toBe('tools');
    v = applySummary(v, summary('done'));
    expect(isEnded(v)).toBe(true);
    // Another turn's summary changes nothing; nor does the same one again.
    expect(applySummary(v, { ...summary('failed'), id: 't2' })).toBe(v);
    expect(applySummary(v, summary('done'))).toBe(v);
  });
});

describe('ui_sync (phase 5, C2)', () => {
  const toolCall = (id: string) => ev({ type: 'tool_call', step: 1, call: id, tool: 'setup_edit', title: 'Change the setup', risk: 'edit', source: 'Magnusim', input_preview: '{}' });
  it("merges a call's syncs on its row (kinds, ids and names once each), and a later tool_call keeps them", () => {
    const c = toolCall('c1');
    let v = view([c]);
    v = applyEvents(v, [ev({ type: 'ui_sync', call: 'c1', project_id: 'p1', kinds: ['bcs'], ids: { bc: ['bc-7'] }, names: { 'bc-7': 'Inlet' } })]);
    v = applyEvents(v, [ev({ type: 'ui_sync', call: 'c1', project_id: 'p1', kinds: ['bcs', 'mesh'], ids: { bc: ['bc-7', 'bc-8'], mesh: ['m1'] }, names: { 'bc-8': 'Outlet' } })]);
    const row = v.items.find((it) => it.kind === 'tool') as Extract<TurnItem, { kind: 'tool' }>;
    expect(row.updated).toEqual({ kinds: ['bcs', 'mesh'], ids: { bc: ['bc-7', 'bc-8'], mesh: ['m1'] }, names: { 'bc-7': 'Inlet', 'bc-8': 'Outlet' } });
    // The same call event again (a replay with a new seq) keeps what the row has.
    v = applyEvents(v, [{ ...c, seq: 999 }]);
    expect((v.items.find((it) => it.kind === 'tool') as Extract<TurnItem, { kind: 'tool' }>).updated?.kinds).toEqual(['bcs', 'mesh']);
  });

  it("a sync of a call the view never saw is a row of its own; a replay changes nothing", () => {
    const s = ev({ type: 'ui_sync', project_id: 'p1', kinds: ['runs'], ids: { run: ['r1'] } });
    const v = view([s]);
    expect(kinds(v)).toEqual(['updated']);
    expect(applyEvents(v, [s])).toBe(v);
  });
});

