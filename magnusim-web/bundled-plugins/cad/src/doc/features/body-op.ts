// The Operation of a body-making feature (Fusion's New body / Join / Cut /
// Intersect): combines the feature's tool shape with the bodies before it,
// with the kernel's booleans (history on, on work copies: inputs stay valid).
// Every result's `valid` flag is honoured: an invalid result fails the feature
// ("Result is not a valid solid") and offers Try repair, which rebuilds with a
// fuzzy tolerance and, if that is not enough, the kernel's ShapeFix repair
// (kept only when it is valid and keeps the volume).
// A boolean OCCT answered as if the tool and a body it overlaps were apart
// (kernel API 10, as_if_apart 'wrong'; GitHub issue 15: a cut that removed
// nothing, valid and without a warning) fails the feature in words that say so,
// never "Nothing to cut"; so does a Cut or Join that leaves a body as it was
// whose common OCCT answered so.
// Face names (src/naming) follow the booleans' history when the kernel gives
// the result's face count and history (API 3); otherwise the body is unnamed.
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { BodyId, BodyMaking, BodyOp, FeatureId } from '../../types/doc';
import type { BuildContext, BuiltBody, FeatureBuildResult } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { AsIfApart, BBox, OpHistory, ShapeId } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';
import { timeoutForFaces } from '../../kernel/timeouts';
import { namesFromResult } from '../../naming/result';

/** Try repair: the tolerances tried in turn (mm). */
export const REPAIR_FUZZY_STEPS = [0.001, 0.01] as const;
/** A ShapeFix repair is kept only if the volume moved less than this (relative). */
const REPAIR_VOLUME_TOL = 1e-3;

export const OP_LABELS: Record<BodyOp, string> = { new: 'New body', join: 'Join', cut: 'Cut', intersect: 'Intersect' };
const VERB: Record<Exclude<BodyOp, 'new'>, string> = { join: 'join', cut: 'cut', intersect: 'intersect' };

type BooleanKind = 'fuse' | 'cut' | 'common';
interface BoolOut {
  id: ShapeId;
  valid: boolean;
  empty: boolean;
  /** Solids in the result (a fuse of two bodies that touch or overlap is one). */
  solids: number;
  reason?: string;
  /** API 3: the result's face count and history (for names). */
  faces?: number;
  history?: OpHistory;
  /** API 10: the result is the one for inputs apart; 'wrong' when they overlap (the kernel's words: warning_text). */
  asIfApart?: AsIfApart;
}

async function boolean(ctx: BuildContext, op: BooleanKind, targets: ShapeId[], tools: ShapeId[], fuzzy: number | undefined): Promise<BoolOut> {
  // Large inputs get the long limit (a cut on an 11,776-face part took 22 s).
  let faces = 0;
  for (const s of [...targets, ...tools]) faces += await ctx.faces(s);
  const timeoutMs = timeoutForFaces('boolean', faces);
  const r = await ctx.kernel.call('boolean', { op, targets, tools, ...(fuzzy ? { fuzzy } : {}) }, timeoutMs ? { timeoutMs } : {});
  const res = r.result;
  return { id: res.id, valid: res.valid !== false, empty: !!res.empty, solids: typeof res.solids === 'number' ? res.solids : 1, reason: res.reason, faces: res.faces, history: res.history, ...(res.as_if_apart ? { asIfApart: res.as_if_apart } : {}) };
}

/**
 * Why a Join / Cut / Intersect with no scope found nothing to act on. Join takes
 * a body it overlaps or shares a face with; Cut and Intersect need an overlap
 * (a tool flush against a face cuts nothing away and leaves nothing in common).
 */
export function nothingToActOn(op: Exclude<BodyOp, 'new'>, label: string): string {
  if (op === 'join') return `Nothing to join: ${label} shares no face with a body made before it`;
  return `Nothing to ${VERB[op]}: ${label} does not overlap any body made before it (touching is not enough)`;
}

/**
 * What went wrong when OCCT answered a Join / Cut / Intersect as if `subject` and `body` were apart
 * although they overlap (kernel API 10, as_if_apart 'wrong'; GitHub issue 15): "it overlaps Body 1,
 * but the geometry kernel's cut removed nothing from Body 1 (OCCT took the two for apart)".
 * Combine's and Pattern's words too (their subject names the tools, or the instances: `many`).
 * `unchanged`: a Join that gave the body back as it was ("join gave Body 1 back as it was").
 */
export function tookForApart(op: Exclude<BodyOp, 'new'>, subject: string, body: string, o: { many?: boolean; unchanged?: boolean } = {}): string {
  const what = op === 'cut' ? `cut removed nothing from ${body}` : op === 'join' ? (o.unchanged ? `join gave ${body} back as it was` : 'join kept them as separate solids') : 'intersect found nothing in common';
  return `${subject} ${o.many ? 'overlap' : 'overlaps'} ${body}, but the geometry kernel's ${what} (OCCT took the two for apart)`;
}

function overlaps(a: BBox, b: BBox, tol: number): boolean {
  return a[0] <= b[3] + tol && b[0] <= a[3] + tol && a[1] <= b[4] + tol && b[1] <= a[4] + tol && a[2] <= b[5] + tol && b[2] <= a[5] + tol;
}

async function volumeOf(ctx: BuildContext, id: ShapeId): Promise<number> {
  const r = await ctx.kernel.call('props', { id, volume: true, bbox: 'none', bbox_mode: 'fast' });
  return typeof r.result.volume === 'number' ? r.result.volume : NaN;
}

async function solidsOf(ctx: BuildContext, id: ShapeId): Promise<number> {
  return (await ctx.kernel.call('props', { id, bbox: 'none', bbox_mode: 'fast' })).result.solids;
}

/** Whether a cut or join gave `body` back as it was: as many faces, and the same volume (to 1e-9 of it). */
async function unchanged(ctx: BuildContext, body: ShapeId, r: BoolOut): Promise<boolean> {
  if (typeof r.faces !== 'number' || r.faces !== (await ctx.faces(body))) return false;
  const [before, after] = [await volumeOf(ctx, body), await volumeOf(ctx, r.id)];
  return Math.abs(after - before) <= 1e-9 * Math.max(1, Math.abs(before));
}

/**
 * The kernel's ShapeFix repair of an invalid result: a new valid shape whose
 * volume matches, or null (the facade may not have `repair`: then null too).
 */
async function shapeFix(ctx: BuildContext, id: ShapeId): Promise<ShapeId | null> {
  let fixed: ShapeId | null = null;
  try {
    const timeoutMs = timeoutForFaces('repair', await ctx.faces(id));
    const r = await ctx.kernel.call('repair', { id }, timeoutMs ? { timeoutMs } : {});
    fixed = r.result.id;
    if (r.result.valid === false) return null;
    const [before, after] = [await volumeOf(ctx, id), await volumeOf(ctx, fixed)];
    if (!(before > 0) || !(after > 0) || Math.abs(after - before) > REPAIR_VOLUME_TOL * before) return null;
    const keep = fixed;
    fixed = null;
    return keep;
  } catch (e) {
    const k = (e as KernelCallError).kind;
    if (k === 'occt' || k === 'input' || k === 'internal') return null;
    throw e;
  } finally {
    if (fixed != null) await ctx.release([fixed]);
  }
}

/**
 * Apply `f.op` with the tool shape the feature built (`label` names the feature
 * in messages, "Box 2"). Owns `tool`: it is released unless it becomes a body.
 */
export async function applyBodyOp(f: BodyMaking & { id: FeatureId }, label: string, tool: { shape: ShapeId; valid: boolean; names?: FaceNames | null }, ctx: BuildContext): Promise<FeatureBuildResult> {
  if (f.op === 'new') {
    if (!tool.valid) {
      await ctx.release([tool.shape]);
      return { ok: false, message: `${label} failed: the result is not a valid solid` };
    }
    if (!f.creates) {
      await ctx.release([tool.shape]);
      return { ok: false, message: `${label} has no body to create` };
    }
    return { ok: true, bodies: [{ id: f.creates, shape: tool.shape, valid: true, names: tool.names ?? null }], removed: [] };
  }

  const made: ShapeId[] = [];
  const fuzzy = f.repair?.fuzzy;
  try {
    if (!tool.valid) return { ok: false, message: `${label} failed: its shape is not a valid solid` };
    const verb = VERB[f.op];

    // Targets: the scope's bodies, or every body the tool overlaps (for Join, or touches).
    let targets: BuiltBody[];
    const common = new Map<BodyId, BoolOut>();
    // Bodies that are targets only because OCCT answered their common as if apart although they
    // overlap: the Operation must change them, or OCCT took them for apart there too (review round 1:
    // a tool with a cap flush on the block's top cut nothing, and the Cut was green).
    const apart = new Set<BodyId>();
    if (f.scope.length) {
      targets = f.scope.map((id) => ctx.bodies.get(id)).filter((b): b is BuiltBody => !!b);
      if (!targets.length) {
        const names = f.scope.map((id) => ctx.bodyName(id)).join(', ');
        return { ok: false, message: `Nothing to ${verb}: ${names} ${f.scope.length === 1 ? 'is' : 'are'} not there at this point` };
      }
    } else {
      const tb = await ctx.bbox(tool.shape);
      const tol = 1e-7 * Math.max(1, Math.hypot(tb[3] - tb[0], tb[4] - tb[1], tb[5] - tb[2]));
      targets = [];
      for (const body of ctx.bodies.values()) {
        if (!overlaps(tb, await ctx.bbox(body.shape), tol)) continue;
        const c = await boolean(ctx, 'common', [body.shape], [tool.shape], fuzzy);
        // An empty common OCCT answered as if the two were apart although they overlap (kernel API 10)
        // still makes the body a target: its Operation below says whether OCCT got it right.
        if (c.empty && c.asIfApart !== 'wrong') {
          await ctx.release([c.id]);
          // Join also takes a body the tool only touches (a shared face, as Box 2 placed
          // against Box 1): the two fuse into one solid. Bodies that are apart stay two.
          if (f.op === 'join') {
            const u = await boolean(ctx, 'fuse', [body.shape], [tool.shape], fuzzy);
            await ctx.release([u.id]);
            if (u.valid && !u.empty && u.solids === 1) targets.push(body);
          }
          continue;
        }
        if (c.empty) apart.add(body.id);
        targets.push(body);
        if (f.op === 'intersect') {
          made.push(c.id);
          common.set(body.id, c);
        } else {
          await ctx.release([c.id]);
        }
      }
      // Only bodies made before this feature in history count (review round 3: Join on the first feature).
      // The words say what was missing, per Operation (P1.5 review round 1: "touches it" was false
      // for a Cut flush against a face, and for a Join that meets a body only along an edge).
      if (!targets.length) return { ok: false, message: nothingToActOn(f.op, label) };
    }

    const out: { id: BodyId; shape: ShapeId; valid: boolean; reason?: string; names: FaceNames | null }[] = [];
    const named = (r: BoolOut, inputs: BuiltBody[]) => namesFromResult(f.id, r, new Map<ShapeId, FaceNames | null>([...inputs.map((b): [ShapeId, FaceNames | null] => [b.shape, b.names]), [tool.shape, tool.names ?? null]]));
    const removed: BodyId[] = [];
    const gone: string[] = [];
    // A body OCCT took for apart fails the Operation; the words say the other targets are held back too.
    const tookApart = (op: Exclude<BodyOp, 'new'>, bodies: BuiltBody[], unchanged = false): FeatureBuildResult => {
      const rest = targets.filter((o) => !bodies.includes(o)).map((o) => ctx.bodyName(o.id));
      const held = rest.length ? `; ${rest.join(', ')} ${rest.length === 1 ? 'is left as it was' : 'are left as they were'} too` : '';
      return { ok: false, message: `${label} failed: ${tookForApart(op, 'it', bodies.map((t) => ctx.bodyName(t.id)).join(', '), { unchanged })}${held}` };
    };
    if (f.op === 'join') {
      const [primary, ...others] = targets;
      const r = await boolean(ctx, 'fuse', [primary.shape], [tool.shape, ...others.map((o) => o.shape)], fuzzy);
      made.push(r.id);
      if (r.asIfApart === 'wrong') return tookApart('join', apart.size ? targets.filter((t) => apart.has(t.id)) : targets);
      // Every target meets the tool, so the join has at least one solid fewer per target than they and
      // the tool had; more, and a body OCCT took for apart stayed a solid of its own (review round 1:
      // Body 1 became two solids and Body 2 went, "ok").
      if (apart.size) {
        let had = await solidsOf(ctx, tool.shape);
        for (const t of targets) had += await solidsOf(ctx, t.shape);
        if (r.solids > had - targets.length) return tookApart('join', targets.filter((t) => apart.has(t.id)));
        // Joined with the tool alone and given back as it was: OCCT dropped the tool (the tool's cap
        // flush with the block's top, review round 1).
        if (!others.length && (await unchanged(ctx, primary.shape, r))) return tookApart('join', [primary], true);
      }
      out.push({ id: primary.id, shape: r.id, valid: r.valid, reason: r.reason, names: named(r, targets) });
      removed.push(...others.map((o) => o.id));
    } else {
      for (const t of targets) {
        let r = common.get(t.id);
        if (!r) {
          r = await boolean(ctx, f.op === 'cut' ? 'cut' : 'common', [t.shape], [tool.shape], fuzzy);
          made.push(r.id);
        }
        if (r.asIfApart === 'wrong') return tookApart(f.op, [t]);
        // Its common answered as if apart, and the cut gave it back as it was: taken for apart again.
        if (apart.has(t.id) && f.op === 'cut' && !r.empty && (await unchanged(ctx, t.shape, r))) return tookApart('cut', [t]);
        if (r.empty) {
          removed.push(t.id);
          gone.push(ctx.bodyName(t.id));
        } else {
          out.push({ id: t.id, shape: r.id, valid: r.valid, reason: r.reason, names: named(r, [t]) });
        }
      }
    }

    // Try repair, second stage: ShapeFix on what the tolerance did not fix.
    const repaired: string[] = [];
    if (f.repair) {
      for (const b of out) {
        if (b.valid) continue;
        const fixed = await shapeFix(ctx, b.shape);
        if (fixed != null) {
          made.push(fixed);
          b.shape = fixed;
          b.valid = true;
          // ShapeFix rebuilt the faces: no names until repair reports history to follow.
          b.names = null;
          repaired.push(ctx.bodyName(b.id));
        }
      }
    }

    const bad = out.find((b) => !b.valid);
    if (bad) {
      const why = bad.reason ? `: ${bad.reason.replace(/^invalid result\s*/i, '').trim()}` : '';
      const tried = fuzzy ? ` (repair with a ${fuzzy} mm tolerance did not fix it)` : '';
      const next = REPAIR_FUZZY_STEPS.find((s) => s > (fuzzy ?? 0));
      return { ok: false, message: `${label} failed: the result is not a valid solid${tried}${why}`, actions: next ? ['repair'] : undefined };
    }
    // Success: the results are kept (not released below).
    const kept = new Set(out.map((b) => b.shape));
    const extra = made.filter((id) => !kept.has(id));
    made.length = 0;
    await ctx.release(extra);
    const notes: string[] = [];
    if (gone.length) notes.push(`${gone.join(', ')} ${gone.length === 1 ? 'was' : 'were'} removed completely`);
    if (repaired.length) notes.push(`${repaired.join(', ')} ${repaired.length === 1 ? 'was' : 'were'} repaired: check the result`);
    return { ok: true, bodies: out.map(({ id, shape, valid, names }) => ({ id, shape, valid, names })), removed, ...(notes.length ? { warning: notes.join('; ') } : {}) };
  } finally {
    // The tool never becomes a body here; results are released unless kept.
    await ctx.release([tool.shape, ...made]).catch(() => {});
  }
}
