import { useEffect, useState, type ReactNode } from 'react';
import { workerRpc } from '../../api/workerRpc';
import { SciNumberInput } from '../../forms/SciNumberInput';
import { dispatchPanelDone, type IslandProps } from '../../islands';
import { unitIsImperial } from '../../units/convert';
import {
  bcStateNow,
  clearBcFaces,
  createBc,
  deleteBc,
  focusBcFace,
  openBc,
  openBcDefaults,
  openBcPicker,
  subscribeBcState,
  unassignBcFace,
  updateBc,
  type BcRecord,
  type BcState,
} from '../legacyBridge';

interface MenuVariant {
  key: string;
  label: string;
  registry_key: string;
  subvariants?: Array<{ key: string; label: string; registry_key: string }>;
}

interface MenuType {
  key: string;
  label: string;
  variants: MenuVariant[];
}

export interface BcMenuItem {
  key: string;
  label: string;
  bcType: string;
  registryKey: string;
}

export function bcMenuFrom(menu: MenuType[]): BcMenuItem[] {
  return menu.map((entry) => {
    const variant = entry.variants[0];
    const registryKey = variant?.subvariants?.[0]?.registry_key || variant?.registry_key || '';
    return { key: entry.key, label: entry.label, bcType: entry.label, registryKey };
  });
}

/** The four types the case writer maps; used until `bc.menu` answers. */
const FALLBACK_TYPES: BcMenuItem[] = [
  { key: 'velocity_inlet', label: 'Velocity inlet', bcType: 'Velocity inlet', registryKey: 'velocity_inlet_fixed' },
  { key: 'velocity_outlet', label: 'Velocity outlet', bcType: 'Velocity outlet', registryKey: 'velocity_outlet' },
  { key: 'pressure_outlet', label: 'Pressure', bcType: 'Pressure', registryKey: 'pressure_outlet_gauge' },
  { key: 'wall', label: 'Wall', bcType: 'Wall', registryKey: 'wall_noslip' },
];

const TYPE_SUB: Record<string, string> = { Wall: 'Slip or no-slip, face by face' };

export type BcKind = 'inlet' | 'outlet' | 'pressure' | 'wall';

/** Legend and face color group, as runtime.bcKind. */
export function bcKind(bc: Pick<BcRecord, 'bc_type'> | null | undefined): BcKind {
  const t = String(bc?.bc_type || '');
  if (t === 'Velocity outlet') return 'outlet';
  if (t.startsWith('Pressure')) return 'pressure';
  if (t === 'Wall') return 'wall';
  return 'inlet';
}

function isWall(bc: BcRecord): boolean {
  return String(bc.bc_type || '') === 'Wall';
}

function isVelocity(bc: BcRecord): boolean {
  return String(bc.bc_type || '').startsWith('Velocity');
}

export function wallType(raw: unknown): 'Slip' | 'No-slip' {
  return String(raw || '').toLowerCase().replace(/[\s_-]+/g, '') === 'slip' ? 'Slip' : 'No-slip';
}

/** "Pressure · face 10@Body1" — the hub card's second line. */
export function bcCardSub(bc: BcRecord): string {
  const type = isWall(bc) ? `Wall · ${wallType(bc.wall_type)}` : String(bc.bc_type || '');
  const faces = (bc.faces || []).join(', ') || 'no faces';
  return `${type} · ${faces}`;
}

export function velocityUnits(velocityType?: string, flowRateType?: string): string[] {
  if (velocityType === 'Flow rate' && flowRateType === 'Mass flow') return ['kg/s', 'lb/s'];
  if (velocityType === 'Flow rate') return ['m³/s', 'ft³/min'];
  return ['m/s', 'ft/s', 'ft/min'];
}

const PRESSURE_UNITS = ['Pa', 'kPa', 'psi'];

function unitFor(current: string | undefined, units: string[], imperial: boolean): string {
  if (current && units.includes(current)) return current;
  return units.find((u) => unitIsImperial(u) === imperial) || units[0];
}

function wallHint(wt: string): string {
  return wt === 'Slip'
    ? 'Air slides along the wall with no friction: zero velocity through it, no shear. Use for symmetry-like or idealized frictionless surfaces.'
    : 'Air sticks to the wall (zero velocity at the surface). This is the usual CFD wall.';
}

export function perFaceHint(n: number, value: unknown, unit: string): string {
  const v = Number(value);
  if (n > 1 && value !== '' && value != null && Number.isFinite(v)) {
    return `Each face gets this value on its own. ${n} faces × ${v} ${unit} = ${n * v} ${unit} total.`;
  }
  return 'Each assigned face gets this value on its own. Two faces at 5 means 10 total.';
}

/** Live runtime BC state (records, open BC, its faces, defaults, picker selection). */
export function useBcState(): BcState | null {
  const [state, setState] = useState<BcState | null>(() => bcStateNow());
  useEffect(() => {
    setState(bcStateNow());
    return subscribeBcState(setState);
  }, []);
  return state;
}

function useBcTypes(): BcMenuItem[] {
  const [items, setItems] = useState<BcMenuItem[]>(FALLBACK_TYPES);
  useEffect(() => {
    let live = true;
    void workerRpc<{ menu?: MenuType[] }>('bc.menu', {})
      .then((doc) => {
        const next = bcMenuFrom(Array.isArray(doc.menu) ? doc.menu : []);
        if (live && next.length) setItems(next);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return items;
}

function report(e: unknown, setNote: (s: string) => void, what: string) {
  setNote(e instanceof Error ? e.message : `${what} failed`);
}

function DoneButton() {
  return (
    <button type="button" className="js-btn tree-panel-done" onClick={() => dispatchPanelDone()}>
      Done
    </button>
  );
}

function BcLegend() {
  return (
    <div className="bc-legend">
      <span><i className="hub-swatch hub-swatch-inlet" /> Velocity inlet</span>
      <span><i className="hub-swatch hub-swatch-outlet" /> Velocity outlet</span>
      <span><i className="hub-swatch hub-swatch-pressure" /> Pressure</span>
      <span><i className="hub-swatch hub-swatch-wall" /> Wall</span>
    </div>
  );
}

/** Overview: legend, one card per BC (click opens its editor), Defaults, Add. */
export function BcHub() {
  const state = useBcState();
  const [note, setNote] = useState('');
  const bcs = state?.bcs || [];
  return (
    <div data-bc-hub="1">
      <div className="sim-def-head">
        <span className="sim-def-title">Boundary conditions</span>
      </div>
      <BcLegend />
      <p className="mat-assign-hint">Every assigned face is shown on the model, color-coded by type.</p>
      <ul className="hub-list">
        {bcs.length ? (
          bcs.map((bc) => (
            <li key={bc.id}>
              <button type="button" className="hub-item" data-open-bc={bc.id} onClick={() => openBc(bc.id)}>
                <span className="hub-item-main">
                  <span className={`hub-swatch hub-swatch-${bcKind(bc)}`} />
                  <span className="hub-item-name">{bc.name}</span>
                  <span className="hub-item-sub">{bcCardSub(bc)}</span>
                </span>
              </button>
              <button
                type="button"
                className="hub-item-del"
                data-del-bc={bc.id}
                onClick={() => void deleteBc(bc.id).catch((e) => report(e, setNote, 'Delete'))}
              >
                Delete
              </button>
            </li>
          ))
        ) : (
          <li className="hub-empty">No boundary conditions yet</li>
        )}
      </ul>
      <button type="button" className="hub-item hub-item-defaults" data-bc-defaults="1" onClick={() => openBcDefaults()}>
        <span className="hub-item-main">
          <span className="hub-swatch hub-swatch-default" />
          <span className="hub-item-name">Defaults</span>
          <span className="hub-item-sub">{state?.defaults_summary || 'Unassigned faces: no-slip walls'}</span>
        </span>
      </button>
      <button
        type="button"
        className="js-btn"
        data-bc-open-picker="1"
        onClick={() => openBcPicker()}
      >
        Add boundary condition
      </button>
      {note ? (
        <p className="mat-assign-hint" role="alert">
          {note}
        </p>
      ) : null}
      <div className="sim-def-foot">
        <DoneButton />
      </div>
    </div>
  );
}

/** Choose a type, click faces in the viewport, then Add. Clicking a type never creates anything. */
export function BcPicker() {
  const state = useBcState();
  const types = useBcTypes();
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const pending = state?.pending_faces || [];
  const item = types.find((t) => t.key === selected) || null;

  async function add() {
    if (!item) return;
    setBusy(true);
    setNote('');
    try {
      await createBc(item.bcType);
    } catch (e) {
      report(e, setNote, 'Add');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-bc-picker="1">
      <div className="sim-def-head">
        <span className="sim-def-title">Boundary conditions</span>
        <button type="button" className="fp-close" aria-label="Close" onClick={() => dispatchPanelDone()}>
          x
        </button>
      </div>
      <button type="button" className="ml-type ml-type-defaults" data-bc-defaults="1" onClick={() => openBcDefaults()}>
        <span className="ml-type-name">Defaults</span>
        <span className="ml-type-sub">{state?.defaults_summary || 'Unassigned faces: no-slip walls'}</span>
      </button>
      <div className="picker-divider" />
      {types.map((t) => (
        <button
          key={t.key}
          type="button"
          className={`ml-type${selected === t.key ? ' is-selected' : ''}`}
          data-bc-key={t.key}
          aria-pressed={selected === t.key}
          onClick={() => setSelected(t.key)}
        >
          <span className="ml-type-name">{t.label}</span>
          {TYPE_SUB[t.bcType] ? <span className="ml-type-sub">{TYPE_SUB[t.bcType]}</span> : null}
        </button>
      ))}
      <p className="mat-assign-hint">
        Click a face in the viewport to select it. Add assigns that face to the new boundary condition.
      </p>
      {pending.length ? (
        <p className="mat-assign-hint" data-bc-pending="1">
          Selected: {pending.join(', ')}
        </p>
      ) : null}
      {note ? (
        <p className="mat-assign-hint" role="alert">
          {note}
        </p>
      ) : null}
      <div className="picker-actions">
        <button
          type="button"
          className="js-btn js-btn-kick"
          data-bc-add="1"
          disabled={!item || busy}
          title={item ? `Add a ${item.label} boundary condition` : 'Choose a type first'}
          onClick={() => void add()}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mat-row">
      <span className="mat-k">{label}</span>
      <span className="mat-v">{children}</span>
    </div>
  );
}

function Select({
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
  return (
    <select className="bc-select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
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
  const n = Number(value);
  return (
    <span className="bc-value-row">
      <SciNumberInput value={Number.isFinite(n) ? n : null} label={label} onCommit={onValue} />
      <Select label={`${label} unit`} value={unit} options={units} onChange={onUnit} />
    </span>
  );
}

/** One BC: type, its values, and the faces assigned by clicking the model. */
export function BcEditor() {
  const state = useBcState();
  const types = useBcTypes();
  const [note, setNote] = useState('');
  const bc = state?.bcs.find((b) => String(b.id) === String(state.active_id)) || null;
  if (!bc || !state) {
    return (
      <div data-bc-editor="1">
        <p className="mat-assign-hint">Open a boundary condition from the tree or the overview.</p>
        <div className="mat-panel-foot foot-end">
          <DoneButton />
        </div>
      </div>
    );
  }
  const id = bc.id;
  const faces = state.draft_faces;
  const imperial = !!state.imperial;
  const save = (patch: Partial<BcRecord>) => void updateBc(id, patch).catch((e) => report(e, setNote, 'Save'));
  const typeNames = types.map((t) => t.bcType);
  if (!typeNames.includes(bc.bc_type)) typeNames.push(bc.bc_type);

  let fields: ReactNode = null;
  if (isVelocity(bc)) {
    const vt = bc.velocity_type || 'Fixed';
    const fr = bc.flow_rate_type || 'Volumetric flow';
    const units = velocityUnits(vt, fr);
    const unit = unitFor(bc.unit, units, imperial);
    const direction = bc.direction || 'Normal to face';
    const vec = Array.isArray(bc.vector) ? bc.vector : [0, 0, 1];
    const valueLabel = vt === 'Flow rate' ? (fr === 'Mass flow' ? 'Mass flow' : 'Volumetric flow') : 'Velocity';
    fields = (
      <>
        <Row label="Velocity type">
          <Select label="Velocity type" value={vt} options={['Fixed', 'Flow rate']} onChange={(v) => save({ velocity_type: v })} />
        </Row>
        {vt === 'Flow rate' ? (
          <Row label="Flow rate type">
            <Select
              label="Flow rate type"
              value={fr}
              options={['Volumetric flow', 'Mass flow']}
              onChange={(v) => save({ flow_rate_type: v })}
            />
          </Row>
        ) : null}
        <Row label={valueLabel}>
          <ValueWithUnit
            label={valueLabel}
            value={bc.value}
            unit={unit}
            units={units}
            onValue={(n) => save({ value: n, unit })}
            onUnit={(u) => save({ unit: u })}
          />
        </Row>
        {vt === 'Fixed' ? (
          <Row label="Direction">
            <Select
              label="Direction"
              value={direction}
              options={['Normal to face', 'Vector']}
              onChange={(v) => save({ direction: v })}
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
                      save({ vector: next });
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
  } else if (isWall(bc)) {
    const wt = wallType(bc.wall_type);
    fields = (
      <>
        <Row label="Wall type">
          <Select label="Wall type" value={wt} options={['No-slip', 'Slip']} onChange={(v) => save({ wall_type: v })} />
        </Row>
        <div className="mat-assign-hint">{wallHint(wt)}</div>
      </>
    );
  } else {
    const unit = unitFor(bc.unit, PRESSURE_UNITS, imperial);
    fields = (
      <>
        <Row label="Pressure type">Fixed value</Row>
        <Row label="Fixed value">
          <ValueWithUnit
            label="Fixed value"
            value={bc.value ?? 0}
            unit={unit}
            units={PRESSURE_UNITS}
            onValue={(n) => save({ value: n, unit })}
            onUnit={(u) => save({ unit: u })}
          />
        </Row>
        <div className="mat-assign-hint">
          Sets pressure on the face. Flow can enter or leave depending on the rest of the case.
        </div>
      </>
    );
  }

  const unitNow = isVelocity(bc)
    ? unitFor(bc.unit, velocityUnits(bc.velocity_type || 'Fixed', bc.flow_rate_type || 'Volumetric flow'), imperial)
    : '';

  return (
    <div data-bc-editor="1" data-bc-id={id}>
      <div className="mat-panel-head">
        <span className="mat-panel-title" data-bc-title="1">
          {bc.name}
        </span>
      </div>
      <div className="mat-panel-body">
        <Row label="Type">
          <Select label="Boundary condition type" value={bc.bc_type} options={typeNames} onChange={(v) => save({ bc_type: v })} />
        </Row>
        {fields}
        <div className="mat-assign-block">
          <div className="mat-assign-head">
            <span className="mat-k">Assigned faces ({faces.length})</span>
            <button type="button" className="mat-clear-link" disabled={!faces.length} onClick={() => void clearBcFaces()}>
              Clear list
            </button>
          </div>
          <ul className="mat-assign-list" aria-label="Assigned faces" data-face-picker="1">
            {faces.map((f) => (
              <li key={f} className={`bc-assign-item${state.focus_face === f ? ' is-focus' : ''}`} data-face-id={f}>
                <button type="button" className="bc-assign-pick" onClick={() => focusBcFace(f)}>
                  {f}
                </button>
                <button type="button" className="bc-assign-x" aria-label={`Remove ${f}`} onClick={() => unassignBcFace(f)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="mat-assign-hint">Click a face in the viewport to assign it. It highlights when selected.</div>
          {isVelocity(bc) ? (
            <div className="mat-assign-hint" data-bc-per-face="1">
              {perFaceHint(faces.length, bc.value, unitNow)}
            </div>
          ) : null}
        </div>
        {note ? (
          <p className="mat-assign-hint" role="alert">
            {note}
          </p>
        ) : null}
        <div className="mat-panel-foot">
          <button
            type="button"
            className="mat-clear-link"
            title="Delete boundary condition"
            onClick={() => void deleteBc(id).catch((e) => report(e, setNote, 'Delete'))}
          >
            Delete
          </button>
          <DoneButton />
        </div>
      </div>
    </div>
  );
}

/** Registered for the hub, the "+" picker and the editor hosts. */
export function BcPanel(props: IslandProps) {
  if (props.panelId === 'panel-bc-editor') return <BcEditor />;
  if (props.panelId === 'panel-bc-picker') return <BcPicker />;
  return <BcHub />;
}
