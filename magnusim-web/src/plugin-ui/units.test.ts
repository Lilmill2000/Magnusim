import { describe, expect, it } from 'vitest';
import * as convert from '../units/convert';
import * as units from './units';
import { IMPERIAL_DEFAULT, METRIC_DEFAULT, SI_DEFAULT, UNITS, fieldQuantity, fieldUnit, type Quantity } from './units';

// Every export src/units/convert.ts had before the move to the kit.
const OLD_EXPORTS = [
  'UNITS',
  'IMPERIAL_DEFAULT',
  'SI_DEFAULT',
  'resolveUnit',
  'preferredUnit',
  'unitIsImperial',
  'convertQuantity',
  'unitLabels',
  'toSi',
  'fromSi',
  'siUnitLabel',
] as const;

const QUANTITIES = Object.keys(UNITS) as Quantity[];

describe('units (moved from src/units/convert.ts)', () => {
  it('src/units/convert.ts still exports every old name, the same objects', () => {
    const old = convert as unknown as Record<string, unknown>;
    const now = units as unknown as Record<string, unknown>;
    for (const name of OLD_EXPORTS) {
      expect(old[name], name).toBeDefined();
      expect(old[name], name).toBe(now[name]);
    }
    expect(old.fieldUnit).toBe(fieldUnit);
    expect(old.fieldQuantity).toBe(fieldQuantity);
  });

  it('freezes the shared tables, so a write throws', () => {
    expect(Object.isFrozen(UNITS)).toBe(true);
    for (const q of QUANTITIES) expect(Object.isFrozen(UNITS[q]), q).toBe(true);
    expect(Object.isFrozen(IMPERIAL_DEFAULT)).toBe(true);
    expect(Object.isFrozen(SI_DEFAULT)).toBe(true);
    // Modules run in strict mode: writing a frozen property throws.
    expect(() => {
      (UNITS.length as Record<string, number>).mm = 2;
    }).toThrow(TypeError);
    expect(() => {
      (UNITS as Record<string, unknown>).length = {};
    }).toThrow(TypeError);
    expect(() => {
      (IMPERIAL_DEFAULT as Record<string, string>).length = 'ft';
    }).toThrow(TypeError);
    expect(() => {
      (SI_DEFAULT as Record<string, string>).pressure = 'bar';
    }).toThrow(TypeError);
    expect(UNITS.length.mm).toBe(1e-3);
    expect(IMPERIAL_DEFAULT.length).toBe('in');
    expect(SI_DEFAULT.pressure).toBe('Pa');
  });

  it('unitIsImperial: imperial units only, not min or mmH₂O', () => {
    for (const u of ['in', 'ft', 'ft/s', 'ft/min', 'mph', 'psi', 'inH₂O', 'inH2O', 'in H2O', 'inh2o', 'ft³/min', 'CFM', 'lb/s', 'lb/ft³', 'ft²/s', '°F']) {
      expect(units.unitIsImperial(u), u).toBe(true);
    }
    for (const u of ['min', 'h', 's', 'mm', 'm', 'm/s', 'mmH₂O', 'Pa', 'kPa', 'kg/min', 'rpm', 'rad/s', '°C', 'K', 'W/m²', 'kW', 'J/(kg·K)', '']) {
      expect(units.unitIsImperial(u), u).toBe(false);
    }
    // A time field in an imperial project keeps seconds (IMPERIAL_DEFAULT.time).
    expect(units.unitLabels('time').find((u) => units.unitIsImperial(u))).toBeUndefined();
  });

  it('fieldUnit: length in mm or in, temperature in °C or °F, every other quantity in its first unit', () => {
    expect(fieldUnit('length', 'metric')).toBe('mm');
    expect(fieldUnit('length', 'imperial')).toBe('in');
    for (const q of QUANTITIES.filter((x) => x !== 'length' && x !== 'temperature')) {
      expect(fieldUnit(q, 'metric'), q).toBe(Object.keys(UNITS[q])[0]);
      expect(fieldUnit(q, 'imperial'), q).toBe(Object.keys(UNITS[q])[0]);
    }
    expect(fieldUnit('pressure', 'imperial')).toBe('Pa');
    // API 1.8 (Heat Transfer): temperatures are typed in the unit system's unit, stored in K.
    expect(fieldUnit('temperature', 'metric')).toBe('°C');
    expect(fieldUnit('temperature', 'imperial')).toBe('°F');
  });

  it('metric shows SI except temperature in °C; SI_DEFAULT stays the storage unit (K)', () => {
    expect(Object.isFrozen(METRIC_DEFAULT)).toBe(true);
    expect(units.preferredUnit('temperature', false)).toBe('°C');
    expect(units.preferredUnit('temperature', true)).toBe('°F');
    expect(SI_DEFAULT.temperature).toBe('K');
    expect(units.siUnitLabel('temperature')).toBe('K');
    for (const q of QUANTITIES.filter((x) => x !== 'temperature')) {
      expect(METRIC_DEFAULT[q], q).toBe(SI_DEFAULT[q]);
    }
  });

  it('every quantity has its SI unit first (factor 1), an imperial unit and a metric unit it knows', () => {
    for (const q of QUANTITIES) {
      const table = UNITS[q];
      expect(Object.keys(table)[0], q).toBe(SI_DEFAULT[q]);
      expect(table[SI_DEFAULT[q]], q).toBe(1);
      expect(IMPERIAL_DEFAULT[q] in table, q).toBe(true);
      expect(METRIC_DEFAULT[q] in table, q).toBe(true);
    }
  });

  it('heat transfer units convert to SI', () => {
    const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);
    near(units.toSi('heat_flux', 1, 'BTU/(h·ft²)'), 3.154591);
    near(units.toSi('heat_transfer_coefficient', 1, 'BTU/(h·ft²·°F)'), 5.678263);
    near(units.toSi('thermal_conductivity', 1, 'BTU/(h·ft·°F)'), 1.730735);
    near(units.toSi('specific_heat', 1, 'BTU/(lb·°F)'), 4186.8);
    near(units.toSi('power', 1, 'BTU/h'), 0.293071);
    near(units.toSi('power_density', 1, 'BTU/(h·ft³)'), 10.349707);
    near(units.toSi('thermal_expansion', 1, '1/°F'), 1.8);
    near(units.toSi('dynamic_viscosity', 1, 'cP'), 1e-3);
    near(units.toSi('acceleration', 10, 'ft/s²'), 3.048);
    expect(units.resolveUnit('heat_transfer_coefficient', 'W/m2K')).toBe('W/(m²·K)');
    expect(units.resolveUnit('thermal_conductivity', 'W/mK')).toBe('W/(m·K)');
    expect(units.unitIsImperial('BTU/h')).toBe(true);
    expect(units.unitIsImperial('hp')).toBe(true);
    expect(units.unitIsImperial('W/(m²·K)')).toBe(false);
  });

  it("fieldQuantity reads a schema field's x-cfddesk.quantity", () => {
    expect(fieldQuantity({ type: 'number', 'x-cfddesk': { quantity: 'velocity' } })).toBe('velocity');
    expect(fieldQuantity({ type: 'number', 'x-cfddesk': {} })).toBeNull();
    expect(fieldQuantity({ type: 'number' })).toBeNull();
    expect(fieldQuantity(undefined)).toBeNull();
    expect(fieldQuantity(null)).toBeNull();
  });
});
