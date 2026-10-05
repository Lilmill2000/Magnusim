/**
 * Unit tables and conversions, shared by the core (src/units/convert.ts
 * re-exports this file) and plugins (through the kit). The tables are frozen,
 * so a plugin cannot change the core's conversions.
 */
export type Quantity =
  | 'velocity'
  | 'pressure'
  | 'volumetric_flow'
  | 'mass_flow'
  | 'length'
  | 'temperature'
  | 'time'
  | 'angular_velocity'
  | 'density'
  | 'kinematic_viscosity'
  | 'area';

/** The units a project or the Settings page shows (the workspace SDK's `units`). */
export type UnitSystem = 'metric' | 'imperial';

/** Multiplicative SI factors. Temperature is affine and handled in toSi/fromSi. */
export const UNITS: Readonly<Record<Quantity, Readonly<Record<string, number>>>> = Object.freeze({
  velocity: Object.freeze({ 'm/s': 1.0, 'km/h': 1.0 / 3.6, mph: 0.44704, 'ft/s': 0.3048, 'ft/min': 0.3048 / 60 }),
  pressure: Object.freeze({
    Pa: 1.0,
    kPa: 1e3,
    bar: 1e5,
    psi: 6894.757293168,
    'inH₂O': 249.08891,
    'mmH₂O': 9.80665,
  }),
  volumetric_flow: Object.freeze({
    'm³/s': 1.0,
    'L/s': 1e-3,
    CFM: 0.00047194745,
    'ft3/min': 0.00047194745,
    'ft³/min': 0.00047194745,
    'm³/h': 1.0 / 3600.0,
  }),
  mass_flow: Object.freeze({ 'kg/s': 1.0, 'kg/h': 1.0 / 3600.0, 'lb/s': 0.45359237 }),
  length: Object.freeze({ m: 1.0, mm: 1e-3, cm: 1e-2, in: 0.0254, ft: 0.3048 }),
  temperature: Object.freeze({ K: 1.0, '°C': 1.0, '°F': 1.0 }),
  time: Object.freeze({ s: 1.0, min: 60.0, h: 3600.0 }),
  angular_velocity: Object.freeze({ 'rad/s': 1.0, rpm: (2.0 * Math.PI) / 60.0 }),
  density: Object.freeze({ 'kg/m³': 1.0, 'lb/ft³': 16.01846337 }),
  kinematic_viscosity: Object.freeze({ 'm²/s': 1.0, cSt: 1e-6, 'ft²/s': 0.09290304 }),
  area: Object.freeze({ 'm²': 1.0, 'cm²': 1e-4, 'mm²': 1e-6, 'in²': 0.00064516, 'ft²': 0.09290304 }),
});

const UNIT_ALIASES: Record<string, string> = {
  'm2/s': 'm²/s',
  'm^2/s': 'm²/s',
  'ft2/s': 'ft²/s',
  'ft^2/s': 'ft²/s',
  'm3/s': 'm³/s',
  'm^3/s': 'm³/s',
  'ft3/min': 'ft³/min',
  'ft^3/min': 'ft³/min',
  'kg/m3': 'kg/m³',
  'lb/ft3': 'lb/ft³',
  m2: 'm²',
  'm^2': 'm²',
  cm2: 'cm²',
  mm2: 'mm²',
  in2: 'in²',
  ft2: 'ft²',
  'ft^2': 'ft²',
  inh2o: 'inH₂O',
  'inH2O': 'inH₂O',
  'in H2O': 'inH₂O',
  mmh2o: 'mmH₂O',
  'mmH2O': 'mmH₂O',
};

export const IMPERIAL_DEFAULT: Readonly<Record<Quantity, string>> = Object.freeze({
  velocity: 'ft/s',
  pressure: 'psi',
  volumetric_flow: 'ft³/min',
  mass_flow: 'lb/s',
  length: 'in',
  temperature: '°F',
  time: 's',
  angular_velocity: 'rpm',
  density: 'lb/ft³',
  kinematic_viscosity: 'ft²/s',
  area: 'ft²',
});

export function resolveUnit(quantity: Quantity, unit: string): string {
  const raw = String(unit || '').trim();
  const table = UNITS[quantity];
  if (raw in table) return raw;
  const alias = UNIT_ALIASES[raw] || UNIT_ALIASES[raw.replace(/\s+/g, '')];
  if (alias && alias in table) return alias;
  const lower = raw.toLowerCase();
  const hit = Object.keys(table).find((k) => k.toLowerCase() === lower);
  return hit || raw;
}

export function preferredUnit(quantity: Quantity, imperial: boolean): string {
  return imperial ? IMPERIAL_DEFAULT[quantity] : SI_DEFAULT[quantity];
}

export function unitIsImperial(unit: string): boolean {
  // "in" only as its own word or inH₂O, never inside one (min, mmH₂O are not imperial).
  return /ft|(?:^|[^a-z])in(?:$|[^a-z]|h)|psi|lb|cfm|mph|°F/i.test(String(unit || ''));
}

export function convertQuantity(
  quantity: Quantity,
  value: number,
  fromUnit: string,
  toUnit: string,
): number {
  if (!Number.isFinite(value)) return value;
  const from = resolveUnit(quantity, fromUnit);
  const to = resolveUnit(quantity, toUnit);
  if (from === to) return value;
  return fromSi(quantity, toSi(quantity, value, from), to);
}

export const SI_DEFAULT: Readonly<Record<Quantity, string>> = Object.freeze({
  velocity: 'm/s',
  pressure: 'Pa',
  volumetric_flow: 'm³/s',
  mass_flow: 'kg/s',
  length: 'm',
  temperature: 'K',
  time: 's',
  angular_velocity: 'rad/s',
  density: 'kg/m³',
  kinematic_viscosity: 'm²/s',
  area: 'm²',
});

export function unitLabels(quantity: Quantity): string[] {
  return Object.keys(UNITS[quantity]);
}

export function toSi(quantity: Quantity, value: number, unit: string): number {
  const resolved = resolveUnit(quantity, unit);
  if (quantity === 'temperature') {
    if (resolved === 'K') return value;
    if (resolved === '°C') return value + 273.15;
    if (resolved === '°F') return ((value - 32.0) * 5.0) / 9.0 + 273.15;
    throw new Error(`unknown temperature unit ${unit}`);
  }
  const table = UNITS[quantity];
  if (!(resolved in table)) throw new Error(`unknown ${quantity} unit ${unit}`);
  return value * table[resolved];
}

export function fromSi(quantity: Quantity, valueSi: number, unit: string): number {
  const resolved = resolveUnit(quantity, unit);
  if (quantity === 'temperature') {
    if (resolved === 'K') return valueSi;
    if (resolved === '°C') return valueSi - 273.15;
    if (resolved === '°F') return ((valueSi - 273.15) * 9.0) / 5.0 + 32.0;
    throw new Error(`unknown temperature unit ${unit}`);
  }
  const table = UNITS[quantity];
  if (!(resolved in table)) throw new Error(`unknown ${quantity} unit ${unit}`);
  return valueSi / table[resolved];
}

/**
 * SI labels of quantities results carry that no input uses (turbulence fields).
 * The fallback for a result field whose analysis names no `unit` of its own (API 1.4).
 */
const RESULT_SI: Record<string, string> = {
  specific_energy: 'm²/s²',
  specific_dissipation_rate: '1/s',
  dissipation_rate: 'm²/s³',
};

/**
 * The SI unit label a result field of this quantity is shown in ('' when the
 * quantity is unknown). Results are drawn in SI; a kinematic field has already
 * been scaled to its quantity (Pa for pressure) by the exporter. Results use it
 * only for a field whose analysis names no `unit` (API 1.4 `ResultField.unit`).
 */
export function siUnitLabel(quantity: string): string {
  const q = String(quantity || '');
  if (q in SI_DEFAULT) return SI_DEFAULT[q as Quantity];
  return RESULT_SI[q] || '';
}

/**
 * The unit a schema form shows a number field in: length in mm or in, every
 * other quantity in its first (SI) unit, in either system.
 */
export function fieldUnit(q: Quantity, units: UnitSystem): string {
  return q === 'length' ? (units === 'imperial' ? 'in' : 'mm') : unitLabels(q)[0];
}

/** A schema field's quantity (its x-cfddesk.quantity), or null. */
export function fieldQuantity(schema: unknown): Quantity | null {
  const x = schema ? (schema as { 'x-cfddesk'?: { quantity?: string } })['x-cfddesk'] : undefined;
  return (x && (x.quantity as Quantity)) || null;
}
