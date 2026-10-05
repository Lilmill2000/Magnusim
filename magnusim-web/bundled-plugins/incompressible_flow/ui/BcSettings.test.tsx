import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import committed from '../../../scripts/generated/registry.json';
import type { BcFamilyRow, RegistryDescribe } from '../../../src/api/registry.gen';
import type { BcState } from '../../../src/panels/legacyBridge';
import { BcPanel } from '../../../src/panels/bcs/BcPanel';
import { unregisterPlugin } from '../../../src/plugin-api';
import { pluginHost } from '../../../src/plugins/loader';
import { useProjectStore } from '../../../src/store/project';
import {
  convertFlowValue,
  freestreamComponents,
  perFaceHint,
  studyIsLaminar,
  turbulenceSpec,
  velocityHint,
  velocityUnits,
  wallType,
} from './BcSettings';
import { register } from './index';

// Incompressible Flow's BC fields in the core's BC editor: the component is
// the plugin's ('incompressible_flow.bc', named by its BC families' ui), the
// chrome around it (type, faces, Delete/Done) the core's.
const FAMILIES = (committed as unknown as RegistryDescribe).bc_family as BcFamilyRow[];

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

beforeEach(() => {
  useProjectStore.setState({
    projectId: 'proj',
    registry: {
      analysis: [{ key: 'incompressible_steady', label: 'Incompressible', bc_types: FAMILIES.flatMap((f) => f.variants) }],
      bc_family: FAMILIES,
      default_analysis: { steady: 'incompressible_steady' },
    } as RegistryDescribe,
  });
  window.__CFD_BCS__ = bcState();
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
  it('reads a wall type the way V0.1.0 did', () => {
    expect(wallType('slip')).toBe('Slip');
    expect(wallType('no_slip')).toBe('No-slip');
    expect(wallType('')).toBe('No-slip');
    expect(wallType('moving')).toBe('Moving');
    expect(wallType('ROTATING')).toBe('Rotating');
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

  it('converts between velocity, volumetric flow and mass flow per face', () => {
    const basis = { face_area_m2: 0.002, density: 1.2 };
    const q = convertFlowValue(10, { velocityType: 'Fixed', unit: 'm/s' }, { velocityType: 'Flow rate', flowRateType: 'Volumetric flow', unit: 'm³/s' }, basis);
    expect(q).toBeCloseTo(0.02, 10);
    const m = convertFlowValue(q, { velocityType: 'Flow rate', flowRateType: 'Volumetric flow', unit: 'm³/s' }, { velocityType: 'Flow rate', flowRateType: 'Mass flow', unit: 'kg/s' }, basis);
    expect(m).toBeCloseTo(0.024, 10);
    const v = convertFlowValue(m, { velocityType: 'Flow rate', flowRateType: 'Mass flow', unit: 'kg/s' }, { velocityType: 'Fixed', unit: 'ft/s' }, basis);
    expect(v).toBeCloseTo(10 / 0.3048, 3);
  });

  it("converts with the app's unit table, every unit it lists", () => {
    const basis = { face_area_m2: 0.01, density: 1.2 };
    const vol = (unit: string) => ({ velocityType: 'Flow rate', flowRateType: 'Volumetric flow', unit });
    // 1 L/s through 0.01 m² is 0.1 m/s; a second table without L/s read it as 1 m³/s (100 m/s).
    expect(convertFlowValue(1, vol('L/s'), { velocityType: 'Fixed', unit: 'm/s' }, basis)).toBeCloseTo(0.1, 10);
    // Six significant digits, as the panel rounds.
    expect(convertFlowValue(1, vol('CFM'), vol('m³/s'), basis)).toBe(0.000471947);
    expect(convertFlowValue(3.6, { velocityType: 'Fixed', unit: 'km/h' }, { velocityType: 'Fixed', unit: 'm/s' }, basis)).toBeCloseTo(1, 10);
  });

  it("uses the app's Air density when the study has none", () => {
    const q = convertFlowValue(1, { velocityType: 'Fixed', unit: 'm/s' }, { velocityType: 'Flow rate', flowRateType: 'Mass flow', unit: 'kg/s' }, { face_area_m2: 1, density: 0 });
    expect(q).toBe(1.204);
  });
});

describe('BC editor fields', () => {
  it('shows the saved value, not a schema default, and saves edits through the bridge', () => {
    publish({ active_id: 'bc2', draft_faces: ['face 13@Body1'] });
    const { container } = render(<BcPanel panelId="panel-bc-editor" />);
    expect(container.querySelector('[data-bc-title]')?.textContent).toBe('Pressure 2');
    expect(screen.getByText('Pressure type').nextSibling).toHaveTextContent('Fixed value');
    const value = screen.getByLabelText('Fixed value') as HTMLInputElement;
    expect(value.value).toBe('-15000');
    fireEvent.change(value, { target: { value: '-14000' } });
    fireEvent.blur(value);
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('bc2', { value: -14000, unit: 'Pa' });
    const unit = screen.getByLabelText('Fixed value unit') as HTMLSelectElement;
    expect([...unit.options].map((o) => o.value)).toEqual(['Pa', 'kPa', 'psi']);
    fireEvent.change(unit, { target: { value: 'kPa' } });
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('bc2', { unit: 'kPa' });
    fireEvent.change(screen.getByLabelText('Boundary condition type'), { target: { value: 'Wall' } });
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('bc2', { bc_type: 'Wall' });
    expect(screen.getByText(/Sets pressure on the face/)).toBeInTheDocument();
    // A pressure says nothing about per-face totals.
    expect(container.querySelector('[data-bc-per-face]')).toBeNull();
  });

  it('shows a pressure in psi on an Imperial project when it has no unit', () => {
    publish({
      active_id: 'p',
      imperial: true,
      bcs: [{ id: 'p', name: 'Pressure 1', bc_type: 'Pressure outlet', faces: [], value: 1 }],
    });
    render(<BcPanel panelId="panel-bc-editor" />);
    expect((screen.getByLabelText('Fixed value unit') as HTMLSelectElement).value).toBe('psi');
  });

  it('shows velocity fields and the vector row only when chosen', () => {
    window.__CFD_BC_FLOW_BASIS__ = vi.fn(() => ({ face_area_m2: null, density: 1.196 }));
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
    const { container } = render(<BcPanel panelId="panel-bc-editor" />);
    expect((screen.getByLabelText('Velocity') as HTMLInputElement).value).toBe('5');
    expect(screen.getByLabelText('Z')).toBeInTheDocument();
    expect(screen.getByText('Air enters at this speed moving along the vector.')).toBeInTheDocument();
    // The per-face line sits under the assigned faces, as before.
    const note = container.querySelector('.mat-assign-block [data-bc-per-face="1"]');
    expect(note?.textContent).toBe('Each face gets this value on its own. 2 faces × 5 m/s = 10 m/s total.');
    expect(note?.previousElementSibling?.textContent).toBe('Click a face in the viewport to assign it. It highlights when selected.');
    fireEvent.change(screen.getByLabelText('Z'), { target: { value: '2' } });
    fireEvent.blur(screen.getByLabelText('Z'));
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('v1', { vector: [0, 0, 2] });
    fireEvent.change(screen.getByLabelText('Velocity type'), { target: { value: 'Flow rate' } });
    // 5 m/s is converted to the same flow, not reused as 5 m³/s (no face area here → 0.01 m² fallback).
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('v1', {
      velocity_type: 'Flow rate',
      flow_rate_type: 'Volumetric flow',
      value: 0.05,
      unit: 'm³/s',
    });
    expect(window.__CFD_BC_FLOW_BASIS__).toHaveBeenCalledWith(['face 1@Body1', 'face 2@Body1']);
  });

  it('lays out the velocity rows in the V0.1.0 order', () => {
    publish({
      active_id: 'v1',
      bcs: [
        {
          id: 'v1',
          name: 'Velocity outlet 1',
          bc_type: 'Velocity outlet',
          faces: [],
          velocity_type: 'Flow rate',
          flow_rate_type: 'Mass flow',
          value: 0.2,
          unit: 'kg/s',
        },
      ],
    });
    const { container } = render(<BcPanel panelId="panel-bc-editor" />);
    const rows = [...container.querySelectorAll('.mat-panel-body > .mat-row > .mat-k')].map((k) => k.textContent);
    expect(rows).toEqual(['Type', 'Velocity type', 'Flow rate type', 'Mass flow']);
    expect([...(screen.getByLabelText('Mass flow unit') as HTMLSelectElement).options].map((o) => o.value)).toEqual(['kg/s', 'lb/s']);
    expect(container.querySelector('[data-bc-per-face="1"]')?.textContent).toMatch(/Two faces at 5 means 10 total/);
  });

  it('says a velocity outlet lets air out at its value', () => {
    publish({
      active_id: 'o1',
      bcs: [
        {
          id: 'o1',
          name: 'Velocity outlet 1',
          bc_type: 'Velocity outlet',
          faces: [],
          velocity_type: 'Fixed',
          value: 3,
          unit: 'm/s',
          direction: 'Normal to face',
        },
      ],
    });
    const { container } = render(<BcPanel panelId="panel-bc-editor" />);
    expect((screen.getByLabelText('Velocity') as HTMLInputElement).value).toBe('3');
    expect(container.querySelector('[data-bc-velocity-hint="1"]')?.textContent).toBe(
      'Air leaves straight out through the face at this speed.',
    );
    expect(velocityHint(true, 'Fixed', 'Vector')).toBe('Air leaves at this speed moving along the vector.');
    expect(velocityHint(true, 'Flow rate', 'Normal to face')).toBe('This much flow leaves through each face.');
    expect(velocityHint(false, 'Fixed', 'Normal to face')).toBe('Air enters straight in through the face at this speed.');
  });

  it("sets a velocity inlet's turbulence at the inlet, its length scale in the unit system", () => {
    const inlet = {
      id: 'v1',
      name: 'Velocity inlet 1',
      bc_type: 'Velocity inlet',
      faces: [],
      velocity_type: 'Fixed',
      value: 5,
      unit: 'm/s',
      direction: 'Normal to face',
    };
    publish({ active_id: 'v1', bcs: [inlet], study: { id: 's1', turbulence_model: 'k-omega SST' } });
    const { container, unmount } = render(<BcPanel panelId="panel-bc-editor" />);
    const spec = screen.getByLabelText('Turbulence at the inlet') as HTMLSelectElement;
    expect([...spec.options].map((o) => o.value)).toEqual(['Auto', 'Intensity and length scale', 'Intensity and viscosity ratio']);
    expect(spec.value).toBe('Auto');
    expect(screen.queryByLabelText('Turbulence intensity')).toBeNull();
    expect(container.querySelector('[data-bc-turbulence="1"]')?.textContent).toMatch(/Auto: 5 % intensity/);
    fireEvent.change(spec, { target: { value: 'Intensity and length scale' } });
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('v1', { turbulence_spec: 'Intensity and length scale' });
    unmount();

    // Saved with its own numbers, on an Imperial project: the length scale shows in inches, saves in metres.
    publish({
      active_id: 'v1',
      imperial: true,
      bcs: [{ ...inlet, turbulence_spec: 'Intensity and length scale', turbulence_intensity: 2, turbulence_length_scale: 0.0254 }],
      study: { id: 's1', turbulence_model: 'k-omega SST' },
    });
    render(<BcPanel panelId="panel-bc-editor" />);
    expect((screen.getByLabelText('Turbulence intensity') as HTMLInputElement).value).toBe('2');
    const length = screen.getByLabelText('Length scale') as HTMLInputElement;
    expect(length.value).toBe('1');
    expect(length.parentElement?.textContent).toContain('in');
    fireEvent.change(length, { target: { value: '2' } });
    fireEvent.blur(length);
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('v1', { turbulence_length_scale: 0.0508 });
    expect(screen.queryByLabelText('Viscosity ratio')).toBeNull();
  });

  it('offers turbulence at the inlet on a pressure boundary, not on a laminar study', () => {
    publish({ active_id: 'bc1', study: { id: 's1', turbulence_model_key: 'kEpsilon' } });
    const { unmount } = render(<BcPanel panelId="panel-bc-editor" />);
    expect(screen.getByLabelText('Turbulence at the inlet')).toBeInTheDocument();
    unmount();
    publish({ active_id: 'bc1', study: { id: 's1', turbulence_model: 'Laminar' } });
    const { container } = render(<BcPanel panelId="panel-bc-editor" />);
    expect(screen.queryByLabelText('Turbulence at the inlet')).toBeNull();
    expect(container.querySelector('[data-bc-turbulence="1"]')).toBeNull();
    expect(studyIsLaminar({ turbulence_model_key: 'laminar' })).toBe(true);
    expect(studyIsLaminar(null)).toBe(false);
    expect(turbulenceSpec('intensity and viscosity RATIO')).toBe('Intensity and viscosity ratio');
    expect(turbulenceSpec(undefined)).toBe('Auto');
  });

  it('says what a symmetry plane does, with no fields to set', () => {
    publish({ active_id: 's1', bcs: [{ id: 's1', name: 'Symmetry 1', bc_type: 'Symmetry', faces: [] }] });
    const { container } = render(<BcPanel panelId="panel-bc-editor" />);
    expect(container.querySelector('[data-bc-symmetry-hint="1"]')?.textContent).toMatch(/^A mirror plane: no flow crosses it/);
    const rows = [...container.querySelectorAll('.mat-panel-body > .mat-row > .mat-k')].map((k) => k.textContent);
    expect(rows).toEqual(['Type']);
    expect(screen.queryByLabelText('Turbulence at the inlet')).toBeNull();
    expect((screen.getByLabelText('Boundary condition type') as HTMLSelectElement).value).toBe('Symmetry');
  });

  it("edits a freestream's speed, direction and pressure, and its velocity as a vector", () => {
    const far = {
      id: 'f1',
      name: 'Freestream 1',
      bc_type: 'Freestream',
      faces: [],
      velocity_input: 'Speed and direction',
      value: 10,
      unit: 'm/s',
      vector: [0, 3, 4],
      freestream_pressure: 6894.757293168,
    };
    publish({ active_id: 'f1', imperial: true, bcs: [far] });
    const { container, unmount } = render(<BcPanel panelId="panel-bc-editor" />);
    expect((screen.getByLabelText('Speed') as HTMLInputElement).value).toBe('10');
    expect((screen.getByLabelText('Speed unit') as HTMLSelectElement).value).toBe('m/s');
    expect((screen.getByLabelText('Direction Z') as HTMLInputElement).value).toBe('4');
    // Gauge pressure stored in Pa, shown in the unit system's unit (psi here).
    const pressure = screen.getByLabelText('Freestream pressure') as HTMLInputElement;
    expect(pressure.value).toBe('1');
    expect(pressure.parentElement?.textContent).toContain('psi');
    fireEvent.change(pressure, { target: { value: '2' } });
    fireEvent.blur(pressure);
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('f1', { freestream_pressure: 13789.5 });
    expect(container.querySelector('[data-bc-freestream-hint="1"]')?.textContent).toMatch(/^The undisturbed flow far from the body/);
    // Its turbulence: Auto is its own rule.
    expect(container.querySelector('[data-bc-turbulence="1"]')?.textContent).toMatch(/5 % intensity of the freestream speed, turbulent viscosity 10/);
    // Typed as a vector: the components are the speed along the direction.
    fireEvent.change(screen.getByLabelText('Velocity given as'), { target: { value: 'Velocity vector' } });
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('f1', { velocity_input: 'Velocity vector', vector: [0, 6, 8] });
    unmount();

    publish({ active_id: 'f1', bcs: [{ ...far, velocity_input: 'Velocity vector', vector: [0, 6, 8] }] });
    render(<BcPanel panelId="panel-bc-editor" />);
    expect(screen.queryByLabelText('Speed')).toBeNull();
    const vy = screen.getByLabelText('Velocity Y') as HTMLInputElement;
    fireEvent.change(vy, { target: { value: '0' } });
    fireEvent.blur(vy);
    // Its length is saved as the speed.
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('f1', { vector: [0, 0, 8], value: 8 });
    fireEvent.change(screen.getByLabelText('Velocity unit'), { target: { value: 'ft/s' } });
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('f1', { unit: 'ft/s', vector: [0, 19.685, 26.2467] });
    expect(freestreamComponents(5, [0, 0, 0])).toEqual([5, 0, 0]);
  });

  it("edits a total-pressure inlet's total pressure and its inlet turbulence", () => {
    publish({
      active_id: 't1',
      imperial: true,
      bcs: [{ id: 't1', name: 'Total pressure inlet 1', bc_type: 'Total pressure inlet', faces: [], value: 250, unit: 'Pa' }],
    });
    const { container } = render(<BcPanel panelId="panel-bc-editor" />);
    expect((screen.getByLabelText('Total pressure') as HTMLInputElement).value).toBe('250');
    const unit = screen.getByLabelText('Total pressure unit') as HTMLSelectElement;
    expect(unit.value).toBe('Pa');
    expect([...unit.options].map((o) => o.value)).toEqual(['Pa', 'kPa', 'psi']);
    fireEvent.change(unit, { target: { value: 'kPa' } });
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('t1', { unit: 'kPa' });
    expect(container.querySelector('[data-bc-total-pressure-hint="1"]')?.textContent).toMatch(/^The total pressure \(gauge\)/);
    expect(screen.getByLabelText('Turbulence at the inlet')).toBeInTheDocument();
    expect(container.querySelector('[data-bc-turbulence="1"]')?.textContent).toMatch(/Auto: 5 % intensity of the case's inlet speed/);
  });

  it('switches a wall between no-slip and slip with its hint', () => {
    publish({
      active_id: 'w1',
      bcs: [{ id: 'w1', name: 'Wall 1', bc_type: 'Wall', faces: [], wall_type: 'slip' }],
    });
    render(<BcPanel panelId="panel-bc-editor" />);
    const wt = screen.getByLabelText('Wall type') as HTMLSelectElement;
    expect([...wt.options].map((o) => o.value)).toEqual(['No-slip', 'Slip', 'Moving', 'Rotating']);
    expect(wt.value).toBe('Slip');
    expect(screen.getByText(/Air slides along the wall with no friction/)).toBeInTheDocument();
    fireEvent.change(wt, { target: { value: 'No-slip' } });
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('w1', { wall_type: 'No-slip' });
  });

  it("sets a moving wall velocity in the unit system and a rotating wall axis, origin and rpm", () => {
    publish({
      active_id: 'w1',
      imperial: true,
      bcs: [{ id: 'w1', name: 'Wall 1', bc_type: 'Wall', faces: [], wall_type: 'Moving', wall_velocity: [0.3048, 0, 0] }],
    });
    const { container, unmount } = render(<BcPanel panelId="panel-bc-editor" />);
    // Stored in m/s, shown in ft/s on an Imperial project.
    const vx = screen.getByLabelText('Wall velocity X') as HTMLInputElement;
    expect(vx.value).toBe('1');
    expect(vx.closest('.bc-value-row')?.parentElement?.textContent).toContain('ft/s');
    fireEvent.change(vx, { target: { value: '2' } });
    fireEvent.blur(vx);
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('w1', { wall_velocity: [0.6096, 0, 0] });
    expect(container.textContent).toMatch(/The wall slides along itself at this velocity/);
    expect(screen.queryByLabelText('Rotation speed')).toBeNull();
    unmount();

    publish({
      active_id: 'w1',
      bcs: [
        {
          id: 'w1',
          name: 'Wall 1',
          bc_type: 'Wall',
          faces: [],
          wall_type: 'Rotating',
          rotation_axis: [0, 1, 0],
          rotation_origin: [0.5, 0, 0],
          rotation_speed: 1500,
        },
      ],
    });
    render(<BcPanel panelId="panel-bc-editor" />);
    expect((screen.getByLabelText('Axis Y') as HTMLInputElement).value).toBe('1');
    expect((screen.getByLabelText('Origin X') as HTMLInputElement).value).toBe('0.5');
    const rpm = screen.getByLabelText('Rotation speed') as HTMLInputElement;
    expect(rpm.value).toBe('1500');
    expect(rpm.parentElement?.textContent).toContain('rpm');
    fireEvent.change(rpm, { target: { value: '-300' } });
    fireEvent.blur(rpm);
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('w1', { rotation_speed: -300 });
    const axisZ = screen.getByLabelText('Axis Z') as HTMLInputElement;
    fireEvent.change(axisZ, { target: { value: '1' } });
    fireEvent.blur(axisZ);
    expect(window.__CFD_BC_UPDATE__).toHaveBeenCalledWith('w1', { rotation_axis: [0, 1, 1] });
    expect(screen.queryByLabelText('Wall velocity X')).toBeNull();
  });
});
