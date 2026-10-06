// The build every pattern and the mirror share: what is repeated (the tool bodies of
// features, copies of bodies, or the local feature some faces bound), the copies made in the
// kernel (`copies`, work copies: the sources never change), their names, and the Operation:
//   New body    each copy its own body (ids derived from the first body, stable per copy key)
//   Join        fused to the body the copy came from (bodies), or to the bodies the copies
//               meet (features); a copy that does not touch it turns the feature red
//   Cut         cut from the scope's bodies, or the bodies the copies meet; a copy that misses
//               every body is named in an amber note
//   Intersect   what the bodies and the copies have in common
// A failure is the feature's red message; the model before it still shows (Onshape semantics).
// Owner: P4b PATTERN.
// SPDX-License-Identifier: GPL-3.0-or-later
import { deriveBodyId, storedBodyName } from '../../doc/features/body-ids';
import { plainKernelMessage } from '../../doc/rebuild';
import { namesFromResult } from '../../naming/result';
import type { BodyId, BodyOp, Feature, FeatureId, PatternCommon, Vec3 } from '../../types/doc';
import type { BuildContext, BuiltBody, FeatureBuildResult, PatternOutput } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { BBox, OpHistory, ShapeId } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';
import { timeoutForFaces } from '../../kernel/timeouts';
import { resolveRefs } from '../p2/refs';
import { copyNames } from './naming';
import { applyPoint, type PatternCopy } from './transforms';

export type PatternFeature = Feature & PatternCommon & { id: FeatureId; name: string };

/** Feature types whose tool body a feature pattern can repeat (they make bodies with an Operation). */
export const REPEATABLE_TYPES: readonly string[] = ['extrude', 'revolve', 'sweep', 'loft', 'pattern_linear', 'pattern_circular', 'mirror'];

/** A body id no document uses: the source feature's tool is built as this "new body". */
const TOOL_BODY = 'b___pattern_tool';

/** One thing repeated: a shape with names, what it came from, and how its copies apply. */
interface Source {
  shape: ShapeId;
  names: FaceNames | null;
  /** The shape is ours to release (a rebuilt tool); a body's own shape is not. */
  owned: boolean;
  op: BodyOp;
  /** Bodies the operation acts on (empty: the bodies the copies meet). */
  scope: BodyId[];
  /** bodies: the body copied (New body ids derive from it; Join fuses to it). */
  body?: BodyId;
  /** Words for messages ("Extrude 2", "Body 1"). */
  label: string;
  /** faces: the part of the local feature that is material (fused) or a hole (cut). */
  part?: 'boss' | 'pocket';
  /** features: the name and colour of the body the feature makes (its copies are "Body 1 (Instance 2)"). */
  bodyName?: string;
  color?: string;
}

type Step<T> = { ok: true; value: T } | { ok: false; message: string };

function bboxUnion(boxes: readonly BBox[]): BBox | null {
  if (!boxes.length) return null;
  const b: BBox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const x of boxes)
    for (let k = 0; k < 3; k++) {
      b[k] = Math.min(b[k], x[k]);
      b[k + 3] = Math.max(b[k + 3], x[k + 3]);
    }
  return b;
}
const centre = (b: BBox): Vec3 => [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
const overlaps = (a: BBox, b: BBox, tol: number) => a[0] <= b[3] + tol && b[0] <= a[3] + tol && a[1] <= b[4] + tol && b[1] <= a[4] + tol && a[2] <= b[5] + tol && b[2] <= a[5] + tol;

/** A kernel refusal in the feature's words (input / OCCT errors); anything else (a stopped kernel) is thrown on. */
function refusal(name: string, err: unknown, what: string): { ok: false; message: string } {
  const e = err as KernelCallError;
  if (e && (e.kind === 'input' || e.kind === 'occt' || e.kind === 'internal')) return { ok: false, message: `${name} failed: ${what}: ${plainKernelMessage(e.message)}` };
  throw err;
}

/** "Instance 4", "Instances 4 and 5", "Instances 2, 3 and 4". */
export function instanceList(labels: readonly string[]): string {
  if (labels.length === 1) return labels[0];
  const bare = labels.map((l) => l.replace(/^Instance /, ''));
  return `Instances ${bare.slice(0, -1).join(', ')} and ${bare[bare.length - 1]}`;
}

/** A copy key as a whole number >= 1 for its body id (stable: "2" -> 3, "-2" -> 4, "2.3" -> 3 + 1000 * 5, "m" -> 1). */
export function copyCode(key: string): number {
  if (key === 'm') return 1;
  const zig = (n: number) => (n > 0 ? 2 * n - 1 : -2 * n);
  const [i, j] = key.split('.').map(Number);
  return zig(i) + (j === undefined ? 0 : 1000 * zig(j));
}

// ------------------------------------------------------------ sources

/**
 * The Operation a feature's tool body is applied with: its own, or for a pattern or mirror that uses
 * each source's ("As each feature"), its first source's, recursively (a mirror of a pattern of holes cuts).
 */
export function effectiveOp(doc: { features: readonly Feature[] }, f: Feature, depth = 0): BodyOp {
  if (!('op' in f)) return 'new';
  const op = (f as { op: BodyOp | 'source' }).op;
  if (op !== 'source') return op;
  if (depth > 16 || !('features' in f) || !Array.isArray(f.features) || !f.features.length) return 'new';
  const first = doc.features.find((g) => g.id === (f.features as string[])[0]);
  return first ? effectiveOp(doc, first, depth + 1) : 'new';
}

async function featureSources(f: PatternFeature, ctx: BuildContext): Promise<Step<Source[]>> {
  if (!f.features.length) return { ok: false, message: `${f.name} failed: Pick the features to repeat` };
  if (!ctx.registry) return { ok: false, message: `${f.name} failed: this build cannot repeat features` };
  const order = new Map(ctx.doc.features.map((g, i) => [g.id, i] as const));
  const out: Source[] = [];
  for (const id of [...f.features].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))) {
    const src = ctx.doc.features.find((g) => g.id === id);
    const label = ctx.featureName(id);
    if (!src) return { ok: false, message: `${f.name} failed: ${label} is not in the part any more` };
    if (src.suppressed) return { ok: false, message: `${f.name} failed: ${label} is suppressed, so there is nothing of it to repeat` };
    if (!REPEATABLE_TYPES.includes(src.type) || !('op' in src)) return { ok: false, message: `${f.name} failed: ${label} makes no body of its own to repeat. Pattern the body, or its faces, instead` };
    if ('of' in src && src.of === 'faces') return { ok: false, message: `${f.name} failed: ${label} copies faces of a body, so it has no tool body to repeat. Pick its faces again, or pattern the body` };
    const def = ctx.registry.get(src.type);
    if (!def) return { ok: false, message: `${f.name} failed: ${label} cannot be built by this version` };
    const own = src as Feature & { op: BodyOp; scope: BodyId[] };
    const asTool = { ...own, op: 'new', creates: TOOL_BODY, scope: [] } as unknown as Feature;
    const values = def.resolve(asTool, ctx.units);
    if (!values.ok) return { ok: false, message: `${f.name} failed: ${label}: ${values.message}` };
    const r = await def.build(asTool, values.values, ctx);
    if (!r.ok) {
      for (const o of out) if (o.owned) await ctx.release([o.shape]);
      return { ok: false, message: `${f.name} failed: ${label} could not be built again to repeat it (${r.message.replace(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} failed: `), '')})` };
    }
    const op: BodyOp = f.op === 'source' ? effectiveOp(ctx.doc, src) : f.op;
    const made = 'creates' in own && typeof own.creates === 'string' ? own.creates : null;
    const bodyName = made ? (storedBodyName(ctx.doc, made) ?? undefined) : undefined;
    const color = made ? ctx.doc.bodies[made]?.color : undefined;
    for (const b of r.bodies) out.push({ shape: b.shape, names: b.names ?? null, owned: true, op, scope: f.op === 'source' ? own.scope : f.scope, label, bodyName, color });
  }
  return { ok: true, value: out };
}

function bodySources(f: PatternFeature, ctx: BuildContext): Step<Source[]> {
  if (!f.bodies.length) return { ok: false, message: `${f.name} failed: Pick the bodies to copy` };
  const out: Source[] = [];
  const op: BodyOp = f.op === 'source' ? 'new' : f.op;
  for (const id of f.bodies) {
    const b = ctx.bodies.get(id);
    if (!b) return { ok: false, message: `${f.name} failed: ${storedBodyName(ctx.doc, id) ?? ctx.bodyName(id)} is not there at this point` };
    out.push({ shape: b.shape, names: b.names, owned: false, op, scope: f.scope, body: id, label: ctx.bodyName(id) });
  }
  return { ok: true, value: out };
}

/**
 * The local feature some faces of a body bound (a boss, a pocket, a hole): OCCT takes the faces off
 * (BRepAlgoAPI_Defeaturing, the neighbours grown to close the gap); what the body has and the result
 * has not is the boss, what the result has and the body has not the pocket.
 */
async function faceSources(f: PatternFeature, ctx: BuildContext, made: ShapeId[]): Promise<Step<{ body: BuiltBody; sources: Source[]; warning: string | null }>> {
  if (!f.faceBody || !f.faces.length) return { ok: false, message: `${f.name} failed: Pick the faces to copy` };
  const body = ctx.bodies.get(f.faceBody);
  const bodyName = storedBodyName(ctx.doc, f.faceBody) ?? ctx.bodyName(f.faceBody);
  if (!body) return { ok: false, message: `${f.name} failed: ${bodyName} is not there at this point` };
  const r = await resolveRefs(ctx, body, f.faces);
  if (!r.ok) return { ok: false, message: `${f.name} failed: ${r.message}` };
  let d: { id: ShapeId; valid?: boolean; reason?: string; faces?: number; history?: OpHistory };
  try {
    const timeoutMs = timeoutForFaces('defeature', await ctx.faces(body.shape));
    d = (await ctx.kernel.call('defeature', { id: body.shape, faces: r.indices }, timeoutMs ? { timeoutMs } : {})).result;
  } catch (err) {
    const e = err as KernelCallError;
    if (e && (e.kind === 'input' || e.kind === 'occt' || e.kind === 'internal'))
      return { ok: false, message: `${f.name} failed: OCCT could not take those faces off ${bodyName} to find the shape they bound (${plainKernelMessage(e.message)}). Pattern the feature or the body instead` };
    throw err;
  }
  made.push(d.id);
  if (d.valid === false) return { ok: false, message: `${f.name} failed: OCCT could not take those faces off ${bodyName} cleanly (the body without them is not a valid solid). Pattern the feature or the body instead` };
  const dNames = namesFromResult(f.id, d, new Map([[body.shape, body.names]]));
  const sources: Source[] = [];
  for (const part of ['boss', 'pocket'] as const) {
    const [a, b] = part === 'boss' ? [body.shape, d.id] : [d.id, body.shape];
    const res = (await ctx.kernel.call('boolean', { op: 'cut', targets: [a], tools: [b] })).result;
    made.push(res.id);
    if (res.empty) continue;
    if (res.valid === false) return { ok: false, message: `${f.name} failed: the shape those faces bound on ${bodyName} is not a valid solid. Pattern the feature or the body instead` };
    const names = namesFromResult(f.id, res, new Map<ShapeId, FaceNames | null>([[body.shape, body.names], [d.id, dNames]]));
    sources.push({ shape: res.id, names, owned: false, op: part === 'boss' ? 'join' : 'cut', scope: [f.faceBody], body: f.faceBody, label: bodyName, part });
  }
  if (!sources.length) return { ok: false, message: `${f.name} failed: those faces bound nothing on ${bodyName} to copy (taking them off left the body as it was)` };
  return { ok: true, value: { body, sources, warning: r.warning } };
}

// ------------------------------------------------------------ the build

interface Made {
  id: ShapeId;
  copy: PatternCopy;
  names: FaceNames | null;
  source: Source;
}

/**
 * Build pattern `f` with these copies (the original left out; skipped ones are in `skip`). `checks`
 * may refuse the copies before any is made (two directions on one line).
 */
export async function buildPattern(f: PatternFeature, copies: PatternCopy[], ctx: BuildContext): Promise<FeatureBuildResult> {
  const skip = new Set(f.skip);
  const active = copies.filter((c) => !skip.has(c.key));
  const made: ShapeId[] = [];
  const keep = new Set<ShapeId>();
  let sources: Source[] = [];
  let faceBody: BuiltBody | null = null;
  const notes: string[] = [];
  const out = (centre0: Vec3 | null, failed: readonly string[] = []): PatternOutput => ({
    type: 'pattern',
    copies: copies.map((c) => ({ key: c.key, label: c.label, at: centre0 ? applyPoint(c.matrix, centre0) : [0, 0, 0], skipped: skip.has(c.key), ...(failed.includes(c.key) ? { failed: true } : {}) })),
    made: active.length,
    origin: centre0,
  });
  try {
    // 1. What is repeated.
    if (f.of === 'features') {
      const s = await featureSources(f, ctx);
      if (!s.ok) return s;
      sources = s.value;
      for (const x of sources) made.push(x.shape);
    } else if (f.of === 'bodies') {
      const s = bodySources(f, ctx);
      if (!s.ok) return s;
      sources = s.value;
    } else {
      const s = await faceSources(f, ctx, made);
      if (!s.ok) return s;
      sources = s.value.sources;
      faceBody = s.value.body;
      if (s.value.warning) notes.push(s.value.warning);
    }
    const boxes: BBox[] = [];
    for (const x of sources) boxes.push(await ctx.bbox(x.shape));
    const box = bboxUnion(boxes);
    const centre0 = box ? centre(box) : null;
    if (!active.length) return { ok: true, bodies: [], removed: [], warning: copies.length ? 'Every instance is skipped: nothing is made' : undefined, output: out(centre0) };

    // 2. The copies (work copies of the sources, which never change).
    const all: Made[] = [];
    for (const src of sources) {
      let r;
      try {
        const timeoutMs = timeoutForFaces('copies', (await ctx.faces(src.shape)) * active.length);
        r = (await ctx.kernel.call('copies', { id: src.shape, transforms: active.map((c) => ({ matrix: c.matrix })) }, timeoutMs ? { timeoutMs } : {})).result;
      } catch (err) {
        return refusal(f.name, err, 'the copies could not be made');
      }
      r.ids.forEach((id) => made.push(id));
      const bad = r.valid?.findIndex((v) => !v) ?? -1;
      if (bad >= 0) return { ok: false, message: `${f.name} failed: ${active[bad].label} of ${src.label} is not a valid solid (${(r.reasons?.[bad] ?? '').replace(/^invalid result\s*/i, '')})` };
      r.ids.forEach((id, k) => all.push({ id, copy: active[k], names: copyNames(f.id, active[k].key, src.names, r.maps[k], r.faces[k]), source: src }));
    }

    // 3. The Operation, per group of sources with the same one.
    const bodiesOut = new Map<BodyId, { shape: ShapeId; names: FaceNames | null; name?: string; color?: string }>();
    const removed: BodyId[] = [];
    const current = (id: BodyId): { shape: ShapeId; names: FaceNames | null } | null => bodiesOut.get(id) ?? ctx.bodies.get(id) ?? null;
    const fuzzy = f.repair?.fuzzy;
    const boolean = async (op: 'fuse' | 'cut' | 'common', target: ShapeId, tools: ShapeId[]) => {
      let faces = await ctx.faces(target);
      for (const t of tools) faces += await ctx.faces(t);
      const timeoutMs = timeoutForFaces('boolean', faces);
      const r = (await ctx.kernel.call('boolean', { op, targets: [target], tools, ...(fuzzy ? { fuzzy } : {}) }, timeoutMs ? { timeoutMs } : {})).result;
      made.push(r.id);
      return r;
    };
    const solidsOf = async (id: ShapeId) => (await ctx.kernel.call('props', { id, bbox: 'none' })).result.solids;

    // New body: each copy its own body. Names that would repeat (several tool bodies from one source,
    // a pattern of a pattern) are numbered: "Linear pattern 1 (Mirror copy 2)" (fix round 1, P1).
    const nameCount = new Map<string, number>();
    for (const m of all.filter((x) => x.source.op === 'new')) {
      const base0 = m.source.body ? (storedBodyName(ctx.doc, m.source.body) ?? ctx.bodyName(m.source.body)) : (m.source.bodyName ?? m.source.label);
      const k0 = `${base0} (${m.copy.label})`;
      nameCount.set(k0, (nameCount.get(k0) ?? 0) + 1);
    }
    const nameSeen = new Map<string, number>();
    for (const m of all.filter((x) => x.source.op === 'new')) {
      // A body's copies derive their ids from it; a feature's from this pattern (stable per copy key).
      const base = m.source.body ?? f.id;
      const si = sources.indexOf(m.source);
      const id = deriveBodyId(f.id, base, copyCode(m.copy.key) + (m.source.body ? 0 : 1_000_000 * si));
      const baseName = m.source.body ? (storedBodyName(ctx.doc, base) ?? ctx.bodyName(base)) : (m.source.bodyName ?? m.source.label);
      const plain = `${baseName} (${m.copy.label})`;
      const nth = (nameSeen.get(plain) ?? 0) + 1;
      nameSeen.set(plain, nth);
      const name = (nameCount.get(plain) ?? 0) > 1 ? `${baseName} (${m.copy.label} ${nth})` : plain;
      bodiesOut.set(id, { shape: m.id, names: m.names, name, ...(m.source.color ? { color: m.source.color } : {}) });
      keep.add(m.id);
    }

    // Join / Cut / Intersect: per source (each keeps its own scope and target rules).
    const failed: string[] = [];
    for (const src of sources) {
      if (src.op === 'new') continue;
      const mine = all.filter((x) => x.source === src);
      if (!mine.length) continue;
      // Targets: the scope, or the body copied (bodies Join, faces), or the bodies the copies meet.
      let targets: BodyId[];
      let nearBody = false;
      if (src.scope.length) targets = src.scope.filter((id) => !!current(id));
      else if (src.body && (src.op === 'join' || f.of === 'faces')) targets = [src.body];
      else {
        targets = [];
        nearBody = false;
        for (const [id] of ctx.bodies) {
          if (f.of === 'bodies' && f.bodies.includes(id) && src.op !== 'join') continue;
          const cur = current(id);
          if (!cur) continue;
          const tb = await ctx.bbox(cur.shape);
          const tol = 1e-6 * Math.max(1, tb[3] - tb[0], tb[4] - tb[1], tb[5] - tb[2]);
          for (const m of mine) {
            if (!overlaps(tb, await ctx.bbox(m.id), tol)) continue;
            nearBody = true;
            const c = await boolean('common', cur.shape, [m.id]);
            if (!c.empty || src.op === 'join') {
              if (c.empty) {
                // Join also takes a body a copy only touches (a shared face): their fuse is one solid.
                const u = await boolean('fuse', cur.shape, [m.id]);
                if (!(u.valid !== false && !u.empty && u.solids === 1)) continue;
              }
              targets.push(id);
              break;
            }
          }
        }
      }
      if (!targets.length && nearBody && src.op !== 'join') {
        // Within a body's box but meeting no material: they land where it was already cut away (fix round 1, B1).
        return { ok: false, message: `${f.name} failed: Nothing to ${src.op === 'cut' ? 'cut' : 'intersect'}: every copy of ${src.label} lands where no material is left (already cut away)` };
      }
      if (!targets.length) {
        const verb = src.op === 'join' ? 'join' : src.op === 'cut' ? 'cut' : 'intersect';
        return { ok: false, message: `${f.name} failed: Nothing to ${verb}: no copy of ${src.label} ${src.op === 'join' ? 'touches' : 'overlaps'} a body made before it${src.op === 'join' ? ' (Join needs overlap or a shared face). Use New body or change the spacing' : ''}` };
      }
      if (src.op === 'join') {
        const [primary, ...others] = targets;
        const p = current(primary)!;
        const before = await solidsOf(p.shape);
        const r = await boolean('fuse', p.shape, [...mine.map((m) => m.id), ...others.map((o) => current(o)!.shape)]);
        if (r.valid === false) return { ok: false, message: `${f.name} failed: the result is not a valid solid${r.reason ? ` (${r.reason.replace(/^invalid result\s*/i, '')})` : ''}`, actions: fuzzy && fuzzy >= 0.01 ? undefined : ['repair'] };
        if (r.solids > before) {
          // Which copies stand apart: fused alone with the body, they make a second solid.
          const apart: PatternCopy[] = [];
          for (const m of mine) {
            const u = await boolean('fuse', p.shape, [m.id]);
            if (u.solids > before) apart.push(m.copy);
          }
          const list = apart.length ? apart : mine.map((m) => m.copy);
          failed.push(...list.map((c) => c.key));
          const what = src.part === 'boss' ? `the copied faces` : src.label;
          return {
            ok: false,
            message: `${f.name} failed: ${instanceList(list.map((c) => c.label))} of ${what} ${list.length === 1 ? "doesn't" : "don't"} touch ${ctx.bodyName(primary)}; Join needs overlap. Use New body or change the spacing`,
            output: out(centre0, failed),
          };
        }
        const inputs = new Map<ShapeId, FaceNames | null>([[p.shape, p.names], ...mine.map((m): [ShapeId, FaceNames | null] => [m.id, m.names]), ...others.map((o): [ShapeId, FaceNames | null] => [current(o)!.shape, current(o)!.names])]);
        bodiesOut.set(primary, { shape: r.id, names: namesFromResult(f.id, r, inputs) });
        keep.add(r.id);
        for (const o of others) {
          bodiesOut.delete(o);
          removed.push(o);
        }
      } else {
        // Copies that meet no target are named (a hole patterned past the plate's edge); one within a
        // body's box that meets no material lands where it was already cut away (fix round 1, B1).
        const hits = new Set<string>();
        const inBox = new Set<string>();
        for (const t of targets) {
          const cur = current(t)!;
          const tb = await ctx.bbox(cur.shape);
          const tol = 1e-6 * Math.max(1, tb[3] - tb[0], tb[4] - tb[1], tb[5] - tb[2]);
          for (const m of mine) {
            if (hits.has(m.copy.key) || !overlaps(tb, await ctx.bbox(m.id), tol)) continue;
            inBox.add(m.copy.key);
            const c = await boolean('common', cur.shape, [m.id]);
            if (!c.empty) hits.add(m.copy.key);
          }
          const r = await boolean(src.op === 'cut' ? 'cut' : 'common', cur.shape, mine.map((m) => m.id));
          if (r.valid === false) return { ok: false, message: `${f.name} failed: the result is not a valid solid${r.reason ? ` (${r.reason.replace(/^invalid result\s*/i, '')})` : ''}`, actions: fuzzy && fuzzy >= 0.01 ? undefined : ['repair'] };
          if (r.empty) {
            bodiesOut.delete(t);
            removed.push(t);
            notes.push(`${ctx.bodyName(t)} was removed completely`);
            continue;
          }
          const inputs = new Map<ShapeId, FaceNames | null>([[cur.shape, cur.names], ...mine.map((m): [ShapeId, FaceNames | null] => [m.id, m.names])]);
          bodiesOut.set(t, { shape: r.id, names: namesFromResult(f.id, r, inputs) });
          keep.add(r.id);
        }
        const missed = mine.filter((m) => !hits.has(m.copy.key)).map((m) => m.copy);
        if (missed.length) {
          const what = src.part === 'pocket' ? 'the copied faces' : src.label;
          const away = missed.filter((c) => !inBox.has(c.key));
          const empty = missed.filter((c) => inBox.has(c.key));
          if (away.length) notes.push(`${instanceList(away.map((c) => c.label))} of ${what} ${away.length === 1 ? 'misses' : 'miss'} every body: ${src.op === 'cut' ? 'nothing is cut there' : 'nothing is kept there'}`);
          if (empty.length) notes.push(`${instanceList(empty.map((c) => c.label))} of ${what} ${empty.length === 1 ? 'lands' : 'land'} where no material is left (already cut away): ${src.op === 'cut' ? 'nothing more is cut there' : 'nothing is kept there'}`);
          failed.push(...missed.map((c) => c.key));
        }
      }
    }
    void faceBody;
    const bodies = [...bodiesOut].map(([id, b]) => ({ id, shape: b.shape, valid: true, names: b.names, ...(b.name ? { name: b.name } : {}), ...(b.color ? { color: b.color } : {}) }));
    for (const b of bodies) keep.add(b.shape);
    const said = [...new Set(notes)];
    return { ok: true, bodies, removed, ...(said.length ? { warning: said.join('; ') } : {}), output: out(centre0, failed) };
  } finally {
    const drop = made.filter((id) => !keep.has(id));
    if (drop.length) await ctx.release(drop).catch(() => {});
  }
}
