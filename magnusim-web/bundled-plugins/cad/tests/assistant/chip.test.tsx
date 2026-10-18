// The Assistant's chip in the dock and `.cad-app[data-assistant]` (CAD tools spec §8.3, the T1
// skeleton): what it says in each phase ("Assistant · thinking · 3 of 120 steps", "Assistant · Read
// the Part · ...", "Assistant: <request> · done"), `data-assistant-state`, nothing while off or
// idle, and the phase hook that the frame's attribute reads ('off' without the Assistant module).
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantChip, chipText } from '../../src/assistant/AssistantChip';
import { createAssistantStore, useAssistantPhase } from '../../src/assistant/state';
import { ServicesProvider, useServices } from '../../src/lib/services';
import { createStateStore } from '../../src/lib/store';
import type { AppServices, AreaApis } from '../../src/types/app';
import type { AssistantUiState } from '../../src/types/assistant';

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
  });
});

function servicesWith(state: ReturnType<typeof createAssistantStore> | null): AppServices {
  const apis = createStateStore<AreaApis>({ sketch: null, solver: null, files: null, ...(state ? { assistant: { autoCamera: () => true, state } } : {}) });
  return { apis } as unknown as AppServices;
}

function Phase() {
  return <span data-phase={useAssistantPhase(useServices())} />;
}
let current: AppServices | null = null;

describe('the chip in the dock', () => {
  it('shows the phase as data-assistant-state, and nothing while idle', () => {
    const store = createAssistantStore();
    current = servicesWith(store);
    const view = render(
      <ServicesProvider services={current}>
        <AssistantChip />
        <Phase />
      </ServicesProvider>,
    );
    const chip = () => view.container.querySelector('[data-chip="assistant"]');
    const phase = () => view.container.querySelector('[data-phase]')!.getAttribute('data-phase');
    expect(chip()).toBeNull();
    expect(phase()).toBe('off');
    act(() => store.set({ ...base, phase: 'thinking', turn: turn() }));
    expect(chip()?.getAttribute('data-assistant-state')).toBe('thinking');
    expect(chip()?.textContent).toBe('Assistant · thinking · 3 of 120 steps');
    expect(chip()?.getAttribute('aria-busy')).toBe('true');
    expect(phase()).toBe('thinking');
    act(() => store.set({ phase: 'ended', turn: turn('done') }));
    expect(chip()?.getAttribute('data-assistant-state')).toBe('ended');
    expect(chip()?.textContent).toBe('Assistant: Plate with four holes · done');
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
});
