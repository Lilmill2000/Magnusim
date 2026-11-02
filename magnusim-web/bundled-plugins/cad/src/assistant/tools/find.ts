// find: preview a selector without changing anything (CAD tools spec §3.2.2, §5.6). Lists what it
// matches, each row with a handle for the rest of the request (#f3, #e7, #v2, #b1; regions as
// "<sketch> r2"), the person's words, the label (Base.end), the body, the feature and role that
// made it, its type, size, radius, centre, normal or axis, a point on it, hole or boss for a round
// face, the faces an edge joins, and for a flat face the frame a sketch on it gets; for a query with
// fillet or a sized hole, each face's fillet radius or hole bore (and through) and the number of
// holes, and a no-match says what the bodies have ("Body 1 has 12 fillet faces, R3 to R5"). The matches
// flash in the person's view at the watch pace (the shown bodies only, and not while the window is
// hidden); at the fast pace nothing lights.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { splitMerged, splitSuffix } from '../../naming/names';
import type { CallCtx, ToolImpl } from '../../types/assistant';
import type { SelectionItem } from '../../types/selection';
import { heartbeat, waitForRead } from '../busy';
import { ToolError } from '../errors';
import { ydirOf } from '../../features/sketch/plane';
import { modelId, parsePart } from '../labels';
import { frameWords } from '../model';
import { dir, jsonBytes, len, sig6, vec } from '../numbers';
import { runtimeOf } from '../runtime';
import { recognitionOf, summaryOf, type Features, type FeaturesSummary } from '../../kernel/recognition';
import { hasWords } from '../../features/delete_faces/words';
import type { DocUnits } from '../../types/units';
import { faceFrameRow, pointOnFace } from '../selectors/geometry';
import {
  centreOf,
  edgeLabel,
  faceLabel,
  handleFor,
  hitWords,
  holeOrBossOf,
  selectAny,
  shapeFiltersOf,
  withScene,
  type Hit,
  type Scene,
  type Selected,
} from '../selectors/resolve';

/** One row of find (CAD tools spec §5.6). */
export type FindRow = {
  handle: string;
  kind: 'face' | 'edge' | 'vertex' | 'body' | 'region' | 'plane' | 'axis';
  words: string;
  label?: string;
  body?: string;
  feature?: string;
  role?: string;
  type?: string;
  area_mm2?: number;
  length_mm?: number;
  radius_mm?: number;
  center_mm?: number[];
  normal?: number[];
  axis?: { point_mm: number[]; dir: number[] };
  point_mm?: number[];
  hole?: boolean;
  /** A fillet query's face: its radius (a torus's tube radius), [smallest, largest] when it varies by more than 1 %. */
  fillet_mm?: number | [number, number];
  /** A sized hole query's face: its hole's bore diameter, [narrowest, widest] for a stepped bore, and whether it goes through. */
  hole_mm?: number | [number, number];
  through?: boolean;
  faces?: [string, string];
  frame?: { origin_mm: number[]; u: number[]; v: number[]; normal: number[]; words: string };
  warning?: string;
} & Record<string, unknown>;

/** How long the matches stay lit in the person's view. */
export const FLASH_MS = 1500;
/** Rows by default, and at most (more counts the rest). */
export const LIMIT_DEFAULT = 10;
export const LIMIT_MAX = 25;

const ROLE_WORD = (role: string) => (role === 'm' ? 'mirror' : /^i-?\d/.test(role) ? 'copy' : role);

/** The feature and role that made a face (its name's first part). */
function madeBy(sc: Scene, name: string | null): { feature?: string; role?: string } {
  if (!name) return {};
  const p = parsePart(splitSuffix(splitMerged(name)[0] ?? '').base);
  if (!p) return {};
  const f = sc.names.featureName(p.feature);
  return { ...(f ? { feature: f } : {}), role: ROLE_WORD(p.role) };
}

const warningOf = (warnings: readonly string[]) => (warnings.length ? { warning: [...new Set(warnings)].join('; ') } : {});

/** A recognised size: one value, or [smallest, largest] when they differ by more than 1 % (a variable fillet, a stepped bore). */
export function spanOf(lo: number, hi: number): number | [number, number] {
  return hi - lo > 0.01 * Math.abs(hi) ? [len(lo), len(hi)] : len((lo + hi) / 2);
}

/**
 * How many drilled holes the faces of a sized hole query belong to; null for any other query, and
 * for one that lists edges or anything but faces ("edges of (Body 1 faces hole <= 6 mm)": its edges
 * carry no hole, so a count would say "0 holes").
 */
export function holesOf(r: Selected): number | null {
  if (r.kind !== 'face' || !shapeFiltersOf(r.sel).hole) return null;
  return new Set(r.hits.flatMap((h) => (h.kind === 'face' && h.recognized?.hole ? [h.recognized.hole.key] : []))).size;
}

/**
 * What one body has, for a query that matched nothing: its fillet faces and radii, its drilled holes
 * and bores, in the Part's units: Delete faces' own words (delete_faces/words.ts hasWords), so the
 * Find panel, the find tool and Add by size read the same ("R2 to R5"; "R0.07874 to R0.1969 in").
 */
export function summaryWords(body: string, s: FeaturesSummary, what: { fillet: boolean; hole: boolean }, units: DocUnits): string {
  const parts: string[] = [];
  if (what.fillet) parts.push(hasWords(body, 'fillets', s, units));
  if (what.hole) parts.push(hasWords(body, 'holes', s, units));
  return parts.join('; ');
}

/**
 * Why a query with fillet or a sized hole matched nothing, in words: what its bodies have ("Body 1
 * has 12 fillet faces, R3 to R5"), from the same recognition (cached), with the numbers in
 * `recognized`; null for any other query, or when no body of its scope could be searched.
 */
export async function nothingFound(sc: Scene, r: Selected): Promise<{ words: string; recognized: Record<string, unknown>[] } | null> {
  const sel = r.sel;
  if (sel.t !== 'query') return null;
  const what = shapeFiltersOf(sel);
  if (!what.fillet && !what.hole) return null;
  const scope = sel.scope;
  const bodies = scope.s === 'body' ? sc.bodies.filter((b) => b.id === scope.body.id) : sc.bodies;
  const words: string[] = [];
  const recognized: Record<string, unknown>[] = [];
  const rc = recognitionOf(sc.services.kernel);
  for (const b of bodies) {
    if (b.solids === 0) continue;
    // The searches the query made (fillets without holes, holes alone: each within its own face limit), cached.
    const opts = { faces: b.faces, signal: sc.signal };
    const fil = what.fillet ? await rc.features(b.shape, { holes: false }, opts) : null;
    const hol = what.hole ? await rc.features(b.shape, { blends: false }, opts) : null;
    if ((fil && !fil.ok) || (hol && !hol.ok)) continue;
    const s = summaryOf({ ...((fil ?? hol) as Extract<Features, { ok: true }>).result, blends: fil?.ok ? fil.result.blends : [], holes: hol?.ok ? hol.result.holes : [] });
    words.push(summaryWords(b.name, s, what, sc.state.doc.units));
    recognized.push({ body: b.name, ...(what.fillet ? { fillets: s.fillets } : {}), ...(what.hole ? { holes: s.holes } : {}) });
  }
  return words.length ? { words: words.join('; '), recognized } : null;
}

/** The words of a query that matched nothing (the find tool's message, the Find panel's line). */
export async function nothingWords(sc: Scene, r: Selected, query: string): Promise<{ message: string; detail: Record<string, unknown> }> {
  const found = await nothingFound(sc, r);
  const why = r.sel.t === 'selection' ? ': the person has nothing selected' : found ? `: ${found.words}` : '';
  return { message: `"${query}" matches nothing${why}.`, detail: found ? { recognized: found.recognized } : {} };
}

/** A row of find for one hit. */
export async function rowOf(sc: Scene, h: Hit, text: string): Promise<FindRow> {
  const words = hitWords(sc, h);
  switch (h.kind) {
    case 'face': {
      const t = h.topo;
      const label = faceLabel(sc, h);
      const p = pointOnFace(h.body.tess, h.index, t);
      const hb = await holeOrBossOf(sc, h);
      const frame = faceFrameRow(t);
      return {
        handle: await handleFor(sc, h),
        kind: 'face',
        words,
        ...(label ? { label } : {}),
        body: h.body.name,
        ...madeBy(sc, h.name),
        type: t.type,
        ...(typeof t.area === 'number' ? { area_mm2: sig6(t.area) } : {}),
        ...(typeof t.radius === 'number' ? { radius_mm: len(t.radius) } : {}),
        ...(t.centroid ? { center_mm: vec(t.centroid) } : {}),
        ...(t.type === 'plane' && t.normal ? { normal: dir(t.normal) } : {}),
        ...(t.axis ? { axis: { point_mm: vec(t.axis.origin), dir: dir(t.axis.dir) } } : {}),
        ...(p ? { point_mm: vec(p) } : {}),
        ...(hb ? { hole: hb === 'hole' } : {}),
        ...(h.recognized?.fillet ? { fillet_mm: spanOf(h.recognized.fillet.r_min, h.recognized.fillet.r_max) } : {}),
        ...(h.recognized?.hole ? { hole_mm: spanOf(h.recognized.hole.d_min, h.recognized.hole.d_max), through: h.recognized.hole.through } : {}),
        ...(frame ? { frame } : {}),
        ...(h.body.names ? {} : { warning: `The faces of ${h.body.name} have no names: pick them by a point (face at (x, y, z)).` }),
        ...warningOf(h.warnings),
      };
    }
    case 'edge': {
      const t = h.topo;
      const topo = await sc.cache.topo(h.body.shape);
      const label = edgeLabel(sc, h, topo);
      const [a, b] = [...new Set(t.faces)];
      const faceWord = (i: number | undefined) => (i === undefined ? '' : (sc.labels.of(h.bi, i).label ?? hitWords(sc, { kind: 'face', bi: h.bi, body: h.body, index: i, topo: topo.faceAt.get(i)!, name: h.body.names?.faces[i] ?? null, warnings: [] })));
      const axis = t.type === 'line' && t.dir && t.first ? { point_mm: vec(t.first), dir: dir(t.dir) } : t.type === 'circle' && t.center && t.axis_dir ? { point_mm: vec(t.center), dir: dir(t.axis_dir) } : null;
      return {
        handle: await handleFor(sc, h),
        kind: 'edge',
        words,
        ...(label ? { label } : {}),
        body: h.body.name,
        ...madeBy(sc, a === undefined ? null : (h.body.names?.faces[a] ?? null)),
        type: t.type,
        ...(typeof t.length === 'number' ? { length_mm: len(t.length) } : {}),
        ...(typeof t.radius === 'number' ? { radius_mm: len(t.radius) } : {}),
        ...((t.center ?? t.mid) ? { center_mm: vec((t.center ?? t.mid)!) } : {}),
        ...(axis ? { axis } : {}),
        ...(t.mid ? { point_mm: vec(t.mid) } : {}),
        ...(a !== undefined ? { faces: [faceWord(a), faceWord(b ?? a)] as [string, string] } : {}),
        ...warningOf(h.warnings),
      };
    }
    case 'vertex':
      return { handle: await handleFor(sc, h), kind: 'vertex', words, body: h.body.name, point_mm: vec(h.topo.p), ...warningOf(h.warnings) };
    case 'body': {
      const info = sc.state.rebuild.bodies.find((b) => b.id === h.body.id);
      const maker = sc.state.doc.features.find((f) => f.id === h.body.feature);
      const c = centreOf(h);
      const solids = info?.solids;
      const parts = [typeof solids === 'number' ? `${solids} ${solids === 1 ? 'solid' : 'solids'}` : null, typeof info?.volume === 'number' ? `${sig6(info.volume)} mm3` : null].filter(Boolean);
      return {
        handle: await handleFor(sc, h),
        kind: 'body',
        words: `${h.body.name}${parts.length ? `: ${parts.join(', ')}` : ''}`,
        body: h.body.name,
        ...(maker ? { feature: maker.name } : {}),
        ...(c ? { center_mm: vec(c) } : {}),
        ...warningOf(h.warnings),
      };
    }
    case 'region': {
      const r = h.row;
      return {
        handle: await handleFor(sc, h),
        kind: 'region',
        words,
        area_mm2: r.area_mm2,
        at: r.at,
        at_mm: vec(centreOf(h)!),
        bbox_uv: r.bbox_uv,
        holes: r.holes,
        depth: r.depth,
        bounded_by: r.entities.slice(0, 40).map(modelId),
        ...warningOf(h.warnings),
      };
    }
    case 'plane':
      return { handle: text, kind: 'plane', words, frame: { origin_mm: vec(h.frame.origin), u: dir(h.frame.xdir), v: dir(ydirOf(h.frame)), normal: dir(h.frame.normal), words: frameWords(h.frame) }, ...warningOf(h.warnings) };
    case 'axis':
      return { handle: text, kind: 'axis', words, axis: { point_mm: vec(h.origin), dir: dir(h.dir) }, ...warningOf(h.warnings) };
  }
}

/** What the person's view lights for the hits (the shown bodies' faces, edges, vertices and bodies; regions). */
function flashItems(sc: Scene, hits: readonly Hit[]): SelectionItem[] {
  if (sc.before !== null) return [];
  const out: SelectionItem[] = [];
  for (const h of hits) {
    if (h.kind === 'face' || h.kind === 'edge' || h.kind === 'vertex') out.push({ kind: h.kind, body: h.body.id, index: h.index });
    else if (h.kind === 'body') out.push({ kind: 'body', body: h.body.id });
    else if (h.kind === 'region') out.push({ kind: 'region', feature: h.sketch.id, key: h.region.key });
  }
  return out;
}

const flashing = new WeakMap<object, number>();

/** Light the matches in the person's view for FLASH_MS: at the watch pace only, never while the window is hidden. */
function flash(ctx: CallCtx, items: SelectionItem[]): void {
  const handle = ctx.services.viewport.get().handle;
  if (!handle || !items.length) return;
  if (runtimeOf(ctx.services)?.pace.get() === 'fast') return;
  if (typeof document !== 'undefined' && document.hidden) return;
  handle.flash(items);
  const token = (flashing.get(handle) ?? 0) + 1;
  flashing.set(handle, token);
  setTimeout(() => {
    if (flashing.get(handle) === token) handle.flash([]);
  }, FLASH_MS);
}

/** What exists where a query matched nothing: the kinds of faces or edges of its scope, counted. */
async function exists(sc: Scene, r: Selected): Promise<Record<string, unknown>> {
  const sel = r.sel;
  if (sel.t !== 'query') return {};
  const bodies = sel.scope.s === 'body' ? sc.bodies.filter((b) => b.id === (sel.scope as { body: { id: string } }).body.id) : sc.bodies;
  const counts: Record<string, number> = {};
  for (const b of bodies) {
    const t = await sc.cache.topo(b.shape, { faces: b.faces });
    const list = sel.of === 'face' ? t.faces.map((f) => f.type) : sel.of === 'edge' ? t.edges.filter((e) => e.type !== 'degenerate').map((e) => e.type) : t.vertices.map(() => 'vertex');
    for (const k of list) counts[k] = (counts[k] ?? 0) + 1;
  }
  return { exists: counts };
}

export const tool: ToolImpl = {
  kind: 'read',
  async run(ctx) {
    await waitForRead(ctx);
    const query = typeof ctx.input.query === 'string' ? ctx.input.query.trim() : '';
    if (!query) throw new ToolError('bad_input', 'query must be a selector (help selectors), not "".', { detail: { field: 'query' } });
    const raw = Number(ctx.input.limit);
    const limit = Number.isFinite(raw) ? Math.min(LIMIT_MAX, Math.max(1, Math.floor(raw))) : LIMIT_DEFAULT;
    await heartbeat(ctx, ctx.services.doc.settled(ctx.signal), 'Waiting for the rebuild');
    ctx.checkAbort();
    return withScene(ctx, {}, async (sc) => {
      const r = await selectAny(sc, query);
      if (!r.hits.length) {
        const no = await nothingWords(sc, r, query);
        throw new ToolError('nothing_selected', no.message, { detail: { query, ...(await exists(sc, r)), ...no.detail } });
      }
      const rows: FindRow[] = [];
      for (const h of r.hits.slice(0, limit)) rows.push(await rowOf(sc, h, r.text));
      const holes = holesOf(r);
      const data: Record<string, unknown> = { query, kind: r.kind, count: r.hits.length, ...(holes !== null ? { holes } : {}), rows, more: r.hits.length - rows.length };
      if (r.live) data.live = `${r.text} keeps every edge of ${r.live.length === 1 ? 'the face' : `the ${r.live.length} faces`} as the part changes (a fillet or chamfer stores the face); add a filter for a fixed set of edges`;
      // Within the reply's budget: the last rows go first.
      while (rows.length > 1 && jsonBytes(data) > ctx.budgets.full) {
        rows.pop();
        data.more = r.hits.length - rows.length;
      }
      flash(ctx, flashItems(sc, r.hits.slice(0, rows.length)));
      const kindWord = r.kind === 'mixed' ? 'things' : r.hits.length === 1 ? r.kind : r.kind === 'vertex' ? 'vertices' : r.kind === 'body' ? 'bodies' : `${r.kind}s`;
      const first = rows[0];
      const firstWords = first.label ?? first.handle ?? first.words;
      return {
        text: `find "${query}": ${r.hits.length} ${kindWord}${holes !== null ? ` (${holes} ${holes === 1 ? 'hole' : 'holes'})` : r.hits.length === 1 ? ` (${firstWords || first.words})` : ''}`,
        data,
        summary: `Found ${r.hits.length} ${kindWord} for ${query}`,
      };
    });
  },
};
