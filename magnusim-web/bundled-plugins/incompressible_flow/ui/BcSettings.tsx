/**
 * Incompressible Flow's boundary-condition fields, drawn in the core's BC
 * editor between the Type row and the assigned faces (the 'bc-settings' slot
 * its BC families name): a velocity inlet or outlet's velocity or flow rate,
 * a wall's slip treatment, a pressure's fixed value. Under the assigned faces
 * a velocity BC says that each face gets the value on its own.
 */
import type { ReactNode } from 'react';
import { Select, UNITS, preferredUnit, resolveUnit, type Quantity } from '@magnusim/plugin-ui';
import type { BcSettingsProps } from '../../../src/plugin-api';
import { host } from './host';

/** The fluid density a flow-rate conversion uses when the study has none (the app's Air). */
const AIR_DENSITY = 1.196;

const VELOCITY_FAMILIES = new Set(['velocity_inlet', 'velocity_outlet']);

export function wallType(raw: unknown): 'Slip' | 'No-slip' {
  return String(raw || '').toLowerCase().replace(/[\s_-]+/g, '') === 'slip' ? 'Slip' : 'No-slip';
}

export function velocityUnits(velocityType?: string, flowRateType?: string): string[] {
  if (velocityType === 'Flow rate' && flowRateType === 'Mass flow') return ['kg/s', 'lb/s'];
  if (velocityType === 'Flow rate') return ['m³/s', 'ft³/min'];
  return ['m/s', 'ft/s', 'ft/min'];
}

const PRESSURE_UNITS = ['Pa', 'kPa', 'psi'];

type FlowKind = 'velocity' | 'volume' | 'mass';

const FLOW_QUANTITY: Record<FlowKind, Quantity> = { velocity: 'velocity', volume: 'volumetric_flow', mass: 'mass_flow' };

function flowKind(velocityType?: string, flowRateType?: string): FlowKind {
  if (velocityType !== 'Flow rate') return 'velocity';
  return flowRateType === 'Mass flow' ? 'mass' : 'volume';
}

/** SI factor of an inlet/outlet unit (to m/s, m³/s or kg/s); 1 for a unit the table does not know. */
function siFactor(kind: FlowKind, unit: string): number {
  const q = FLOW_QUANTITY[kind];
  return UNITS[q][resolveUnit(q, unit)] ?? 1;
}

function roundSig(n: number): number {
  return Number(n.toPrecision(6));
}

/**
 * The same physical flow in another quantity: switching Velocity type or Flow rate
 * type converts the number (per face, v·A = Q, ρ·Q = ṁ) instead of reusing it, so
 * 5 m/s never silently becomes 5 m³/s. Without a face area it falls back to a
 * safe 1 m/s-equivalent through a 0.01 m² face.
 */
export function convertFlowValue(
  value: unknown,
  from: { velocityType?: string; flowRateType?: string; unit: string },
  to: { velocityType?: string; flowRateType?: string; unit: string },
  basis: { face_area_m2: number | null; density: number },
): number {
  const fromKind = flowKind(from.velocityType, from.flowRateType);
  const toKind = flowKind(to.velocityType, to.flowRateType);
  const area = basis.face_area_m2 && basis.face_area_m2 > 0 ? basis.face_area_m2 : 0.01;
  const rho = basis.density > 0 ? basis.density : AIR_DENSITY;
  let si = Number(value) * siFactor(fromKind, from.unit);
  if (!Number.isFinite(si)) si = fromKind === 'velocity' ? 1 : fromKind === 'volume' ? area : rho * area;
  const velocity = fromKind === 'velocity' ? si : fromKind === 'volume' ? si / area : si / (rho * area);
  const out = toKind === 'velocity' ? velocity : toKind === 'volume' ? velocity * area : velocity * area * rho;
  return roundSig(out / siFactor(toKind, to.unit));
}

/** The record's unit when the list offers it, else the unit system's unit of the list's quantity. */
function unitFor(current: unknown, units: string[], imperial: boolean, quantity: Quantity): string {
  const unit = String(current || '');
  if (unit && units.includes(unit)) return unit;
  const preferred = preferredUnit(quantity, imperial);
  return units.includes(preferred) ? preferred : units[0];
}

function velocityQuantity(velocityType?: string, flowRateType?: string): Quantity {
  return FLOW_QUANTITY[flowKind(velocityType, flowRateType)];
}

export function perFaceHint(n: number, value: unknown, unit: string): string {
  const v = Number(value);
  if (n > 1 && value !== '' && value != null && Number.isFinite(v)) {
    return `Each face gets this value on its own. ${n} faces × ${v} ${unit} = ${n * v} ${unit} total.`;
  }
  return 'Each assigned face gets this value on its own. Two faces at 5 means 10 total.';
}

function wallHint(wt: string): string {
  return wt === 'Slip'
    ? 'Air slides along the wall with no friction: zero velocity through it, no shear. Use for symmetry-like or idealized frictionless surfaces.'
    : 'Air sticks to the wall (zero velocity at the surface). This is the usual CFD wall.';
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mat-row">
      <span className="mat-k">{label}</span>
      <span className="mat-v">{children}</span>
    </div>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (next: string) => void;
}) {
  return <Select label={label} value={value} options={options.map((o) => ({ value: o, label: o }))} onChange={onChange} />;
}

function ValueWithUnit({
  label,
  value,
  unit,
  units,
  onValue,
  onUnit,
}: {
  label: string;
  value: unknown;
  unit: string;
  units: string[];
  onValue: (n: number) => void;
  onUnit: (u: string) => void;
}) {
  const { SciNumberInput } = host().pluginUi;
  const n = Number(value);
  return (
    <span className="bc-value-row">
      <SciNumberInput value={Number.isFinite(n) ? n : null} label={label} onCommit={onValue} />
      <Choice label={`${label} unit`} value={unit} options={units} onChange={onUnit} />
    </span>
  );
}

function VelocityFields({ bc, imperial, save, flowBasis }: BcSettingsProps) {
  const { SciNumberInput } = host().pluginUi;
  const vt = String(bc.velocity_type || 'Fixed');
  const fr = String(bc.flow_rate_type || 'Volumetric flow');
  const units = velocityUnits(vt, fr);
  const unit = unitFor(bc.unit, units, imperial, velocityQuantity(vt, fr));
  const direction = String(bc.direction || 'Normal to face');
  const vec = Array.isArray(bc.vector) ? bc.vector : [0, 0, 1];
  const valueLabel = vt === 'Flow rate' ? (fr === 'Mass flow' ? 'Mass flow' : 'Volumetric flow') : 'Velocity';
  // Changing what the number means converts it to the same physical flow.
  const switchKind = (nextVt: string, nextFr: string) => {
    const nextUnit = unitFor(undefined, velocityUnits(nextVt, nextFr), imperial, velocityQuantity(nextVt, nextFr));
    const value = convertFlowValue(
      bc.value,
      { velocityType: vt, flowRateType: fr, unit },
      { velocityType: nextVt, flowRateType: nextFr, unit: nextUnit },
      flowBasis(bc.faces || []),
    );
    void save({ velocity_type: nextVt, flow_rate_type: nextFr, value, unit: nextUnit });
  };
  return (
    <>
      <Row label="Velocity type">
        <Choice label="Velocity type" value={vt} options={['Fixed', 'Flow rate']} onChange={(v) => switchKind(v, fr)} />
      </Row>
      {vt === 'Flow rate' ? (
        <Row label="Flow rate type">
          <Choice
            label="Flow rate type"
            value={fr}
            options={['Volumetric flow', 'Mass flow']}
            onChange={(v) => switchKind(vt, v)}
          />
        </Row>
      ) : null}
      <Row label={valueLabel}>
        <ValueWithUnit
          label={valueLabel}
          value={bc.value}
          unit={unit}
          units={units}
          onValue={(n) => void save({ value: n, unit })}
          onUnit={(u) => void save({ unit: u })}
        />
      </Row>
      {vt === 'Fixed' ? (
        <Row label="Direction">
          <Choice
            label="Direction"
            value={direction}
            options={['Normal to face', 'Vector']}
            onChange={(v) => void save({ direction: v })}
          />
        </Row>
      ) : null}
      {vt === 'Fixed' && direction === 'Vector' ? (
        <>
          <Row label="Vector (X Y Z)">
            <span className="bc-value-row bc-vector-row">
              {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                <SciNumberInput
                  key={axis}
                  className="bc-input bc-vec"
                  label={axis}
                  value={Number(vec[i] ?? 0)}
                  onCommit={(n) => {
                    const next = [Number(vec[0] ?? 0), Number(vec[1] ?? 0), Number(vec[2] ?? 1)];
                    next[i] = n;
                    void save({ vector: next });
                  }}
                />
              ))}
            </span>
          </Row>
          <div className="mat-assign-hint">Air enters at this speed moving along the vector.</div>
        </>
      ) : null}
    </>
  );
}

function WallFields({ bc, save }: BcSettingsProps) {
  const wt = wallType(bc.wall_type);
  return (
    <>
      <Row label="Wall type">
        <Choice label="Wall type" value={wt} options={['No-slip', 'Slip']} onChange={(v) => void save({ wall_type: v })} />
      </Row>
      <div className="mat-assign-hint">{wallHint(wt)}</div>
    </>
  );
}

function PressureFields({ bc, imperial, save }: BcSettingsProps) {
  const unit = unitFor(bc.unit, PRESSURE_UNITS, imperial, 'pressure');
  return (
    <>
      <Row label="Pressure type">Fixed value</Row>
      <Row label="Fixed value">
        <ValueWithUnit
          label="Fixed value"
          value={bc.value ?? 0}
          unit={unit}
          units={PRESSURE_UNITS}
          onValue={(n) => void save({ value: n, unit })}
          onUnit={(u) => void save({ unit: u })}
        />
      </Row>
      <div className="mat-assign-hint">
        Sets pressure on the face. Flow can enter or leave depending on the rest of the case.
      </div>
    </>
  );
}

/** The fields of one of this plugin's BC families. */
export function BcSettings(props: BcSettingsProps) {
  const key = props.family.key;
  if (VELOCITY_FAMILIES.has(key)) return <VelocityFields {...props} />;
  if (key === 'wall') return <WallFields {...props} />;
  return <PressureFields {...props} />;
}

/** Under a velocity BC's assigned faces: each face gets the value on its own. */
export function BcFacesNote({ bc, family, faces, imperial }: BcSettingsProps) {
  if (!VELOCITY_FAMILIES.has(family.key)) return null;
  const vt = String(bc.velocity_type || 'Fixed');
  const fr = String(bc.flow_rate_type || 'Volumetric flow');
  const unit = unitFor(bc.unit, velocityUnits(vt, fr), imperial, velocityQuantity(vt, fr));
  return (
    <div className="mat-assign-hint" data-bc-per-face="1">
      {perFaceHint(faces.length, bc.value, unit)}
    </div>
  );
}
