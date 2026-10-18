// The real sketch solver (solver-api.mjs over the shipped PlaneGCS wasm) in this process, from any
// test environment, jsdom included (its import.meta.url is not a file URL, so the paths come from
// the plugin folder, the test's working directory, as tests/features/p2/kernel-anywhere.ts does).
// The same client as tests/sketch/harness.ts's inProcessSolver: an interactive instance and a
// scratch one (solveFeature, analyzeFeature), as the worker has.
// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toSolverSketch } from '../../src/sketch/model';
import type { SketchSolverClient } from '../../src/types/sketch';

const ROOT = process.cwd();
const API = pathToFileURL(resolve(ROOT, 'src/solver-worker/solver-api.mjs')).href;
const MODULE = pathToFileURL(resolve(ROOT, 'workspace/solver/planegcs.mjs')).href;
const WASM = resolve(ROOT, 'workspace/solver/planegcs.wasm');

type Api = Record<string, (...a: unknown[]) => unknown>;

let wasm: Uint8Array | null = null;

export async function solverAnywhere(): Promise<SketchSolverClient> {
  const { createSolver } = (await import(/* @vite-ignore */ API)) as { createSolver(o: { moduleFactory: unknown }): Promise<Api> };
  const { default: factory } = (await import(/* @vite-ignore */ MODULE)) as { default: (o: Record<string, unknown>) => Promise<unknown> };
  // The wasm's bytes from disk: in jsdom the module would fetch it from the page's address.
  wasm ??= readFileSync(WASM);
  const moduleFactory = (o: Record<string, unknown>) => factory({ ...o, wasmBinary: wasm });
  const s = await createSolver({ moduleFactory });
  const scratch = await createSolver({ moduleFactory });
  const call = <T>(op: string, ...args: unknown[]) => Promise.resolve().then(() => s[op](...args) as T);
  return {
    ready: () => Promise.resolve(),
    solveFeature: (f, values) =>
      Promise.resolve().then(() => {
        scratch.load(toSolverSketch(f, values));
        return scratch.solve() as never;
      }),
    analyzeFeature: (f, values) =>
      Promise.resolve().then(() => {
        scratch.load(toSolverSketch(f, values));
        const solve = scratch.solve();
        return { solve, analysis: scratch.analyze() } as never;
      }),
    load: (sk) => call('load', sk),
    solve: () => call('solve'),
    analyze: () => call('analyze'),
    setValue: (c, v) => call('setValue', c, v),
    dragStart: (p, o) => call('dragStart', p, o ?? {}),
    dragMove: (u, v) => call('dragMove', u, v),
    dragEnd: () => call('dragEnd'),
    dispose: () => {
      s.dispose();
      scratch.dispose();
    },
  };
}
