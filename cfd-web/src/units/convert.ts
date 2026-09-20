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
  | 'kinematic_viscosity';

/** Multiplicative SI factors. Temperature is affine and handled in toSi/fromSi. */
export const UNITS: Record<Quantity, Record<string, number>> = {
  velocity: { 'm/s': 1.0, 'km/h': 1.0 / 3.6, mph: 0.44704, 'ft/s': 0.3048, 'ft/min': 0.3048 / 60 },
  pressure: {
    Pa: 1.0,
    kPa: 1e3,
    bar: 1e5,
    psi: 6894.757293168,
    'inH₂O': 249.08891,
    'mmH₂O': 9.80665,
  },
  volumetric_flow: {
    'm³/s': 1.0,
    'L/s': 1e-3,
    CFM: 0.00047194745,
    'ft3/min': 0.00047194745,
    'ft³/min': 0.00047194745,
    'm³/h': 1.0 / 3600.0,
  },
  mass_flow: { 'kg/s': 1.0, 'kg/h': 1.0 / 3600.0, 'lb/s': 0.45359237 },
  length: { m: 1.0, mm: 1e-3, cm: 1e-2, in: 0.0254, ft: 0.3048 },
  temperature: { K: 1.0, '°C': 1.0, '°F': 1.0 },
  time: { s: 1.0, min: 60.0, h: 3600.0 },
  angular_velocity: { 'rad/s': 1.0, rpm: (2.0 * Math.PI) / 60.0 },
  density: { 'kg/m³': 1.0, 'lb/ft³': 16.01846337 },
  kinematic_viscosity: { 'm²/s': 1.0, cSt: 1e-6, 'ft²/s': 0.09290304 },
};

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
  inh2o: 'inH₂O',
  'inH2O': 'inH₂O',
  'in H2O': 'inH₂O',
  mmh2o: 'mmH₂O',
  'mmH2O': 'mmH₂O',
};

export const IMPERIAL_DEFAULT: Record<Quantity, string> = {
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
};

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
  return /ft|in(?!t)|psi|lb|cfm|mph|°F/i.test(String(unit || ''));
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

export const SI_DEFAULT: Record<Quantity, string> = {
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
};

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
