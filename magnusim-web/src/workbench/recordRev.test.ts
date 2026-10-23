/** A record's rev on the page (phase 5, C2): base_rev from the record, the stale answer, and saves of one record one at a time. */
import { describe, expect, it } from 'vitest';
import { isStaleRecord, revOf, serialSave, withBaseRev } from './recordRev';

describe('revOf and withBaseRev', () => {
  it('reads a whole-number rev, else none', () => {
    expect(revOf({ rev: 4 })).toBe(4);
    expect(revOf({ rev: 0 })).toBe(0);
    expect(revOf({ rev: 1.5 })).toBeNull();
    expect(revOf({})).toBeNull();
    expect(revOf(null)).toBeNull();
  });

  it("sends the record's rev as base_rev and never its own rev", () => {
    expect(withBaseRev({ id: 'a', v: 1, rev: 3 })).toEqual({ id: 'a', v: 1, base_rev: 3 });
    expect(withBaseRev({ id: 'a', rev: 3 }, { rev: 7 })).toEqual({ id: 'a', base_rev: 7 });
    // No rev known: sent as before.
    expect(withBaseRev({ id: 'a' })).toEqual({ id: 'a' });
    expect(withBaseRev({ id: 'a', rev: 2 }, null)).toEqual({ id: 'a' });
  });

  it('tells a stale refusal (its JSON, or the error a worker call threw)', () => {
    expect(isStaleRecord({ code: 'stale_record' })).toBe(true);
    expect(isStaleRecord(Object.assign(new Error('x'), { code: 'stale_record' }))).toBe(true);
    expect(isStaleRecord({ code: 'geometry_changed' })).toBe(false);
    expect(isStaleRecord(null)).toBe(false);
  });
});

describe('serialSave', () => {
  it('runs the saves of one key one after the other, a failed one included, and other keys at once', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const first = serialSave('k', () => new Promise<void>((r) => (release = () => {
      order.push('first');
      r();
    })));
    const failing = serialSave('k', async () => {
      order.push('second');
      throw new Error('no');
    });
    const third = serialSave('k', async () => {
      order.push('third');
      return 3;
    });
    const other = serialSave('other', async () => {
      order.push('other');
    });
    await other;
    expect(order).toEqual(['other']);
    release();
    await first;
    await expect(failing).rejects.toThrow('no');
    await expect(third).resolves.toBe(3);
    expect(order).toEqual(['other', 'first', 'second', 'third']);
  });
});
