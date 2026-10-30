// @vitest-environment node
// Import SVG/DXF keeps the drawing it previews in view (the owner's review: part.dxf, 533 mm wide,
// lay mostly off the view, and Fit framed nothing, the sketch being empty): opening it fits the
// view (the app's own move) when the drawing reaches off what the panels leave free, once the
// camera rests; the tool's frameUv gives the drawing's box, so a fit counts it. A Scale, Place or
// layer change that takes it out of view fits again; one that keeps it in view leaves the camera,
// and so does one made while it did not all show (the person zoomed in on a part of it).
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { createStateStore } from '../../../src/lib/store';
import { readDrawing } from '../../../src/sketch/import';
import { openRead } from '../../../src/sketch/import/tool';
import { toModel } from '../../../src/sketch/mode';
import type { ToolOption } from '../../../src/sketch/tools/options';
import type { Vec3 } from '../../../src/types/doc';
import type { ViewportHandle } from '../../../src/types/viewport';
import { sketchHarness, type Harness } from '../harness';
import { bytesOf, DXF_PART } from './fixtures';

let h: Harness | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
});

/** A view that shows the square |x|, |y| <= half (mm); fit makes it show everything. */
function view() {
  const v = { half: 100, fits: [] as string[], asked: [] as Vec3[][], state: createStateStore({ animating: false }) };
  const handle: Partial<ViewportHandle> = {
    lookAt: () => {},
    state: v.state as unknown as ViewportHandle['state'],
    offView: (points) => {
      v.asked.push(points.map((p) => [...p] as Vec3));
      return points.some((p) => Math.abs(p[0]) > v.half || Math.abs(p[1]) > v.half);
    },
    fit: (o) => {
      v.fits.push(o?.auto ? 'auto' : 'person');
      v.half = 1e9;
    },
  };
  return { v, handle };
}

const option = (hh: Harness, id: string) => (hh.mode.tool?.options?.() ?? []).find((o) => o.id === id) as ToolOption;
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the drawing being imported, in view', () => {
  it('opening it fits the view once the camera rests; frameUv is its box; a change that takes it out fits again, one that keeps it in or comes while it did not all show leaves the camera', async () => {
    const { v, handle } = view();
    h = await sketchHarness({}, { handle });
    // A transition runs (sketch entry's Normal to): nothing until it rests.
    v.state.set({ animating: true });
    expect(openRead(h.mode, readDrawing('part.dxf', bytesOf(DXF_PART)))).toBe(true);
    await tick();
    expect(v.fits).toEqual([]);
    v.state.set({ animating: false });
    expect(v.fits).toEqual(['auto']);
    // What it asked about: the preview's box corners on the sketch plane; the same box counts in a fit.
    const box = h.mode.tool!.frameUv!()!;
    expect(box[1][0] - box[0][0]).toBeGreaterThan(500);
    const plane = h.mode.plane()!;
    expect(v.asked[0]).toEqual([box[0], [box[1][0], box[0][1]], box[1], [box[0][0], box[1][1]]].map((uv) => toModel(plane, uv as [number, number])));
    // Smaller (1 mm per unit), still all in view: the camera stays.
    v.half = 1000;
    const scale = option(h, 'scale') as Extract<ToolOption, { kind: 'number' }>;
    scale.set('1', 1);
    expect(v.fits).toEqual(['auto']);
    // 2540 mm per unit takes it out of view: framed again.
    (option(h, 'scale') as Extract<ToolOption, { kind: 'number' }>).set('2540', 2540);
    expect(v.fits).toEqual(['auto', 'auto']);
    // The person zooms in on a part of it; Centred then takes it further out: the camera stays.
    v.half = 10;
    (option(h, 'place') as Extract<ToolOption, { kind: 'choice' }>).set('centre');
    expect(v.fits).toEqual(['auto', 'auto']);
    // Cancel: no box counts any more.
    (option(h, 'cancel') as Extract<ToolOption, { kind: 'button' }>).run();
    expect(h.mode.tool?.id).toBe('select');
    expect(h.mode.tool?.frameUv?.() ?? null).toBeNull();
  });
});
