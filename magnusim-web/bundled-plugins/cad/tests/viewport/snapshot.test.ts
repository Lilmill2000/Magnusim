// @vitest-environment node
// ViewportHandle.snapshot's pure parts (src/viewport/snapshot.ts): the eight directions (iso_back
// seen from back-left-top), the picture's own orthographic camera (it frames the sphere whatever
// the picture's shape, the centre in the middle, mm per pixel), projection into the picture, the
// size limits in words, the cut as the section view makes it, the triad's corner, the rows read
// top to bottom, and which overlay layers a picture leaves out, pinned against their owners.
// The drawing itself and what it puts back: camera-count.test.ts and e2e/cad-viewport-snapshot.spec.ts.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sphere, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { HANDLES_LAYER } from '../../src/features/enclosure/handles';
import { HANDLE_LAYER } from '../../src/features/extrude/handle';
import { MARKERS_LAYER } from '../../src/features/pattern/markers';
import { LAYER_CONSTRUCT } from '../../src/features/refgeom/overlay';
import { SKETCH_BANANA_LAYER } from '../../src/features/scale/sketch-banana';
import { BANANA_LAYER } from '../../src/features/scale/view';
import { LAYER_MARKERS, LAYER_REGIONS, LAYER_SKETCHES } from '../../src/features/sketch/overlay';
import { PICKS_LAYER } from '../../src/features/solids/overlay';
import type { Vec3 } from '../../src/types/doc';
import type { SnapshotView } from '../../src/types/viewport';
import { VIEW_DIRS } from '../../src/viewport/camera';
import { TRIAD_PX } from '../../src/viewport/colors';
import { projectToPicture, rowsTopDown, SNAPSHOT_DIRS, SNAPSHOT_HIDDEN_LAYERS, SNAPSHOT_MAX_PX, snapshotClip, snapshotRig, snapshotSection, snapshotSize, snapshotTriadRect } from '../../src/viewport/snapshot';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const VIEWS: SnapshotView[] = ['iso', 'iso_back', 'front', 'back', 'left', 'right', 'top', 'bottom'];
const near = (a: readonly number[], b: readonly number[], tol = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

describe('directions', () => {
  it('the eight views: the standard ones as the view has them, iso_back from back-left-top', () => {
    expect(Object.keys(SNAPSHOT_DIRS).sort()).toEqual([...VIEWS].sort());
    for (const v of VIEWS) if (v !== 'iso_back') expect(SNAPSHOT_DIRS[v]).toEqual(VIEW_DIRS[v]);
    const s = 1 / Math.sqrt(3);
    expect(near(SNAPSHOT_DIRS.iso_back.dir, [-s, s, s])).toBe(true);
    expect(SNAPSHOT_DIRS.iso_back.up).toEqual([0, 0, 1]);
  });
});

describe('the picture camera', () => {
  const sphere = new Sphere(new Vector3(5, 10, 15), 12);

  it('is orthographic, looks along the view at the centre, and puts the centre in the middle', () => {
    for (const v of VIEWS) {
      const rig = snapshotRig(v, sphere, 320, 240);
      expect(rig.projection).toBe('orthographic');
      const back = rig.position.clone().sub(rig.target).normalize();
      expect(near(back.toArray(), new Vector3(...SNAPSHOT_DIRS[v].dir).normalize().toArray(), 1e-9), v).toBe(true);
      expect(rig.target.toArray()).toEqual([5, 10, 15]);
      const cam = rig.apply(320 / 240);
      const c = projectToPicture(cam, 320, 240, [5, 10, 15])!;
      expect(near(c, [160, 120], 1e-6), `${v}: ${c}`).toBe(true);
    }
  });

  it('fits the sphere both ways: its height in a wide picture, its width in a tall one; mm per pixel', () => {
    const wide = snapshotRig('top', sphere, 320, 240);
    expect(wide.orthoHeight).toBeCloseTo(24, 9);
    expect(wide.orthoHeight / 240).toBeCloseTo(0.1, 12);
    const tall = snapshotRig('top', sphere, 200, 400);
    // Visible width = orthoHeight * aspect = the sphere's diameter.
    expect(tall.orthoHeight * (200 / 400)).toBeCloseTo(24, 9);
    for (const [w, h, rig] of [[320, 240, wide], [200, 400, tall]] as const) {
      const cam = rig.apply(w / h);
      // From the top (X right, Y up): the sphere's rim at +X and +Y lies inside the picture.
      const right = projectToPicture(cam, w, h, [17, 10, 15])!;
      const up = projectToPicture(cam, w, h, [5, 22, 15])!;
      expect(right[0]).toBeLessThanOrEqual(w + 1e-6);
      expect(up[1]).toBeGreaterThanOrEqual(-1e-6);
      expect(Math.min(w - right[0], up[1]) < 1e-6, `${w}x${h}: one side is filled`).toBe(true);
    }
  });

  it('iso shows +X to the right, iso_back (the back-left-top corner) to the left; Z is up in both', () => {
    const at = (v: SnapshotView, p: Vec3) => projectToPicture(snapshotRig(v, sphere, 300, 300).apply(1), 300, 300, p)!;
    expect(at('iso', [15, 10, 15])[0]).toBeGreaterThan(150);
    expect(at('iso_back', [15, 10, 15])[0]).toBeLessThan(150);
    // +Y: toward the viewer's right in iso too (front-right-top), to the left in iso_back.
    expect(at('iso', [5, 20, 15])[0]).toBeGreaterThan(150);
    expect(at('iso_back', [5, 20, 15])[0]).toBeLessThan(150);
    for (const v of ['iso', 'iso_back'] as const) expect(at(v, [5, 10, 25])[1]).toBeLessThan(150);
  });

  it('a point outside the picture depth projects to null', () => {
    const rig = snapshotRig('front', sphere, 100, 100);
    const cam = rig.apply(1);
    // Far behind the camera, beyond the near plane of an orthographic view of the sphere.
    expect(projectToPicture(cam, 100, 100, [5, -1e6, 15])).toBeNull();
  });
});

describe('size, cut, triad and rows', () => {
  it('whole pixels, 1 to the largest side (and never more than the GPU draws); otherwise a RangeError in words', () => {
    expect(snapshotSize({ width: 320.4, height: 239.6 })).toEqual({ width: 320, height: 240 });
    expect(snapshotSize({ width: SNAPSHOT_MAX_PX, height: 1 })).toEqual({ width: SNAPSHOT_MAX_PX, height: 1 });
    for (const [w, h] of [[0, 10], [10, -1], [Number.NaN, 10], [SNAPSHOT_MAX_PX + 1, 10]]) expect(() => snapshotSize({ width: w, height: h })).toThrow(/A snapshot is 1 to 4096 px on each side/);
    expect(() => snapshotSize({ width: 3000, height: 100 }, 2048)).toThrow(/1 to 2048 px/);
  });

  it('the cut is the section view\'s plane through the offset (flip keeps the other side); the shared state is not involved', () => {
    expect(snapshotSection({ plane: 'top', offset: 5, flip: false })).toEqual({ on: true, plane: 'origin:top', offset: 5, flip: false });
    expect(snapshotSection({ plane: 'right', offset: Number.NaN, flip: true })).toEqual({ on: true, plane: 'origin:right', offset: 0, flip: true });
    const below = snapshotClip({ plane: 'top', offset: 5, flip: false });
    expect(below.distanceToPoint(new Vector3(0, 0, 0))).toBeGreaterThan(0);
    expect(below.distanceToPoint(new Vector3(0, 0, 10))).toBeLessThan(0);
    const above = snapshotClip({ plane: 'top', offset: 5, flip: true });
    expect(above.distanceToPoint(new Vector3(0, 0, 10))).toBeGreaterThan(0);
  });

  it('the triad sits in the bottom-right corner (target pixels, origin bottom-left), no larger than the view\'s, none in a tiny picture', () => {
    expect(snapshotTriadRect(320, 240)).toEqual({ x: 320 - 48 - 6, y: 6, s: 48 });
    const big = snapshotTriadRect(1280, 960)!;
    expect(big.s).toBe(TRIAD_PX);
    expect(big.x + big.s).toBeLessThan(1280);
    expect(snapshotTriadRect(100, 100)).toBeNull();
  });

  it('a render target\'s rows (bottom first) come out top first', () => {
    const w = 2;
    const h = 3;
    const src = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) src.fill(10 + y, y * w * 4, (y + 1) * w * 4);
    const out = rowsTopDown(src, w, h);
    expect(out).toBeInstanceOf(Uint8ClampedArray);
    expect([out[0], out[w * 4], out[2 * w * 4]]).toEqual([12, 11, 10]);
    expect(out.length).toBe(w * h * 4);
  });
});

describe('the layers a picture leaves out', () => {
  /** Every overlay layer id the app adds (addLayer's first argument, a literal or a const of the same file). */
  function layerIds(): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !p.endsWith(join('viewport', 'viewport.ts')) && !p.includes(`${join('src', 'types')}`)) {
          const src = readFileSync(p, 'utf8');
          for (const m of src.matchAll(/\baddLayer\(\s*('([^']+)'|[A-Za-z_]\w*)/g)) {
            const id = m[2] ?? new RegExp(`const\\s+${m[1]}\\s*=\\s*'([^']+)'`).exec(src)?.[1];
            expect(id, `${p}: the layer id ${m[1]} is not a literal or a const of the file`).toBeTruthy();
            out.set(id!, p.slice(SRC.length).replace(/\\/g, '/'));
          }
        }
      }
    };
    walk(SRC);
    return out;
  }

  it('manipulators, markers and bananas; the sketches and reference planes stay', () => {
    expect([...SNAPSHOT_HIDDEN_LAYERS].sort()).toEqual([HANDLE_LAYER, HANDLES_LAYER, 'p2-measure', MARKERS_LAYER, PICKS_LAYER, 'sketch.pick', BANANA_LAYER, SKETCH_BANANA_LAYER].sort());
    const kept = [LAYER_CONSTRUCT, LAYER_REGIONS, LAYER_SKETCHES, LAYER_MARKERS, 'sketch-geometry', 'sketch-annotations'];
    for (const id of kept) expect(SNAPSHOT_HIDDEN_LAYERS.has(id), id).toBe(false);
    // Every layer the app adds is one or the other (a new layer must be placed in one list).
    const ids = layerIds();
    expect([...ids.keys()].filter((id) => !SNAPSHOT_HIDDEN_LAYERS.has(id) && !kept.includes(id)), 'layers in neither list').toEqual([]);
    expect([...SNAPSHOT_HIDDEN_LAYERS].filter((id) => !ids.has(id)), 'hidden ids no module adds').toEqual([]);
    expect(ids.get('p2-measure')).toBe('features/measure/overlay.ts');
    expect(ids.get('sketch.pick')).toBe('sketch/commands.ts');
  });
});
