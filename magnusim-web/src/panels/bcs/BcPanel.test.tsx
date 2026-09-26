import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BcState } from '../legacyBridge';
import { BcPanel, bcCardSub, bcKind, convertFlowValue, perFaceHint, velocityUnits } from './BcPanel';

const workerRpc = vi.fn(async (_method: string, _params?: unknown) => ({ menu: [] as unknown[] }));
vi.mock('../../api/workerRpc', () => ({
  workerRpc: (method: string, params?: unknown) => workerRpc(method, params),
}));

function bcState(partial: Partial<BcState> = {}): BcState {
  return {
    simulation_id: 's1',
    bcs: [
      { id: 'bc1', name: 'Pressure 1', bc_type: 'Pressure', faces: ['face 10@Body1'], value: 0, unit: 'Pa' },
      { id: 'bc2', name: 'Pressure 2', bc_type: 'Pressure', faces: ['face 13@Body1'], value: -15000, unit: 'Pa' },
    ],
    active_id: null,
    draft_faces: [],
    focus_face: null,
    defaults: { wall_type: 'No-slip' },
    defaults_summary: 'Unassigned faces: no-slip walls',
    pending_faces: [],
    imperial: false,
    ...partial,
  };
}

function publish(partial: Partial<BcState>) {
  const detail = bcState(partial);
  window.__CFD_BCS__ = detail;
  act(() => {
    window.dispatchEvent(new CustomEvent('cfd:bcs', { detail }));
  });
}

beforeEach(() => {
  workerRpc.mockClear();
  window.__CFD_BCS__ = bcState();
  window.__CFD_OPEN_BC__ = vi.fn(() => true);
  window.__CFD_BC_OPEN_PICKER__ = vi.fn();
  window.__CFD_BC_OPEN_DEFAULTS__ = vi.fn();
  window.__CFD_BC_CREATE__ = vi.fn(async () => ({}));
  window.__CFD_BC_UPDATE__ = vi.fn(async () => ({}));
  window.__CFD_BC_DELETE__ = vi.fn(async () => ({}));
  window.__CFD_BC_UNASSIGN_FACE__ = vi.fn();
  window.__CFD_BC_FOCUS_FACE__ = vi.fn();
  window.__CFD_BC_CLEAR_FACES__ = vi.fn(async () => ({}));
});

afterEach(() => {
  cleanup();
  delete window.__CFD_BCS__;
});

describe('helpers', () => {
  it('labels cards the way V0.1.0 did', () => {
    expect(bcCardSub({ id: 'a', name: 'P', bc_type: 'Pressure', faces: ['face 10@Body1'] })).toBe(
      'Pressure · face 10@Body1',
    );
    expect(bcCardSub({ id: 'a', name: 'W', bc_type: 'Wall', faces: [], wall_type: 'slip' })).toBe(
      'Wall · Slip · no faces',
    );
  });

  it('groups types into the legend colors', () => {
    expect(bcKind({ bc_type: 'Velocity inlet' })).toBe('inlet');
    expect(bcKind({ bc_type: 'Velocity outlet' })).toBe('outlet');
    expect(bcKind({ bc_type: 'Pressure' })).toBe('pressure');
    expect(bcKind({ bc_type: 'Wall' })).toBe('wall');
  });

  it('offers the units that match the velocity mode', () => {
    expect(velocityUnits('Fixed')).toEqual(['m/s', 'ft/s', 'ft/min']);
    expect(velocityUnits('Flow rate', 'Volumetric flow')).toEqual(['m³/s', 'ft³/min']);
    expect(velocityUnits('Flow rate', 'Mass flow')).toEqual(['kg/s', 'lb/s']);
  });

  it('spells out the per-face total', () => {
    expect(perFaceHint(3, 5, 'm/s')).toBe('Each face gets this value on its own. 3 faces × 5 m/s = 15 m/s total.');
    expect(perFaceHint(1, 5, 'm/s')).toMatch(/Two faces at 5 means 10 total/);
  });
});

describe('hub', () => {
  it('lists cards, opens the editor on click, deletes, and opens the picker', () => {
    render(<BcPanel panelId="panel-bcs-hub" />);
    expect(screen.getByText('Pressure 2')).toBeInTheDocument();
    expect(screen.getByText('Pressure · face 13@Body1')).toBeInTheDocument();
    expect(screen.getByText('Unassigned faces: no-slip walls')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Pressure 2'));
    expect(window.__CFD_OPEN_BC__).toHaveBeenCalledWith('bc2');
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    expect(window.__CFD_BC_DELETE__).toHaveBeenCalledWith('bc1');
    fireEvent.click(screen.getByRole('button', { name: 'Add boundary condition' }));
    expect(window.__CFD_BC_OPEN_PICKER__).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Defaults'));
    expect(window.__CFD_BC_OPEN_DEFAULTS__).toHaveBeenCalled();
  });

  it('follows runtime updates', () => {
    render(<BcPanel panelId="panel-bcs-hub" />);
    publish({ bcs: [] });
    expect(screen.getByText('No boundary conditions yet')).toBeInTheDocument();
  });
});

describe('picker', () => {
  it('never creates on a type click; Add creates the selected type', async () => {
    render(<BcPanel panelId="panel-bc-picker" />);
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toBeDisabled();
    fireEvent.click(screen.getByText('Pressure'));
    expect(window.__CFD_BC_CREATE__).not.toHaveBeenCalled();
    expect(screen.getByText('Pressure').closest('button')).toHaveClass('is-selected');
    expect(add).toBeEnabled();
    await act(async () => {
      fireEvent.click(add);
    });
    expect(window.__CFD_BC_CREATE__).toHaveBeenCalledWith('Pressure');
  });

  it('shows the faces picked in the viewport', () => {
    render(<BcPanel panelId="panel-bc-picker" />);
    publish({ pending_faces: ['face 15@Body1'] });
    expect(screen.getByText('Selected: face 15@Body1')).toBeInTheDocument();
  });
});

describe('editor', () => {
  it('shows the saved value, not a schema default, and saves edits through the bridge', () => {
    publish({ active_id: 'bc2', draft_faces: ['face 13@Body1'] });
    const { container } = render(<BcPanel panelId="panel-bc-editor" />);
    expect(container.querySelector('[data-bc-title]')?.textContent).toBe('Pressure 2');
    const value = screen.getByLabelText('Fixed value') as HTMLInputElement;
    expect(value.value).toBe('-15000');
    fireEvent.change(value, { target: { value: '-14000' } });
    fireEvent.blur(value);
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('bc2', { value: -14000, unit: 'Pa' });
    fireEvent.change(screen.getByLabelText('Fixed value unit'), { target: { value: 'kPa' } });
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('bc2', { unit: 'kPa' });
    fireEvent.change(screen.getByLabelText('Boundary condition type'), { target: { value: 'Wall' } });
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('bc2', { bc_type: 'Wall' });
  });

  it('lists assigned faces with remove, focus and clear', () => {
    publish({ active_id: 'bc2', draft_faces: ['face 13@Body1', 'face 15@Body1'], focus_face: 'face 15@Body1' });
    const { container } = render(<BcPanel panelId="panel-bc-editor" />);
    const items = container.querySelectorAll('[data-face-picker="1"] [data-face-id]');
    expect([...items].map((n) => n.getAttribute('data-face-id'))).toEqual(['face 13@Body1', 'face 15@Body1']);
    expect(items[1]).toHaveClass('is-focus');
    expect(screen.getByText('Assigned faces (2)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove face 13@Body1' }));
    expect(window.__CFD_BC_UNASSIGN_FACE__).toHaveBeenCalledWith('face 13@Body1');
    fireEvent.click(screen.getByRole('button', { name: 'face 15@Body1' }));
    expect(window.__CFD_BC_FOCUS_FACE__).toHaveBeenCalledWith('face 15@Body1');
    fireEvent.click(screen.getByRole('button', { name: 'Clear list' }));
    expect(window.__CFD_BC_CLEAR_FACES__).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(window.__CFD_BC_DELETE__).toHaveBeenCalledWith('bc2');
  });

  it('shows velocity fields and the vector row only when chosen', () => {
    publish({
      active_id: 'v1',
      draft_faces: ['face 1@Body1', 'face 2@Body1'],
      bcs: [
        {
          id: 'v1',
          name: 'Velocity inlet 1',
          bc_type: 'Velocity inlet',
          faces: ['face 1@Body1', 'face 2@Body1'],
          velocity_type: 'Fixed',
          value: 5,
          unit: 'm/s',
          direction: 'Vector',
          vector: [0, 0, 1],
        },
      ],
    });
    render(<BcPanel panelId="panel-bc-editor" />);
    expect((screen.getByLabelText('Velocity') as HTMLInputElement).value).toBe('5');
    expect(screen.getByLabelText('Z')).toBeInTheDocument();
    expect(screen.getByText('Each face gets this value on its own. 2 faces × 5 m/s = 10 m/s total.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Velocity type'), { target: { value: 'Flow rate' } });
    // 5 m/s is converted to the same flow, not reused as 5 m³/s (no face area here → 0.01 m² fallback).
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('v1', {
      velocity_type: 'Flow rate',
      flow_rate_type: 'Volumetric flow',
      value: 0.05,
      unit: 'm³/s',
    });
  });

  it('converts between velocity, volumetric flow and mass flow per face', () => {
    const basis = { face_area_m2: 0.002, density: 1.2 };
    const q = convertFlowValue(10, { velocityType: 'Fixed', unit: 'm/s' }, { velocityType: 'Flow rate', flowRateType: 'Volumetric flow', unit: 'm³/s' }, basis);
    expect(q).toBeCloseTo(0.02, 10);
    const m = convertFlowValue(q, { velocityType: 'Flow rate', flowRateType: 'Volumetric flow', unit: 'm³/s' }, { velocityType: 'Flow rate', flowRateType: 'Mass flow', unit: 'kg/s' }, basis);
    expect(m).toBeCloseTo(0.024, 10);
    const v = convertFlowValue(m, { velocityType: 'Flow rate', flowRateType: 'Mass flow', unit: 'kg/s' }, { velocityType: 'Fixed', unit: 'ft/s' }, basis);
    expect(v).toBeCloseTo(10 / 0.3048, 3);
  });

  it('says so when no BC is open', () => {
    publish({ active_id: null });
    render(<BcPanel panelId="panel-bc-editor" />);
    expect(screen.getByText('Open a boundary condition from the tree or the overview.')).toBeInTheDocument();
  });
});
