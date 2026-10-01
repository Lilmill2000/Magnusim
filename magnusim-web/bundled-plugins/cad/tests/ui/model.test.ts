// Design tree data: history order, the rollback bar, bodies and selection sync.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { BodyInfo } from '../../src/types/kernel';
import type { Feature } from '../../src/types/doc';
import { barIndexAt, bodyRows, historyRows, rollbackIndex, rollbackValue, selectedBodies, selectedFeatures } from '../../src/ui/tree/model';

const box = (id: string, name: string, extra: Partial<Feature> = {}): Feature =>
  ({ id, type: 'box', name, op: 'new', creates: `b_${id}`, scope: [], origin: ['0', '0', '0'], size: ['1', '1', '1'], ...extra }) as Feature;
const cyl = (id: string, name: string, extra: Partial<Feature> = {}): Feature =>
  ({ id, type: 'cylinder', name, op: 'join', creates: null, scope: [], origin: ['0', '0', '0'], axis: 'origin:z', diameter: '1', height: '1', ...extra }) as Feature;

const body = (id: string, feature: string, name = id): BodyInfo =>
  ({ id, name, color: '#bdc9db', feature, shape: 1, valid: true, faces: 6, edges: 12, bbox: [0, 0, 0, 1, 1, 1], volume: 1, area: 6, visible: true, tessKey: id, tess: null }) as unknown as BodyInfo;

describe('history rows', () => {
  const features = [box('f1', 'Box 1'), cyl('f2', 'Cylinder 1'), box('f3', 'Box 2')];

  it('keeps the document order, whatever the rebuild order or names', () => {
    const rows = historyRows({ features: [features[2], features[0], features[1]] }, { rollback: null }, { features: {} });
    expect(rows.map((r) => r.name)).toEqual(['Box 2', 'Box 1', 'Cylinder 1']);
    expect(rows.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.type)).toEqual(['box', 'box', 'cylinder']);
  });

  it('marks rows at or below the rollback bar as rolled back', () => {
    expect(historyRows({ features }, { rollback: null }, { features: {} }).map((r) => r.rolledBack)).toEqual([false, false, false]);
    expect(historyRows({ features }, { rollback: 2 }, { features: {} }).map((r) => r.rolledBack)).toEqual([false, false, true]);
    expect(historyRows({ features }, { rollback: 0 }, { features: {} }).map((r) => r.rolledBack)).toEqual([true, true, true]);
    // Out of range values clamp (a stale view after a delete).
    expect(historyRows({ features }, { rollback: 9 }, { features: {} }).map((r) => r.rolledBack)).toEqual([false, false, false]);
  });

  it('carries suppression and the rebuild outcome with its message', () => {
    const rows = historyRows(
      { features: [box('f1', 'Box 1'), cyl('f2', 'Cylinder 1', { suppressed: true }), box('f3', 'Box 2')] },
      { rollback: null },
      {
        features: {
          f1: { state: 'ok' },
          f2: { state: 'suppressed' },
          f3: { state: 'error', message: 'Box 2 failed: the result is not a valid solid' },
        },
      },
    );
    expect(rows.map((r) => [r.suppressed, r.status, r.message])).toEqual([
      [false, 'ok', null],
      [true, 'ok', null],
      [false, 'error', 'Box 2 failed: the result is not a valid solid'],
    ]);
    const warn = historyRows({ features: [box('f1', 'Box 1')] }, { rollback: null }, { features: { f1: { state: 'warning', message: 'Nothing to cut' } } });
    expect(warn[0]).toMatchObject({ status: 'warning', message: 'Nothing to cut' });
    const failedNoText = historyRows({ features: [box('f1', 'Box 1')] }, { rollback: null }, { features: { f1: { state: 'error' } } });
    expect(failedNoText[0].message).toBe('Box 1 failed');
    const pending = historyRows({ features: [box('f1', 'Box 1')] }, { rollback: null }, { features: { f1: { state: 'pending' } } });
    expect(pending[0].status).toBe('pending');
  });
});

describe('rollback bar', () => {
  it('maps the saved value to a bar index and back', () => {
    expect(rollbackIndex({ rollback: null }, 3)).toBe(3);
    expect(rollbackIndex({ rollback: 1 }, 3)).toBe(1);
    expect(rollbackIndex({ rollback: -4 }, 3)).toBe(0);
    expect(rollbackIndex({ rollback: 7 }, 3)).toBe(3);
    expect(rollbackIndex({ rollback: 1.7 }, 3)).toBe(1);
    expect(rollbackValue(3, 3)).toBeNull();
    expect(rollbackValue(9, 3)).toBeNull();
    expect(rollbackValue(0, 3)).toBe(0);
    expect(rollbackValue(2, 3)).toBe(2);
    expect(rollbackValue(-1, 3)).toBe(0);
  });

  it('drops the bar after every row whose middle is above the pointer', () => {
    const mids = [12, 36, 60];
    expect(barIndexAt(0, mids)).toBe(0);
    expect(barIndexAt(12, mids)).toBe(0);
    expect(barIndexAt(13, mids)).toBe(1);
    expect(barIndexAt(48, mids)).toBe(2);
    expect(barIndexAt(61, mids)).toBe(3);
    expect(barIndexAt(500, mids)).toBe(3);
    expect(barIndexAt(10, [])).toBe(0);
  });
});

describe('bodies and selection', () => {
  it('lists bodies in rebuild order with saved names, colours and visibility', () => {
    const rows = bodyRows(
      { bodies: { b1: { name: 'Housing', color: '#ff0000' } } },
      { hiddenBodies: ['b2'] },
      [body('b1', 'f1', 'Body 1'), body('b2', 'f3', 'Body 2')],
    );
    expect(rows).toEqual([
      { id: 'b1', name: 'Housing', color: '#ff0000', visible: true, feature: 'f1', valid: true },
      { id: 'b2', name: 'Body 2', color: '#bdc9db', visible: false, feature: 'f3', valid: true },
    ]);
  });

  it('lists bodies in the order the document made them, not the order the rebuild last touched them (review round 1)', () => {
    const doc = { bodies: { b1: { name: 'Body 1', color: '#bdc9db' }, b2: { name: 'Body 2', color: '#bdc9db' }, b3: { name: 'Body 3', color: '#bdc9db' } } };
    // A join into Body 2 after Body 3 was made puts Body 2 last in the rebuild's list.
    const rows = bodyRows(doc, { hiddenBodies: [] }, [body('b1', 'f1', 'Body 1'), body('b3', 'f3', 'Body 3'), body('b2', 'f4', 'Body 2')]);
    expect(rows.map((r) => r.name)).toEqual(['Body 1', 'Body 2', 'Body 3']);
  });

  it('finds the bodies and features a selection touches', () => {
    const bodies = [body('b1', 'f1'), body('b2', 'f3')];
    const sel = { filter: [], items: [{ kind: 'face' as const, body: 'b2', index: 3 }, { kind: 'feature' as const, feature: 'f1' }] };
    expect([...selectedBodies(sel)]).toEqual(['b2']);
    const { direct, related } = selectedFeatures(sel, bodies);
    expect([...direct]).toEqual(['f1']);
    expect([...related]).toEqual(['f3']);
    // A feature selected directly is not also "related".
    const both = selectedFeatures({ filter: [], items: [{ kind: 'feature', feature: 'f1' }, { kind: 'body', body: 'b1' }] }, bodies);
    expect([...both.direct]).toEqual(['f1']);
    expect([...both.related]).toEqual([]);
    expect([...selectedBodies({ filter: [], items: [{ kind: 'origin', ref: 'origin:top' }] })]).toEqual([]);
  });
});
