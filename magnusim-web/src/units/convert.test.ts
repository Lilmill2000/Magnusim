import { describe, expect, it } from 'vitest';
import { convertQuantity, fromSi, toSi, UNITS } from './convert';

describe('units convert', () => {
  it('matches Python multiplicative tables', () => {
    expect(UNITS.velocity['m/s']).toBe(1);
    expect(UNITS.velocity['km/h']).toBeCloseTo(1 / 3.6);
    expect(UNITS.pressure.psi).toBeCloseTo(6894.757293168);
    expect(UNITS.pressure['inH₂O']).toBeCloseTo(249.08891);
    expect(UNITS.length.mm).toBeCloseTo(0.001);
    expect(UNITS.length.in).toBeCloseTo(0.0254);
    expect(UNITS.time.min).toBe(60);
    expect(UNITS.angular_velocity.rpm).toBeCloseTo((2 * Math.PI) / 60);
    expect(UNITS.density['lb/ft³']).toBeCloseTo(16.01846337);
  });

  it('converts temperature affinely', () => {
    expect(toSi('temperature', 0, '°C')).toBeCloseTo(273.15);
    expect(fromSi('temperature', 273.15, '°C')).toBeCloseTo(0);
    expect(toSi('temperature', 32, '°F')).toBeCloseTo(273.15);
  });

  it('round-trips length and velocity', () => {
    expect(fromSi('length', toSi('length', 25, 'mm'), 'mm')).toBeCloseTo(25);
    expect(fromSi('velocity', toSi('velocity', 10, 'm/s'), 'm/s')).toBeCloseTo(10);
  });

  it('converts metric velocity and pressure to US customary', () => {
    expect(fromSi('velocity', toSi('velocity', 5, 'm/s'), 'ft/s')).toBeCloseTo(16.4042, 3);
    expect(fromSi('pressure', toSi('pressure', 101325, 'Pa'), 'psi')).toBeCloseTo(14.6959, 3);
    expect(fromSi('velocity', toSi('velocity', 60, 'ft/min'), 'ft/s')).toBeCloseTo(1, 5);
    expect(convertQuantity('velocity', 5, 'm/s', 'ft/s')).toBeCloseTo(16.4042, 3);
    expect(convertQuantity('pressure', 0, 'Pa', 'psi')).toBe(0);
    expect(convertQuantity('length', 25.4, 'mm', 'in')).toBeCloseTo(1, 5);
  });
});
