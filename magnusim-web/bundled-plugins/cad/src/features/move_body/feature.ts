// Move/copy body (SOLIDWORKS' Move/Copy Body, Fusion's Move with Create copy; Daniel 2026-10-30:
// a body could not be moved after it was made). The bodies turn by Angle about X, Y or Z through
// the pivot (the centre of their box just before this feature unless one is typed), or about a
// picked axis (a CONSTRUCT or origin axis, a straight or round edge, a round face's axis, a sketch
// line); then they move by X, Y, Z. One rigid transform per body, through the kernel's `copies`.
//   Moved      the bodies keep their ids, names, colours and face names: a fillet on a moved
//              body's edge, a sketch on its face, a Combine of it still find them. Each body's
//              placement (src/naming/placement.ts) takes the transform too, so references made
//              before or after the move, or across an edit of it, resolve where the body is now
//              and a sketch on its face moves with it (an edit of the move is not a repair).
//   Keep a copy  the originals stay; each copy is a new body, its id derived from its source's
//              (deriveBodyId, k 1), named "Body 1 (Copy)" (copyBodyName), its faces named as a
//              pattern copy's (F:<feature>:i2:<source face>, instance 2 of the feature).
// Values are evaluated with the panel's words ("Move X: ...", "Angle: ..."). A move of nothing
// (every distance 0, no turn) is incomplete unless it keeps a copy (a copy in place is allowed,
// and said in a note: Combine's tools are often a copy left where the original is).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { copyBodyName, deriveBodyId, parseDerivedBodyId, storedBodyName } from '../../doc/features/body-ids';
import { plainKernelMessage } from '../../doc/rebuild';
import { timeoutForFaces } from '../../kernel/timeouts';
import { newId, nextName } from '../../lib/ids';
import type { BodyId, FeatureId, MoveBodyFeature, Vec3 } from '../../types/doc';
import type { BuildContext, ExprField, FeatureBuildResult, FeatureTypeDef } from '../../types/doc-service';
import type { KernelCallError } from '../../types/kernel';
import type { BBox, ShapeId } from '../../types/kernel-protocol';
import type { FaceNames } from '../../types/naming';
import type { Expr, UnitsService } from '../../types/units';
import { copyNames } from '../pattern/naming';
import { compose, rotation, translation, unitOf, type Mat } from '../pattern/transforms';
import { refBodies, refParents, resolveAxis } from '../refgeom/resolve';
import { composePlacement } from '../../naming/placement';

/** Four arrows from a box (24 viewBox outline, as P2_ICONS). */
export const MOVE_BODY_ICON = 'M8 9l4-2 4 2v5l-4 2-4-2z M8 9l4 2 4-2 M12 11v5 M12 2v3 M10.5 3.5L12 2l1.5 1.5 M12 19v3 M10.5 20.5L12 22l1.5-1.5 M2 12h3 M3.5 10.5L2 12l1.5 1.5 M19 12h3 M20.5 10.5L22 12l-1.5 1.5';

export const XYZ = ['X', 'Y', 'Z'] as const;
const AXIS_DIR: Record<'x' | 'y' | 'z', Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
/** The copy's key in its faces' names (pattern naming): instance 2, the original being instance 1. */
export const COPY_KEY = '2';

export interface MoveValues {
  /** mm along X, Y, Z. */
  move: Vec3;
  /** Degrees. */
  angle: number;
  /** mm, or null: the centre of the bodies' box. */
  pivot: Vec3 | null;
}

type R<T> = { ok: true; value: T } | { ok: false; message: string };

function evalAs(label: string, expr: Expr, q: 'length' | 'angle', units: UnitsService): R<number> {
  const r = units.evaluate(typeof expr === 'string' ? expr : String(expr ?? ''), q);
  return r.ok ? { ok: true, value: r.value } : { ok: false, message: `${label}: ${r.error}` };
}

function vec(label: string, exprs: readonly Expr[], units: UnitsService): R<Vec3> {
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = evalAs(`${label} ${XYZ[i]}`, exprs[i] ?? '', 'length', units);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return { ok: true, value: out as Vec3 };
}

/** No turn: 0, or a whole number of turns. */
export const turnless = (deg: number) => Math.abs(deg - 360 * Math.round(deg / 360)) < 1e-9;
/** Moves nothing: no distance and no turn. */
export const still = (v: MoveValues) => v.move.every((x) => Math.abs(x) < 1e-9) && turnless(v.angle);

/** The words of a picked axis the panel's field asks for. */
export const AXIS_WANTED = 'Pick the axis to turn about: an axis, a straight or round edge, a round face or a sketch line (or turn about X, Y or Z)';
export const NOTHING_TO_MOVE = 'Nothing to move: give a distance or an angle';
export const OWN_COPY = 'That body is a copy this feature makes';

/**
 * Why the Bodies field of `feature` refuses `id`: one of the feature's own copies (Keep a copy), never
 * a body it only moves (a moved body is "last changed" by the move too, and taking it out then
 * clicking it again puts it back).
 */
export function bodyRefusal(feature: FeatureId, picked: readonly BodyId[], id: BodyId): string | null {
  return parseDerivedBodyId(feature, id)?.k === 1 && !picked.includes(id) ? OWN_COPY : null;
}

const turnRefs = (f: MoveBodyFeature) => (f.about === 'axis' && f.axis ? [f.axis] : []);

/** The union of boxes, or null. */
function unionBox(boxes: readonly BBox[]): BBox | null {
  if (!boxes.length) return null;
  const b: BBox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const x of boxes)
    for (let k = 0; k < 3; k++) {
      b[k] = Math.min(b[k], x[k]);
      b[k + 3] = Math.max(b[k + 3], x[k + 3]);
    }
  return b.every(Number.isFinite) ? b : null;
}

/** The centre of the bodies' box: exact for bodies up to a large part's faces (as the tree's sizes), else the fast box. */
async function centreOf(ctx: BuildContext, shapes: readonly ShapeId[]): Promise<Vec3 | null> {
  const boxes: BBox[] = [];
  for (const s of shapes) {
    const faces = await ctx.faces(s);
    if (faces > 2000) boxes.push(await ctx.bbox(s));
    else {
      const p = (await ctx.kernel.call('props', { id: s, bbox: 'exact' })).result;
      boxes.push((p.bbox as BBox | null | undefined) ?? (await ctx.bbox(s)));
    }
  }
  const b = unionBox(boxes);
  return b ? [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2] : null;
}

/** Face names in a copy's numbering (`map[i]`: the copy's face of source face i; null: the same). */
function renumbered(names: FaceNames | null, map: readonly number[] | null, faces: number): FaceNames | null {
  if (!names || !map) return names;
  const out: (string | null)[] = new Array(faces).fill(null);
  names.faces.forEach((n, i) => {
    const at = map[i];
    if (at >= 0 && at < faces) out[at] = n;
  });
  return out.some((n) => n == null) ? null : { faces: out as string[] };
}

/** "Body-Move 3" <-> "Body-Copy 1": the name it was given follows Keep a copy; a name the person chose stays. */
export function nameForCopy(name: string, copy: boolean, others: readonly string[]): string {
  if (!/^Body-(Move|Copy) \d+$/.test(name)) return name;
  if (name.startsWith(copy ? 'Body-Copy ' : 'Body-Move ')) return name;
  return nextName(copy ? 'Body-Copy' : 'Body-Move', others);
}

/** The feature's transform: the turn about `line` first, then the move. */
export function moveMatrix(v: MoveValues, line: { origin: Vec3; dir: Vec3 } | null): Mat {
  const t = translation(v.move);
  return line && !turnless(v.angle) ? compose(t, rotation(line.origin, line.dir, v.angle)) : t;
}

export const moveBodyDef: FeatureTypeDef<MoveBodyFeature, MoveValues> = {
  type: 'move_body',
  label: 'Move/copy body',
  icon: MOVE_BODY_ICON,
  // While its panel is open the bodies are drawn just after it (later features rolled back, as a
  // sketch's): what the handle drags and what the rebuild builds are the same bodies, also when a
  // later feature turns, joins or reshapes them.
  isolateWhileEditing: true,
  create(doc, init = {}) {
    const names = doc.features.map((f) => f.name);
    return {
      id: newId('f'),
      type: 'move_body',
      // "Body-Move 1" / "Body-Copy 1" (SOLIDWORKS' Body-Move/Copy1), as Body-Delete 1.
      name: nextName(init.copy ? 'Body-Copy' : 'Body-Move', names),
      bodies: [],
      move: ['0 mm', '0 mm', '0 mm'],
      angle: '0 deg',
      about: 'z',
      axis: null,
      pivot: null,
      copy: false,
      ...init,
    } as MoveBodyFeature;
  },
  resolve(f, units) {
    const move = vec('Move', f.move ?? [], units);
    if (!move.ok) return move;
    const angle = evalAs('Angle', f.angle, 'angle', units);
    if (!angle.ok) return angle;
    let pivot: Vec3 | null = null;
    if (f.pivot) {
      const p = vec('Pivot', f.pivot, units);
      if (!p.ok) return p;
      pivot = p.value;
    }
    return { ok: true, values: { move: move.value, angle: angle.value, pivot } };
  },
  incomplete(f, units) {
    if (!f.bodies?.length) return 'Pick the bodies to move';
    const r = moveBodyDef.resolve(f, units);
    if (!r.ok) return r.message;
    if (!turnless(r.values.angle) && f.about === 'axis' && !f.axis) return AXIS_WANTED;
    if (still(r.values) && !f.copy) return NOTHING_TO_MOVE;
    return null;
  },
  parents: (f) => refParents(turnRefs(f)),
  uses: (f) => [...new Set([...(f.bodies ?? []), ...refBodies(turnRefs(f))])],
  // The copies (Keep a copy): ids derived from their sources'.
  ownsBody(f, id) {
    if (!f.copy) return false;
    const d = parseDerivedBodyId(f.id, id);
    return !!d && d.k === 1 && f.bodies.includes(d.target);
  },
  exprs: (f) => [
    ...(f.move ?? []).map((expr, i): ExprField => ({ path: `move[${i}]`, expr })),
    { path: 'angle', expr: f.angle },
    ...(f.pivot ?? []).map((expr, i): ExprField => ({ path: `pivot[${i}]`, expr })),
  ],
  mapExprs: (f, fn) => ({ ...f, move: f.move.map(fn) as MoveBodyFeature['move'], angle: fn(f.angle), pivot: f.pivot ? (f.pivot.map(fn) as MoveBodyFeature['pivot']) : null }),
  async build(f, v, ctx): Promise<FeatureBuildResult> {
    const ids = [...new Set(f.bodies)];
    if (!ids.length) return { ok: false, message: `${f.name} failed: Pick the bodies to move` };
    const missing = ids.filter((id) => !ctx.bodies.has(id));
    if (missing.length) return { ok: false, message: `${f.name} failed: ${missing.map((id) => storedBodyName(ctx.doc, id) ?? ctx.bodyName(id)).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not there at this point` };
    const sources = ids.map((id) => ctx.bodies.get(id)!);
    const centre = await centreOf(ctx, sources.map((b) => b.shape));
    let line: { origin: Vec3; dir: Vec3 } | null = null;
    // The picked axis as found here, also with no turn: the view's handle draws its ring on it.
    let turnAxis: { origin: Vec3; dir: Vec3 } | null = null;
    let warning: string | undefined;
    const turning = !turnless(v.angle);
    if (f.about === 'axis') {
      if (f.axis) {
        const a = await resolveAxis(f.axis, ctx);
        const dir = a.ok ? unitOf(a.value.dir) : null;
        if (a.ok && dir) turnAxis = { origin: a.value.origin, dir };
        if (turning) {
          if (!a.ok) return { ok: false, message: `${f.name} failed: Axis: ${a.message}` };
          if (!dir) return { ok: false, message: `${f.name} failed: the axis has no direction` };
          line = turnAxis;
          if (a.warning) warning = `Axis: ${a.warning}`;
        }
      } else if (turning) return { ok: false, message: `${f.name} failed: ${AXIS_WANTED}` };
    } else if (turning) {
      line = { origin: v.pivot ?? centre ?? [0, 0, 0], dir: AXIS_DIR[f.about] ?? AXIS_DIR.z };
    }
    const matrix = moveMatrix(v, line);
    const output = { type: 'move_body' as const, centre, axis: line, turnAxis, matrix };
    const made: ShapeId[] = [];
    const bodies: Extract<FeatureBuildResult, { ok: true }>['bodies'] = [];
    let done = false;
    try {
      for (const b of sources) {
        let r;
        try {
          const timeoutMs = timeoutForFaces('copies', await ctx.faces(b.shape));
          // A rigid motion keeps a valid solid valid: no check (the source's own state is kept).
          r = (await ctx.kernel.call('copies', { id: b.shape, transforms: [{ matrix }], check: false }, timeoutMs ? { timeoutMs } : {})).result;
        } catch (err) {
          const e = err as KernelCallError;
          if (e && (e.kind === 'input' || e.kind === 'occt' || e.kind === 'internal')) return { ok: false, message: `${f.name} failed: ${ctx.bodyName(b.id)} could not be moved: ${plainKernelMessage(e.message)}`, output };
          throw err;
        }
        const shape = r.ids[0];
        made.push(...r.ids);
        // The copy as the original: where its source was made, then moved by this feature.
        const placement = composePlacement(matrix, b.placement);
        if (!f.copy) {
          bodies.push({ id: b.id, shape, valid: b.valid, names: renumbered(b.names, r.maps[0], r.faces[0]), placement });
          continue;
        }
        const base = storedBodyName(ctx.doc, b.id) ?? ctx.bodyName(b.id);
        const color = ctx.doc.bodies[b.id]?.color;
        bodies.push({
          id: deriveBodyId(f.id, b.id, 1),
          shape,
          valid: b.valid,
          names: copyNames(f.id, COPY_KEY, b.names, r.maps[0], r.faces[0]),
          name: copyBodyName(ctx.doc, f.id, b.id, base),
          ...(color ? { color } : {}),
          placement,
        });
      }
      done = true;
      return {
        ok: true,
        bodies,
        removed: [],
        ...(warning ? { warning } : {}),
        ...(f.copy && still(v) ? { note: `the ${ids.length === 1 ? 'copy sits' : 'copies sit'} where the ${ids.length === 1 ? 'original is' : 'originals are'} (no distance, no turn)` } : {}),
        output,
      };
    } finally {
      // A failure keeps none of what it made.
      const kept = new Set(done ? bodies.map((b) => b.shape) : []);
      const drop = made.filter((s) => !kept.has(s));
      if (drop.length) await ctx.release(drop).catch(() => {});
    }
  },
};
