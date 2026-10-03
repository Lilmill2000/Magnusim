// Shared helpers for the kernel tests: the real kernel (mk32.wasm) in Node through
// the same wrapper the worker uses, the fixtures, and the native reference values.
// The kernel under test is workspace/kernel/ (what ships), or CAD_KERNEL_DIR (any
// other build, e.g. to compare two builds or to run a test build).
// Owner: KERNEL-HARDENING.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'vitest';
import { createKernel, type Kernel } from '../../src/kernel-worker/kernel-api';

export type R = Record<string, any>;

export const PLUGIN = fileURLToPath(new URL('../../', import.meta.url));
export const FIXTURES = join(PLUGIN, 'fixtures', 'kernel');
export const KERNEL_DIR = process.env.CAD_KERNEL_DIR || join(PLUGIN, 'workspace', 'kernel');

/** Native reference values (fixtures/kernel/reference.json, OCCT 7.9.3 natively). */
export const REF: R = JSON.parse(readFileSync(join(FIXTURES, 'reference.json'), 'utf8'));

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

/**
 * Daniel's Vortex part ("Vortex CFD Test.step"), read where it is: it is never copied
 * into the plugin (review P2/P3 round 3). Only CAD_E2E_VORTEX_STEP names it, as for the
 * e2e gates. Without it the tests that need it are skipped and say why in their names;
 * set to a path with no file there, they fail (reading it) with that path.
 */
export const VORTEX_STEP = process.env.CAD_E2E_VORTEX_STEP || '';
export const HAVE_VORTEX = VORTEX_STEP !== '';
export const NO_VORTEX = "needs Daniel's Vortex STEP: set CAD_E2E_VORTEX_STEP to the path of Vortex CFD Test.step";
if (!HAVE_VORTEX) console.warn(`[kernel tests] skipping the Vortex tests: ${NO_VORTEX}`);

/** The Vortex STEP's bytes (only called by tests that run when HAVE_VORTEX). */
export function vortexBytes(): Uint8Array {
  return new Uint8Array(readFileSync(VORTEX_STEP));
}

/** A test that needs the Vortex STEP: skipped, with the reason in its name, when it is not there. */
export function itVortex(name: string, fn: () => unknown, timeout?: number): void {
  if (HAVE_VORTEX) it(name, fn, timeout);
  else it.skip(`${name} [skipped: ${NO_VORTEX}]`, fn);
}

/** A group of tests that needs the Vortex STEP (its own beforeAll reads it). */
export function describeVortex(name: string, fn: () => void): void {
  if (HAVE_VORTEX) describe(name, fn);
  else describe.skip(`${name} [skipped: ${NO_VORTEX}]`, fn);
}

export async function loadKernel(): Promise<Kernel> {
  return createKernel({
    moduleUrl: pathToFileURL(join(KERNEL_DIR, 'mk32.mjs')).href,
    wasmBinary: readFileSync(join(KERNEL_DIR, 'mk32.wasm')),
  });
}

/** Relative difference |a - b| / |b|. */
export const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);

/** A typed-enough call: throws on ok:false (KernelError with kind and message). */
export const call = (k: Kernel, op: string, params: R = {}): R => k.call(op, params) as R;

/** The raw result: {ok:false, error, kind} comes back instead of throwing. */
export const tryCall = (k: Kernel, op: string, params: R = {}): R => k.tryCall(op, params) as R;

export function importStep(k: Kernel, file: string, extra: R = {}): R {
  return call(k, 'import_step', { ...k.putBytes(fixture(file)), name: file, heal: true, tol: 1e-3, ...extra });
}

/** import_step of the Vortex STEP (read by path), healed as importStep heals. */
export function importVortex(k: Kernel, extra: R = {}): R {
  return call(k, 'import_step', { ...k.putBytes(vortexBytes()), name: 'Vortex CFD Test.step', heal: true, tol: 1e-3, ...extra });
}

export function volume(k: Kernel, id: number): number {
  return call(k, 'props', { id, volume: true, bbox: 'none' }).volume as number;
}

/** Everything cheap that would show a changed body: counts, volume, area, exact bbox, validity, signatures. */
export function fingerprint(k: Kernel, id: number): R {
  const p = call(k, 'props', { id, volume: true, area: true, bbox: 'exact' });
  const t = call(k, 'topo', { id });
  return {
    faces: p.faces,
    edges: p.edges,
    vertices: p.vertices,
    volume: p.volume,
    area: p.area,
    bbox: p.bbox,
    valid: call(k, 'check', { id }).valid,
    topo: JSON.stringify({ f: t.faces, e: t.edges, v: t.vertices }),
  };
}

export const XY = { origin: [0, 0, 0], normal: [0, 0, 1], xdir: [1, 0, 0] };

/** A rectangle profile [x0,x1]x[y0,y1] on a plane, segments s1 (bottom), s2, s3, s4. */
export function rect(x0: number, y0: number, x1: number, y1: number, plane: R = XY): R {
  return {
    plane,
    loops: [
      [
        { id: 's1', kind: 'line', a: [x0, y0], b: [x1, y0] },
        { id: 's2', kind: 'line', a: [x1, y0], b: [x1, y1] },
        { id: 's3', kind: 'line', a: [x1, y1], b: [x0, y1] },
        { id: 's4', kind: 'line', a: [x0, y1], b: [x0, y0] },
      ],
    ],
  };
}

export function circle(cx: number, cy: number, r: number, plane: R = XY, id = 'c1'): R {
  return { plane, loops: [[{ id, kind: 'circle', c: [cx, cy], r }]] };
}
