/**
 * "Stop when a monitor settles": the quantities a run can watch while it solves
 * and the setting the Run panel saves (incompressible_flow/settle.py writes it as
 * an OpenFOAM runTimeControl; keep the two lists in step).
 *
 * OpenFOAM's condition is met when the quantity stays within an amount (in its
 * own unit) of its running average over the window, so the panel asks for an
 * amount, not a percentage.
 */
import type { RunSettleMonitor } from '../../../src/panels/legacyBridge';

export interface SettleQuantity {
  key: string;
  label: string;
  /** The tolerance's unit ('' for a coefficient). */
  unit: string;
  /** Tolerance a new choice starts with. */
  tolerance: number;
}

export interface SettleSetting {
  source: 'monitor' | 'boundary';
  id: string;
  quantity: string;
  tolerance: number;
  window: number;
}

export interface SettleChoice {
  source: 'monitor' | 'boundary';
  id: string;
  name: string;
  kind: string;
  quantity: SettleQuantity;
  label: string;
}

const PRESSURE: SettleQuantity = { key: 'p', label: 'Pressure', unit: 'Pa', tolerance: 1 };
const VELOCITY: SettleQuantity = { key: 'U', label: 'Velocity', unit: 'm/s', tolerance: 0.01 };

/** Per monitor kind (a result control's monitor_type, or 'boundary'). */
export const SETTLE_QUANTITIES: Record<string, readonly SettleQuantity[]> = {
  area_average: [PRESSURE, VELOCITY],
  boundary: [PRESSURE, VELOCITY, { key: 'Q', label: 'Flow rate', unit: 'm³/s', tolerance: 1e-6 }],
  forces: [
    { key: 'Cd', label: 'Cd', unit: '', tolerance: 0.001 },
    { key: 'Cl', label: 'Cl', unit: '', tolerance: 0.001 },
    { key: 'Cs', label: 'Cs', unit: '', tolerance: 0.001 },
    { key: 'Cm', label: 'Cm', unit: '', tolerance: 0.001 },
  ],
  probe: [
    { ...PRESSURE, label: 'Pressure (average of its points)' },
    { ...VELOCITY, label: 'Velocity (average of its points)' },
  ],
};

/** A monitor saved before monitor types is an area average when its words say so (monitors.py). */
const AREA_AVERAGE_WORDS = /area average|surface data/i;
/** The boundaries the case monitors: openings (function_objects.monitor_patches_from_mapped). */
const OPENING = /velocity\s*inlet|velocity\s*outlet|^\s*pressure|free\s*stream|far\s*field|total\s*pressure/i;

/** A monitor's kind for its quantities, or '' when the stop cannot watch it (or it is placed on nothing). */
export function settleKind(m: RunSettleMonitor): string {
  if (m.source === 'boundary') return OPENING.test(String(m.bc_type || '')) ? 'boundary' : '';
  if (m.targets === 0) return '';
  if (m.kind) return SETTLE_QUANTITIES[m.kind] ? m.kind : '';
  return AREA_AVERAGE_WORDS.test(`${m.words || ''} ${m.name || ''}`) ? 'area_average' : '';
}

/** Every monitor quantity the run can stop on, in the order its monitors are listed. */
export function settleChoices(monitors: readonly RunSettleMonitor[] | undefined): SettleChoice[] {
  const out: SettleChoice[] = [];
  for (const m of monitors || []) {
    const kind = settleKind(m);
    for (const q of SETTLE_QUANTITIES[kind] || []) {
      out.push({ source: m.source, id: m.id, name: m.name, kind, quantity: q, label: `${m.name} · ${q.label}` });
    }
  }
  return out;
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** The stored setting, or null when it is off or malformed. */
export function readSettle(raw: unknown): SettleSetting | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tolerance = num(r.tolerance);
  const window = num(r.window);
  if (!r.id || !r.quantity || tolerance === null || window === null) return null;
  return {
    source: r.source === 'boundary' ? 'boundary' : 'monitor',
    id: String(r.id),
    quantity: String(r.quantity),
    tolerance,
    window,
  };
}

/** The choice a setting watches, or null (its monitor is gone). */
export function choiceOf(choices: readonly SettleChoice[], s: SettleSetting | null): SettleChoice | null {
  if (!s) return null;
  return choices.find((c) => c.source === s.source && c.id === s.id && c.quantity.key === s.quantity) || null;
}

function positive(v: unknown): boolean {
  const n = num(v);
  return n !== null && n > 0;
}

/**
 * Why a saved stop would not be written, as far as the panel can tell before Start
 * (the plan's check, settle.py check_settle, has the last word once the run starts):
 * its monitor removed, placed on nothing or not one the case watches, or a force
 * coefficient without the study's reference area (Cm: length). '' when none is known.
 * `study` is the study's record (null: not known, those checks are left out).
 */
export function settleProblem(
  s: SettleSetting | null,
  choices: readonly SettleChoice[],
  monitors: readonly RunSettleMonitor[] | undefined,
  study: Record<string, unknown> | null | undefined,
): string {
  if (!s) return '';
  const chosen = choiceOf(choices, s);
  if (!chosen) {
    const m = (monitors || []).find((x) => x.id === s.id && x.source === s.source);
    if (!m) return s.source === 'boundary' ? 'the boundary it watches was deleted or has no faces' : 'the monitor it watches was deleted';
    if (m.source === 'boundary') return `${m.name} is not an inlet or outlet the case monitors`;
    if (m.targets === 0) return `${m.name} is not placed on anything yet`;
    return `${m.name} has no quantity the stop can watch`;
  }
  if (chosen.kind === 'forces' && study) {
    if (!positive(study.ref_area)) return "force coefficients need the study's reference area";
    if (chosen.quantity.key === 'Cm' && !positive(study.ref_length)) {
      return "the moment coefficient needs the study's reference length";
    }
  }
  return '';
}

/** A window a new choice starts with: 100 iterations, or one result frame's time. */
export function defaultWindow(transient: boolean, frameInterval: number): number {
  if (!transient) return 100;
  return frameInterval > 0 ? Number(frameInterval.toPrecision(6)) : 0.1;
}

/** "0.001", "1e-6": a number as the panel and the run's texts show it. */
export function settleNumber(x: number): string {
  return String(Number(x.toPrecision(6)));
}

/** "Forces 1 · Cd stays within 0.001 of its average over the last 100 iterations." */
export function settleSentence(choice: SettleChoice, s: SettleSetting, transient: boolean): string {
  const unit = choice.quantity.unit ? ` ${choice.quantity.unit}` : '';
  const span = transient ? `${settleNumber(s.window)} s` : `${Math.round(s.window)} iteration${Math.round(s.window) === 1 ? '' : 's'}`;
  return `${choice.label} stays within ${settleNumber(s.tolerance)}${unit} of its average over the last ${span}`;
}
