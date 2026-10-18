// The Assistant's chip in the dock and `.cad-app[data-assistant]` (CAD tools spec §8.3): what it
// says in each phase ("Assistant · thinking · 3 of 120 steps", "Assistant · Read the Part · ...",
// "Assistant: <request> · done") in `[data-assistant-text]`, `data-assistant-state`, nothing while
// off or idle, and the phase hook that the frame's attribute reads ('off' without the Assistant
// module). Watch mode: each phase's buttons (Pause, Stop only with the host's turn events, Fast or
// Watch, Ask each step pressed or not, Keep and Discard, Resume, Undo only while the turn's group
// is the newest step), each running its action; an ended turn's health (ok, warn, error; amber or
// red) with the words, and a click on them selects the first such tree row.
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantChip, chipButtons, chipText } from '../../src/assistant/AssistantChip';
import { healthOf } from '../../src/assistant/health';
import { createAssistantStore, useAssistantPhase } from '../../src/assistant/state';
import { createSelectionStore } from '../../src/lib/selection';
import { ServicesProvider, useServices } from '../../src/lib/services';
import { createStateStore } from '../../src/lib/store';
import type { AppServices, AreaApis } from '../../src/types/app';
import type { AssistantActions, AssistantUiState } from '../../src/types/assistant';
import type { DocState } from '../../src/types/doc-service';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(cleanup);

const base: AssistantUiState = { phase: 'idle', registration: 'on', reason: null, turn: null, call: null, note: null };
const turn = (end: 'done' | 'stopped' | 'failed' | 'capped' | 'ended' | null = null) => ({ id: 't-1', title: 'Plate with four holes', steps: 3, stepsCap: 120, end });

describe('chipText', () => {
  it('says what the Assistant does in each phase', () => {
    expect(chipText(base)).toBeNull();
    expect(chipText({ ...base, phase: 'off', registration: 'off' })).toBeNull();
    expect(chipText({ ...base, phase: 'thinking', turn: turn() })).toBe('Assistant · thinking · 3 of 120 steps');
    expect(chipText({ ...base, phase: 'thinking' })).toBe('Assistant · thinking');
    expect(chipText({ ...base, phase: 'working', turn: turn(), call: { tool: 'get_model', label: 'Read the Part' } })).toBe('Assistant · Read the Part · 3 of 120 steps');
    expect(chipText({ ...base, phase: 'ended', turn: turn('done') })).toBe('Assistant: Plate with four holes · done');
    expect(chipText({ ...base, phase: 'ended', turn: turn('capped') })).toBe('Assistant: Plate with four holes · stopped at its limits');
    expect(chipText({ ...base, phase: 'ended', turn: turn('ended') })).toBe('Assistant: Plate with four holes · ended');
    expect(chipText({ ...base, phase: 'waiting', note: 'close the Fillet 2 panel' })).toBe('Assistant waits for you: close the Fillet 2 panel');
    expect(chipText({ ...base, phase: 'approve', call: { tool: 'extrude', label: 'Extrude Boss' } })).toBe('Assistant: Extrude Boss · keep it?');
    expect(chipText({ ...base, phase: 'paused', note: 'you took over' })).toBe('Assistant paused · you took over');
  });
});

describe('chipButtons', () => {
  it("gives each phase its buttons; Stop only with the host's turn events; Undo only while the group is the newest", () => {
    const ids = (s: Partial<AssistantUiState>, undo = false) => chipButtons({ ...base, ...s }, undo).map((b) => b.id);
    expect(ids({ phase: 'thinking', canStop: true })).toEqual(['pause', 'stop', 'ask']);
    expect(ids({ phase: 'thinking' })).toEqual(['pause', 'ask']);
    expect(ids({ phase: 'working', canStop: true })).toEqual(['pause', 'stop', 'pace', 'ask']);
    expect(ids({ phase: 'waiting', canStop: true })).toEqual(['pause', 'stop']);
    expect(ids({ phase: 'approve', canStop: true })).toEqual(['keep', 'discard']);
    expect(ids({ phase: 'paused', canStop: true })).toEqual(['resume', 'stop']);
    expect(ids({ phase: 'ended', turn: turn('done') }, true)).toEqual(['undo']);
    expect(ids({ phase: 'ended', turn: turn('done') }, false)).toEqual([]);
    expect(ids({ phase: 'idle' })).toEqual([]);
    // Fast at the watch pace, Watch at the fast pace; Ask each step says whether it is on.
    const pace = (p: 'watch' | 'fast') => chipButtons({ ...base, phase: 'working', pace: p }, false).find((b) => b.id === 'pace')!.label;
    expect([pace('watch'), pace('fast')]).toEqual(['Fast', 'Watch']);
    const ask = (on: boolean) => chipButtons({ ...base, phase: 'thinking', askEach: on }, false).find((b) => b.id === 'ask')!.pressed;
    expect([ask(false), ask(true)]).toEqual([false, true]);
  });
});

/** A doc state with these features as built (state per name), sketches with their solved state. */
function docState(rows: { name: string; type?: string; state: string; under?: boolean; suppressed?: boolean }[], status: 'done' | 'failed' = 'done'): DocState {
  const features = rows.map((r, i) => ({ id: `f${i + 1}`, name: r.name, type: r.type ?? 'extrude', ...(r.suppressed ? { suppressed: true } : {}), ...(r.type === 'sketch' ? { solved: { values: {}, dof: r.under ? 2 : 0, state: r.under ? 'under' : 'fully' } } : {}) }));
  return {
    status: 'ready',
    doc: { features, params: [], bodies: {} },
    rebuild: { status, features: Object.fromEntries(rows.map((r, i) => [`f${i + 1}`, { state: r.state }])), bodies: [], outputs: {}, seq: 1 },
  } as unknown as DocState;
}

describe("the Part's health", () => {
  it('names one failing feature, counts several, and the under-defined sketches and warnings; the first row to show', () => {
    expect(healthOf(docState([{ name: 'Sketch 1', type: 'sketch', state: 'ok' }]))).toEqual({ health: 'ok', words: [], first: null });
    expect(healthOf(docState([{ name: 'Base', state: 'ok' }, { name: 'Fillet 1', state: 'error' }]))).toEqual({ health: 'error', words: ['Fillet 1 fails'], first: 'f2' });
    expect(healthOf(docState([{ name: 'A', state: 'error' }, { name: 'B', state: 'error' }, { name: 'S', type: 'sketch', state: 'ok', under: true }]))).toEqual({ health: 'error', words: ['2 features fail', '1 sketch under-defined'], first: 'f1' });
    expect(healthOf(docState([{ name: 'S', type: 'sketch', state: 'ok', under: true }, { name: 'T', type: 'sketch', state: 'ok', under: true }, { name: 'C', state: 'warning' }]))).toEqual({ health: 'warn', words: ['2 sketches under-defined', '1 feature with a warning'], first: 'f1' });
    // A suppressed or rolled-back sketch is not counted; a failed rebuild is an error.
    expect(healthOf(docState([{ name: 'S', type: 'sketch', state: 'suppressed', under: true, suppressed: true }, { name: 'T', type: 'sketch', state: 'rolled-back', under: true }]))).toEqual({ health: 'ok', words: [], first: null });
    expect(healthOf(docState([{ name: 'Base', state: 'ok' }], 'failed')).health).toBe('error');
  });
});

function servicesWith(state: ReturnType<typeof createAssistantStore> | null, o: { actions?: AssistantActions; doc?: ReturnType<typeof createStateStore<DocState>>; top?: () => { tag: string } | null } = {}): AppServices {
  const apis = createStateStore<AreaApis>({ sketch: null, solver: null, files: null, ...(state ? { assistant: { autoCamera: () => true, state, ...(o.actions ? { actions: o.actions } : {}) } } : {}) });
  const doc = o.doc ? { state: o.doc, assistant: { topGroup: o.top ?? (() => null) } } : undefined;
  return { apis, selection: createSelectionStore(), ...(doc ? { doc } : {}) } as unknown as AppServices;
}

function Phase() {
  return <span data-phase={useAssistantPhase(useServices())} />;
}
let current: AppServices | null = null;

function actionsSpy(): AssistantActions & Record<string, ReturnType<typeof vi.fn>> {
  return { pause: vi.fn(), resume: vi.fn(), stop: vi.fn(), keep: vi.fn(), discard: vi.fn(), undo: vi.fn(), setPace: vi.fn(), setAskEach: vi.fn() } as never;
}

describe('the chip in the dock', () => {
  it('shows the phase as data-assistant-state, its words in data-assistant-text, and nothing while idle', () => {
    const store = createAssistantStore();
    current = servicesWith(store);
    const view = render(
      <ServicesProvider services={current}>
        <AssistantChip />
        <Phase />
      </ServicesProvider>,
    );
    const chip = () => view.container.querySelector('[data-chip="assistant"]');
    const words = () => chip()?.querySelector('[data-assistant-text]')?.textContent;
    const phase = () => view.container.querySelector('[data-phase]')!.getAttribute('data-phase');
    expect(chip()).toBeNull();
    expect(phase()).toBe('off');
    act(() => store.set({ ...base, phase: 'thinking', turn: turn() }));
    expect(chip()?.getAttribute('data-assistant-state')).toBe('thinking');
    expect(words()).toBe('Assistant · thinking · 3 of 120 steps');
    expect(chip()?.getAttribute('aria-busy')).toBe('true');
    expect(phase()).toBe('thinking');
    act(() => store.set({ phase: 'ended', turn: turn('done') }));
    expect(chip()?.getAttribute('data-assistant-state')).toBe('ended');
    expect(words()).toBe('Assistant: Plate with four holes · done');
    expect(chip()?.getAttribute('aria-busy')).toBeNull();
    act(() => store.set({ phase: 'idle', turn: null }));
    expect(chip()).toBeNull();
    expect(phase()).toBe('idle');
  });

  it("without the Assistant module the frame's phase is off and no chip shows", () => {
    current = servicesWith(null);
    const view = render(
      <ServicesProvider services={current}>
        <AssistantChip />
        <Phase />
      </ServicesProvider>,
    );
    expect(view.container.querySelector('[data-chip="assistant"]')).toBeNull();
    expect(view.container.querySelector('[data-phase]')!.getAttribute('data-phase')).toBe('off');
  });

  it('each button runs its action: Pause, Stop, Fast, Ask each step; Keep and Discard; Resume', () => {
    const store = createAssistantStore();
    const actions = actionsSpy();
    current = servicesWith(store, { actions });
    const view = render(
      <ServicesProvider services={current}>
        <AssistantChip />
      </ServicesProvider>,
    );
    const click = (id: string) => fireEvent.click(view.container.querySelector(`[data-assistant-action="${id}"]`)!);
    const labels = () => [...view.container.querySelectorAll('[data-assistant-action]')].map((b) => b.textContent);
    act(() => store.set({ ...base, phase: 'working', turn: turn(), call: { tool: 'sketch', label: 'Sketch Plate sketch' }, pace: 'watch', askEach: false, canStop: true }));
    expect(labels()).toEqual(['Pause', 'Stop', 'Fast', 'Ask each step']);
    click('pause');
    click('stop');
    click('pace');
    click('ask');
    expect(actions.pause).toHaveBeenCalledTimes(1);
    expect(actions.stop).toHaveBeenCalledTimes(1);
    expect(actions.setPace).toHaveBeenCalledWith('fast');
    expect(actions.setAskEach).toHaveBeenCalledWith(true);
    // On: pressed, with its check mark; at the fast pace the toggle says Watch.
    act(() => store.set({ pace: 'fast', askEach: true }));
    expect(labels()).toEqual(['Pause', 'Stop', 'Watch', 'Ask each step ✓']);
    expect(view.container.querySelector('[data-assistant-action="ask"]')!.getAttribute('aria-pressed')).toBe('true');
    click('pace');
    click('ask');
    expect(actions.setPace).toHaveBeenLastCalledWith('watch');
    expect(actions.setAskEach).toHaveBeenLastCalledWith(false);
    act(() => store.set({ phase: 'approve' }));
    expect(view.container.querySelector('[data-assistant-text]')!.textContent).toBe('Assistant: Sketch Plate sketch · keep it?');
    click('keep');
    click('discard');
    expect(actions.keep).toHaveBeenCalledTimes(1);
    expect(actions.discard).toHaveBeenCalledTimes(1);
    act(() => store.set({ phase: 'paused', note: 'you took over' }));
    expect(labels()).toEqual(['Resume', 'Stop']);
    click('resume');
    expect(actions.resume).toHaveBeenCalledTimes(1);
  });

  it("an ended turn shows the Part's health, amber or red, and a click on it selects the first such tree row; Undo while the group is the newest", () => {
    const store = createAssistantStore();
    const actions = actionsSpy();
    const doc = createStateStore<DocState>(docState([{ name: 'Base', state: 'ok' }, { name: 'Fillet 1', state: 'error' }]));
    let top: { tag: string } | null = { tag: 'turn:t-1' };
    current = servicesWith(store, { actions, doc, top: () => top });
    const view = render(
      <ServicesProvider services={current}>
        <AssistantChip />
      </ServicesProvider>,
    );
    const chip = () => view.container.querySelector('[data-chip="assistant"]')!;
    act(() => store.set({ ...base, phase: 'ended', turn: turn('done') }));
    expect(chip().getAttribute('data-assistant-health')).toBe('error');
    expect(chip().classList.contains('is-error')).toBe(true);
    expect(chip().querySelector('[data-assistant-health-text]')!.textContent).toBe('· Fillet 1 fails');
    fireEvent.click(chip().querySelector('[data-assistant-health-text]')!);
    expect(current.selection.get().items).toEqual([{ kind: 'feature', feature: 'f2' }]);
    fireEvent.click(chip().querySelector('[data-assistant-action="undo"]')!);
    expect(actions.undo).toHaveBeenCalledTimes(1);
    // A sketch left under-defined: amber, no error.
    act(() => doc.set(docState([{ name: 'Plate sketch', type: 'sketch', state: 'ok', under: true }])));
    expect(chip().getAttribute('data-assistant-health')).toBe('warn');
    expect(chip().classList.contains('is-warning')).toBe(true);
    expect(chip().querySelector('[data-assistant-health-text]')!.textContent).toBe('· 1 sketch under-defined');
    // All well: ok, no words; another group on top: no Undo.
    top = { tag: 'turn:t-0' };
    act(() => doc.set(docState([{ name: 'Plate sketch', type: 'sketch', state: 'ok' }])));
    expect(chip().getAttribute('data-assistant-health')).toBe('ok');
    expect(chip().querySelector('[data-assistant-health-text]')).toBeNull();
    expect(chip().querySelector('[data-assistant-action="undo"]')).toBeNull();
    // Not ended: no health at all.
    act(() => store.set({ phase: 'thinking', turn: turn() }));
    expect(chip().getAttribute('data-assistant-health')).toBeNull();
  });
});
