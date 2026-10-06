import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import committed from '../../../scripts/generated/registry.json';
import type { BcFamilyRow, RegistryDescribe } from '../../api/registry.gen';
import { pluginUiFor, unregisterPlugin, type BcSettingsProps } from '../../plugin-api';
import { useProjectStore } from '../../store/project';
import type { BcState } from '../legacyBridge';
import { BcPanel, bcCardSub } from './BcPanel';

// The BC panels are core chrome around the BC families the study's analysis
// offers (registry kind bc_family): picker, legend and cards come from the
// rows, a family's fields from the plugin component its `ui` names.
const IF_FAMILIES = (committed as unknown as RegistryDescribe).bc_family as BcFamilyRow[];
const IF_BCS = IF_FAMILIES.flatMap((f) => f.variants);

const mirror: BcFamilyRow = {
  key: 'mirror_plane',
  label: 'Mirror plane',
  plugin: 'example-extra-bc',
  record_type: 'Mirror plane',
  aliases: [],
  color: 'other',
  hint: 'Mirror plane: no flow through it',
  variants: ['symmetry_plane'],
  defaults: { metric: { mirror: 'Plane' }, imperial: { mirror: 'Plane' } },
  values: [],
  fields: {
    type: 'object',
    properties: { mirror: { type: 'string', title: 'Mirror', enum: ['Plane', 'Wedge'], default: 'Plane' } },
  },
  ui: '',
};

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
    analysis_key: 'incompressible_steady',
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

const seen: BcSettingsProps[] = [];

/** A stand-in for Incompressible Flow's 'incompressible_flow.bc' component. */
function FakeIfFields(props: BcSettingsProps) {
  seen.push(props);
  return (
    <div data-fake-if-fields={props.family.key}>
      <button type="button" onClick={() => void props.save({ value: 1 })}>
        Save one
      </button>
    </div>
  );
}

function FakeFacesNote(props: BcSettingsProps) {
  return <div data-fake-note="1">{`${props.faces.length} faces`}</div>;
}

beforeEach(() => {
  seen.length = 0;
  useProjectStore.setState({
    registry: {
      analysis: [
        { key: 'incompressible_steady', label: 'Incompressible', bc_types: IF_BCS },
        { key: 'extra_bc_steady', label: 'Extra BC', bc_types: [...IF_BCS, 'symmetry_plane'] },
      ],
      bc_family: [...IF_FAMILIES, mirror],
      default_analysis: { steady: 'incompressible_steady' },
    } as RegistryDescribe,
  });
  window.__CFD_PLUGINS_READY__ = true;
  pluginUiFor('bcpanel-test').registerBcSettings('incompressible_flow.bc', FakeIfFields, { facesNote: FakeFacesNote });
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
  window.__CFD_BC_FLOW_BASIS__ = vi.fn(() => ({ face_area_m2: 0.002, density: 1.2 }));
});

afterEach(() => {
  cleanup();
  unregisterPlugin('bcpanel-test');
  delete window.__CFD_BCS__;
  delete window.__CFD_PLUGINS_READY__;
  delete window.__CFD_BC_FLOW_BASIS__;
});

describe('helpers', () => {
  it('labels cards the way V0.1.0 did', () => {
    expect(bcCardSub({ id: 'a', name: 'P', bc_type: 'Pressure', faces: ['face 10@Body1'] }, { wall_type: 'No-slip' })).toBe(
      'Pressure · face 10@Body1',
    );
    expect(bcCardSub({ id: 'a', name: 'W', bc_type: 'Wall', faces: [], wall_type: 'slip' }, { wall_type: 'No-slip' })).toBe(
      'Wall · Slip · no faces',
    );
    expect(bcCardSub({ id: 'a', name: 'W', bc_type: 'Wall', faces: [] }, { wall_type: 'No-slip' })).toBe('Wall · No-slip · no faces');
  });

  it("says a BC follows its time table in a transient study, with the table's range in the BC's unit", () => {
    const transient = { id: 's1', time_dependency: 'Transient' };
    const inlet = {
      id: 'v',
      name: 'V',
      bc_type: 'Velocity inlet',
      faces: ['face 1@Body1'],
      velocity_type: 'Fixed',
      value: 5,
      unit: 'm/s',
      time_varying: true,
      time_table: [
        [0, 1],
        [0.5, 3],
        [1, 2],
      ],
      time_table_unit: 'm/s',
    };
    expect(bcCardSub(inlet, null, transient)).toBe('Velocity inlet · Varies with time, 1–3 m/s · face 1@Body1');
    // Shown in the BC's unit, whatever unit the rows were typed in.
    expect(bcCardSub({ ...inlet, unit: 'ft/s' }, null, transient)).toBe('Velocity inlet · Varies with time, 3.281–9.843 ft/s · face 1@Body1');
    // A table the run would refuse has no range to show.
    expect(bcCardSub({ ...inlet, time_table: [[0, 1]] }, null, transient)).toBe('Velocity inlet · Varies with time · face 1@Body1');
    expect(bcCardSub({ ...inlet, time_table_unit: 'Pa' }, null, transient)).toBe('Velocity inlet · Varies with time · face 1@Body1');
    // A steady study solves the fixed value; a table that is off is not mentioned.
    expect(bcCardSub(inlet, null, { id: 's1', time_dependency: 'Steady-state' })).toBe('Velocity inlet · face 1@Body1');
    expect(bcCardSub({ ...inlet, time_varying: false }, null, transient)).toBe('Velocity inlet · face 1@Body1');
    const p = { id: 'p', name: 'P', bc_type: 'Pressure', faces: [], value: 0, unit: 'kPa', time_varying: true, time_table: [[0, 500], [1, 1500]], time_table_unit: 'Pa' };
    expect(bcCardSub(p, null, { analysis_type: 'incompressible_transient' })).toBe('Pressure · Varies with time, 0.5–1.5 kPa · no faces');
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

  it("draws the legend from the analysis's families and colours cards by family", () => {
    publish({
      bcs: [
        { id: 'w', name: 'Wall 1', bc_type: 'Wall', faces: [], wall_type: 'Slip' },
        { id: 'p', name: 'Old', bc_type: 'Pressure outlet', faces: [] },
        { id: 'm', name: 'Mystery 1', bc_type: 'Mystery', faces: [] },
      ],
    });
    const { container } = render(<BcPanel panelId="panel-bcs-hub" />);
    const legend = [...container.querySelectorAll('.bc-legend > span')].map((s) => [
      s.querySelector('i')?.className,
      s.textContent?.trim(),
    ]);
    expect(legend.slice(0, 3)).toEqual([
      ['hub-swatch hub-swatch-inlet', 'Velocity inlet'],
      ['hub-swatch hub-swatch-outlet', 'Velocity outlet'],
      ['hub-swatch hub-swatch-pressure', 'Pressure'],
    ]);
    expect(legend).toEqual(IF_FAMILIES.map((f) => [`hub-swatch hub-swatch-${f.color}`, f.label]));
    expect(legend).toEqual(
      expect.arrayContaining([
        ['hub-swatch hub-swatch-wall', 'Wall'],
        ['hub-swatch hub-swatch-symmetry', 'Symmetry'],
        ['hub-swatch hub-swatch-freestream', 'Freestream'],
      ]),
    );
    const swatches = [...container.querySelectorAll('.hub-item-main .hub-swatch')].map((s) => s.className);
    expect(swatches.slice(0, 3)).toEqual([
      'hub-swatch hub-swatch-wall',
      'hub-swatch hub-swatch-pressure',
      'hub-swatch hub-swatch-other',
    ]);
    expect(screen.getByText('Wall · Slip · no faces')).toBeInTheDocument();
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

  it("lists the analysis's families with their keys and hints", () => {
    const { container, rerender } = render(<BcPanel panelId="panel-bc-picker" />);
    const keys = () => [...container.querySelectorAll('[data-bc-key]')].map((b) => b.getAttribute('data-bc-key'));
    expect(keys()).toEqual(IF_FAMILIES.map((f) => f.key));
    expect(container.querySelector('[data-bc-key="wall"] .ml-type-sub')?.textContent).toBe('No-slip, slip, moving or rotating, face by face');
    expect(container.querySelector('[data-bc-key="velocity_inlet"] .ml-type-sub')).toBeNull();
    publish({ analysis_key: 'extra_bc_steady' });
    rerender(<BcPanel panelId="panel-bc-picker" />);
    expect(keys()).toEqual([...IF_FAMILIES.map((f) => f.key), 'mirror_plane']);
    expect(container.querySelector('[data-bc-key="mirror_plane"] .ml-type-sub')?.textContent).toBe('Mirror plane: no flow through it');
  });

  it('waits for the registry instead of offering types it does not have', () => {
    const loadRegistry = useProjectStore.getState().loadRegistry;
    useProjectStore.setState({ registry: null, loadRegistry: vi.fn(async () => ({})) });
    try {
      const { container } = render(<BcPanel panelId="panel-bc-picker" />);
      expect(container.querySelectorAll('[data-bc-key]')).toHaveLength(0);
      expect(container.querySelector('[data-bc-types-loading="1"]')).not.toBeNull();
    } finally {
      useProjectStore.setState({ loadRegistry });
    }
  });

  it('shows the faces picked in the viewport', () => {
    render(<BcPanel panelId="panel-bc-picker" />);
    publish({ pending_faces: ['face 15@Body1'] });
    expect(screen.getByText('Selected: face 15@Body1')).toBeInTheDocument();
  });
});

describe('editor', () => {
  it("draws the family's slot component with the BC, its family, units, faces and the flow basis", async () => {
    const study = { id: 's1', turbulence_model: 'laminar' };
    publish({ active_id: 'bc2', draft_faces: ['face 13@Body1', 'face 14@Body1'], imperial: true, study });
    const { container } = render(<BcPanel panelId="panel-bc-editor" />);
    expect(container.querySelector('[data-bc-title]')?.textContent).toBe('Pressure 2');
    expect(container.querySelector('[data-fake-if-fields="pressure_outlet"]')).not.toBeNull();
    const props = seen[seen.length - 1];
    expect(props.bc.id).toBe('bc2');
    expect(props.study).toEqual(study);
    expect(props.family.key).toBe('pressure_outlet');
    expect(props.imperial).toBe(true);
    expect(props.faces).toEqual(['face 13@Body1', 'face 14@Body1']);
    expect(props.flowBasis(['face 13@Body1'])).toEqual({ face_area_m2: 0.002, density: 1.2 });
    // Under the assigned faces: the family's faces note.
    expect(container.querySelector('.mat-assign-block [data-fake-note="1"]')?.textContent).toBe('2 faces');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save one' }));
    });
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('bc2', { value: 1 });
  });

  it('changes the type through the runtime, offering the families of the analysis', () => {
    publish({ active_id: 'bc2', draft_faces: ['face 13@Body1'] });
    render(<BcPanel panelId="panel-bc-editor" />);
    const type = screen.getByLabelText('Boundary condition type') as HTMLSelectElement;
    expect([...type.options].map((o) => o.value)).toEqual(IF_FAMILIES.map((f) => f.record_type));
    expect(type.value).toBe('Pressure');
    fireEvent.change(type, { target: { value: 'Wall' } });
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('bc2', { bc_type: 'Wall' });
  });

  it("shows a failed save's message", async () => {
    window.__CFD_BC_UPDATE__ = vi.fn(async () => {
      throw new Error('Disk full');
    });
    publish({ active_id: 'bc2' });
    render(<BcPanel panelId="panel-bc-editor" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save one' }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Disk full');
  });

  it('draws a form from the family fields when it names no component', () => {
    publish({
      analysis_key: 'extra_bc_steady',
      active_id: 's1',
      bcs: [{ id: 's1', name: 'Mirror plane 1', bc_type: 'Mirror plane', faces: [], mirror: 'Wedge' }],
    });
    const { container } = render(<BcPanel panelId="panel-bc-editor" />);
    const select = container.querySelector('[data-schema-key="mirror"] select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.selectedOptions[0]?.textContent).toBe('Wedge');
    expect(container.querySelector('[data-fake-if-fields]')).toBeNull();
    expect(container.querySelector('[data-fake-note]')).toBeNull();
    vi.useFakeTimers();
    try {
      const plane = [...select.options].find((o) => o.textContent === 'Plane');
      fireEvent.change(select, { target: { value: plane?.value } });
      act(() => {
        vi.advanceTimersByTime(400);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('s1', { mirror: 'Plane' });
  });

  it('keeps an unknown type and its fields, and says its plugin is off', () => {
    publish({
      active_id: 'm1',
      bcs: [{ id: 'm1', name: 'Mystery 1', bc_type: 'Mystery', faces: ['face 2@Body1'], strength: 3 }],
      draft_faces: ['face 2@Body1'],
    });
    const { container } = render(<BcPanel panelId="panel-bc-editor" />);
    expect(container.querySelector('[data-bc-plugin-off="1"]')?.textContent).toBe("This boundary condition's plugin is off");
    const type = screen.getByLabelText('Boundary condition type') as HTMLSelectElement;
    expect(type.value).toBe('Mystery');
    expect(window.__CFD_BC_UPDATE__).not.toHaveBeenCalled();
    // Faces can still be assigned and removed.
    fireEvent.click(screen.getByRole('button', { name: 'Remove face 2@Body1' }));
    expect(window.__CFD_BC_UNASSIGN_FACE__).toHaveBeenCalledWith('face 2@Body1');
  });

  it("never flashes the generic form while the family's plugin UI is loading", () => {
    unregisterPlugin('bcpanel-test');
    window.__CFD_PLUGINS_READY__ = false;
    publish({ active_id: 'bc2' });
    const { container } = render(<BcPanel panelId="panel-bc-editor" />);
    expect(container.querySelector('.schema-form')).toBeNull();
    expect(container.querySelector('[data-bc-plugin-off]')).toBeNull();
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

  it('says so when no BC is open', () => {
    publish({ active_id: null });
    render(<BcPanel panelId="panel-bc-editor" />);
    expect(screen.getByText('Open a boundary condition from the tree or the overview.')).toBeInTheDocument();
  });
});
