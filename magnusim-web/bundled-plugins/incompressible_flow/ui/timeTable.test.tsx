import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import committed from '../../../scripts/generated/registry.json';
import type { BcFamilyRow, RegistryDescribe } from '../../../src/api/registry.gen';
import type { BcState } from '../../../src/panels/legacyBridge';
import { BcPanel } from '../../../src/panels/bcs/BcPanel';
import { unregisterPlugin } from '../../../src/plugin-api';
import { pluginHost } from '../../../src/plugins/loader';
import { useProjectStore } from '../../../src/store/project';
import { register } from './index';
import {
  afterLast,
  nextRow,
  parseTableText,
  shownRows,
  studyIsTransient,
  tableProblem,
  tableRows,
  variesWithTime,
} from './timeTable';

// "Varies with time" on a velocity inlet, a pressure and a total-pressure inlet
// of a transient study: a table of (time, value) rows the BC panel edits.
const FAMILIES = (committed as unknown as RegistryDescribe).bc_family as BcFamilyRow[];
const TRANSIENT = { id: 's1', time_dependency: 'Transient', analysis_type: 'incompressible_transient' };
const STEADY = { id: 's1', time_dependency: 'Steady-state', analysis_type: 'incompressible_steady' };

const INLET = { id: 'v1', name: 'Velocity inlet 1', bc_type: 'Velocity inlet', faces: ['face 1@Body1'], velocity_type: 'Fixed', value: 5, unit: 'm/s' };

function publish(partial: Partial<BcState>) {
  const detail: BcState = {
    simulation_id: 's1',
    bcs: [],
    active_id: null,
    draft_faces: [],
    focus_face: null,
    defaults: { wall_type: 'No-slip' },
    defaults_summary: 'Unassigned faces: no-slip walls',
    pending_faces: [],
    imperial: false,
    analysis_key: 'incompressible_transient',
    ...partial,
  };
  window.__CFD_BCS__ = detail;
  act(() => {
    window.dispatchEvent(new CustomEvent('cfd:bcs', { detail }));
  });
}

beforeEach(() => {
  useProjectStore.setState({
    projectId: 'proj',
    registry: {
      analysis: [{ key: 'incompressible_transient', label: 'Incompressible', bc_types: FAMILIES.flatMap((f) => f.variants) }],
      bc_family: FAMILIES,
      default_analysis: { transient: 'incompressible_transient' },
    } as RegistryDescribe,
  });
  window.__CFD_BC_UPDATE__ = vi.fn(async () => ({}));
  window.__CFD_BC_DELETE__ = vi.fn(async () => ({}));
  window.__CFD_PLUGINS_READY__ = true;
  register(pluginHost('p:proj', 'incompressible_flow'));
});

afterEach(() => {
  cleanup();
  unregisterPlugin('incompressible_flow');
  delete window.__CFD_BCS__;
  delete window.__CFD_PLUGINS_READY__;
  delete window.__CFD_BC_FLOW_BASIS__;
});

describe('helpers', () => {
  it('reads the study and the record the way the plugin does', () => {
    expect(studyIsTransient(TRANSIENT)).toBe(true);
    expect(studyIsTransient(STEADY)).toBe(false);
    expect(studyIsTransient({ analysis_type: 'incompressible_transient' })).toBe(true);
    expect(studyIsTransient(null)).toBe(false);
    expect(variesWithTime({ time_varying: true })).toBe(true);
    expect(variesWithTime({ time_varying: 'true' })).toBe(true);
    expect(variesWithTime({})).toBe(false);
    expect(afterLast('repeat')).toBe('Repeat');
    expect(afterLast(undefined)).toBe('Hold');
    expect(tableRows([[0, '1'], ['', 2], 'x', { t: 3, value: 4 }])).toEqual([[0, 1], [null, 2], [null, null], [3, 4]]);
  });

  it('refuses what the run would refuse, in the same words', () => {
    expect(tableProblem([[0, 1]])).toBe('The table needs at least 2 rows (time, value).');
    expect(tableProblem([[0, 1], [null, 2]])).toBe('Row 2 has no time.');
    expect(tableProblem([[0, 1], [1, null]])).toBe('Row 2 has no value.');
    expect(tableProblem([[0, 1], [0, 2]])).toBe('The times must increase from row to row (row 2 is at 0 s, not after 0 s).');
    expect(tableProblem([[0, 1], [0.5, 2]])).toBeNull();
  });

  it('adds a row one step after the last, at the last value', () => {
    expect(nextRow([])).toEqual([0, 0]);
    expect(nextRow([[0, 4]])).toEqual([1, 4]);
    expect(nextRow([[0, 4], [0.25, 6]])).toEqual([0.5, 6]);
  });

  it('reads two pasted columns, skipping a header', () => {
    expect(parseTableText('time\tspeed\n0\t1\n0.5\t2.5\r\n1\t3\n')).toEqual([[0, 1], [0.5, 2.5], [1, 3]]);
    expect(parseTableText('0,1\n1;2\n2 3')).toEqual([[0, 1], [1, 2], [2, 3]]);
    expect(parseTableText('12')).toBeNull();
  });

  it('shows the rows in the BC unit, and none typed for another quantity', () => {
    const rec = { time_table: [[0, 1], [1, 2]], time_table_unit: 'm/s', unit: 'ft/s' };
    expect(shownRows(rec, 'velocity', 'ft/s')).toEqual([[0, 3.280839895], [1, 6.56167979]]);
    expect(shownRows({ ...rec, time_table_unit: 'm/s' }, 'pressure', 'Pa')).toEqual([]);
  });
});

describe('the BC panel', () => {
  it('offers Varies with time on a transient study and starts a table at the fixed value', () => {
    publish({ active_id: 'v1', bcs: [INLET], study: TRANSIENT });
    render(<BcPanel panelId="panel-bc-editor" />);
    expect((screen.getByLabelText('Velocity') as HTMLInputElement).value).toBe('5');
    fireEvent.click(screen.getByLabelText('Varies with time'));
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('v1', {
      time_varying: true,
      time_table: [
        [0, 5],
        [1, 5],
      ],
      time_table_unit: 'm/s',
    });
  });

  it('does not offer it on a steady study or a velocity outlet', () => {
    publish({ active_id: 'v1', bcs: [{ ...INLET, time_varying: true, time_table: [[0, 1], [1, 2]] }], study: STEADY });
    const { unmount } = render(<BcPanel panelId="panel-bc-editor" />);
    expect(screen.queryByLabelText('Varies with time')).toBeNull();
    // The fixed value is what a steady run solves.
    expect((screen.getByLabelText('Velocity') as HTMLInputElement).value).toBe('5');
    unmount();
    publish({ active_id: 'o1', bcs: [{ ...INLET, id: 'o1', name: 'Velocity outlet 1', bc_type: 'Velocity outlet' }], study: TRANSIENT });
    render(<BcPanel panelId="panel-bc-editor" />);
    expect(screen.queryByLabelText('Varies with time')).toBeNull();
  });

  it('edits, adds, removes and pastes rows, and sets what happens after the last row', () => {
    const rec = { ...INLET, time_varying: true, time_table: [[0, 1], [0.5, 3]], time_table_unit: 'm/s' };
    publish({ active_id: 'v1', bcs: [rec], study: TRANSIENT });
    const { container } = render(<BcPanel panelId="panel-bc-editor" />);
    expect(screen.queryByLabelText('Velocity')).toBeNull();
    expect((screen.getByLabelText('Row 2 time') as HTMLInputElement).value).toBe('0.5');
    expect((screen.getByLabelText('Row 2 value') as HTMLInputElement).value).toBe('3');
    expect(container.querySelector('[data-bc-time-plot="1"] svg')).not.toBeNull();
    expect(container.querySelector('[data-bc-velocity-hint="1"]')?.textContent).toBe(
      "Air enters straight in through the face at the table's speed; a negative speed blows out.",
    );
    expect(container.querySelector('[data-bc-time-hint="1"]')?.textContent).toMatch(/Turbulence at the inlet uses the table's largest value\.$/);

    fireEvent.change(screen.getByLabelText('Row 2 value'), { target: { value: '4' } });
    fireEvent.blur(screen.getByLabelText('Row 2 value'));
    expect(window.__CFD_BC_UPDATE__).toHaveBeenLastCalledWith('v1', { time_table: [[0, 1], [0.5, 4]], time_table_unit: 'm/s' });

    fireEvent.click(screen.getByText('Add row'));
    expect(window.__CFD_BC_UPDATE__).toHaveBeenLastCalledWith('v1', { time_table: [[0, 1], [0.5, 3], [1, 3]], time_table_unit: 'm/s' });

    fireEvent.click(screen.getByLabelText('Remove row 1'));
    expect(window.__CFD_BC_UPDATE__).toHaveBeenLastCalledWith('v1', { time_table: [[0.5, 3]], time_table_unit: 'm/s' });

    fireEvent.paste(screen.getByLabelText('Row 1 time'), { clipboardData: { getData: () => '0\t2\n2\t6\n4\t2' } });
    expect(window.__CFD_BC_UPDATE__).toHaveBeenLastCalledWith('v1', { time_table: [[0, 2], [2, 6], [4, 2]], time_table_unit: 'm/s' });

    fireEvent.change(screen.getByLabelText('After the last point'), { target: { value: 'Repeat' } });
    expect(window.__CFD_BC_UPDATE__).toHaveBeenLastCalledWith('v1', { time_after_last: 'Repeat' });
  });

  it('says what is wrong with a table and draws no preview', () => {
    const rec = { ...INLET, time_varying: true, time_table: [[0, 1], [0, 3]], time_table_unit: 'm/s' };
    publish({ active_id: 'v1', bcs: [rec], study: TRANSIENT });
    const { container } = render(<BcPanel panelId="panel-bc-editor" />);
    expect(screen.getByRole('alert').textContent).toBe('The times must increase from row to row (row 2 is at 0 s, not after 0 s).');
    expect(container.querySelector('[data-bc-time-plot="1"]')).toBeNull();
  });

  it('turns the table rows into the same flow when the velocity becomes a flow rate', () => {
    window.__CFD_BC_FLOW_BASIS__ = vi.fn(() => ({ face_area_m2: 0.01, density: 1.2 }));
    const rec = { ...INLET, time_varying: true, time_table: [[0, 1], [1, 2]], time_table_unit: 'm/s' };
    publish({ active_id: 'v1', bcs: [rec], study: TRANSIENT });
    render(<BcPanel panelId="panel-bc-editor" />);
    fireEvent.change(screen.getByLabelText('Velocity type'), { target: { value: 'Flow rate' } });
    expect(window.__CFD_BC_UPDATE__).toHaveBeenLastCalledWith('v1', {
      velocity_type: 'Flow rate',
      flow_rate_type: 'Volumetric flow',
      value: 0.05,
      unit: 'm³/s',
      time_table: [
        [0, 0.01],
        [1, 0.02],
      ],
      time_table_unit: 'm³/s',
    });
  });

  it('puts a table on a pressure and on a total-pressure inlet, in their unit', () => {
    const p = { id: 'p1', name: 'Pressure 1', bc_type: 'Pressure', faces: [], value: 0, unit: 'kPa', time_varying: true, time_table: [[0, 1000], [1, 2000]], time_table_unit: 'Pa' };
    publish({ active_id: 'p1', bcs: [p], study: TRANSIENT });
    const { unmount } = render(<BcPanel panelId="panel-bc-editor" />);
    expect((screen.getByLabelText('Row 2 value') as HTMLInputElement).value).toBe('2');
    expect(screen.queryByLabelText('Fixed value')).toBeNull();
    fireEvent.change(screen.getByLabelText('Pressure unit'), { target: { value: 'Pa' } });
    expect(window.__CFD_BC_UPDATE__).toHaveBeenLastCalledWith('p1', { unit: 'Pa' });
    unmount();
    const t = { id: 't1', name: 'Total pressure inlet 1', bc_type: 'Total pressure inlet', faces: [], value: 250, unit: 'Pa' };
    publish({ active_id: 't1', bcs: [t], study: TRANSIENT });
    render(<BcPanel panelId="panel-bc-editor" />);
    fireEvent.click(screen.getByLabelText('Varies with time'));
    expect(window.__CFD_BC_UPDATE__).toHaveBeenLastCalledWith('t1', {
      time_varying: true,
      time_table: [
        [0, 250],
        [1, 250],
      ],
      time_table_unit: 'Pa',
    });
  });
});
