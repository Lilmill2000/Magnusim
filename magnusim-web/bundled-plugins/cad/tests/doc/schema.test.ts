// readDoc never leaves part of a stored document out without a word (P1.5
// review round 1: a parameter with no id was dropped, and the moved Part then
// saved without it while the chip said Saved).
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { DocReadError, readDoc } from '../../src/doc/schema';

const base = () => ({
  schema: 1,
  units: { length: 'mm', angle: 'deg' },
  params: [{ id: 'p_w', name: 'w', expr: '30 mm', quantity: 'length' }],
  bodies: { b_1: { name: 'Body 1', color: '#bdc9db' } },
  features: [{ id: 'f_1', type: 'box', name: 'Old box', op: 'new', creates: 'b_1', scope: [], origin: ['0 mm', '0 mm', '0 mm'], size: ['w', '20 mm', '10 mm'] }],
  meta: { created_at: '2026-09-30T19:00:00.000Z', written_by: '0.1.0' },
});

const reason = (raw: unknown): string => {
  try {
    readDoc(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(DocReadError);
    return (e as Error).message;
  }
  throw new Error('readDoc accepted it');
};

describe('readDoc', () => {
  it('keeps a whole document as it is', () => {
    const d = readDoc(base());
    expect(d.params).toEqual(base().params);
    expect(d.features).toEqual(base().features);
    expect(d.bodies).toEqual(base().bodies);
  });

  it('gives a parameter or a feature with no id one, and keeps everything else of it', () => {
    const raw = base();
    delete (raw.params[0] as { id?: string }).id;
    delete (raw.features[0] as { id?: string }).id;
    const d = readDoc(raw);
    expect(d.params).toHaveLength(1);
    expect(d.params[0]).toMatchObject({ name: 'w', expr: '30 mm', quantity: 'length', id: expect.stringMatching(/^p_[0-9a-z]{12}$/) });
    expect(d.features).toHaveLength(1);
    expect(d.features[0]).toMatchObject({ name: 'Old box', type: 'box', size: ['w', '20 mm', '10 mm'], id: expect.stringMatching(/^f_[0-9a-z]{12}$/) });
  });

  it('refuses, naming it, a parameter or feature it cannot read, instead of leaving it out', () => {
    const noQuantity = base();
    noQuantity.params = [{ name: 'w', expr: '30 mm' } as never];
    expect(reason(noQuantity)).toBe('parameter "w" does not say whether it is a length, an angle or a number');
    const noName = base();
    noName.params.push({ id: 'p_2', expr: '1', quantity: 'scalar' } as never);
    expect(reason(noName)).toBe('parameter 2 has no name');
    const noExpr = base();
    noExpr.params = [{ id: 'p_1', name: 'h', quantity: 'length' } as never];
    expect(reason(noExpr)).toBe('parameter "h" has no expression');
    const junk = base();
    junk.params = ['w = 30' as never];
    expect(reason(junk)).toBe('parameter 1 is not a parameter');
    const noType = base();
    noType.features = [{ id: 'f_1', name: 'Odd' } as never];
    expect(reason(noType)).toBe('feature "Odd" has no type');
    const unnamed = base();
    unnamed.features.push({ id: 'f_2', type: 'box' } as never);
    expect(reason(unnamed)).toBe('feature 2 has no name');
    const notList = base();
    notList.params = { w: '30 mm' } as never;
    expect(reason(notList)).toBe('its parameters are not a list');
  });

  it('a body entry it cannot read keeps its id with the default name and colour', () => {
    const raw = base();
    (raw.bodies as Record<string, unknown>).b_1 = 'Body 1';
    expect(readDoc(raw).bodies).toEqual({ b_1: { name: 'Body', color: '#bdc9db' } });
  });

  it('a feature of a type this version does not build is kept (the rebuild says so)', () => {
    const raw = base();
    raw.features.push({ id: 'f_2', type: 'sketch', name: 'Sketch 1' } as never);
    expect(readDoc(raw).features.map((f) => f.type)).toEqual(['box', 'sketch']);
  });
});
