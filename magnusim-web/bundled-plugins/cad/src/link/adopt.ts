// Edit in CAD (host API 1.7): the original-names sidecar. A Part opened to edit a
// project geometry imports the geometry's STEP; its faces get CAD's persistent names
// (F:<import>:import:<item>:<k>). Before the first Back with a change, the app must
// learn which of the ORIGINAL geometry's faces carries which of those names, so that
// its usual name-then-shape map (the link update) carries every boundary condition,
// refinement and monitor over to the edited part. This file writes that sidecar:
// one row per host face (the app's own numbering, ws.project.geometryFaces()), in
// the app's "magnusim.face-names" format (sidecar.ts), with CAD's name where the face
// is found:
//   1. by index: CAD's visit i (the kernel's link_export order over the import's
//      solids, the app's face_visits rule) when its fingerprint matches host face i
//      (centroid within 1e-4 of the diagonal, area within 1e-3 relative, normals
//      within dot 0.9999 when both have one: the app's sameFace);
//   2. else the one face of the same body (bodies paired by the index matches, else by
//      order) with that fingerprint, if exactly one has it;
//   3. else unnamed: that face's records follow by shape only, and the Part says so.
// Healing can renumber or split faces; the fingerprints catch the renumbering.
// Owner: LINK (Edit in CAD).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Bridge } from '../lib/bridge';
import { recentBrep } from '../features/import/feature';
import type { CadDoc, FeatureId, ImportFeature } from '../types/doc';
import type { CadAdopt, EditedGeometry, GeometryFace, GeometryFaces } from '../types/edit-geometry';
import type { KernelAdapter } from '../types/kernel';
import type { BBox, ShapeId } from '../types/kernel-protocol';
import { canonicalJson } from '../doc/canonical';
import { sha256Hex } from './export';
import { faceKey, faceLabeler, faceNamesText, pieceName, uniqueNames, type SidecarBody, type SidecarFace } from './sidecar';

/**
 * Where the sidecar goes in the plugin's folder: beside the study's model, one per Imported feature
 * (two tabs that each imported never write the same file).
 */
export function adoptPath(studyId: string, importId: string): string {
  return `studies/${studyId}/adopt/${importId}/original_names.json`;
}

/**
 * The design as saved, for "is it still the import?" (Undo back to the import, then Back): its
 * features, bodies and parameters in canonical form, hashed. The view, the units and the doc's meta
 * are left out.
 */
export async function designDigest(doc: Pick<CadDoc, 'features' | 'bodies' | 'params'>): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson({ features: doc.features, bodies: doc.bodies, params: doc.params })));
}

/** One face visit of CAD's import, as the app would number it. */
export interface CadVisit {
  /** 1-based solid (link_export's `visit_body`). */
  solid: number;
  /** CAD's body (a body of several solids: "<id>#k" for piece k > 1). */
  bodyId: string;
  /** The face's index in its own body's shape (selection, persistent names). */
  face: number;
  /** CAD's persistent face name, or null. */
  name: string | null;
  area: number | null;
  centroid: [number, number, number] | null;
  normal: [number, number, number] | null;
}

export interface FaceMatch {
  /** Per host face (in GeometryFaces.faces order): the CAD visit's index in `visits`, or -1. */
  visit: number[];
  matched: number;
  total: number;
  byIndex: number;
  byShape: number;
  /** Host body index (1-based) -> CAD solid (1-based), or null. */
  bodies: Map<number, number | null>;
}

const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The app's sameFace (scripts/geometry-face-match.js): place, size and facing. */
export function sameFace(h: Pick<GeometryFace, 'area' | 'centroid' | 'normal'>, c: Pick<CadVisit, 'area' | 'centroid' | 'normal'>, tol: number): boolean {
  if (!Array.isArray(h.centroid) || !c.centroid || c.area == null) return false;
  if (!(dist(h.centroid, c.centroid) <= tol)) return false;
  const ha = Number(h.area);
  const ca = Number(c.area);
  if (!(Math.abs(ha - ca) <= 1e-3 * Math.max(ha, ca, 1e-12))) return false;
  if (Array.isArray(h.normal) && Array.isArray(c.normal)) {
    const dot = h.normal[0] * c.normal[0] + h.normal[1] * c.normal[1] + h.normal[2] * c.normal[2];
    if (!(dot >= 0.9999)) return false;
  }
  return true;
}

/**
 * Host faces -> CAD visits: by index first, then the unique fingerprint match in the same body.
 * `diag` is the part's bounding-box diagonal (mm).
 */
export function matchFaces(host: readonly GeometryFace[], visits: readonly CadVisit[], diag: number): FaceMatch {
  const tol = Math.max(1e-4 * diag, 1e-6);
  // The visits by centroid in a grid of tol cells: a fingerprint is looked for in the 27 cells
  // around it, never over every face (the 113 MB part has tens of thousands).
  const cell = (v: number) => Math.floor(v / tol);
  const grid = new Map<string, number[]>();
  visits.forEach((c, k) => {
    if (!c.centroid) return;
    const key = `${cell(c.centroid[0])},${cell(c.centroid[1])},${cell(c.centroid[2])}`;
    const list = grid.get(key);
    if (list) list.push(k);
    else grid.set(key, [k]);
  });
  /** Visits with the fingerprint of host face h (in `solid` when given), by index. */
  const like = (h: GeometryFace, solid: number | null = null): number[] => {
    if (!Array.isArray(h.centroid)) return [];
    const [x, y, z] = h.centroid.map(cell);
    const out: number[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const k of grid.get(`${x + dx},${y + dy},${z + dz}`) ?? []) if ((solid == null || visits[k].solid === solid) && sameFace(h, visits[k], tol)) out.push(k);
    return out.sort((a, b) => a - b);
  };
  const visit = host.map(() => -1);
  const used = new Set<number>();
  let byIndex = 0;
  host.forEach((h, i) => {
    const c = visits[i];
    if (c && sameFace(h, c, tol)) {
      visit[i] = i;
      used.add(i);
      byIndex++;
    }
  });
  // Bodies: each host body to the CAD solid most of its index matches are in; a body with none
  // (the app lists the bodies in another order) by its faces' unique fingerprints over every solid.
  const votes = new Map<number, Map<number, number>>();
  const vote = (body: number, solid: number) => {
    const m = votes.get(body) ?? new Map<number, number>();
    m.set(solid, (m.get(solid) ?? 0) + 1);
    votes.set(body, m);
  };
  host.forEach((h, i) => {
    if (visit[i] >= 0) vote(h.body, visits[visit[i]].solid);
  });
  const byIndex0 = new Set(votes.keys());
  host.forEach((h) => {
    if (byIndex0.has(h.body)) return;
    const hits = like(h);
    if (hits.length === 1) vote(h.body, visits[hits[0]].solid);
  });
  const hostBodies = [...new Set(host.map((h) => h.body))].sort((a, b) => a - b);
  const solids = [...new Set(visits.map((v) => v.solid))].sort((a, b) => a - b);
  const bodies = new Map<number, number | null>();
  const taken = new Set<number>();
  for (const b of hostBodies) {
    const m = votes.get(b);
    if (!m) continue;
    const best = [...m.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0]).find(([s]) => !taken.has(s));
    if (best) {
      bodies.set(b, best[0]);
      taken.add(best[0]);
    }
  }
  if (hostBodies.length === solids.length) {
    hostBodies.forEach((b, k) => {
      if (!bodies.has(b) && !taken.has(solids[k])) {
        bodies.set(b, solids[k]);
        taken.add(solids[k]);
      }
    });
  }
  for (const b of hostBodies) if (!bodies.has(b)) bodies.set(b, null);
  // The rest: the one CAD face of the paired body (any body when unpaired) with the same fingerprint.
  let byShape = 0;
  host.forEach((h, i) => {
    if (visit[i] >= 0) return;
    const hits = like(h, bodies.get(h.body) ?? null).filter((k) => !used.has(k));
    const hit = hits.length === 1 ? hits[0] : -1;
    if (hit >= 0) {
      visit[i] = hit;
      used.add(hit);
      byShape++;
    }
  });
  return { visit, matched: byIndex + byShape, total: host.length, byIndex, byShape, bodies };
}

/** The sidecar's rows: one per host face and host body, with CAD's names where matched. */
export function originalNamesText(
  faces: GeometryFaces,
  visits: readonly CadVisit[],
  match: FaceMatch,
  solidBodies: readonly { id: string; name: string }[],
  featureName: (id: FeatureId) => string | null,
): string {
  const raw = match.visit.map((k) => (k >= 0 ? visits[k].name : null));
  const label = faceLabeler(raw, featureName);
  // A named row carries the fingerprint of the CAD face it names (contract change 4): the app checks
  // it against its own face `index`, and drops a name that does not fit (that face follows by shape).
  const rows: SidecarFace[] = faces.faces.map((h, i) => {
    const name = faceKey(raw[i]) ?? undefined;
    const v = match.visit[i] >= 0 ? visits[match.visit[i]] : null;
    const print = name && v && v.centroid && v.area != null ? { centroid: [...v.centroid], area: v.area, normal: v.normal ? [...v.normal] : null } : {};
    return { index: h.index, body: h.body, name: name && Object.keys(print).length ? name : undefined, label: label(raw[i]) ?? undefined, ...print };
  });
  // The rows of the app's own bodies, exactly (a surface-only import has none).
  const hostBodies = faces.bodies.map((b) => b.index);
  const bodies: SidecarBody[] = hostBodies.map((index) => {
    const solid = match.bodies.get(index) ?? null;
    const b = solid != null ? solidBodies[solid - 1] : null;
    return b ? { index, id: b.id, name: b.name, label: b.name } : { index };
  });
  return faceNamesText(bodies, rows, faces.sourceSha256);
}

/** The Imported feature this Part made from the geometry it edits, or null. */
export function importOf(doc: Pick<CadDoc, 'features'>, geometryId: string): ImportFeature | null {
  return (doc.features.find((f) => f.type === 'import' && (f as ImportFeature).origin?.geometryId === geometryId) as ImportFeature | undefined) ?? null;
}

export interface AdoptDeps {
  bridge: Bridge;
  kernel: KernelAdapter;
  /** The document now (the import's bodies and their names). */
  doc(): CadDoc;
  /**
   * Extra kernels (started) that read the faces' fingerprints beside the Part's kernel on a large
   * part, as many as the memory budget allows for a BREP of `brepBytes` (the caller stops the rest),
   * or none. The caller owns them: dropHelpers() stops them all.
   */
  helpers?(brepBytes: number): Promise<KernelAdapter[]>;
  /** Stop every helper kernel now (one failed: the Part's kernel finishes alone). */
  dropHelpers?(): void;
}

/** CAD's visits of the import's solids, with their fingerprints. */
export interface CadFaceTable {
  visits: CadVisit[];
  /** Per solid (1-based - 1): its body id and unique name, as an export names them. */
  solids: { id: string; name: string }[];
  diag: number;
}

function grow(box: BBox | null, b: BBox | null | undefined): BBox | null {
  if (!b || !b.every(Number.isFinite)) return box;
  if (!box) return [...b];
  return [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.min(box[2], b[2]), Math.max(box[3], b[3]), Math.max(box[4], b[4]), Math.max(box[5], b[5])];
}

/** Stops between kernel calls (a kernel call is never cut off: that would restart the worker). */
function check(signal?: AbortSignal) {
  if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
}

/** Faces per `topo` call while the fingerprints are read (a B-spline face takes ~2.5 ms). */
const PROPS_CHUNK = 200;

type FaceProps = { area: number | null; centroid: [number, number, number] | null; normal: [number, number, number] | null };

/**
 * CAD's face table of the Imported feature `f`: its stored shapes read again (the same face
 * indices its build gives, so the same names), visited as the app visits them.
 * - The visit order: an import body that is ONE solid is visited face by face in its face
 *   map's order (TopExp_Explorer over a solid visits each face once, in the order MapShapes
 *   numbers them), so when every body is one solid (or a surface body, which a link leaves
 *   out) and the app counts as many faces (`expectFaces`: no face visited twice), no
 *   `link_export` is needed. Otherwise the kernel's link_export gives it.
 * - The fingerprints (area and centroid: BRepGProp, ~2.5 ms per B-spline face, 17 s on the
 *   113 MB part in one worker) are read in chunks from one queue: on a large part by the helper
 *   kernels of `d.helpers()` (each reads the BREP; edit-open.ts sizes them by memory), else by
 *   the Part's kernel. The Part's kernel takes no chunk beside the helpers: right after the
 *   import it is still drawing the part, and one chunk queued behind that held the whole
 *   matching 7 s on the 113 MB part. A helper is never worth more than the edit: if one fails
 *   (its read, a chunk, its worker dies), every helper is stopped (`d.dropHelpers()`), the chunks
 *   not finished go back in the queue, and the Part's kernel reads the BREP and finishes them alone.
 * `prof` gets where the time went (ms), `helpers` (how many read), `helper_failed` (1 when they
 * were dropped), `helper_heap_mb` (the largest helper heap seen) and `main_chunks`.
 */
export async function cadFaceTable(d: AdoptDeps, f: ImportFeature, signal?: AbortSignal, prof: Record<string, number> = {}, expectFaces?: number | Promise<number>): Promise<CadFaceTable> {
  const { bridge, kernel } = d;
  const doc = d.doc();
  let t = performance.now();
  const lap = (k: string) => {
    const now = performance.now();
    prof[k] = (prof[k] ?? 0) + now - t;
    t = now;
  };
  let bytes = recentBrep(f.brep.sha256);
  if (!bytes) {
    if (!bridge.files) throw new Error('this Magnusim cannot read CAD files (it needs host API 1.2)');
    bytes = await bridge.files.read(f.brep.rel);
    if (!bytes) throw new Error(`the stored shapes of ${f.name} are not in the project any more`);
  }
  const brepBytes = bytes.byteLength;
  let pool = (await d.helpers?.(brepBytes).catch(() => [] as KernelAdapter[])) ?? [];
  lap('brep_bytes');
  check(signal);
  // Every helper reads the stored shapes (a call transfers its bytes: each gets a copy); the Part's
  // kernel only when there is no helper, or they failed. A helper whose read fails ends them all.
  const src = bytes;
  bytes = null;
  const theirs = await Promise.allSettled(pool.map((k) => k.call('brep_read', { check: false }, { bytes: src.slice(0) })));
  let dead = false;
  const helperShapes: (ShapeId[] | null)[] = [];
  const drop = () => {
    if (dead) return;
    dead = true;
    prof.helper_failed = 1;
    d.dropHelpers?.();
  };
  theirs.forEach((r, w) => {
    helperShapes[w] = r.status === 'fulfilled' ? r.value.result.shapes.map((x) => x.id) : null;
  });
  if (helperShapes.some((x) => !x)) drop();
  type ShapeInfo = { id: ShapeId; type: string; faces: number };
  let mainShapes: ShapeInfo[] | null = null;
  const ensureMain = async (): Promise<ShapeInfo[]> => {
    if (!mainShapes) mainShapes = (await kernel.call('brep_read', { check: false }, { bytes: src.slice(0) })).result.shapes;
    return mainShapes;
  };
  const first = theirs[0];
  const shapes: ShapeInfo[] = !dead && first && first.status === 'fulfilled' ? first.value.result.shapes : await ensureMain();
  if (dead) pool = [];
  prof.helpers = pool.length;
  lap('brep_read');
  try {
    const items = f.items.filter((it) => shapes[it.index]);
    // The solids, in order: [item, piece] (src = its place in `items`).
    let solidsOf: { src: number; piece: number }[];
    let visitBody: number[];
    let visitFace: number[];
    // One solid or one shell per body: visited face by face (the app's face_visits over the STEP
    // visits a surface body's faces too). A link_export only when a body holds several solids and
    // the app counts other faces than that order gives; it leaves surface bodies out, so with no
    // solid at all the face order is the best there is (the fingerprints sort out the rest).
    const oneEach = items.every((it) => shapes[it.index].type === 'solid' || shapes[it.index].type === 'shell');
    const fastCount = items.reduce((n, it) => n + shapes[it.index].faces, 0);
    const solidCount = items.filter((it) => shapes[it.index].type === 'solid' || shapes[it.index].type === 'other').length;
    const expect = await expectFaces;
    if ((oneEach && (expect === undefined || expect === fastCount)) || solidCount === 0) {
      solidsOf = [];
      visitBody = [];
      visitFace = [];
      items.forEach((it, k) => {
        if (shapes[it.index].type !== 'solid' && shapes[it.index].type !== 'shell') return;
        solidsOf.push({ src: k, piece: 1 });
        for (let i = 0; i < shapes[it.index].faces; i++) {
          visitBody.push(solidsOf.length);
          visitFace.push(i);
        }
      });
      lap('visits');
    } else {
      check(signal);
      const ex = await (pool.length ? pool[0] : kernel).call('link_export', { ids: items.map((it) => shapes[it.index].id) });
      solidsOf = ex.result.solids;
      visitBody = ex.result.visit_body;
      visitFace = ex.result.visit_face;
      lap('link_export');
    }
    const names = uniqueNames(
      solidsOf.map((s) => {
        const n = doc.bodies[items[s.src].body]?.name ?? items[s.src].stepName ?? 'Body';
        return s.piece === 1 ? n : pieceName(n, s.piece);
      }),
    );
    const solids = solidsOf.map((s, k) => ({ id: s.piece === 1 ? items[s.src].body : `${items[s.src].body}#${s.piece}`, name: names[k] }));
    // Fingerprints of every face of each shape that has a visit: chunks from one queue.
    const props = new Map<number, Map<number, FaceProps>>();
    const queue: { src: number; start: number; count: number }[] = [];
    for (const k of [...new Set(solidsOf.map((s) => s.src))]) {
      props.set(k, new Map());
      const n = shapes[items[k].index].faces;
      for (let start = 0; start < n; start += PROPS_CHUNK) queue.push({ src: k, start, count: Math.min(PROPS_CHUNK, n - start) });
    }
    let box: BBox | null = null;
    const read = async (k: KernelAdapter, id: ShapeId, c: { src: number; start: number; count: number }) => {
      const r = await k.call('topo', { id, faces: { start: c.start, count: c.count }, edges: { start: 0, count: 0 }, vertices: { start: 0, count: 0 }, face_mass: true, face_bbox: 'fast' });
      const m = props.get(c.src)!;
      for (const fc of r.result.faces) {
        m.set(fc.i, { area: typeof fc.area === 'number' ? fc.area : null, centroid: (fc.centroid as [number, number, number] | null | undefined) ?? null, normal: (fc.normal as [number, number, number] | undefined) ?? null });
        box = grow(box, fc.bbox);
      }
    };
    const mainLoop = async () => {
      if (!queue.length) return;
      const mine = await ensureMain();
      for (let c = queue.shift(); c; c = queue.shift()) {
        check(signal);
        const t1 = performance.now();
        await read(kernel, mine[items[c.src].index].id, c);
        prof.main_chunks = (prof.main_chunks ?? 0) + 1;
        prof.main_chunk_ms_max = Math.max(prof.main_chunk_ms_max ?? 0, Math.round(performance.now() - t1));
      }
    };
    const helperLoop = async (k: KernelAdapter, w: number) => {
      for (let c = dead ? undefined : queue.shift(); c; c = dead ? undefined : queue.shift()) {
        try {
          await read(k, helperShapes[w]![items[c.src].index], c);
        } catch (e) {
          // Its chunk goes back to the Part's kernel, and no helper takes another one.
          queue.unshift(c);
          if (!dead) console.warn('[cad] a helper kernel failed; the Part kernel finishes the face fingerprints', e);
          drop();
          return;
        }
        prof.helper_heap_mb = Math.max(prof.helper_heap_mb ?? 0, Math.round((k.status.get().heap_bytes ?? 0) / 2 ** 20));
      }
    };
    await Promise.all(pool.map((k, w) => helperLoop(k, w)));
    // No helper, or they failed: the Part's kernel does what is left.
    await mainLoop();
    lap('topo');
    const visits: CadVisit[] = visitBody.map((solid, i) => {
      const s = solidsOf[solid - 1];
      const item = items[s.src];
      const face = visitFace[i];
      const p = props.get(s.src)?.get(face);
      return { solid, bodyId: solids[solid - 1].id, face, name: `F:${f.id}:import:${item.index}:${face}`, area: p?.area ?? null, centroid: p?.centroid ?? null, normal: p?.normal ?? null };
    });
    const b = box as BBox | null;
    const diag = b ? Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) : 0;
    return { visits, solids, diag };
  } finally {
    // Helper kernels are stopped by the caller (that frees everything at once). The Part's kernel
    // releases its copy in the background (1.5 s on the 113 MB part: nothing waits for it).
    const own = mainShapes as ShapeInfo[] | null;
    if (own) void kernel.call('release', { ids: own.map((x) => x.id) }).catch(() => {});
    lap('release');
  }
}

export interface AdoptOutcome {
  record: CadAdopt;
  /** Host face index (1-based) -> CAD face (body, index), for the faces found. */
  faces: Map<number, { body: string; index: number }>;
  /** Host body index (1-based) -> CAD body id. */
  bodies: Map<number, string>;
  /** The host's face table it was matched against. */
  table: GeometryFaces;
  ms: number;
  /** Where the time went (ms): host_faces, brep_bytes, brep_read, link_export, topo, release, match, sidecar, write. */
  prof?: Record<string, number>;
}

/** CAD body id of a solid ("<id>#k" pieces belong to <id>). */
const bodyOfSolid = (id: string) => id.replace(/#\d+$/, '');

/** The import's faces matched to the geometry's (nothing written). */
export interface AdoptMatch {
  table: GeometryFaces;
  cad: CadFaceTable;
  match: FaceMatch;
  /** Host face index (1-based) -> CAD face (body, index), for the faces found. */
  faces: Map<number, { body: string; index: number }>;
  /** Host body index (1-based) -> CAD body id. */
  bodies: Map<number, string>;
}

/** Match the import's faces to the geometry's face table (ws.project.geometryFaces()). */
export async function matchToGeometry(d: AdoptDeps, feature: ImportFeature, signal?: AbortSignal, prof: Record<string, number> = {}): Promise<AdoptMatch> {
  if (!d.bridge.edit) throw new Error('this Magnusim cannot edit a project geometry (it needs host API 1.7)');
  // The app's face table and CAD's at once (the app's comes while the kernels read the BREP).
  let t0 = performance.now();
  const tableP = d.bridge.edit.faces().then((t) => {
    prof.host_faces = performance.now() - t0;
    return t;
  });
  const [table, cad] = await Promise.all([tableP, cadFaceTable(d, feature, signal, prof, tableP.then((t) => t.faces.length))]);
  t0 = performance.now();
  const match = matchFaces(table.faces, cad.visits, cad.diag);
  prof.match = performance.now() - t0;
  const faces = new Map<number, { body: string; index: number }>();
  table.faces.forEach((h, i) => {
    const k = match.visit[i];
    if (k >= 0) faces.set(h.index, { body: bodyOfSolid(cad.visits[k].bodyId), index: cad.visits[k].face });
  });
  const bodies = new Map<number, string>();
  for (const [hb, solid] of match.bodies) if (solid != null) bodies.set(hb, bodyOfSolid(cad.solids[solid - 1].id));
  return { table, cad, match, faces, bodies };
}

/**
 * Match the import's faces to the geometry's, write the sidecar into the plugin's folder and
 * return the record for the study (`cad_adopt`). `baselineVersion` is the Part's save counter
 * with the import saved.
 */
export async function prepareAdoption(
  d: AdoptDeps,
  o: { geometry: EditedGeometry; feature: ImportFeature; baselineVersion: number; baselineDigest: string | null; studyId: string; signal?: AbortSignal },
): Promise<AdoptOutcome> {
  const t0 = performance.now();
  const files = d.bridge.files;
  if (!files) throw new Error('this Magnusim cannot store CAD files (it needs host API 1.2)');
  const prof: Record<string, number> = {};
  const m = await matchToGeometry(d, o.feature, o.signal, prof);
  const doc = d.doc();
  let t1 = performance.now();
  const text = originalNamesText(m.table, m.cad.visits, m.match, m.cad.solids, (id) => doc.features.find((f) => f.id === id)?.name ?? null);
  prof.sidecar = performance.now() - t1;
  t1 = performance.now();
  const rel = adoptPath(o.studyId, o.feature.id);
  const written = await files.write(rel, text, { signal: o.signal });
  const sha256 = String(written.sha256 ?? '').toLowerCase() || (await sha256Hex(new TextEncoder().encode(text)));
  prof.write = performance.now() - t1;
  return {
    record: { geometryId: o.geometry.id, importId: o.feature.id, baselineVersion: o.baselineVersion, baselineDigest: o.baselineDigest, originalNames: { rel, sha256 }, matched: m.match.matched, total: m.match.total, error: null },
    faces: m.faces,
    bodies: m.bodies,
    table: m.table,
    ms: performance.now() - t0,
    prof,
  };
}

/** "N faces of <Geometry> could not be matched; ..." when some were not, else null. */
export function unmatchedWords(a: Pick<CadAdopt, 'matched' | 'total'> & { error?: string | null }, geometryName: string): string | null {
  // A matching that failed is not "faces not matched": say what failed (review S5).
  if (a.error) return `Face matching failed: ${a.error.replace(/\.$/, '')}. Boundary conditions will follow by shape only.`;
  const n = a.total - a.matched;
  if (n <= 0) return null;
  return `${n} ${n === 1 ? 'face' : 'faces'} of ${geometryName} could not be matched; their boundary conditions follow by shape only.`;
}

/** The study's `cad_adopt`, when it is well formed. */
export function readCadAdopt(v: unknown): CadAdopt | null {
  if (!v || typeof v !== 'object') return null;
  const a = v as Partial<CadAdopt>;
  if (typeof a.geometryId !== 'string' || !a.geometryId || typeof a.baselineVersion !== 'number') return null;
  const n = a.originalNames;
  const names = n && typeof n === 'object' && typeof n.rel === 'string' && n.rel ? { rel: n.rel, sha256: String(n.sha256 ?? '') } : null;
  return {
    geometryId: a.geometryId,
    importId: typeof a.importId === 'string' && a.importId ? a.importId : null,
    baselineVersion: a.baselineVersion,
    baselineDigest: typeof a.baselineDigest === 'string' && a.baselineDigest ? a.baselineDigest : null,
    originalNames: names,
    matched: Number(a.matched) || 0,
    total: Number(a.total) || 0,
    error: typeof a.error === 'string' && a.error ? a.error : null,
  };
}

/** The app's count of named rows it could not check (LinkResult.unverified), in words, or null. */
export function unverifiedWords(n: number | null | undefined, geometryName: string): string | null {
  if (!n || n <= 0) return null;
  return `${n} ${n === 1 ? 'face' : 'faces'} of ${geometryName} could not be checked; their boundary conditions follow by shape only.`;
}
