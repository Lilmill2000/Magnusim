// @vitest-environment node
// gate:l2-cad, the export the app links (host API 1.5), with the real kernel in
// Node and the app's own checker (python -m magnusim_sdk.link check) on CAD's
// exports:
//   - two bodies sharing a face (a block split in two: the cut face is one face of
//     both pieces), so the face numbering must count it once per body (no
//     de-duplication);
//   - a body with an internal face (a face inside the solid, not on its boundary);
//   - every face index lands on the right face: the app's face_visits (Python) and
//     CAD's link_export agree visit by visit (body and centroid);
//   - the BinTools format version is pinned (4), and an export of the same design
//     in a fresh kernel (a reload) is byte-identical, BREP and sidecar.
// The app's Python is the core venv's (CAD_E2E_PYTHON, default
// ../../python/.venv/Scripts/python.exe): without it these tests are skipped and
// say so, except under the gate (scripts/gate-l2-cad.mjs sets
// CAD_LINK_REQUIRE_PYTHON=1), where they fail: the gate never passes by skipping.
// Owner: LINK.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportForLink, sha256Hex, type LinkExport } from '../../src/link/export';
import type { Kernel } from '../../src/kernel-worker/kernel-api';
import type { CadDoc } from '../../src/types/doc';
import type { EndBody } from '../../src/types/doc-service';
import type { KernelAdapter } from '../../src/types/kernel';
import { call, loadKernel, PLUGIN } from './kernel-lib';

const PYTHON = process.env.CAD_E2E_PYTHON || join(PLUGIN, '..', '..', 'python', '.venv', 'Scripts', 'python.exe');
const HAVE_PY = existsSync(PYTHON);
const NO_PY = `needs the app's Python with magnusim_sdk and OCP: set CAD_E2E_PYTHON (looked for ${PYTHON})`;
if (!HAVE_PY) console.warn(`[kernel-link] skipping the checker tests: ${NO_PY}`);
const REQUIRE_PY = process.env.CAD_LINK_REQUIRE_PYTHON === '1';
const itPy = (name: string, fn: () => unknown, timeout?: number) =>
  HAVE_PY
    ? it(name, fn, timeout)
    : REQUIRE_PY
      ? it(name, () => {
          throw new Error(`gate:l2-cad ${NO_PY}`);
        })
      : it.skip(`${name} [skipped: ${NO_PY}]`, fn);

/** The KernelAdapter calls the export makes, over the in-process kernel. */
function adapter(k: Kernel): KernelAdapter {
  return {
    async call(op: string, params: Record<string, unknown>) {
      const r = call(k, op, params);
      const bufs = k.takeBuffers(r as never);
      const buffers: Record<string, ArrayBuffer> = {};
      for (const [n, v] of Object.entries(bufs)) buffers[n] = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
      return { result: r, buffers, ms: 0, wall_ms: 0, heap_bytes: 0 };
    },
  } as unknown as KernelAdapter;
}

function py(args: string[], input?: string): { code: number; out: string } {
  const r = spawnSync(PYTHON, args, { input, encoding: 'utf8', timeout: 120_000 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

// Each face visit as the app numbers it: (body, centroid), from magnusim_sdk.link.face_visits.
const VISITS_PY = `
import json, sys
from magnusim_sdk.link import face_visits, read_shape
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
shape = read_shape(sys.argv[1]).shape
out = []
for index, body, face in face_visits(shape):
    g = GProp_GProps()
    BRepGProp.SurfaceProperties_s(face, g)
    c = g.CentreOfMass()
    out.append([index, body, [round(c.X(), 4), round(c.Y(), 4), round(c.Z(), 4)]])
print(json.dumps(out))
`;

// The app's own sidecar writer, given CAD's rows: its bytes must be CAD's bytes.
const CANON_PY = `
import json, sys
from magnusim_sdk.link import write_face_names
doc = json.loads(open(sys.argv[1], encoding='utf-8').read())
write_face_names(sys.argv[2], doc['bodies'], doc['faces'], doc['shape_sha256'])
`;

// How many distinct faces the shape has (TopExp.MapShapes: a shared face once).
const DISTINCT_PY = `
import sys
from magnusim_sdk.link import read_shape
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp
from OCP.TopTools import TopTools_IndexedMapOfShape
m = TopTools_IndexedMapOfShape()
TopExp.MapShapes_s(read_shape(sys.argv[1]).shape, TopAbs_FACE, m)
print(m.Extent())
`;

// A 20 mm box whose solid also holds an internal face (the plane z = 10, inside it).
const INTERNAL_PY = `
import sys
from OCP.BinTools import BinTools
from OCP.BRep import BRep_Builder
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.gp import gp_Pln, gp_Pnt, gp_Dir
from OCP.TopAbs import TopAbs_INTERNAL, TopAbs_SHELL
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Compound
box = BRepPrimAPI_MakeBox(20.0, 20.0, 20.0).Solid()
shell = TopoDS.Shell_s(TopExp_Explorer(box, TopAbs_SHELL).Current())
face = BRepBuilderAPI_MakeFace(gp_Pln(gp_Pnt(10, 10, 10), gp_Dir(0, 0, 1)), -5.0, 5.0, -5.0, 5.0).Face()
b = BRep_Builder()
shell.Free(True)
b.Add(shell, face.Oriented(TopAbs_INTERNAL))
comp = TopoDS_Compound()
b.MakeCompound(comp)
b.Add(comp, box)
BinTools.Write_s(comp, sys.argv[1])
`;

let k: Kernel;
let tmp: string;

beforeAll(async () => {
  k = await loadKernel();
  tmp = mkdtempSync(join(tmpdir(), 'cad-link-'));
}, 60_000);

// Removing the temp folder took over 10 s once on Windows (a scanner holding the new files): give it time.
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 60_000);

function doc(bodies: Record<string, { name: string; simulation?: false }>, features: { id: string; name: string }[] = []): CadDoc {
  const defs: CadDoc['bodies'] = {};
  for (const [id, b] of Object.entries(bodies)) defs[id] = { name: b.name, color: '#bdc9db', ...(b.simulation === false ? { simulation: false as const } : {}) };
  return { schema: 2, units: { length: 'mm', angle: 'deg' }, params: [], bodies: defs, features: features as CadDoc['features'], meta: { created_at: 'x', written_by: 'test' } } as CadDoc;
}

function body(id: string, shape: number, name: string, faces: number, feature = 'f1'): EndBody {
  return { id, shape, valid: true, feature, name, color: '#bdc9db', names: { faces: Array.from({ length: faces }, (_, i) => `F:${feature}:side:s${i}#${i % 2}`) } };
}

/** Write an export, run the app's checker on it, and return its sidecar. */
function check(name: string, ex: LinkExport) {
  const shape = join(tmp, `${name}.bbrep`);
  const names = join(tmp, `${name}.face_names.json`);
  writeFileSync(shape, ex.brep);
  writeFileSync(names, ex.faceNames, 'utf8');
  const r = py(['-m', 'magnusim_sdk.link', 'check', shape, names]);
  return { r, shape, sidecar: JSON.parse(readFileSync(names, 'utf8')) as { bodies: { index: number; id: string; name: string }[]; faces: { index: number; body: number; name?: string; label?: string }[]; shape_sha256: string } };
}

/** Kernel face centroids of a shape by its own (MapShapes) index. */
function centroids(shape: number): Map<number, number[]> {
  const t = call(k, 'topo', { id: shape, faces: 'all', edges: 'none', vertices: 'none', face_bbox: 'none' }) as unknown as { faces: { i: number; centroid: number[] }[] };
  return new Map(t.faces.map((f) => [f.i, f.centroid.map((v) => Math.round(v * 1e4) / 1e4 + 0)]));
}

describe('gate:l2-cad the export the app links (kernel link_export, BinTools 4, the app checker)', () => {
  it('pins the BinTools format version (4) for the link and for stored BREPs', () => {
    const box = call(k, 'box', { dx: 10, dy: 10, dz: 10 }).id as number;
    const r = call(k, 'link_export', { ids: [box] });
    expect(r.format_version).toBe(4);
    const bytes = k.takeBuffers(r as never).brep as Uint8Array;
    // BinTools writes its version into the header: "Open CASCADE Topology V4".
    const head = new TextDecoder().decode(bytes.slice(0, 64));
    expect(head).toMatch(/Open CASCADE Topology V4/);
    const w = call(k, 'brep_write', { ids: [box] });
    const stored = new TextDecoder().decode((k.takeBuffers(w as never).brep as Uint8Array).slice(0, 64));
    expect(stored).toMatch(/Open CASCADE Topology V4/);
  });

  itPy(
    'two bodies sharing a face: the shared face is counted once per body; the app accepts the pair; every index lands on its face',
    async () => {
      const block = call(k, 'box', { dx: 20, dy: 10, dz: 10 }).id as number;
      const split = call(k, 'split', { id: block, plane: { origin: [8, 0, 0], normal: [1, 0, 0] } });
      const [a, b] = split.ids as number[];
      const faces = split.faces as number[];
      expect(faces).toEqual([6, 6]);
      const end = { bodies: [body('b1', a, 'Block', 6), body('b2', b, 'Block', 6)], failed: [] };
      const ex = await exportForLink(adapter(k), doc({ b1: { name: 'Block' }, b2: { name: 'Block' } }, [{ id: 'f1', name: 'Split 1' }]), end);
      if ('nothing' in ex) throw new Error('nothing exported');
      expect([ex.solids, ex.faces]).toEqual([2, 12]);
      const { r, shape, sidecar } = check('shared', ex);
      expect(r.out).toBe('ok');
      expect(r.code).toBe(0);
      // Body names unique in the export, ids the stable body ids.
      expect(sidecar.bodies.map((x) => [x.index, x.id, x.name])).toEqual([
        [1, 'b1', 'Block'],
        [2, 'b2', 'Block (2)'],
      ]);
      // Names without the internal #k suffix; labels in words.
      expect(sidecar.faces[0].name).toBe('F:f1:side:s0');
      expect(sidecar.faces[0].label).toMatch(/^Split 1 · Side \d+ · part 1$/);
      expect(sidecar.shape_sha256).toBe(await sha256Hex(ex.brep));
      // Byte for byte what magnusim_sdk.link.write_face_names writes for the same rows.
      const theirs = join(tmp, 'shared.app.json');
      const w = py(['-c', CANON_PY, join(tmp, 'shared.face_names.json'), theirs]);
      expect(w.code, w.out).toBe(0);
      expect(readFileSync(theirs, 'utf8')).toBe(ex.faceNames);
      // The app's numbering, visit by visit: same body, same face (centroid).
      const visits = py(['-c', VISITS_PY, shape]);
      expect(visits.code, visits.out).toBe(0);
      const appVisits = (JSON.parse(visits.out) as [number, number, number[]][]).map(([i, b, c]) => [i, b, c.map((v) => v + 0)] as [number, number, number[]]);
      expect(appVisits.length).toBe(12);
      const cA = centroids(a);
      const cB = centroids(b);
      const ours = sidecar.faces.map((f) => f.body);
      expect(appVisits.map((v) => v[1])).toEqual(ours);
      // The pieces really share the cut face (one face of both solids): 11 distinct faces, 12 visits.
      expect(py(['-c', DISTINCT_PY, shape]).out).toBe('11');
      // The cut face (x = 8) is visited twice: once in each body.
      const cut = appVisits.filter((v) => Math.abs(v[2][0] - 8) < 1e-6);
      expect(cut.map((v) => v[1])).toEqual([1, 2]);
      // Each visit's face, as CAD names it (its body's own face index), has the app's centroid.
      const raw = call(k, 'link_export', { ids: [a, b] });
      k.takeBuffers(raw as never);
      const vb = raw.visit_body as number[];
      const vf = raw.visit_face as number[];
      vb.forEach((bi, i) => {
        const c = (bi === 1 ? cA : cB).get(vf[i]);
        expect(c, `visit ${i + 1}`).toEqual(appVisits[i][2]);
      });
    },
    120_000,
  );

  itPy(
    'a body with an internal face: the face is a visit of its solid; the app accepts the pair',
    async () => {
      const file = join(tmp, 'internal-in.bbrep');
      const made = py(['-c', INTERNAL_PY, file]);
      expect(made.code, made.out).toBe(0);
      const read = call(k, 'brep_read', k.putBytes(new Uint8Array(readFileSync(file))));
      const shapes = read.shapes as { id: number; type: string; faces: number }[];
      expect(shapes.map((s) => [s.type, s.faces])).toEqual([['solid', 7]]);
      const end = { bodies: [{ id: 'b1', shape: shapes[0].id, valid: true, feature: 'f1', names: null, name: 'Body 1', color: '#bdc9db' }], failed: [] };
      const ex = await exportForLink(adapter(k), doc({ b1: { name: 'Body 1' } }), end);
      if ('nothing' in ex) throw new Error('nothing exported');
      expect([ex.solids, ex.faces]).toEqual([1, 7]);
      const { r, shape, sidecar } = check('internal', ex);
      expect(r.out).toBe('ok');
      expect(r.code).toBe(0);
      // No names (an unnamed body): the faces are listed by index and body only.
      expect(sidecar.faces.map((f) => [f.index, f.body, f.name ?? null])).toEqual(Array.from({ length: 7 }, (_, i) => [i + 1, 1, null]));
      const visits = JSON.parse(py(['-c', VISITS_PY, shape]).out) as [number, number, number[]][];
      expect(visits.some((v) => v[2][2] === 10 && v[2][0] === 10 && v[2][1] === 10)).toBe(true);
    },
    120_000,
  );

  it('the same design in a fresh kernel (a reload) exports byte-identical BREP and sidecar', async () => {
    const build = async (kk: Kernel) => {
      const block = call(kk, 'box', { dx: 30, dy: 20, dz: 10 }).id as number;
      const split = call(kk, 'split', { id: block, plane: { origin: [12, 0, 0], normal: [1, 0, 0] } });
      const [a, b] = split.ids as number[];
      const end = { bodies: [body('b1', a, 'Block', 6), body('b2', b, 'Block', 6)], failed: [] };
      const ex = await exportForLink(adapter(kk), doc({ b1: { name: 'Block' }, b2: { name: 'Block' } }, [{ id: 'f1', name: 'Split 1' }]), end);
      if ('nothing' in ex) throw new Error('nothing exported');
      return ex;
    };
    const first = await build(k);
    const fresh = await loadKernel();
    const again = await build(fresh);
    expect(again.shapeSha256).toBe(first.shapeSha256);
    expect(Buffer.from(again.brep).equals(Buffer.from(first.brep))).toBe(true);
    expect(again.faceNames).toBe(first.faceNames);
  });

  it('a body left out of the simulation is not sent; with none left there is nothing to link', async () => {
    const one = call(k, 'box', { dx: 10, dy: 10, dz: 10 }).id as number;
    const two = call(k, 'box', { dx: 10, dy: 10, dz: 10, origin: [20, 0, 0] }).id as number;
    const end = { bodies: [body('b1', one, 'Part', 6), body('b2', two, 'Fluid', 6)], failed: [] };
    const ex = await exportForLink(adapter(k), doc({ b1: { name: 'Part' }, b2: { name: 'Fluid', simulation: false } }), end);
    if ('nothing' in ex) throw new Error('nothing exported');
    expect([ex.solids, ex.faces, ex.excluded]).toEqual([1, 6, ['Fluid']]);
    const none = await exportForLink(adapter(k), doc({ b1: { name: 'Part', simulation: false }, b2: { name: 'Fluid', simulation: false } }), end);
    expect(none).toEqual({ nothing: true, excluded: ['Part', 'Fluid'], surfaces: [] });
  });
});
