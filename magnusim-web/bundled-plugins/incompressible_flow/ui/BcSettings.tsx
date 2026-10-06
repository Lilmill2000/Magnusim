/**
 * Incompressible Flow's boundary-condition fields, drawn in the core's BC
 * editor between the Type row and the assigned faces (the 'bc-settings' slot
 * its BC families name): a velocity inlet or outlet's velocity or flow rate,
 * a wall's slip treatment, a pressure's fixed value. Under the assigned faces
 * a velocity BC says that each face gets the value on its own.
 */
import type { ReactNode } from 'react';
import { Select, UNITS, convertQuantity, fromSi, preferredUnit, resolveUnit, toSi, type Quantity } from '@magnusim/plugin-ui';
import type { BcSettingsProps } from '../../../src/plugin-api';
import { host } from './host';
import { turbulenceKey } from './StudySettings';

/** The fluid density a flow-rate conversion uses when the study has none: Air at 20 C, 1 atm (materials.AIR). */
const AIR_DENSITY = 1.204;

const VELOCITY_FAMILIES = new Set(['velocity_inlet', 'velocity_outlet']);

/** A wall's treatment (incompressible_flow.bc_kinds.WALL_KINDS). */
export const WALL_TYPES = ['No-slip', 'Slip', 'Moving', 'Rotating'] as const;
export type WallType = (typeof WALL_TYPES)[number];

export function wallType(raw: unknown): WallType {
  const want = String(raw || '').toLowerCase().replace(/[\s_-]+/g, '');
  return WALL_TYPES.find((t) => t.toLowerCase().replace(/[\s_-]+/g, '') === want) || 'No-slip';
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
  if (wt === 'Moving') {
    return 'The wall slides along itself at this velocity and the air sticks to it (a belt, a lid). Give a velocity along the wall surface: a part through the wall would push air through it.';
  }
  if (wt === 'Rotating') {
    return 'The wall turns about the axis through the origin at this speed (right-hand rule; negative turns the other way) and the air sticks to it. The mesh does not move: use it for round parts spinning in place.';
  }
  return wt === 'Slip'
    ? 'Air slides along the wall with no friction: zero velocity through it, no shear. Use for idealized frictionless surfaces; for a mirror plane use Symmetry.'
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

/** What a velocity inlet or outlet does with its value, in the user's words. */
export function velocityHint(outlet: boolean, velocityType: string, direction: string): string {
  if (velocityType === 'Flow rate') {
    return outlet ? 'This much flow leaves through each face.' : 'This much flow enters through each face.';
  }
  if (direction === 'Vector') {
    return outlet ? 'Air leaves at this speed moving along the vector.' : 'Air enters at this speed moving along the vector.';
  }
  return outlet ? 'Air leaves straight out through the face at this speed.' : 'Air enters straight in through the face at this speed.';
}

function VelocityFields({ bc, family, imperial, save, flowBasis }: BcSettingsProps) {
  const { SciNumberInput } = host().pluginUi;
  const outlet = family.key === 'velocity_outlet';
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
        </>
      ) : null}
      <div className="mat-assign-hint" data-bc-velocity-hint="1">
        {velocityHint(outlet, vt, direction)}
      </div>
    </>
  );
}

/** A vector stored in SI, shown and typed in the project's unit system's unit of `quantity`. */
function SiVector({
  label,
  valueSi,
  quantity,
  imperial,
  onCommitSi,
}: {
  label: string;
  valueSi: number[];
  quantity: Quantity;
  imperial: boolean;
  onCommitSi: (si: number[]) => void;
}) {
  const unit = preferredUnit(quantity, imperial);
  const shown = valueSi.map((x) => roundShown(fromSi(quantity, x, unit)));
  return (
    <span className="bc-value-row">
      <VectorInputs
        label={label}
        value={shown}
        onCommit={(next) => onCommitSi(next.map((x) => roundShown(toSi(quantity, x, unit))))}
      />
      <span className="bc-unit-label">{unit}</span>
    </span>
  );
}

function WallFields({ bc, imperial, save }: BcSettingsProps) {
  const { SciNumberInput } = host().pluginUi;
  const wt = wallType(bc.wall_type);
  return (
    <>
      <Row label="Wall type">
        <Choice label="Wall type" value={wt} options={[...WALL_TYPES]} onChange={(v) => void save({ wall_type: v })} />
      </Row>
      {wt === 'Moving' ? (
        <Row label="Wall velocity (X Y Z)">
          <SiVector
            label="Wall velocity"
            valueSi={vec3(bc.wall_velocity, [1, 0, 0])}
            quantity="velocity"
            imperial={imperial}
            onCommitSi={(next) => void save({ wall_velocity: next })}
          />
        </Row>
      ) : null}
      {wt === 'Rotating' ? (
        <>
          <Row label="Axis (X Y Z)">
            <VectorInputs
              label="Axis"
              value={vec3(bc.rotation_axis, [0, 0, 1])}
              onCommit={(next) => void save({ rotation_axis: next })}
            />
          </Row>
          <Row label="Origin (X Y Z)">
            <SiVector
              label="Origin"
              valueSi={vec3(bc.rotation_origin, [0, 0, 0])}
              quantity="length"
              imperial={imperial}
              onCommitSi={(next) => void save({ rotation_origin: next })}
            />
          </Row>
          <Row label="Speed">
            <span className="bc-value-row">
              <SciNumberInput
                value={num(bc.rotation_speed, 100)}
                label="Rotation speed"
                onCommit={(n) => void save({ rotation_speed: n })}
              />
              <span className="bc-unit-label">rpm</span>
            </span>
          </Row>
        </>
      ) : null}
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

export const SYMMETRY_HINT =
  'A mirror plane: no flow crosses it and it has no friction; every field is mirrored across it. Use it to model half (or a quarter) of a symmetric case. The faces need not be flat.';

function SymmetryFields() {
  return (
    <div className="mat-assign-hint" data-bc-symmetry-hint="1">
      {SYMMETRY_HINT}
    </div>
  );
}

/** "Turbulence at the inlet" (incompressible_flow.inlet_turbulence.SPECS). */
export const TURBULENCE_SPECS = ['Auto', 'Intensity and length scale', 'Intensity and viscosity ratio'] as const;
export type TurbulenceSpec = (typeof TURBULENCE_SPECS)[number];

/** The families flow comes in through: they carry "Turbulence at the inlet". */
const TURBULENCE_FAMILIES = new Set(['velocity_inlet', 'pressure_outlet', 'total_pressure_inlet', 'freestream']);

export function turbulenceSpec(raw: unknown): TurbulenceSpec {
  const want = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
  return TURBULENCE_SPECS.find((s) => s.toLowerCase().replace(/[^a-z]/g, '') === want) || 'Auto';
}

/** A laminar study solves no turbulence: its boundaries take no turbulence settings. */
export function studyIsLaminar(study: Record<string, unknown> | null | undefined): boolean {
  return !!study && turbulenceKey(study) === 'laminar';
}

/**
 * A Spalart-Allmaras study solves for one field, the modified turbulent viscosity
 * (nuTilda), not k and omega: its viscosity-ratio setting has no intensity, and its
 * Auto is nuTilda = 3 x the fluid's viscosity (inlet_turbulence.py).
 */
export function studyIsSpalartAllmaras(study: Record<string, unknown> | null | undefined): boolean {
  return !!study && turbulenceKey(study) === 'SpalartAllmaras';
}

/** The "Turbulence at the inlet" choices: Spalart-Allmaras names the ratio setting without its intensity. */
export function turbulenceOptions(sa: boolean): Array<{ value: TurbulenceSpec; label: string }> {
  return TURBULENCE_SPECS.map((s) => ({ value: s, label: sa && s === 'Intensity and viscosity ratio' ? 'Viscosity ratio' : s }));
}

/** What a Spalart-Allmaras "Turbulence at the inlet" choice sets. */
export function saTurbulenceHint(spec: TurbulenceSpec, speedWord: string): string {
  if (spec === 'Intensity and length scale') {
    return `ν̃ (modified turbulent viscosity) from a turbulent viscosity set by the intensity of ${speedWord} and the length scale (about 7 % of the opening's size is typical).`;
  }
  if (spec === 'Intensity and viscosity ratio') {
    return "ν̃ (modified turbulent viscosity) from a turbulent viscosity this many times the fluid's (1 to 10 is calm, 100 or more very turbulent).";
  }
  return "Auto: ν̃ (modified turbulent viscosity) = 3 × the fluid's viscosity, a calm inflow (3 to 5 × is usual for external flow).";
}

/** What a "Turbulence at the inlet" choice sets, in the user's words (a freestream's Auto is its own rule). */
export function turbulenceHint(spec: TurbulenceSpec, speedWord: string, freestream = false): string {
  if (spec === 'Intensity and length scale') {
    return `k from the intensity of ${speedWord}; ω (or ε) from the length scale (about 7 % of the opening's size is typical).`;
  }
  if (spec === 'Intensity and viscosity ratio') {
    return `k from the intensity of ${speedWord}; ω (or ε) from a turbulent viscosity this many times the fluid's (1 to 10 is calm, 100 or more very turbulent).`;
  }
  if (freestream) return "Auto: 5 % intensity of the freestream speed, turbulent viscosity 10 × the fluid's.";
  return "Auto: 5 % intensity of the case's inlet speed, length scale 0.07 × the largest inlet's hydraulic diameter.";
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return v === undefined || v === null || v === '' || !Number.isFinite(n) ? fallback : n;
}

function roundShown(n: number): number {
  return Number.isFinite(n) ? Number(n.toPrecision(6)) : n;
}

/** A number stored in SI, shown and typed in the project's unit system's unit of `quantity`. */
function SiNumber({
  label,
  valueSi,
  quantity,
  imperial,
  onCommitSi,
}: {
  label: string;
  valueSi: number;
  quantity: Quantity;
  imperial: boolean;
  onCommitSi: (si: number) => void;
}) {
  const { SciNumberInput } = host().pluginUi;
  const unit = preferredUnit(quantity, imperial);
  return (
    <span className="bc-value-row">
      <SciNumberInput
        value={roundShown(fromSi(quantity, valueSi, unit))}
        label={label}
        onCommit={(n) => onCommitSi(roundShown(toSi(quantity, n, unit)))}
      />
      <span className="bc-unit-label">{unit}</span>
    </span>
  );
}

function TurbulenceFields({ bc, family, imperial, save, study }: BcSettingsProps) {
  const { SciNumberInput } = host().pluginUi;
  if (studyIsLaminar(study)) return null;
  const sa = studyIsSpalartAllmaras(study);
  const spec = turbulenceSpec(bc.turbulence_spec);
  const speedWord =
    family.key === 'velocity_inlet'
      ? "this inlet's speed"
      : family.key === 'freestream'
        ? 'the freestream speed'
        : "the case's reference speed";
  return (
    <div data-bc-turbulence="1">
      <Row label="Turbulence at the inlet">
        <Select
          label="Turbulence at the inlet"
          value={spec}
          options={turbulenceOptions(sa)}
          onChange={(v) => void save({ turbulence_spec: v })}
        />
      </Row>
      {spec === 'Intensity and length scale' || (spec === 'Intensity and viscosity ratio' && !sa) ? (
        <Row label="Intensity">
          <span className="bc-value-row">
            <SciNumberInput
              value={num(bc.turbulence_intensity, 5)}
              label="Turbulence intensity"
              onCommit={(n) => void save({ turbulence_intensity: n })}
            />
            <span className="bc-unit-label">%</span>
          </span>
        </Row>
      ) : null}
      {spec === 'Intensity and length scale' ? (
        <Row label="Length scale">
          <SiNumber
            label="Length scale"
            valueSi={num(bc.turbulence_length_scale, 0.01)}
            quantity="length"
            imperial={imperial}
            onCommitSi={(n) => void save({ turbulence_length_scale: n })}
          />
        </Row>
      ) : null}
      {spec === 'Intensity and viscosity ratio' ? (
        <Row label="Viscosity ratio">
          <SciNumberInput
            value={num(bc.turbulence_viscosity_ratio, 10)}
            label="Viscosity ratio"
            onCommit={(n) => void save({ turbulence_viscosity_ratio: n })}
          />
        </Row>
      ) : null}
      <div className="mat-assign-hint">
        {sa ? saTurbulenceHint(spec, speedWord) : turbulenceHint(spec, speedWord, family.key === 'freestream')}
      </div>
    </div>
  );
}

/** How a freestream's velocity is typed (incompressible_flow.bcs.FREESTREAM_INPUTS). */
export const FREESTREAM_INPUTS = ['Speed and direction', 'Velocity vector'] as const;

const SPEED_UNITS = ['m/s', 'ft/s', 'ft/min'];

function vec3(raw: unknown, fallback: number[]): number[] {
  const v = Array.isArray(raw) ? raw.slice(0, 3).map((x) => Number(x)) : [];
  return v.length === 3 && v.every(Number.isFinite) ? v : fallback.slice();
}

/** The velocity components a freestream's speed along its direction makes (+x when it has none), rounded as the panel shows them. */
export function freestreamComponents(speed: number, direction: number[]): number[] {
  const m = Math.hypot(direction[0], direction[1], direction[2]);
  const unit = m > 0 ? direction.map((x) => x / m) : [1, 0, 0];
  return unit.map((x) => roundShown(x * (Number.isFinite(speed) ? Math.abs(speed) : 0)));
}

export const FREESTREAM_HINT =
  'The undisturbed flow far from the body: it comes in with this velocity where the flow enters and leaves freely elsewhere, at the freestream pressure. Put it well away from the body (a box around it).';

function VectorInputs({ label, value, onCommit }: { label: string; value: number[]; onCommit: (next: number[]) => void }) {
  const { SciNumberInput } = host().pluginUi;
  return (
    <span className="bc-value-row bc-vector-row">
      {(['X', 'Y', 'Z'] as const).map((axis, i) => (
        <SciNumberInput
          key={axis}
          className="bc-input bc-vec"
          label={`${label} ${axis}`}
          value={value[i]}
          onCommit={(n) => {
            const next = value.slice();
            next[i] = n;
            onCommit(next);
          }}
        />
      ))}
    </span>
  );
}

function FreestreamFields({ bc, imperial, save }: BcSettingsProps) {
  const mode = FREESTREAM_INPUTS.find((m) => m === bc.velocity_input) || FREESTREAM_INPUTS[0];
  const unit = unitFor(bc.unit, SPEED_UNITS, imperial, 'velocity');
  const speed = num(bc.value, 10);
  const vector = vec3(bc.vector, [1, 0, 0]);
  const components = mode === 'Velocity vector' ? vector : freestreamComponents(speed, vector);
  return (
    <>
      <Row label="Velocity given as">
        <Choice
          label="Velocity given as"
          value={mode}
          options={[...FREESTREAM_INPUTS]}
          onChange={(v) =>
            // Typed as components, the vector holds the velocity itself (its length is the speed).
            void save(v === 'Velocity vector' ? { velocity_input: v, vector: components } : { velocity_input: v })
          }
        />
      </Row>
      {mode === 'Speed and direction' ? (
        <>
          <Row label="Speed">
            <ValueWithUnit
              label="Speed"
              value={bc.value}
              unit={unit}
              units={SPEED_UNITS}
              onValue={(n) => void save({ value: n, unit })}
              onUnit={(u) => void save({ unit: u })}
            />
          </Row>
          <Row label="Direction (X Y Z)">
            <VectorInputs label="Direction" value={vector} onCommit={(next) => void save({ vector: next })} />
          </Row>
        </>
      ) : (
        <Row label="Velocity (X Y Z)">
          <span className="bc-value-row">
            <VectorInputs
              label="Velocity"
              value={vector}
              onCommit={(next) => void save({ vector: next, value: roundShown(Math.hypot(next[0], next[1], next[2])) })}
            />
            <Choice
              label="Velocity unit"
              value={unit}
              options={SPEED_UNITS}
              onChange={(u) =>
                // The components follow the unit; the core converts the speed (value) itself.
                void save({ unit: u, vector: vector.map((x) => roundShown(convertQuantity('velocity', x, unit, u))) })
              }
            />
          </span>
        </Row>
      )}
      <Row label="Pressure">
        <SiNumber
          label="Freestream pressure"
          valueSi={num(bc.freestream_pressure, 0)}
          quantity="pressure"
          imperial={imperial}
          onCommitSi={(n) => void save({ freestream_pressure: n })}
        />
      </Row>
      <div className="mat-assign-hint" data-bc-freestream-hint="1">
        {FREESTREAM_HINT} The pressure is gauge.
      </div>
    </>
  );
}

export const TOTAL_PRESSURE_HINT =
  'The total pressure (gauge) of the air coming in: its static pressure plus ½ρU². How fast it comes in follows from the pressure drop to the outlets. Where flow leaves through it, it holds this value as a static pressure.';

function TotalPressureFields({ bc, imperial, save }: BcSettingsProps) {
  const unit = unitFor(bc.unit, PRESSURE_UNITS, imperial, 'pressure');
  return (
    <>
      <Row label="Total pressure">
        <ValueWithUnit
          label="Total pressure"
          value={bc.value ?? 0}
          unit={unit}
          units={PRESSURE_UNITS}
          onValue={(n) => void save({ value: n, unit })}
          onUnit={(u) => void save({ unit: u })}
        />
      </Row>
      <div className="mat-assign-hint" data-bc-total-pressure-hint="1">
        {TOTAL_PRESSURE_HINT}
      </div>
    </>
  );
}

/** The fields of one of this plugin's BC families. */
export function BcSettings(props: BcSettingsProps) {
  const key = props.family.key;
  const turbulence = TURBULENCE_FAMILIES.has(key) ? <TurbulenceFields {...props} /> : null;
  if (VELOCITY_FAMILIES.has(key)) {
    return (
      <>
        <VelocityFields {...props} />
        {turbulence}
      </>
    );
  }
  if (key === 'wall') return <WallFields {...props} />;
  if (key === 'symmetry') return <SymmetryFields />;
  if (key === 'total_pressure_inlet') {
    return (
      <>
        <TotalPressureFields {...props} />
        {turbulence}
      </>
    );
  }
  if (key === 'freestream') {
    return (
      <>
        <FreestreamFields {...props} />
        {turbulence}
      </>
    );
  }
  return (
    <>
      <PressureFields {...props} />
      {turbulence}
    </>
  );
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
