// Selectors resolved on the Part (CAD tools spec §5.1, §5.4): what a selector string names on a
// set of bodies, by the rules the person's own picks follow.
//   bodies   the shown bodies once the rebuild caught up (a new feature), or the bodies just before
//            the feature an edit changes (doc.bodiesBefore: a feature never picks what it made)
//   roles    a face matches when any part of its stored name has the feature and role (labels.ts);
//            none left lists the roles that are
//   queries  run on the page over the kernel's topo (one call per shape, topo-cache.ts); fillet and
//            a sized hole over the kernel's recognition (src/kernel/recognition.ts, cached per shape):
//            a body that cannot be searched (a surface body, over the face limit, a kernel below
//            API 8, a failure) refuses the whole query in words, never a partial list
//   points   the faces whose box is nearest first, measured by the kernel until the next box is
//            farther than the best; within max(0.05 mm, 0.002 x the body's size), one wins when it is
//            at most half as far as the next, else the selector is ambiguous
//   handles  resolved again by their stored reference (handles.ts)
// A rebuild or a kernel restart while a selector is read reads it once more; a second one answers
// busy/changed. Errors carry at most 8 candidates, each with a handle, a label, words and a centre.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { ownsBody } from '../../doc/features/hooks';
import { refOfRegion } from '../../features/extrude/profiles';
import { constructOutput } from '../../features/refgeom/api';
import { faceFrame, toModel } from '../../features/sketch/plane';
import { regionAt } from '../../features/sketch/regions';
import { refOfEdge, refOfVertex, resolveEdge, resolveVertex } from '../../naming/edges';
import { splitMerged, splitSuffix } from '../../naming/names';
import { refOfFace } from '../../naming/refs';
import { resolveFace } from '../../naming/resolve';
import { userSelection } from '../../lib/selection';
import type { SelectionItem } from '../../types/selection';
import type { AppServices } from '../../types/app';
import type { CallCtx } from '../../types/assistant';
import { ORIGIN_PLANES, type BodyId, type Feature, type FeatureId, type PersistentRef, type PlaneFrame, type RegionRef, type SketchFeature, type Vec2, type Vec3 } from '../../types/doc';
import type { DocState } from '../../types/doc-service';
import type { KernelCallError, TessPayload } from '../../types/kernel';
import type { BBox, RecognizeResult, ShapeId, TopoResult } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';
import type { SketchOutput, SketchRegion } from '../../types/sketch';
import type { AxisOutput, PlaneOutput } from '../../types/references';
import { heartbeat } from '../busy';
import { ToolError } from '../errors';
import { edgeWordsOf, faceWords, LABEL_ROLES, LabelIndex, parsePart, vertexWordsOf, type LabelNames } from '../labels';
import { describeSketch } from '../sketch/describe';
import { len, vec } from '../numbers';
import { regionRows, type RegionRow } from '../sketch/regions';
import { boxDiagonal, boxDistance, distance, dot, holeOrBoss, unionBox, unit } from './geometry';
import { currentHandles, handlesOf, type HandleEntry, type HandleKind } from './handles';
import { parseSelector, SelectorSyntaxError, type Filter, type KnownNames, type Sel, type SelKind, type SizeCmp, type Want } from './parse';
import { closestName, closestWords } from '../closest';
import { isFillet, limitWords, overLimit, recognitionOf, withCommas, type FaceLimits, type FeaturesQuery, type LimitKind } from '../../kernel/recognition';
import { topoCacheOf, type Topo, type TopoCache } from './topo-cache';

export type TopoFace = TopoResult['faces'][number];
export type TopoEdge = TopoResult['edges'][number];
export type TopoVertex = TopoResult['vertices'][number];

/** A body as the selectors read it. */
export interface SelBody {
  id: BodyId;
  name: string;
  shape: ShapeId;
  names: FaceNames | null;
  /** The feature that last changed it. */
  feature: FeatureId;
  /** The page's tessellation (a shown body), or null. */
  tess: TessPayload | null;
  bbox: BBox | null;
  faces: number | null;
  /** 0: a surface body (its normals may point either way). */
  solids: number | null;
  /** Where Move/copy body features took it (BuiltBody.placement). */
  placement?: number[] | null;
}

/** What the selectors of one call read: the bodies, their labels, the names, the handle key. */
export interface Scene {
  readonly services: AppServices;
  readonly state: DocState;
  readonly bodies: SelBody[];
  /** The feature the bodies are before (an edit), or null (the shown bodies). */
  readonly before: FeatureId | null;
  /** The tool's sketch, for bare region selectors ("r2", "all"). */
  readonly sketch: FeatureId | null;
  /** The feature being made or edited (a face it made cannot be kept by it). */
  readonly self: FeatureId | null;
  readonly labels: LabelIndex;
  readonly names: LabelNames;
  readonly known: KnownNames;
  readonly key: string;
  readonly cache: TopoCache;
  readonly signal?: AbortSignal;
  readonly progress: (label: string) => void;
  /** What "selection" names: a panel's own picks (the person's Hole panel's face), or null for the person's selection. */
  readonly selection?: readonly SelectionItem[] | null;
}

/** What recognition found a face to be: set by the fillet and sized-hole filters only (find's fillet_mm, hole_mm, through). */
export interface Recognized {
  fillet?: { r_min: number; r_max: number };
  /** key: the hole's own (body and hole), to count holes. */
  hole?: { key: string; d_min: number; d_max: number; through: boolean };
}

/** `handle`: the handle a hit was named by (it keeps it). */
export type FaceHit = { kind: 'face'; bi: number; body: SelBody; index: number; topo: TopoFace; name: string | null; warnings: string[]; handle?: string; recognized?: Recognized };
export type EdgeHit = { kind: 'edge'; bi: number; body: SelBody; index: number; topo: TopoEdge; warnings: string[]; handle?: string };
export type VertexHit = { kind: 'vertex'; bi: number; body: SelBody; index: number; topo: TopoVertex; warnings: string[]; handle?: string };
export type BodyHit = { kind: 'body'; bi: number; body: SelBody; warnings: string[]; handle?: string };
export type RegionHit = { kind: 'region'; sketch: SketchFeature; out: SketchOutput; row: RegionRow; region: SketchRegion; ref: RegionRef; warnings: string[] };
export type PlaneSource = { s: 'origin'; plane: 'origin:top' | 'origin:front' | 'origin:right' } | { s: 'feature'; feature: Feature } | { s: 'face'; face: FaceHit };
export type PlaneHit = {
  kind: 'plane';
  source: PlaneSource;
  /** The plane named, before any offset. */
  base: PlaneFrame;
  /** The plane itself (the base moved by its offset). */
  frame: PlaneFrame;
  offset: { expr: string; mm: number } | null;
  flip: boolean;
  words: string;
  warnings: string[];
};
export type AxisSource =
  | { s: 'origin'; axis: 'origin:x' | 'origin:y' | 'origin:z' }
  | { s: 'feature'; feature: Feature }
  | { s: 'sketch-line'; sketch: SketchFeature; entity: string }
  | { s: 'edge'; edge: EdgeHit }
  | { s: 'face-axis'; face: FaceHit }
  | { s: 'normal'; plane: PlaneHit };
export type AxisHit = { kind: 'axis'; source: AxisSource; origin: Vec3; dir: Vec3; words: string; warnings: string[] };
export type Hit = FaceHit | EdgeHit | VertexHit | BodyHit | RegionHit | PlaneHit | AxisHit;

/** What one selector named. */
export interface Selected {
  /** The kind of its hits ('mixed' for a selection of several kinds). */
  kind: SelKind | 'mixed';
  hits: Hit[];
  /**
   * "edges of F" with no filter: the faces F, kept as faces by a fillet or chamfer (a live set:
   * every edge of them, as the part changes); null otherwise.
   */
  live: FaceHit[] | null;
  warnings: string[];
  text: string;
  sel: Sel;
}

export interface SceneOptions {
  /** An edit: the bodies just before this feature. */
  before?: FeatureId | null;
  /** The tool's sketch (bare region selectors). */
  sketch?: FeatureId | null;
  /** The feature being made or edited. */
  self?: FeatureId | null;
}

/** What a scene needs of a call. */
export type SceneCall = Pick<CallCtx, 'services' | 'key' | 'signal' | 'progress'> & { readonly selection?: readonly SelectionItem[] | null };

const CANDIDATES_MAX = 8;
const COS1 = Math.cos(Math.PI / 180);
const SIN1 = Math.sin(Math.PI / 180);

// ------------------------------------------------------------------ the scene

function featureNames(s: DocState): LabelNames {
  const names = new Map(s.doc.features.map((f) => [f.id, f.name]));
  return { featureName: (id) => names.get(id) ?? null };
}

/** The bodies a scene reads, from the shown rebuild or the bodies before a feature. */
async function sceneBodies(services: AppServices, before: FeatureId | null): Promise<SelBody[]> {
  const s = services.doc.state.get();
  if (before) {
    const eb = await services.doc.bodiesBefore(before);
    return eb.bodies.map((b) => ({ id: b.id, name: b.name, shape: b.shape, names: b.names, feature: b.feature, tess: null, bbox: null, faces: null, solids: null, ...(b.placement ? { placement: b.placement } : {}) }));
  }
  return s.rebuild.bodies.map((b) => ({ id: b.id, name: b.name, shape: b.shape, names: b.names ?? null, feature: b.feature, tess: b.tess, bbox: b.bbox, faces: b.faces, solids: typeof b.solids === 'number' ? b.solids : null, ...(b.placement ? { placement: b.placement } : {}) }));
}

export async function buildScene(call: SceneCall, opts: SceneOptions = {}): Promise<Scene> {
  const { services } = call;
  const before = opts.before ?? null;
  const bodies = await sceneBodies(services, before);
  const state = services.doc.state.get();
  const names = featureNames(state);
  const known: KnownNames = {
    features: state.doc.features.map((f) => ({ id: f.id, name: f.name, type: f.type })),
    bodies: [...new Map([...Object.entries(state.doc.bodies).map(([id, b]) => [id, { id, name: b.name }] as const), ...bodies.map((b) => [b.id, { id: b.id, name: b.name }] as const)]).values()],
  };
  return {
    services,
    state,
    bodies,
    before,
    sketch: opts.sketch ?? null,
    self: opts.self ?? before ?? null,
    labels: new LabelIndex(bodies, names),
    names,
    known,
    key: call.key,
    cache: topoCacheOf(services),
    signal: call.signal,
    progress: (label) => call.progress(null, label),
    selection: call.selection ?? null,
  };
}

const isRestart = (e: unknown) => {
  const k = (e as Partial<KernelCallError> | null)?.kind;
  return k === 'restarted' || k === 'watchdog' || k === 'crash';
};

/**
 * Run `fn` on a scene; when the Part rebuilt or the kernel restarted meanwhile, once more on a new
 * scene (after the rebuild caught up); a second change answers busy/changed.
 */
export async function withScene<T>(call: SceneCall, opts: SceneOptions, fn: (sc: Scene) => Promise<T>): Promise<T> {
  const { services } = call;
  const mark = () => `${services.doc.state.get().rebuild.seq}:${services.kernel.status.get().respawns}:${services.kernel.status.get().state}`;
  for (let attempt = 0; ; attempt++) {
    const m0 = mark();
    let out: { ok: true; v: T } | { ok: false; e: unknown };
    try {
      const sc = await buildScene(call, opts);
      out = { ok: true, v: await fn(sc) };
    } catch (e) {
      out = { ok: false, e };
    }
    const changed = mark() !== m0 || (!out.ok && isRestart(out.e));
    if (!changed) {
      if (out.ok) return out.v;
      throw out.e;
    }
    if (call.signal?.aborted) throw out.ok ? new ToolError('stopped', 'The call was stopped.') : out.e;
    if (attempt >= 1) throw new ToolError('changed', 'The Part changed twice while the selector was read (a rebuild, or the geometry kernel restarted).');
    await heartbeat(call, services.doc.settled(call.signal), 'Waiting for the rebuild');
  }
}

// ------------------------------------------------------------------ small pieces

const bodyNameOf = (sc: Scene, id: BodyId) => sc.bodies.find((b) => b.id === id)?.name ?? sc.state.doc.bodies[id]?.name ?? sc.state.rebuild.bodies.find((b) => b.id === id)?.name ?? 'a removed body';
const featureById = (sc: Scene, id: FeatureId) => sc.state.doc.features.find((f) => f.id === id) ?? null;

async function topoOf(sc: Scene, b: SelBody): Promise<Topo> {
  return sc.cache.topo(b.shape, { faces: b.faces, signal: sc.signal, progress: (done, total) => sc.progress(`Reading the faces of ${b.name} (${done} of ${total})`) });
}

/** A body's box: the drawn one, else its faces' boxes. */
async function boxOf(sc: Scene, b: SelBody): Promise<BBox | null> {
  if (b.bbox) return b.bbox;
  const t = await topoOf(sc, b);
  return unionBox(t.faces.map((f) => f.bbox ?? null));
}

/** The size the selectors measure ties with: the bodies' box diagonal (at least 1 mm). */
async function partSize(sc: Scene, bodies: readonly SelBody[] = sc.bodies): Promise<number> {
  const boxes = await Promise.all(bodies.map((b) => boxOf(sc, b)));
  return Math.max(1, boxDiagonal(unionBox(boxes)));
}

const isSeam = (e: TopoEdge) => e.type === 'degenerate' || (e.faces.length >= 2 && new Set(e.faces).size < 2);

/** The words of a hit (the person's: "End face of Plate", "End · Side 2 of Plate"). */
export function hitWords(sc: Scene, h: Hit): string {
  const own = (b: SelBody) => b.names?.faces ?? null;
  switch (h.kind) {
    case 'face':
      return faceWords(h.name, sc.names, own(h.body));
    case 'edge': {
      const [a, b] = [...new Set(h.topo.faces)];
      return edgeWordsOf(h.body.names?.faces[a], h.body.names?.faces[b ?? a], sc.names, own(h.body)) ?? `an edge of ${h.body.name}`;
    }
    case 'vertex':
      return vertexWordsOf((h.topo.faces ?? []).map((i) => h.body.names?.faces[i]), sc.names, own(h.body)) ?? `a vertex of ${h.body.name}`;
    case 'body':
      return h.body.name;
    case 'region':
      return `${h.row.id} of ${h.sketch.name} (${h.row.area_mm2} mm2${h.row.holes ? `, ${h.row.holes} ${h.row.holes === 1 ? 'hole' : 'holes'}` : ''})`;
    case 'plane':
    case 'axis':
      return h.words;
  }
}

/** A face's label (with ~k), or null. */
export function faceLabel(sc: Scene, h: FaceHit): string | null {
  return sc.labels.of(h.bi, h.index).label;
}

/** An edge's label ("<label A> & <label B>") when its two faces have labels and no other edge joins them. */
export function edgeLabel(sc: Scene, h: EdgeHit, t?: Topo): string | null {
  const faces = [...new Set(h.topo.faces)];
  if (faces.length !== 2) return null;
  const a = sc.labels.of(h.bi, faces[0]).label;
  const b = sc.labels.of(h.bi, faces[1]).label;
  if (!a || !b) return null;
  if (t) {
    const twins = t.edges.filter((e) => !isSeam(e) && e.faces.length === 2 && new Set(e.faces).size === 2 && e.faces.includes(faces[0]) && e.faces.includes(faces[1]));
    if (twins.length > 1) return null;
  }
  return `${a} & ${b}`;
}

/** Where a hit is (model mm): a face's centroid, an edge's middle, a vertex, a body's box centre. */
export function centreOf(h: Hit): Vec3 | null {
  switch (h.kind) {
    case 'face':
      return (h.topo.centroid as Vec3 | undefined) ?? null;
    case 'edge':
      return (h.topo.mid as Vec3 | undefined) ?? (h.topo.first as Vec3 | undefined) ?? null;
    case 'vertex':
      return [...h.topo.p] as Vec3;
    case 'body':
      return h.body.bbox ? [(h.body.bbox[0] + h.body.bbox[3]) / 2, (h.body.bbox[1] + h.body.bbox[4]) / 2, (h.body.bbox[2] + h.body.bbox[5]) / 2] : null;
    case 'region':
      return toModel(h.out.plane, h.region.sample);
    case 'plane':
      return [...h.frame.origin] as Vec3;
    case 'axis':
      return h.origin;
  }
}

/** The stored reference of face, edge or vertex `index` of a body (null when the body has no names). */
async function refAt(sc: Scene, kind: 'face' | 'edge' | 'vertex', body: Pick<SelBody, 'shape' | 'names' | 'placement'>, index: number): Promise<PersistentRef | null> {
  if (!body.names) return null;
  try {
    if (kind === 'face') return await refOfFace(sc.cache.lookup, body, index);
    if (kind === 'edge') return await refOfEdge(sc.cache.lookup, body, index);
    return await refOfVertex(sc.cache.lookup, body, index);
  } catch {
    return null;
  }
}

const refForHandle = (sc: Scene, h: FaceHit | EdgeHit | VertexHit) => refAt(sc, h.kind, h.body, h.index);

/** The handle of a hit under the scene's key ('' when it cannot have one: an unnamed body's faces, a region, a plane). */
export async function handleFor(sc: Scene, h: Hit): Promise<string> {
  if (h.kind === 'region') return `${h.sketch.name} ${h.row.id}`;
  if (h.kind === 'plane' || h.kind === 'axis') return '';
  if (h.handle) return h.handle;
  const table = handlesOf(sc.services, sc.key);
  const words = hitWords(sc, h);
  if (h.kind === 'body') return table.give({ kind: 'body', body: h.body.id, bodyName: h.body.name, ref: null, label: h.body.name, words });
  const ref = await refForHandle(sc, h);
  if (!ref) return '';
  const label = h.kind === 'face' ? faceLabel(sc, h) : h.kind === 'edge' ? edgeLabel(sc, h) : null;
  return table.give({ kind: h.kind as HandleKind, body: h.body.id, bodyName: h.body.name, ref, label, words });
}

/** Up to 8 candidates for an error: {handle, label, words, center_mm}. */
export async function candidates(sc: Scene, hits: readonly Hit[]): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const h of hits.slice(0, CANDIDATES_MAX)) {
    const c = centreOf(h);
    const label = h.kind === 'face' ? faceLabel(sc, h) : h.kind === 'edge' ? edgeLabel(sc, h) : h.kind === 'body' ? h.body.name : null;
    out.push({ handle: await handleFor(sc, h), ...(label ? { label } : {}), words: hitWords(sc, h), ...(c ? { center_mm: vec(c) } : {}) });
  }
  return out;
}

// ------------------------------------------------------------------ hits

async function faceHit(sc: Scene, bi: number, index: number, warnings: string[] = []): Promise<FaceHit | null> {
  const b = sc.bodies[bi];
  const t = await topoOf(sc, b);
  const topo = t.faceAt.get(index);
  if (!topo) return null;
  const w = [...warnings];
  const lw = sc.labels.of(bi, index).warning;
  if (lw && !w.includes(lw)) w.push(lw);
  return { kind: 'face', bi, body: b, index, topo, name: b.names?.faces[index] ?? null, warnings: w };
}

async function facesOf(sc: Scene, bi: number): Promise<FaceHit[]> {
  const t = await topoOf(sc, sc.bodies[bi]);
  const out: FaceHit[] = [];
  for (const f of t.faces) {
    const h = await faceHit(sc, bi, f.i);
    if (h) out.push(h);
  }
  return out;
}

async function edgesOf(sc: Scene, bi: number): Promise<EdgeHit[]> {
  const t = await topoOf(sc, sc.bodies[bi]);
  return t.edges.filter((e) => !isSeam(e)).map((e) => ({ kind: 'edge', bi, body: sc.bodies[bi], index: e.i, topo: e, warnings: [] }));
}

async function verticesOf(sc: Scene, bi: number): Promise<VertexHit[]> {
  const t = await topoOf(sc, sc.bodies[bi]);
  return t.vertices.map((v) => ({ kind: 'vertex', bi, body: sc.bodies[bi], index: v.i, topo: v, warnings: [] }));
}

/** Whether face `index` of body `bi` was made by `feature` (any part of its name). */
function faceOwnedBy(sc: Scene, bi: number, index: number, feature: FeatureId): boolean {
  const n = sc.bodies[bi].names?.faces[index];
  return !!n && splitMerged(n).some((p) => parsePart(splitSuffix(p).base)?.feature === feature);
}

// ------------------------------------------------------------------ errors

function noBody(sc: Scene, id: BodyId): ToolError {
  const name = bodyNameOf(sc, id);
  const now = sc.bodies.map((b) => b.name);
  return new ToolError('not_found', `${name} is not there ${sc.before ? `before ${featureById(sc, sc.before)?.name ?? 'this feature'}` : 'now'}. Bodies: ${now.join(', ') || 'none'}.`, { detail: { body: name, bodies: now.slice(0, 30) } });
}

async function nothing(sc: Scene, message: string, near: readonly Hit[], extra: Record<string, unknown> = {}): Promise<ToolError> {
  return new ToolError('nothing_selected', message, { detail: { ...extra, candidates: await candidates(sc, near) } });
}

// ------------------------------------------------------------------ resolution

async function byHandle(sc: Scene, sel: Extract<Sel, { t: 'handle' }>): Promise<Hit> {
  const e: HandleEntry | null = currentHandles(sc.services, sc.key)?.get(sel.text) ?? null;
  if (!e) throw new ToolError('selector_stale', `${sel.text} is not a handle of this request: call find, then use the handles it gives.`, { detail: { handle: sel.text } });
  const bi = sc.bodies.findIndex((b) => b.id === e.body);
  if (bi < 0) throw new ToolError('selector_stale', `${sel.text} is gone: ${e.bodyName} is not there now; call find again.`, { detail: { handle: sel.text, was: e.label ?? e.words } });
  const body = sc.bodies[bi];
  if (e.kind === 'body') return { kind: 'body', bi, body, warnings: [], handle: sel.text.toLowerCase() };
  const after = featureById(sc, body.feature)?.name;
  const gone = () => new ToolError('selector_stale', `${sel.text} is gone after ${after ?? 'a change'}; call find again.`, { detail: { handle: sel.text, was: e.label ?? e.words } });
  if (!body.names || !e.ref) throw gone();
  const input = { ref: e.ref, shape: body.shape, names: body.names, lookup: sc.cache.lookup, placement: body.placement };
  const r = e.kind === 'face' ? await resolveFace(input) : e.kind === 'edge' ? await resolveEdge(input) : await resolveVertex(input);
  if (!r.ok) throw gone();
  const warnings = r.how === 'name' ? [] : [`${sel.text} moved: check`];
  const t = await topoOf(sc, body);
  const handle = sel.text.toLowerCase();
  if (e.kind === 'face') {
    const h = await faceHit(sc, bi, r.index, warnings);
    if (!h) throw gone();
    return { ...h, handle };
  }
  if (e.kind === 'edge') {
    const topo = t.edgeAt.get(r.index);
    if (!topo) throw gone();
    return { kind: 'edge', bi, body, index: r.index, topo, warnings, handle };
  }
  const topo = t.vertexAt.get(r.index);
  if (!topo) throw gone();
  return { kind: 'vertex', bi, body, index: r.index, topo, warnings, handle };
}

/** The person's selection on the scene's bodies (a shown face found again on the bodies before a feature). */
async function bySelection(sc: Scene, want: Want): Promise<Hit[]> {
  const items = sc.selection ?? userSelection(sc.services.selection.get()).items;
  const shown = sc.state.rebuild.bodies;
  const out: Hit[] = [];
  for (const it of items) {
    if (it.kind === 'face' || it.kind === 'edge' || it.kind === 'vertex') {
      const bi = sc.bodies.findIndex((b) => b.id === it.body);
      if (bi < 0) continue;
      const body = sc.bodies[bi];
      const from = shown.find((b) => b.id === it.body);
      let index: number | null = it.index;
      if (!from || from.shape !== body.shape) {
        if (!from?.names || !body.names) continue;
        const ref = await refAt(sc, it.kind, { shape: from.shape, names: from.names, placement: from.placement }, it.index);
        if (!ref) continue;
        const input = { ref, shape: body.shape, names: body.names, lookup: sc.cache.lookup, placement: body.placement };
        const r = it.kind === 'face' ? await resolveFace(input) : it.kind === 'edge' ? await resolveEdge(input) : await resolveVertex(input);
        index = r.ok ? r.index : null;
      }
      if (index === null) continue;
      const t = await topoOf(sc, body);
      if (it.kind === 'face') {
        const h = await faceHit(sc, bi, index);
        if (h) out.push(h);
      } else if (it.kind === 'edge') {
        const topo = t.edgeAt.get(index);
        if (topo) out.push({ kind: 'edge', bi, body, index, topo, warnings: [] });
      } else {
        const topo = t.vertexAt.get(index);
        if (topo) out.push({ kind: 'vertex', bi, body, index, topo, warnings: [] });
      }
    } else if (it.kind === 'body') {
      const bi = sc.bodies.findIndex((b) => b.id === it.body);
      if (bi >= 0) out.push({ kind: 'body', bi, body: sc.bodies[bi], warnings: [] });
    } else if (it.kind === 'region') {
      const h = regionByKey(sc, it.feature, it.key);
      if (h) out.push(h);
    } else if (it.kind === 'origin' && it.ref !== 'origin:point') {
      if (it.ref === 'origin:x' || it.ref === 'origin:y' || it.ref === 'origin:z') out.push(originAxis(it.ref));
      else out.push(originPlane(it.ref));
    } else if (it.kind === 'feature') {
      const f = featureById(sc, it.feature);
      if (f?.type === 'ref_plane') {
        const p = constructPlane(sc, f);
        if (p) out.push(p);
      } else if (f?.type === 'ref_axis') {
        const a = constructAxis(sc, f);
        if (a) out.push(a);
      }
    }
  }
  const kinds: Record<Want, Hit['kind'][]> = {
    face: ['face'],
    edge: ['edge'],
    vertex: ['vertex'],
    body: ['body'],
    plane: ['plane', 'face'],
    axis: ['axis', 'edge', 'face'],
    region: ['region'],
    any: ['face', 'edge', 'vertex', 'body', 'region', 'plane', 'axis'],
  };
  return out.filter((h) => kinds[want].includes(h.kind));
}

/** A role reference (CAD tools spec §5.4 rule 1). */
async function byRole(sc: Scene, sel: Extract<Sel, { t: 'role' }>): Promise<FaceHit[]> {
  const f = featureById(sc, sel.feature.id);
  const name = sel.feature.name;
  const rolesLeft = () => {
    const roles = sc.labels.rolesOf(sel.feature.id);
    return [...roles.entries()].map(([r, n]) => (n > 1 ? `${r} x${n}` : r));
  };
  if (f && (f.type === 'sketch' || f.type.startsWith('ref_'))) {
    throw new ToolError('unknown_role', `${name} is a ${f.type === 'sketch' ? 'sketch' : 'construction feature'}: it makes no faces${f.type === 'sketch' ? ` (its regions: "${name} r1", "${name} all")` : ''}.`, { detail: { feature: name } });
  }
  if (!(LABEL_ROLES as readonly string[]).includes(sel.role)) {
    const left = rolesLeft();
    throw new ToolError('unknown_role', `${name} has no role "${sel.role}". Roles: ${LABEL_ROLES.join(', ')}; ${name} has ${left.join(', ') || 'no faces with a role'} now.`, { detail: { feature: name, roles: left } });
  }
  const prefix = `${sel.feature.id}\u0000${sel.role}\u0000`;
  // side(o) of a sweep is every side swept from o (o@l1, o@a2, ...); side(o@a2) one of them.
  const swept = sel.role === 'side' && sel.detail !== null && !sel.detail.includes('@') ? `${prefix}${sel.detail}@` : null;
  const members = sc.labels.select((key) => (sel.detail === null ? key.startsWith(prefix) : key === `${prefix}${sel.detail}` || (swept !== null && key.startsWith(swept))));
  if (!members.length) {
    const left = rolesLeft();
    const near: Hit[] = [];
    for (let bi = 0; bi < sc.bodies.length && near.length < CANDIDATES_MAX; bi++)
      for (const f2 of await facesOf(sc, bi)) if (faceOwnedBy(sc, bi, f2.index, sel.feature.id) && near.length < CANDIDATES_MAX) near.push(f2);
    const what = `${sel.role}${sel.detail !== null ? `(${sel.text.slice(sel.text.indexOf('(') + 1, sel.text.lastIndexOf(')'))})` : ''}`;
    const where = sc.before ? ` before ${featureById(sc, sc.before)?.name ?? 'this feature'}` : '';
    throw await nothing(sc, left.length ? `${name} has ${left.join(', ')} on the bodies${where}; no ${what} is left (a later feature removed or merged it, or it never had one).` : `No face made by ${name} is on the bodies${where}.`, near, { feature: name, roles: left });
  }
  let picked = members;
  if (sel.k !== null) {
    if (sel.k > members.length) throw new ToolError('selector_index', `${sel.text}: there ${members.length === 1 ? 'is 1 face' : `are ${members.length} faces`} with that label, so ~1${members.length > 1 ? ` to ~${members.length}` : ''}.`, { detail: { range: [1, members.length] } });
    picked = [members[sel.k - 1]];
  }
  const out: FaceHit[] = [];
  for (const m of picked) {
    const h = await faceHit(sc, m.body, m.face);
    if (h) out.push(h);
  }
  return out;
}

function scopeBodies(sc: Scene, scope: Extract<Sel, { t: 'query' }>['scope']): number[] {
  if (scope.s === 'all' || scope.s === 'feature') return sc.bodies.map((_, i) => i);
  const bi = sc.bodies.findIndex((b) => b.id === scope.body.id);
  if (bi < 0) throw noBody(sc, scope.body.id);
  return [bi];
}

async function byQuery(sc: Scene, sel: Extract<Sel, { t: 'query' }>): Promise<Hit[]> {
  const bodies = scopeBodies(sc, sel.scope);
  let hits: (FaceHit | EdgeHit | VertexHit)[] = [];
  for (const bi of bodies) {
    if (sel.of === 'face') hits.push(...(await facesOf(sc, bi)));
    else if (sel.of === 'edge') hits.push(...(await edgesOf(sc, bi)));
    else hits.push(...(await verticesOf(sc, bi)));
  }
  if (sel.scope.s === 'feature') {
    const fid = sel.scope.feature.id;
    hits = hits.filter((h) => {
      if (h.kind === 'face') return faceOwnedBy(sc, h.bi, h.index, fid);
      const faces = h.kind === 'edge' ? h.topo.faces : (h.topo.faces ?? []);
      return faces.some((f) => faceOwnedBy(sc, h.bi, f, fid));
    });
  }
  return applyFilters(sc, hits, sel.filters);
}

/** The point rule (§5.4 rule 3). */
async function byPoint(sc: Scene, sel: Extract<Sel, { t: 'at' }>): Promise<Hit[]> {
  const p = sel.p;
  let bodies = sc.bodies.map((_, i) => i);
  if (sel.body) {
    const bi = sc.bodies.findIndex((b) => b.id === sel.body!.id);
    if (bi < 0) throw noBody(sc, sel.body.id);
    bodies = [bi];
  }
  const tolOf = new Map<number, number>();
  for (const bi of bodies) tolOf.set(bi, Math.max(0.05, 0.002 * boxDiagonal(await boxOf(sc, sc.bodies[bi]))));
  type Scored = { hit: FaceHit | EdgeHit | VertexHit; bound: number; d: number | null };
  const pool: Scored[] = [];
  for (const bi of bodies) {
    if (sel.of === 'face') for (const h of await facesOf(sc, bi)) pool.push({ hit: h, bound: boxDistance(h.topo.bbox ?? null, p), d: null });
    else if (sel.of === 'edge') for (const h of await edgesOf(sc, bi)) pool.push({ hit: h, bound: Math.max(0, distance(p, (h.topo.mid ?? h.topo.first ?? p) as Vec3) - (h.topo.length ?? Infinity)), d: null });
    else for (const h of await verticesOf(sc, bi)) pool.push({ hit: h, bound: distance(p, h.topo.p), d: distance(p, h.topo.p) });
  }
  pool.sort((a, b) => a.bound - b.bound);
  const maxTol = Math.max(0, ...tolOf.values());
  let best = Infinity;
  for (const s of pool) {
    if (s.bound > best + maxTol) break;
    if (s.d === null) {
      const h = s.hit;
      if (h.kind === 'face') {
        const r = await sc.services.kernel.call('measure', { a: { id: h.body.shape, face: h.index }, b: { point: [...p] as Vec3 } });
        s.d = r.result.distance ?? Infinity;
      } else {
        const r = await sc.services.kernel.call('edge_eval', { id: h.body.shape, edge: h.index, near: [...p] as Vec3 });
        s.d = r.result.nearest?.distance ?? Infinity;
      }
    }
    best = Math.min(best, s.d);
  }
  const measured = pool.filter((s) => s.d !== null).sort((a, b) => a.d! - b.d!);
  const within = measured.filter((s) => s.d! <= tolOf.get(s.hit.bi)!);
  const at = `(${p.map((v) => len(v)).join(', ')})`;
  const where = sel.body ? ` of ${sel.body.name}` : '';
  if (!within.length) {
    const n = measured[0];
    const nearWords = n ? `: nearest is ${(n.hit.kind === 'face' ? faceLabel(sc, n.hit) : n.hit.kind === 'edge' ? edgeLabel(sc, n.hit) : null) ?? hitWords(sc, n.hit)}, ${len(n.d!)} mm away` : '';
    throw await nothing(sc, `No ${sel.of}${where} at ${at}${nearWords}.`, measured.slice(0, CANDIDATES_MAX).map((s) => s.hit), { point_mm: vec(p), tolerance_mm: len(maxTol) });
  }
  if (within.length === 1) return [within[0].hit];
  const [d0, d1] = [within[0].d!, within[1].d!];
  if (d0 <= 0.5 * d1 && d1 - d0 > 1e-6) return [within[0].hit];
  throw new ToolError('selector_ambiguous', `${within.length} ${sel.of === 'vertex' ? 'vertices' : `${sel.of}s`}${where} are at ${at} (within ${len(Math.max(...within.map((s) => tolOf.get(s.hit.bi)!)))} mm): name one by a handle or a label, or a point inside it.`, {
    detail: { candidates: await candidates(sc, within.map((s) => s.hit)), point_mm: vec(p) },
  });
}

async function byEdgesOf(sc: Scene, sel: Extract<Sel, { t: 'edges-of' }>): Promise<{ hits: EdgeHit[]; live: FaceHit[] | null }> {
  const faces = (await evaluate(sc, sel.face, 'face')).hits as FaceHit[];
  const out: EdgeHit[] = [];
  const seen = new Set<string>();
  for (const f of faces) {
    for (const e of await edgesOf(sc, f.bi)) {
      if (!e.topo.faces.includes(f.index)) continue;
      const k = `${e.bi}:${e.index}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e);
    }
  }
  if (!sel.filters.length) return { hits: out, live: faces };
  return { hits: (await applyFilters(sc, out, sel.filters)) as EdgeHit[], live: null };
}

async function byPair(sc: Scene, sel: Extract<Sel, { t: 'pair' }>): Promise<EdgeHit[]> {
  const a = (await oneOf(sc, sel.a, 'face', 'the first face of "&"')) as FaceHit;
  const b = (await oneOf(sc, sel.b, 'face', 'the second face of "&"')) as FaceHit;
  const words = (h: FaceHit) => faceLabel(sc, h) ?? hitWords(sc, h);
  if (a.body.id !== b.body.id) throw new ToolError('bad_selector', `${words(a)} is on ${a.body.name} and ${words(b)} on ${b.body.name}: an edge joins two faces of one body.`, { detail: { selector: sel.text } });
  if (a.index === b.index) throw new ToolError('bad_selector', `"${sel.text}" names the same face twice.`, { detail: { selector: sel.text } });
  const edges = (await edgesOf(sc, a.bi)).filter((e) => {
    const f = new Set(e.topo.faces);
    return f.size === 2 && f.has(a.index) && f.has(b.index);
  });
  if (!edges.length) throw await nothing(sc, `${words(a)} and ${words(b)} do not meet: no edge joins them.`, [a, b]);
  return edges;
}

function originPlane(plane: 'origin:top' | 'origin:front' | 'origin:right'): PlaneHit {
  const p = ORIGIN_PLANES[plane];
  const frame: PlaneFrame = { origin: [...p.origin] as Vec3, normal: [...p.normal] as Vec3, xdir: [...p.xdir] as Vec3 };
  return { kind: 'plane', source: { s: 'origin', plane }, base: frame, frame, offset: null, flip: false, words: p.label, warnings: [] };
}

function originAxis(axis: 'origin:x' | 'origin:y' | 'origin:z'): AxisHit {
  const dirs: Record<string, Vec3> = { 'origin:x': [1, 0, 0], 'origin:y': [0, 1, 0], 'origin:z': [0, 0, 1] };
  return { kind: 'axis', source: { s: 'origin', axis }, origin: [0, 0, 0], dir: dirs[axis], words: `${axis.slice(-1).toUpperCase()} axis`, warnings: [] };
}

function constructPlane(sc: Scene, f: Feature): PlaneHit | null {
  const out = constructOutput(sc.state, f.id) as PlaneOutput | null;
  if (!out || out.type !== 'plane') return null;
  const frame: PlaneFrame = { origin: [...out.frame.origin] as Vec3, normal: [...out.frame.normal] as Vec3, xdir: [...out.frame.xdir] as Vec3 };
  return { kind: 'plane', source: { s: 'feature', feature: f }, base: frame, frame, offset: null, flip: false, words: `construction plane ${f.name}`, warnings: [] };
}

function constructAxis(sc: Scene, f: Feature): AxisHit | null {
  const out = constructOutput(sc.state, f.id) as AxisOutput | null;
  if (!out || out.type !== 'axis') return null;
  return { kind: 'axis', source: { s: 'feature', feature: f }, origin: [...out.origin] as Vec3, dir: unit(out.dir), words: `construction axis ${f.name}`, warnings: [] };
}

async function byPlane(sc: Scene, sel: Extract<Sel, { t: 'plane' }>): Promise<PlaneHit> {
  let hit: PlaneHit;
  const base = sel.base;
  if (base.b === 'origin') hit = originPlane(base.plane);
  else if (base.b === 'feature') {
    const f = featureById(sc, base.feature.id);
    const p = f ? constructPlane(sc, f) : null;
    if (!p) throw new ToolError('not_found', `${base.feature.name} is not built: fix it first, or use another plane.`, { detail: { feature: base.feature.name } });
    hit = p;
  } else {
    const face = (await oneOf(sc, base.face, 'face', 'the plane')) as FaceHit;
    if (face.topo.type !== 'plane' || !face.topo.normal || !face.topo.centroid) {
      throw new ToolError('not_flat', `${faceLabel(sc, face) ?? hitWords(sc, face)} is ${face.topo.type === 'plane' ? 'flat but has no normal' : `a ${face.topo.type} face`}: a plane needs one flat face, a construction plane, or Top, Front or Right.`, {
        detail: { candidates: await candidates(sc, [face]) },
      });
    }
    const frame = faceFrame(face.topo.normal as Vec3, face.topo.centroid as Vec3);
    hit = { kind: 'plane', source: { s: 'face', face }, base: frame, frame, offset: null, flip: false, words: `the plane of ${faceLabel(sc, face) ?? hitWords(sc, face)}`, warnings: [...face.warnings] };
  }
  if (sel.offset === null) return hit;
  const r = sc.services.doc.units.evaluate(sel.offset, 'length');
  if (!r.ok) throw new ToolError('expr_error', `offset "${sel.offset}": ${r.error}`, { detail: { selector: sel.text } });
  const mm = r.value;
  const d = sel.flip ? -mm : mm;
  const n = unit(hit.base.normal);
  const frame: PlaneFrame = { origin: [hit.base.origin[0] + n[0] * d, hit.base.origin[1] + n[1] * d, hit.base.origin[2] + n[2] * d], normal: [...hit.base.normal] as Vec3, xdir: [...hit.base.xdir] as Vec3 };
  return { ...hit, frame, offset: { expr: sel.offset, mm }, flip: sel.flip, words: `${hit.words} offset ${len(d)} mm` };
}

async function byAxis(sc: Scene, sel: Extract<Sel, { t: 'axis' }>): Promise<AxisHit> {
  const b = sel.base;
  switch (b.b) {
    case 'origin':
      return originAxis(b.axis);
    case 'feature': {
      const f = featureById(sc, b.feature.id);
      const a = f ? constructAxis(sc, f) : null;
      if (!a) throw new ToolError('not_found', `${b.feature.name} is not built: fix it first, or use another axis.`, { detail: { feature: b.feature.name } });
      return a;
    }
    case 'sketch-line': {
      const f = featureById(sc, b.sketch.id);
      if (!f || f.type !== 'sketch') throw new ToolError('not_found', `${b.sketch.name} is not a sketch.`, { detail: { feature: b.sketch.name } });
      const e = f.entities.find((x) => x.id.toLowerCase() === b.entity);
      const lines = f.entities.filter((x) => x.kind === 'line').map((x) => x.id.replace('__', '.'));
      if (!e) throw new ToolError('not_found', `${b.sketch.name} has no line ${b.text}. Lines: ${lines.slice(0, 30).join(', ') || 'none'}.`, { detail: { lines: lines.slice(0, 30) } });
      if (e.kind !== 'line') throw new ToolError('bad_selector', `${b.sketch.name}.${b.text} is a ${e.kind}: an axis needs a straight line.`, { detail: { lines: lines.slice(0, 30) } });
      const out = sc.state.rebuild.outputs[f.id] as SketchOutput | undefined;
      const pts = out?.type === 'sketch' ? out.points : f.points;
      const plane = out?.type === 'sketch' ? out.plane : f.plane;
      const a = pts[e.p[0]];
      const c = pts[e.p[1]];
      if (!a || !c) throw new ToolError('not_found', `${b.sketch.name}.${b.text} is not built.`);
      const A = toModel(plane, a);
      const C = toModel(plane, c);
      return { kind: 'axis', source: { s: 'sketch-line', sketch: f, entity: e.id }, origin: A, dir: unit([C[0] - A[0], C[1] - A[1], C[2] - A[2]]), words: `line ${b.text} of ${b.sketch.name}`, warnings: [] };
    }
    case 'edge': {
      const e = (await oneOf(sc, b.edge, 'edge', 'the axis')) as EdgeHit;
      const t = e.topo;
      const words = edgeLabel(sc, e) ?? hitWords(sc, e);
      if (t.type === 'line') {
        const d = t.dir ?? (t.first && t.last ? unit([t.last[0] - t.first[0], t.last[1] - t.first[1], t.last[2] - t.first[2]]) : null);
        if (!d || !t.first) throw new ToolError('bad_selector', `${words} has no direction.`);
        return { kind: 'axis', source: { s: 'edge', edge: e }, origin: [...t.first] as Vec3, dir: unit(d), words: `the line of ${words}`, warnings: [...e.warnings] };
      }
      if (t.type === 'circle' && t.center && t.axis_dir) return { kind: 'axis', source: { s: 'edge', edge: e }, origin: [...t.center] as Vec3, dir: unit(t.axis_dir), words: `the axis of ${words}`, warnings: [...e.warnings] };
      throw new ToolError('bad_selector', `${words} is ${t.type === 'ellipse' ? 'an ellipse' : `a ${t.type} edge`}: an axis needs a straight or round edge.`, { detail: { candidates: await candidates(sc, [e]) } });
    }
    case 'face-axis': {
      const f = (await oneOf(sc, b.face, 'face', 'the axis')) as FaceHit;
      if (!f.topo.axis) throw new ToolError('bad_selector', `${faceLabel(sc, f) ?? hitWords(sc, f)} is ${f.topo.type === 'plane' ? 'flat' : `a ${f.topo.type} face`}: "axis of" needs a round face (cylinder, cone, sphere or torus).`, { detail: { candidates: await candidates(sc, [f]) } });
      return { kind: 'axis', source: { s: 'face-axis', face: f }, origin: [...f.topo.axis.origin] as Vec3, dir: unit(f.topo.axis.dir), words: `the axis of ${faceLabel(sc, f) ?? hitWords(sc, f)}`, warnings: [...f.warnings] };
    }
    case 'normal': {
      const p = (await oneOf(sc, b.plane, 'plane', 'the axis')) as PlaneHit;
      return { kind: 'axis', source: { s: 'normal', plane: p }, origin: [...p.frame.origin] as Vec3, dir: unit(p.frame.normal), words: `the normal of ${p.words}`, warnings: [...p.warnings] };
    }
  }
}

function sketchById(sc: Scene, id: FeatureId): { f: SketchFeature; out: SketchOutput } {
  const f = featureById(sc, id);
  if (!f || f.type !== 'sketch') throw new ToolError('not_found', `${f?.name ?? 'That feature'} is not a sketch.`);
  const out = sc.state.rebuild.outputs[id] as SketchOutput | undefined;
  if (!out || out.type !== 'sketch') throw new ToolError('not_found', `${f.name} is not built (it is ${sc.state.rebuild.features[id]?.state ?? 'not rebuilt yet'}): fix it first.`, { detail: { feature: f.name } });
  return { f, out };
}

function regionHit(f: SketchFeature, out: SketchOutput, row: RegionRow): RegionHit {
  const region = out.regions.find((r) => r.key === row.key)!;
  return { kind: 'region', sketch: f, out, row, region, ref: refOfRegion(f.id, region), warnings: [] };
}

function regionByKey(sc: Scene, sketch: FeatureId, key: string): RegionHit | null {
  try {
    const { f, out } = sketchById(sc, sketch);
    const row = regionRows(out).find((r) => r.key === key);
    return row ? regionHit(f, out, row) : null;
  } catch {
    return null;
  }
}

function byRegion(sc: Scene, sel: Extract<Sel, { t: 'region' }>): RegionHit[] {
  const id = sel.sketch?.id ?? sc.sketch;
  if (!id) throw new ToolError('bad_selector', `"${sel.text}" names no sketch: write "<sketch> ${sel.text}".`, { detail: { selector: sel.text } });
  const { f, out } = sketchById(sc, id);
  const rows = regionRows(out);
  const list = () => rows.slice(0, 30).map((r) => ({ id: r.id, area_mm2: r.area_mm2, at: r.at, holes: r.holes, depth: r.depth }));
  if (!rows.length) {
    if (out.open.length) {
      // By the model's names (p.3, not the stored p__3), as the sketch tool and get_model give them.
      const { refOf } = describeSketch(f, sc.state);
      throw new ToolError('open_profile', `${f.name} has no closed region: ${out.open.length} open ${out.open.length === 1 ? 'end' : 'ends'} (${out.open.slice(0, 6).map((o) => `${refOf(o.entity)} at (${o.at.map((v) => len(v)).join(', ')})`).join(', ')}).`, {
        detail: { open: out.open.slice(0, 40).map((o) => ({ at: vec(o.at), entity: refOf(o.entity) })) },
      });
    }
    throw new ToolError('region_not_found', `${f.name} has no closed region.`, { detail: { regions: [] } });
  }
  const w = sel.which;
  const hits = (rs: RegionRow[]) => rs.map((r) => regionHit(f, out, r));
  switch (w.w) {
    case 'regions':
      return hits(rows);
    case 'all':
      // The regions at even depth are material: every hole stays open, an island in one is material.
      return hits(rows.filter((r) => r.depth % 2 === 0));
    case 'largest':
      return hits([rows[0]]);
    case 'r': {
      const r = rows[w.n - 1];
      if (!r) throw new ToolError('region_not_found', `${f.name} has ${rows.length === 1 ? 'one region, r1' : `regions r1 to r${rows.length}`}; there is no r${w.n}.`, { detail: { regions: list() } });
      return hits([r]);
    }
    case 'at': {
      const reg = regionAt(out.regions, w.uv as Vec2);
      if (!reg) throw new ToolError('region_not_found', `No region of ${f.name} holds (${w.uv.map((v) => len(v)).join(', ')}) (sketch u, v in mm).`, { detail: { regions: list() } });
      return hits(rows.filter((r) => r.key === reg.key));
    }
    case 'key': {
      const r = rows.find((x) => x.key === w.key);
      if (!r) throw new ToolError('region_not_found', `${f.name} has no region with that key now: use r1... or at(u, v).`, { detail: { regions: list() } });
      return hits([r]);
    }
  }
}

function bodiesOfFeature(sc: Scene, sel: Extract<Sel, { t: 'bodies-of' }>): BodyHit[] {
  const f = featureById(sc, sel.feature.id);
  const out: BodyHit[] = [];
  if (f) sc.bodies.forEach((b, bi) => {
    if (ownsBody(sc.services.doc.features, f, b.id)) out.push({ kind: 'body', bi, body: b, warnings: [] });
  });
  return out;
}

// ------------------------------------------------------------------ filters

type Geo = FaceHit | EdgeHit | VertexHit;

function centre(h: Geo): Vec3 | null {
  return centreOf(h);
}

async function tessFor(sc: Scene, b: SelBody): Promise<TessPayload | null> {
  if (b.tess) return b.tess;
  return sc.cache.tess(b.shape, Math.max(1, boxDiagonal(await boxOf(sc, b))));
}

/** The filters of a query, left to right (CAD tools spec §5.2 FILTER). */
export async function applyFilters(sc: Scene, start: Geo[], filters: readonly Filter[]): Promise<Geo[]> {
  let hits = start;
  for (const f of filters) {
    if (!hits.length) break;
    switch (f.f) {
      case '>':
      case '<': {
        const size = await partSize(sc);
        const tol = 1e-6 * size;
        const scored = hits.map((h) => ({ h, v: dot(centre(h) ?? [0, 0, 0], f.ax.dir) })).sort((a, b) => (f.f === '>' ? b.v - a.v : a.v - b.v));
        const levels: Geo[][] = [];
        let lead = NaN;
        for (const s of scored) {
          if (!levels.length || Math.abs(s.v - lead) > tol) {
            levels.push([]);
            lead = s.v;
          }
          levels[levels.length - 1].push(s.h);
        }
        if (f.n > levels.length) throw new ToolError('selector_index', `${f.text}: there ${levels.length === 1 ? 'is 1 level' : `are ${levels.length} levels`} along ${f.ax.text}, so [1]${levels.length > 1 ? ` to [${levels.length}]` : ''}.`, { detail: { range: [1, levels.length], column: f.col } });
        hits = levels[f.n - 1];
        break;
      }
      case '+':
      case '-': {
        const want = f.f === '+' ? f.ax.dir : ([-f.ax.dir[0], -f.ax.dir[1], -f.ax.dir[2]] as Vec3);
        hits = hits.filter((h) => h.kind === 'face' && h.topo.type === 'plane' && !!h.topo.normal && dot(unit(h.topo.normal), want) >= COS1);
        for (const h of hits) if (h.body.solids === 0 && !h.warnings.some((w) => w.startsWith('normals'))) h.warnings.push(`normals may be unreliable on ${h.body.name} (a surface body)`);
        break;
      }
      case '|':
      case '#': {
        const parallel = f.f === '|';
        hits = hits.filter((h) => {
          if (h.kind === 'face') {
            const d = h.topo.type === 'plane' ? h.topo.normal : h.topo.axis?.dir;
            if (!d) return false;
            const c = Math.abs(dot(unit(d), f.ax.dir));
            return parallel ? c >= COS1 : c <= SIN1;
          }
          if (h.kind === 'edge') {
            if (h.topo.type === 'line' && h.topo.dir) {
              const c = Math.abs(dot(unit(h.topo.dir), f.ax.dir));
              return parallel ? c >= COS1 : c <= SIN1;
            }
            // A circle lies across the axis it turns about.
            if ((h.topo.type === 'circle' || h.topo.type === 'ellipse') && h.topo.axis_dir) return !parallel && Math.abs(dot(unit(h.topo.axis_dir), f.ax.dir)) >= COS1;
          }
          return false;
        });
        break;
      }
      case '%':
        hits = hits.filter((h) => h.kind !== 'vertex' && h.topo.type === f.type);
        break;
      case 'hole':
      case 'boss': {
        const keep: Geo[] = [];
        for (const h of hits) {
          if (h.kind !== 'face') continue;
          if ((await holeOrBossOf(sc, h)) === f.f) keep.push(h);
        }
        hits = keep;
        break;
      }
      case 'radius': {
        const r = sc.services.doc.units.evaluate(f.expr, 'length');
        if (!r.ok) throw new ToolError('expr_error', `radius "${f.expr}": ${r.error}`, { detail: { column: f.col } });
        const want = r.value;
        const tol = Math.max(1e-4, 1e-6 * Math.abs(want));
        const ok = (v: number) => (f.cmp === '<=' ? v <= want + tol : f.cmp === '>=' ? v >= want - tol : Math.abs(v - want) <= tol);
        hits = hits.filter((h) => h.kind !== 'vertex' && typeof h.topo.radius === 'number' && ok(h.topo.radius));
        break;
      }
      case 'fillet':
      case 'sized-hole':
        hits = await byShape(sc, hits, f);
        break;
      case 'largest':
      case 'smallest': {
        const size = (h: Geo) => (h.kind === 'face' ? (h.topo.area ?? 0) : h.kind === 'edge' ? (h.topo.length ?? 0) : 0);
        const best = f.f === 'largest' ? Math.max(...hits.map(size)) : Math.min(...hits.map(size));
        hits = hits.filter((h) => Math.abs(size(h) - best) <= 1e-6 * Math.max(Math.abs(best), 1e-12));
        break;
      }
      case 'nearest': {
        const size = await partSize(sc);
        const ds: { h: Geo; d: number; bound: number }[] = hits.map((h) => ({ h, d: NaN, bound: h.kind === 'vertex' ? distance(f.p, h.topo.p) : h.kind === 'face' ? boxDistance(h.topo.bbox ?? null, f.p) : Math.max(0, distance(f.p, (h.topo.mid ?? f.p) as Vec3) - (h.topo.length ?? Infinity)) }));
        ds.sort((a, b) => a.bound - b.bound);
        let best = Infinity;
        for (const s of ds) {
          if (s.bound > best + 1e-6 * size) break;
          if (s.h.kind === 'vertex') s.d = s.bound;
          else if (s.h.kind === 'face') s.d = (await sc.services.kernel.call('measure', { a: { id: s.h.body.shape, face: s.h.index }, b: { point: [...f.p] as Vec3 } })).result.distance ?? Infinity;
          else s.d = (await sc.services.kernel.call('edge_eval', { id: s.h.body.shape, edge: s.h.index, near: [...f.p] as Vec3 })).result.nearest?.distance ?? Infinity;
          best = Math.min(best, s.d);
        }
        hits = ds.filter((s) => Number.isFinite(s.d) && s.d <= best + 1e-6 * size).map((s) => s.h);
        break;
      }
    }
  }
  return hits;
}

// ------------------------------------------------------------------ fillets and holes by shape

/** What a refusal to search a body tells the person (and the Assistant) to do instead. */
const SELECT_INSTEAD = 'Select its faces in the view instead.';

/** A plain size's margin: equal within max(0.001 mm, 1 %) (plan 3.2, decision D8). */
export function sizeTolerance(v: number): number {
  return Math.max(1e-3, 0.01 * Math.abs(v));
}

/**
 * The margin of <= and >=: 0.001 mm (a millionth of the size past 1 m), room for a sampled radius,
 * never the plain size's 1 %, which D8 gives a plain size only: "hole <= 5.95 mm" takes no 6 mm
 * bore, and Add by size's "4 holes up to Ø5.95 mm" is never said of them (review 2026-11-02).
 */
export function boundMargin(v: number): number {
  return Math.max(1e-3, 1e-6 * Math.abs(v));
}

/** Whether a fillet's radii or a hole's bores [lo, hi] fit a size: <= compares the largest, >= the smallest, = both (decision D8). */
export function fitsSize(lo: number, hi: number, cmp: SizeCmp, v: number): boolean {
  if (cmp === '<=') return hi <= v + boundMargin(v);
  if (cmp === '>=') return lo >= v - boundMargin(v);
  const tol = sizeTolerance(v);
  return lo >= v - tol && hi <= v + tol;
}

/** The search of one kind: fillets only, or drilled holes only (each with its own face limit). */
const searchOf = (what: 'Fillets' | 'Holes'): FeaturesQuery => (what === 'Fillets' ? { holes: false } : { blends: false });

/** The page's two face limits now (tests lower them). */
function limitsOf(sc: Scene): FaceLimits {
  const l = recognitionOf(sc.services.kernel).limits;
  return { fillets: l.maxFilletFaces, holes: l.maxHoleFaces };
}

/**
 * A body that cannot be searched for `what`, from what is known without a kernel call (a surface
 * body, more faces than that search's limit), or null.
 */
function unsearchable(sc: Scene, b: SelBody, what: 'Fillets' | 'Holes'): ToolError | null {
  if (b.solids === 0) return new ToolError('bad_selector', `${b.name} is a surface body: fillets and holes are found on solids only.`, { detail: { body: b.name, why: 'not_solid' }, hint: SELECT_INSTEAD });
  const limits = limitsOf(sc);
  const over = typeof b.faces === 'number' ? overLimit(b.faces, searchOf(what), limits) : null;
  return over ? tooLarge(b, b.faces!, over, limits) : null;
}

/**
 * A body over a face limit, naming both, the one the search ran into first: "Body 1 has 3,000
 * faces: holes are found on bodies of up to 2,600 faces and fillets on bodies of up to 5,000 faces."
 * The person's Find and Add by size read these words, and the Assistant gets them with both limits
 * in detail.
 */
const tooLarge = (b: SelBody, faces: number, over: LimitKind, limits: FaceLimits) =>
  new ToolError('bad_selector', `${b.name} has ${withCommas(faces)} faces: ${limitWords(over, limits)} faces.`, {
    detail: { body: b.name, why: 'too_large', faces, over, limit: limits[over], limits: { ...limits } },
    hint: SELECT_INSTEAD,
  });

/**
 * The fillets (or the drilled holes) recognition finds on a body (the page's client, cached per
 * shape and search), or its refusal as a ToolError in words. `what` is the search, and names it in
 * a failure's words: fillets are searched without holes (the larger face limit), holes alone.
 */
export async function recognizedOf(sc: Scene, b: SelBody, what: 'Fillets' | 'Holes' = 'Fillets'): Promise<RecognizeResult> {
  const early = unsearchable(sc, b, what);
  if (early) throw early;
  sc.progress(`Finding the ${what === 'Fillets' ? 'fillets' : 'holes'} of ${b.name}`);
  const r = await recognitionOf(sc.services.kernel).features(b.shape, searchOf(what), { faces: b.faces, signal: sc.signal });
  if (r.ok) return r.result;
  switch (r.reason) {
    case 'too_large':
      throw tooLarge(b, r.faces ?? b.faces ?? 0, r.over ?? (what === 'Fillets' ? 'fillets' : 'holes'), r.limits ?? limitsOf(sc));
    case 'not_solid':
      throw new ToolError('bad_selector', `${b.name} is a surface body: fillets and holes are found on solids only.`, { detail: { body: b.name, why: 'not_solid' }, hint: SELECT_INSTEAD });
    case 'old_kernel':
      throw new ToolError('kernel_failed', r.words, { detail: { body: b.name, why: 'old_kernel', api: r.api }, hint: SELECT_INSTEAD });
    default:
      throw new ToolError('kernel_failed', `${what} could not be found on ${b.name}: ${r.words.replace(/\.$/, '')}.`, { detail: { body: b.name, why: 'failed' }, hint: SELECT_INSTEAD });
  }
}

/**
 * The fillet and sized-hole filters: the faces recognition reads as a fillet (D7: ordinary and
 * vertex blends; 'cliff', tangent on one side only, and 'uncertain' are not) whose radius fits the
 * size, or that belong to a drilled hole whose bore fits it. Every body with faces left must be
 * searchable, else the whole query is refused with that body's words (checked from what is known
 * before any kernel call, then by the kernel).
 */
async function byShape(sc: Scene, hits: Geo[], f: Extract<Filter, { f: 'fillet' | 'sized-hole' }>): Promise<Geo[]> {
  let want: number | null = null;
  if (f.size) {
    const r = sc.services.doc.units.evaluate(f.size.expr, 'length');
    if (!r.ok) throw new ToolError('expr_error', `${f.f === 'fillet' ? 'fillet' : 'hole'} "${f.size.expr}": ${r.error}`, { detail: { column: f.col } });
    want = r.value;
  }
  const bodies = [...new Set(hits.map((h) => h.bi))];
  const what = f.f === 'fillet' ? 'Fillets' : 'Holes';
  for (const bi of bodies) {
    const early = unsearchable(sc, sc.bodies[bi], what);
    if (early) throw early;
  }
  const found = new Map<number, { blendAt: Map<number, RecognizeResult['blends'][number]>; holeAt: Map<number, number>; rec: RecognizeResult }>();
  for (const bi of bodies) {
    const rec = await recognizedOf(sc, sc.bodies[bi], what);
    const holeAt = new Map<number, number>();
    rec.holes.forEach((h, k) => h.faces.forEach((face) => holeAt.has(face) || holeAt.set(face, k)));
    found.set(bi, { blendAt: new Map(rec.blends.map((b) => [b.face, b])), holeAt, rec });
  }
  const out: Geo[] = [];
  for (const h of hits) {
    if (h.kind !== 'face') continue;
    const { blendAt, holeAt, rec } = found.get(h.bi)!;
    if (f.f === 'fillet') {
      const b = blendAt.get(h.index);
      if (!b || !isFillet(b)) continue;
      if (want !== null && !fitsSize(b.r_min, b.r_max, f.size!.cmp, want)) continue;
      out.push({ ...h, recognized: { ...h.recognized, fillet: { r_min: b.r_min, r_max: b.r_max } } });
    } else {
      const k = holeAt.get(h.index);
      if (k === undefined) continue;
      const hole = rec.holes[k];
      // A hole with no cylinder has no bore to size.
      if (hole.d_min === null || hole.d_max === null || want === null) continue;
      if (!fitsSize(hole.d_min, hole.d_max, f.size.cmp, want)) continue;
      out.push({ ...h, recognized: { ...h.recognized, hole: { key: `${h.bi}:${k}`, d_min: hole.d_min, d_max: hole.d_max, through: hole.through } } });
    }
  }
  return out;
}

/** Which shape filters a selector uses (fillet, a sized hole), its bracketed face queries too. */
export function shapeFiltersOf(sel: Sel): { fillet: boolean; hole: boolean } {
  const out = { fillet: false, hole: false };
  const walk = (s: Sel) => {
    if (s.t === 'query' || s.t === 'edges-of') {
      for (const f of s.filters) {
        if (f.f === 'fillet') out.fillet = true;
        if (f.f === 'sized-hole') out.hole = true;
      }
      if (s.t === 'edges-of') walk(s.face);
    } else if (s.t === 'pair') {
      walk(s.a);
      walk(s.b);
    }
  };
  walk(sel);
  return out;
}

const holeCache = new WeakMap<TessPayload, Map<number, 'hole' | 'boss' | null>>();

/** Whether a round face is a hole or a boss (geometry.ts), from the page's tessellation or a coarse one. */
export async function holeOrBossOf(sc: Scene, h: FaceHit): Promise<'hole' | 'boss' | null> {
  if (h.topo.type !== 'cylinder' && h.topo.type !== 'cone') return null;
  const tess = await tessFor(sc, h.body);
  if (!tess) return null;
  let m = holeCache.get(tess);
  if (!m) {
    m = new Map();
    holeCache.set(tess, m);
  }
  if (!m.has(h.index)) m.set(h.index, holeOrBoss(tess, h.index, h.topo));
  return m.get(h.index) ?? null;
}

// ------------------------------------------------------------------ evaluate

/** What `sel` names on the scene (no count rule: see selectOne / selectSet). */
export async function evaluate(sc: Scene, sel: Sel, want: Want): Promise<Selected> {
  const done = (kind: Selected['kind'], hits: Hit[], live: FaceHit[] | null = null): Selected => ({ kind, hits, live, warnings: [...new Set(hits.flatMap((h) => h.warnings))], text: textOf(sel), sel });
  switch (sel.t) {
    case 'handle': {
      const h = await byHandle(sc, sel);
      return done(h.kind as SelKind, [h]);
    }
    case 'selection': {
      const hits = await bySelection(sc, want);
      const kinds = new Set(hits.map((h) => h.kind));
      return done(kinds.size === 1 ? ([...kinds][0] as SelKind) : kinds.size ? 'mixed' : (want === 'any' ? 'face' : (want as SelKind)), hits);
    }
    case 'role':
      return done('face', await byRole(sc, sel));
    case 'query':
      return done(sel.of, await byQuery(sc, sel));
    case 'at':
      return done(sel.of, await byPoint(sc, sel));
    case 'edges-of': {
      const r = await byEdgesOf(sc, sel);
      return done('edge', r.hits, r.live);
    }
    case 'pair':
      return done('edge', await byPair(sc, sel));
    case 'body': {
      const bi = sc.bodies.findIndex((b) => b.id === sel.body.id);
      if (bi < 0) throw noBody(sc, sel.body.id);
      return done('body', [{ kind: 'body', bi, body: sc.bodies[bi], warnings: [] }]);
    }
    case 'bodies-of':
      return done('body', bodiesOfFeature(sc, sel));
    case 'all-bodies':
      return done(
        'body',
        sc.bodies.map((body, bi) => ({ kind: 'body', bi, body, warnings: [] })),
      );
    case 'plane':
      return done('plane', [await byPlane(sc, sel)]);
    case 'axis':
      return done('axis', [await byAxis(sc, sel)]);
    case 'region':
      return done('region', byRegion(sc, sel));
  }
}

function textOf(sel: Sel): string {
  switch (sel.t) {
    case 'selection':
      return 'selection';
    case 'body':
      return sel.body.name;
    case 'bodies-of':
      return `bodies of ${sel.feature.name}`;
    case 'all-bodies':
      return 'all bodies';
    default:
      return sel.text;
  }
}

/** A selector that does not read and starts with a filter (>Z, +Z, |Z, #Z, %cylinder, hole, boss, largest, smallest, radius, nearest, fillet): its scope is missing. */
const BARE_FILTER = /^(?:[<>+|%-]|#(?![fevb][1-9])|(?:hole|boss|largest|smallest|radius|nearest|fillet)(?:\s|$))/i;

/** A feature's name and what follows it ("Fillet 2 faces", "Hole 3.end"): a word, a number, then a kind or a role; never a filter and its size ("fillet 2 mm"). */
const NAME_SHAPED = /^[a-z][\w-]*\s+\d+\s*(?:\.(?!\d)|(?:faces|edges|vertices|face|edge|vertex|bodies|body|of)\b)/i;

const wordChar = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);

/** Whether `text` starts with a name of the Part, whole (as the parser reads names, quoted too): "Fillet 1 facs" names Fillet 1. */
export function startsWithName(text: string, known: KnownNames): boolean {
  const low = text.trim().toLowerCase();
  return [...known.features, ...known.bodies].some((n) => {
    const name = n.name.toLowerCase();
    if (!name) return false;
    if (low.startsWith(`"${name}"`)) return true;
    return low.startsWith(name) && !(wordChar(name[name.length - 1]) && wordChar(low[name.length]));
  });
}

/**
 * Whether a selector that does not read is a filter with no scope ("fillet <= 2 mm", "+Z", "hole"),
 * not a feature or body named like one whose selector has a slip ("Fillet 1 facs", "Hole 2.start(x",
 * "Fillet 2 faces" when there is no Fillet 2): those get the plain words at the column (review 2026-11-02).
 */
export function bareFilter(text: string, known: KnownNames): boolean {
  const t = text.trim();
  return BARE_FILTER.test(t) && !startsWithName(t, known) && !NAME_SHAPED.test(t);
}

/** The name a selector that does not read starts with at `column` (1-based): up to its first ".", "&", ",", "(" or kind word, unquoted. */
export function nameAt(text: string, column: number): string {
  const rest = text.slice(Math.max(0, column - 1));
  return rest
    .split(/[.&,(]|\s+(?:faces|edges|vertices|face|edge|vertex|bodies|body|of)\b/i)[0]
    .replace(/^\s*"|"\s*$/g, '')
    .trim();
}

/** Parse `text` for `want`, a syntax error as bad_selector with its column (a name it does not know: the closest one too). */
export function parseFor(sc: Scene, text: string, want: Want, field?: string): Sel {
  try {
    return parseSelector(text, sc.known, want);
  } catch (e) {
    if (!(e instanceof SelectorSyntaxError)) throw e;
    const unknownName = /no .* starts here|is called/.test(e.message);
    const names = unknownName ? { features: sc.known.features.slice(0, 20).map((f) => f.name), bodies: sc.known.bodies.slice(0, 20).map((b) => b.name) } : null;
    const near = unknownName ? closestName(nameAt(text, e.column), [...sc.known.features.map((f) => f.name), ...sc.known.bodies.map((b) => b.name)]) : null;
    // A filter alone ("+Z", "hole", "largest" as a face): it goes after its scope.
    const bare = want !== 'region' && want !== 'body' && want !== 'plane' && want !== 'axis' && bareFilter(text, sc.known);
    const example = bare ? `${sc.known.bodies[0]?.name ?? 'Body 1'} ${want === 'edge' ? 'edges' : want === 'vertex' ? 'vertices' : 'faces'} ${text.trim()}` : '';
    throw new ToolError('bad_selector', `${field ? `${field}: ` : ''}${e.message} (column ${e.column} of "${text}")${bare ? `: a filter goes after its scope, as in "${example}"` : ''}.${closestWords(near)}`, {
      detail: { ...(field ? { field } : {}), selector: text, column: e.column, ...(names ? { names } : {}), ...(near ? { closest: near } : {}) },
      ...(bare ? { hint: `Put the body (or "all") and the kind first: "${example}"; find lists what it names.` } : {}),
    });
  }
}

const plural = (kind: string) => (kind === 'vertex' ? 'vertices' : kind === 'body' ? 'bodies' : `${kind}s`);

async function oneOf(sc: Scene, sel: Sel, want: Exclude<Want, 'any'>, field: string): Promise<Hit> {
  const r = await evaluate(sc, sel, want);
  return one(sc, r, want, field);
}

async function one(sc: Scene, r: Selected, want: Want, field: string): Promise<Hit> {
  if (!r.hits.length) throw await nothing(sc, `${field}: "${r.text}" names no ${want === 'any' ? 'thing' : want}${r.sel.t === 'selection' ? ' (the person has none selected)' : ''}.`, [], { field });
  if (r.hits.length > 1) {
    throw new ToolError('selector_ambiguous', `${field}: "${r.text}" names ${r.hits.length} ${plural(r.kind === 'mixed' ? 'thing' : r.kind)}; this field takes one: narrow it, or use one of the candidates' handles.`, {
      detail: { field, count: r.hits.length, candidates: await candidates(sc, r.hits) },
    });
  }
  return r.hits[0];
}

/**
 * The one thing a single-entity field names (`on`, `to`, `axis`, `about`, `face`, a measure
 * target): none is nothing_selected, more than one selector_ambiguous with up to 8 candidates.
 */
export async function selectOne(sc: Scene, text: string, want: Exclude<Want, 'any'>, field: string): Promise<{ hit: Hit; selected: Selected }> {
  const r = await evaluate(sc, parseFor(sc, text, want, field), want);
  return { hit: await one(sc, r, want, field), selected: r };
}

/** What a set field's selector names (targets, items, tools): at least one, deduplicated. */
export async function selectSet(sc: Scene, text: string, want: Exclude<Want, 'any'>, field: string): Promise<Selected> {
  const r = await evaluate(sc, parseFor(sc, text, want, field), want);
  if (!r.hits.length) throw await nothing(sc, `${field}: "${r.text}" names no ${plural(want)}${r.sel.t === 'selection' ? ' (the person has none selected)' : ''}.`, [], { field });
  return r;
}

/** Whatever a selector names (find), possibly nothing. */
export async function selectAny(sc: Scene, text: string, field = 'query'): Promise<Selected> {
  return evaluate(sc, parseFor(sc, text, 'any', field), 'any');
}

/**
 * The echo an edit's result gives for a field (§5.4 rule 7): "edges of Base.end %line -> 4 edges
 * (lines), fixed set".
 */
export function echo(sc: Scene, r: Selected): string {
  const n = r.hits.length;
  const kind = r.kind === 'mixed' ? 'things' : n === 1 ? r.kind : plural(r.kind);
  let what = '';
  if (n === 1) {
    const h = r.hits[0];
    what = h.kind === 'face' ? (faceLabel(sc, h) ?? hitWords(sc, h)) : h.kind === 'edge' ? (edgeLabel(sc, h) ?? hitWords(sc, h)) : hitWords(sc, h);
  } else {
    const types = new Map<string, number>();
    for (const h of r.hits) {
      const t = h.kind === 'face' || h.kind === 'edge' ? h.topo.type : h.kind;
      types.set(t, (types.get(t) ?? 0) + 1);
    }
    what = [...types.entries()].map(([t, k]) => (types.size === 1 ? plural(t) : `${k} ${k === 1 ? t : plural(t)}`)).join(', ');
  }
  const set = r.kind === 'edge' && r.sel.t === 'edges-of' ? (r.live ? ', live set (every edge of the face as the part changes)' : ', fixed set') : '';
  return `${r.text} -> ${n === 1 ? `${what}` : `${n} ${kind} (${what})`}${set}`;
}

