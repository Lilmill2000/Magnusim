// Measure (proposal §2.11): what it sends the kernel for each pick, what it
// shows (in the document's units), and the tool panel as the user meets it:
// picks from the viewport go to the panel (not the selection), a third pick
// starts over, the distance shows with its X/Y/Z parts and a marker label, a
// rebuild clears the picks and says so. The kernel's measure is scripted here
// until it lands (API 3).
// SPDX-License-Identifier: GPL-3.0-or-later
import { act, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { itemLabel, measureRows, targetOf } from '../../../src/features/measure/words';
import { createUnitsService } from '../../../src/doc/units';
import type { BodyInfo, KernelAdapter } from '../../../src/types/kernel';
import type { MeasureResult } from '../../../src/types/kernel-protocol';
import { block, registerSolidFeatures } from '../../doc/blocks';
import { mountApp, type TestApp } from '../p2/app';
import { hybridKernel } from '../p2/hybrid-kernel';
import { realKernelAnywhere } from '../p2/kernel-anywhere';

const mm = createUnitsService(() => ({ length: 'mm', angle: 'deg' }));
const inch = createUnitsService(() => ({ length: 'in', angle: 'deg' }));
const body = { id: 'b_1', shape: 7, name: 'Body 1' } as BodyInfo;

describe('Measure words', () => {
  it('kernel targets and labels for each kind of pick', () => {
    expect(targetOf({ kind: 'face', body: 'b_1', index: 3 }, [body])).toEqual({ id: 7, face: 3 });
    expect(targetOf({ kind: 'edge', body: 'b_1', index: 0 }, [body])).toEqual({ id: 7, edge: 0 });
    expect(targetOf({ kind: 'vertex', body: 'b_1', index: 2 }, [body])).toEqual({ id: 7, vertex: 2 });
    expect(targetOf({ kind: 'origin', ref: 'origin:top' }, [])).toEqual({ plane: { origin: [0, 0, 0], normal: [0, 0, 1] } });
    expect(targetOf({ kind: 'origin', ref: 'origin:x' }, [])).toEqual({ axis: { origin: [0, 0, 0], dir: [1, 0, 0] } });
    expect(targetOf({ kind: 'face', body: 'b_9', index: 0 }, [body])).toBeNull();
    expect(itemLabel({ kind: 'face', body: 'b_1', index: 3 }, [body])).toBe('Face 4 of Body 1');
    expect(itemLabel({ kind: 'vertex', body: 'b_1', index: 0 }, [body])).toBe('Point 1 of Body 1');
    expect(itemLabel({ kind: 'origin', ref: 'origin:front' }, [])).toBe('Front plane');
  });

  it('two picks: distance with its parts, angle, centre distance; in the document unit', () => {
    const r: MeasureResult = { a: { kind: 'face', type: 'plane' }, b: { kind: 'face', type: 'plane' }, distance: 20, p1: [0, 0, 0], p2: [0, 0, 20], delta: [0, 0, -20], angle_deg: 0, parallel: true, timings: {} };
    expect(measureRows(r, mm).map((x) => `${x.label}: ${x.value}`)).toEqual(['Distance: 20 mm', 'ΔX: 0 mm', 'ΔY: 0 mm', 'ΔZ: 20 mm', 'Angle: 0°']);
    expect(measureRows({ ...r, distance: 25.4, angle_deg: undefined, delta: undefined, center_distance: 50.8 }, inch).map((x) => x.value)).toEqual(['1 in', '2 in']);
  });

  it('one pick: area, length, radius and diameter, a point', () => {
    expect(measureRows({ a: { kind: 'face', type: 'cylinder', area: 314.159265, radius: 5, center: [1, 2, 3] }, timings: {} }, mm).map((x) => `${x.label}: ${x.value}`)).toEqual([
      'Type: Cylinder',
      'Area: 314.159 mm²',
      'Radius: 5 mm',
      'Diameter: 10 mm',
      'Centre: 1, 2, 3 mm',
    ]);
    expect(measureRows({ a: { kind: 'edge', type: 'line', length: 12345.6 }, timings: {} }, mm).map((x) => x.value)).toEqual(['Straight', '12,345.6 mm']);
    expect(measureRows({ a: { kind: 'vertex', point: [0, 10, 20] }, timings: {} }, mm).map((x) => x.value)).toEqual(['0, 10, 20 mm']);
  });
});

/** The hybrid real kernel with `measure` scripted (API 3). */
function withMeasure(k: KernelAdapter, answer: (p: Record<string, unknown>) => MeasureResult): KernelAdapter & { measured: Record<string, unknown>[] } {
  const measured: Record<string, unknown>[] = [];
  return Object.assign(Object.create(k) as KernelAdapter, {
    measured,
    call: (op: string, params: Record<string, unknown>, opts?: object) => {
      if (op === 'measure') {
        measured.push(params);
        return Promise.resolve({ result: answer(params), buffers: {}, ms: 0, wall_ms: 0, heap_bytes: 0 });
      }
      return (k.call as (o: string, p: unknown, x?: object) => Promise<unknown>)(op, params, opts);
    },
  }) as KernelAdapter & { measured: Record<string, unknown>[] };
}

let app: TestApp | null = null;
afterEach(() => {
  app?.dispose();
  app = null;
});

async function settled(a: TestApp, n: number) {
  for (let i = 0; i < 500 && a.services.doc.state.get().rebuild.bodies.length < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  expect(a.services.doc.state.get().rebuild.bodies).toHaveLength(n);
}

describe('Measure panel', () => {
  it('picks go to the panel; two picks show the distance; a third starts over; a rebuild clears them', async () => {
    const real = realKernelAnywhere();
    await real.start();
    const k = withMeasure(hybridKernel(real), (p) =>
      p.b ? { a: { kind: 'face', type: 'plane' }, b: { kind: 'face', type: 'plane' }, distance: 20, p1: [0, 0, 0], p2: [0, 0, 20], delta: [0, 0, 20], angle_deg: 0, parallel: true, timings: {} } : { a: { kind: 'face', type: 'plane', area: 400 }, timings: {} },
    );
    const a = mountApp(k);
    app = a;
    await act(async () => {
      await a.services.doc.load();
    });
    registerSolidFeatures(a.services.doc);
    // Two 20 mm cubes, sketched and extruded.
    await act(async () => {
      block(a.services.doc);
      block(a.services.doc, { at: [30, 0, 0] });
    });
    await settled(a, 2);
    const b = a.services.doc.state.get().rebuild.bodies[0];
    await act(async () => {
      await a.run('inspect.measure');
    });
    expect(a.$('[data-tool-panel="inspect.measure"]')).not.toBeNull();
    expect(a.$('[data-command="inspect.measure"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(a.view.click({ kind: 'face', body: b.id, index: 4 })).toBe(true);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(k.measured.at(-1)).toEqual({ a: { id: b.shape, face: 4 } });
    expect(a.$('[data-measure-value="a.area"]')?.textContent).toBe('400 mm²');
    // What the panel holds is shown as the selection (the viewport's highlight).
    expect(a.services.selection.get().items).toEqual([{ kind: 'face', body: b.id, index: 4 }]);
    a.view.click({ kind: 'face', body: b.id, index: 5 });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(k.measured.at(-1)).toEqual({ a: { id: b.shape, face: 4 }, b: { id: b.shape, face: 5 } });
    expect(a.$('[data-measure-value="distance"]')?.textContent).toBe('20 mm');
    expect(a.$('[data-measure-value="dz"]')?.textContent).toBe('20 mm');
    expect(a.view.layers.get('p2-measure')?.html.querySelector('[data-measure-label]')?.textContent).toBe('20 mm');
    expect(a.$$('[data-pick-row]').map((r) => r.textContent?.replace('×', ''))).toEqual(['Face 5 of Body 1', 'Face 6 of Body 1']);
    // A third pick starts over.
    a.view.click({ kind: 'face', body: b.id, index: 0 });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(a.$$('[data-pick-row]')).toHaveLength(1);
    // The part changes (Undo of the second extrude): the picks go, and the panel says why.
    await act(async () => {
      a.services.doc.undo();
    });
    for (let i = 0; i < 500 && a.services.doc.state.get().rebuild.bodies.length !== 1; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    expect(a.$$('[data-pick-row]')).toHaveLength(0);
    expect(a.$('[data-tool-panel="inspect.measure"]')?.textContent).toContain('The part changed: pick again');
    // Done closes; the selection the panel showed goes with it.
    act(() => void fireEvent.click(a.$('[data-panel-done]')!));
    expect(a.$('[data-tool-panel]')).toBeNull();
    expect(a.view.tools).toHaveLength(0);
  });
});
