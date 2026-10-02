import { describe, expect, it } from 'vitest';
import * as convert from '../units/convert';
import * as units from './units';
import { IMPERIAL_DEFAULT, SI_DEFAULT, UNITS, fieldQuantity, fieldUnit, type Quantity } from './units';

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
    for (const u of ['min', 'h', 's', 'mm', 'm', 'm/s', 'mmH₂O', 'Pa', 'kPa', 'kg/min', 'rpm', 'rad/s', '°C', 'K', '']) {
      expect(units.unitIsImperial(u), u).toBe(false);
    }
    // A time field in an imperial project keeps seconds (IMPERIAL_DEFAULT.time).
    expect(units.unitLabels('time').find((u) => units.unitIsImperial(u))).toBeUndefined();
  });

  it('fieldUnit: length in mm or in, every other quantity in its first unit', () => {
    expect(fieldUnit('length', 'metric')).toBe('mm');
    expect(fieldUnit('length', 'imperial')).toBe('in');
    for (const q of QUANTITIES.filter((x) => x !== 'length')) {
      expect(fieldUnit(q, 'metric'), q).toBe(Object.keys(UNITS[q])[0]);
      expect(fieldUnit(q, 'imperial'), q).toBe(Object.keys(UNITS[q])[0]);
    }
    expect(fieldUnit('pressure', 'imperial')).toBe('Pa');
    expect(fieldUnit('temperature', 'imperial')).toBe('K');
  });

  it("fieldQuantity reads a schema field's x-cfddesk.quantity", () => {
    expect(fieldQuantity({ type: 'number', 'x-cfddesk': { quantity: 'velocity' } })).toBe('velocity');
    expect(fieldQuantity({ type: 'number', 'x-cfddesk': {} })).toBeNull();
    expect(fieldQuantity({ type: 'number' })).toBeNull();
    expect(fieldQuantity(undefined)).toBeNull();
    expect(fieldQuantity(null)).toBeNull();
  });
});
