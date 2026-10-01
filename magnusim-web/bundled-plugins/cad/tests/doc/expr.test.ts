// Unit-aware expressions and parameters: arithmetic, units, functions,
// references, cycles, error messages, renaming.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { namesIn, renameInExpr } from '../../src/doc/expr';
import { createParamScope, evaluateIn, paramNameProblem, usersOfParam } from '../../src/doc/params';
import { emptyDoc } from '../../src/doc/schema';
import { createUnitsService } from '../../src/doc/units';
import type { CadDoc, Param } from '../../src/types/doc';
import type { DocUnits, Quantity } from '../../src/types/units';

const MM: DocUnits = { length: 'mm', angle: 'deg' };
const IN: DocUnits = { length: 'in', angle: 'deg' };

function p(name: string, expr: string, quantity: Quantity = 'length'): Param {
  return { id: `p_${name}`, name, expr, quantity };
}

function ev(text: string, quantity: Quantity = 'length', params: Param[] = [], units: DocUnits = MM) {
  return evaluateIn({ params, units }, text, quantity);
}

function val(text: string, quantity: Quantity = 'length', params: Param[] = [], units: DocUnits = MM): number {
  const r = ev(text, quantity, params, units);
  if (!r.ok) throw new Error(`${text}: ${r.error}`);
  return r.value;
}

describe('expressions: numbers and units', () => {
  it('reads every length and angle unit into mm and degrees', () => {
    expect(val('20 mm')).toBe(20);
    expect(val('2cm')).toBe(20);
    expect(val('0.5 m')).toBe(500);
    expect(val('2 in')).toBeCloseTo(50.8, 12);
    expect(val('1 ft')).toBeCloseTo(304.8, 12);
    expect(val('1.5e1 mm')).toBe(15);
    expect(val('.5 in')).toBeCloseTo(12.7, 12);
    expect(val('30 deg', 'angle')).toBe(30);
    expect(val('15°', 'angle')).toBe(15);
    expect(val('1 rad', 'angle')).toBeCloseTo(180 / Math.PI, 12);
    expect(val('20 MM')).toBe(20);
  });

  it('a unitless number takes the document display unit', () => {
    expect(val('20')).toBe(20);
    expect(val('20', 'length', [], IN)).toBeCloseTo(508, 12);
    expect(val('10 * 2', 'length', [], IN)).toBeCloseTo(508, 12);
    expect(val('45', 'angle', [], { length: 'mm', angle: 'rad' })).toBeCloseTo((45 * 180) / Math.PI, 9);
    // Mixed: the bare number beside a length is in the display unit.
    expect(val('1 in + 1', 'length', [], IN)).toBeCloseTo(50.8, 12);
    expect(val('10 mm + 5')).toBe(15);
    expect(val('1 in + 5 mm')).toBeCloseTo(30.4, 12);
  });

  it('arithmetic, precedence, powers and parentheses', () => {
    expect(val('2 + 3 * 4', 'scalar')).toBe(14);
    expect(val('(2 + 3) * 4', 'scalar')).toBe(20);
    expect(val('2^3^2', 'scalar')).toBe(512);
    expect(val('-2^2', 'scalar')).toBe(-4);
    expect(val('2^-1', 'scalar')).toBe(0.5);
    expect(val('10 mm / 4')).toBe(2.5);
    expect(val('(2 + 3) mm')).toBe(5);
    expect(val('sqrt((3 mm)^2 + (4 mm)^2)')).toBeCloseTo(5, 12);
    expect(val('--5 mm')).toBe(5);
    expect(val('2 mm * 3 mm / 1 mm')).toBe(6);
  });

  it('functions and pi', () => {
    expect(val('sin(30 deg)', 'scalar')).toBeCloseTo(0.5, 12);
    expect(val('cos(pi rad)', 'scalar')).toBeCloseTo(-1, 12);
    expect(val('tan(45)', 'scalar')).toBeCloseTo(1, 12);
    expect(val('10 mm * sin(90)')).toBeCloseTo(10, 12);
    expect(val('abs(-3 mm)')).toBe(3);
    expect(val('min(3 mm, 1 in, 20)')).toBe(3);
    expect(val('max(3 mm, 1 in)')).toBeCloseTo(25.4, 12);
    expect(val('max(1, 2)', 'length', [], IN)).toBeCloseTo(50.8, 12);
    expect(val('2 * pi', 'scalar')).toBeCloseTo(2 * Math.PI, 12);
    expect(val('sqrt(16)', 'scalar')).toBe(4);
  });

  it('says what is wrong, and where', () => {
    const cases: [string, Quantity, RegExp][] = [
      ['', 'length', /^Enter a value$/],
      ['20 +', 'length', /incomplete/],
      ['(20 mm', 'length', /^Missing "\)"$/],
      ['20 mm)', 'length', /without a matching/],
      ['3 parsecs', 'length', /"parsecs" is not a unit/],
      ['20 mm 5', 'length', /Expected an operator/],
      ['15 deg', 'length', /^Expected a length, got an angle$/],
      ['2 mm * 3 mm', 'length', /^Expected a length, got an area$/],
      ['20 mm', 'scalar', /^Expected a number without units, got a length$/],
      ['10 mm + 5 deg', 'length', /Cannot add a length and an angle/],
      ['1 / 0', 'scalar', /Division by zero/],
      ['sqrt(-1)', 'scalar', /negative/],
      ['sqrt(2 mm)', 'length', /square root of a length/],
      ['sin(2 mm)', 'scalar', /sin takes an angle/],
      ['sin', 'scalar', /sin needs parentheses/],
      ['foo(2)', 'scalar', /Unknown function "foo"/],
      ['widht * 2', 'length', /Unknown parameter "widht"/],
      ['mm', 'length', /is a unit/],
      ['2 mm ^ 0.5', 'length', /Cannot raise a length to the power 0.5/],
      ['3 # 4', 'scalar', /"#" is not allowed/],
      ['tan(90 deg) * 1e300 * 1e300', 'scalar', /finite/],
    ];
    for (const [text, q, re] of cases) {
      const r = ev(text, q);
      expect(r.ok, text).toBe(false);
      if (!r.ok) expect(r.error, text).toMatch(re);
    }
    const r = ev('20 mm + widht');
    expect(r).toMatchObject({ ok: false, at: 8 });
  });
});

describe('parameters', () => {
  const params = [p('width', '50 mm'), p('height', 'width / 2 + 5'), p('angle', '30 deg', 'angle'), p('count', '4', 'scalar'), p('pitch', 'width / count')];

  it('resolve through each other, with their own quantity', () => {
    expect(val('width', 'length', params)).toBe(50);
    expect(val('height', 'length', params)).toBe(30);
    expect(val('pitch * 2', 'length', params)).toBe(25);
    expect(val('width * sin(angle)', 'length', params)).toBeCloseTo(25, 12);
    expect(val('count + 1', 'scalar', params)).toBe(5);
    const r = ev('height + width', 'length', params);
    expect(r).toMatchObject({ ok: true, uses: ['height', 'width'] });
    // In an inch part the bare 5 in "width / 2 + 5" is 5 in.
    expect(val('height', 'length', params, IN)).toBeCloseTo(25 + 127, 9);
  });

  it('finds cycles and says them in order', () => {
    const cyc = [p('a', 'b + 1'), p('b', 'c * 2'), p('c', 'a')];
    const r = ev('a', 'length', cyc);
    expect(r).toMatchObject({ ok: false, error: 'Circular reference: a → b → c → a' });
    const self = createParamScope([p('x', 'x + 1')], MM).valueOf('x');
    expect(self).toMatchObject({ ok: false, error: 'Circular reference: x → x' });
  });

  it('a parameter with an error makes its users fail, naming it', () => {
    const r = ev('w2', 'length', [p('w', '2 deg'), p('w2', 'w * 2')]);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.error).toMatch(/Parameter "w" has an error: Expected a length, got an angle/);
  });

  it('names: rules, reserved words, clashes', () => {
    expect(paramNameProblem('width', [])).toBeNull();
    expect(paramNameProblem('_w2', [])).toBeNull();
    expect(paramNameProblem('2w', [])).toMatch(/starts with a letter/);
    expect(paramNameProblem('my width', [])).toMatch(/only letters/);
    expect(paramNameProblem('mm', [])).toMatch(/unit or function/);
    expect(paramNameProblem('Sin', [])).toMatch(/unit or function/);
    expect(paramNameProblem('PI', [])).toMatch(/unit or function/);
    expect(paramNameProblem('width', [p('width', '1')])).toMatch(/already a parameter/);
    expect(paramNameProblem('width', [p('width', '1')], 'p_width')).toBeNull();
    expect(paramNameProblem('', [])).toBe('Enter a name');
  });

  it('rename keeps functions, units and other names', () => {
    expect(renameInExpr('w * 2 + sin(w) + 2 w2', 'w', 'width')).toBe('width * 2 + sin(width) + 2 w2');
    expect(renameInExpr('width/2', 'width', 'breadth')).toBe('breadth/2');
    expect(renameInExpr('min(a, 2 mm)', 'min', 'x')).toBe('min(a, 2 mm)');
    expect(namesIn('a + b * sin(c) + pi')).toEqual(['a', 'b', 'c']);
  });

  it('usersOfParam lists parameters and features that read it', () => {
    const doc: CadDoc = {
      ...emptyDoc('metric'),
      params: [p('w', '10'), p('h', 'w * 2')],
      features: [{ id: 'f_1', type: 'box', name: 'Box 1', op: 'new', creates: 'b_1', scope: [], origin: ['0', '0', '0'], size: ['w', '10', '10'] }],
    };
    const u = usersOfParam(doc, 'w');
    expect(u.params.map((x) => x.name)).toEqual(['h']);
    expect(u.features.map((x) => x.name)).toEqual(['Box 1']);
  });
});

describe('units service', () => {
  it('evaluates against the current parameters and formats in display units', () => {
    let params = [p('w', '1 in')];
    let units: DocUnits = IN;
    const s = createUnitsService(
      () => units,
      () => params,
    );
    expect(s.evaluate('w * 2', 'length')).toMatchObject({ ok: true, value: 50.8 });
    params = [p('w', '2 in')];
    expect(s.evaluate('w * 2', 'length')).toMatchObject({ ok: true, value: 101.6 });
    expect(s.format(50.8, 'length')).toBe('2 in');
    units = MM;
    expect(s.format(50.8, 'length')).toBe('50.8 mm');
    expect(s.unitLabel('angle')).toBe('°');
  });
});
