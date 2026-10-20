// measure: exact numbers from the geometry kernel (CAD tools spec §3.2.3, §9.3), in mm, mm², mm³
// and degrees (lengths to 1e-4, areas and volumes to 6 significant figures):
//   one body                volume, area, centre of mass, bounding box, solids, shells, voids,
//                           faces, edges, valid;
//   one face, edge, vertex  type, area or length, radius, centre, normal or axis, a point on it
//                           (a round edge: its circumference, or an arc's angle);
//   two targets             minimum distance, both points and their delta, angle, centre distance;
//   two bodies              also their overlap volume (0: no interference), whether they touch,
//                           and the solids and voids of their union;
//   one body and section    the cut there: material area, loops, holes and each piece;
//   a body that is not valid  also the Check panel's list (the kernel's check): each problem's
//                           status, the sub-shape it is on and a point there;
//   two bodies, 3-32 bodies the Mass properties panel's total of them (volumes and areas add, the
//                           centre of mass weighted by volume, one box round all), and for 3 or
//                           more each body's volume and validity.
// A read: it never waits for the person, and runs on the bodies built now after the rebuild
// caught up. When the Part changes while it measures (the person edits, the kernel restarts),
// it measures again once; a second change answers busy/changed.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { CallCtx, ToolImpl, ToolReply } from '../../types/assistant';
import type { DocState } from '../../types/doc-service';
import type { BodyInfo } from '../../types/kernel';
import { heartbeat, waitForRead } from '../busy';
import { ToolError } from '../errors';
import { bodyFacts, entityFacts, overlapFacts, pairFacts, planeOfFace, sectionFacts, SECTION_REGIONS_MAX, TOUCH_MM, type BodyFacts, type EntityFacts, type OverlapFacts, type PairFacts, type SectionFacts } from '../measure';
import { selectorTargets } from '../measure-selectors';
import { registerSelectorResolver, resolveSectionPlane, resolveTarget, type Entity, type SectionPlane } from '../measure-targets';
import { dir, len, sig6, vec } from '../numbers';
import { topoCacheOf } from '../selectors/topo-cache';
import type { CheckProblem } from '../../types/kernel-protocol';

type Row = Record<string, unknown>;

// Faces, edges, vertices and handles by selector (selectors/), after measure's own forms.
registerSelectorResolver(selectorTargets);

/** What a call read: the model, the rebuild it measured and the kernel's worker (a respawn kills every shape). */
interface Stamp {
  doc: unknown;
  seq: number;
  respawns: number;
}

function stampOf(ctx: CallCtx): Stamp {
  const s = ctx.services.doc.state.get();
  return { doc: s.doc, seq: s.rebuild.seq, respawns: ctx.services.kernel.status.get().respawns };
}

const sameStamp = (a: Stamp, b: Stamp) => a.doc === b.doc && a.seq === b.seq && a.respawns === b.respawns;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The most bodies a total takes (the schema's maxItems). */
const TOTAL_MAX = 32;
/** The most problems a body's check lists (the Check panel's). */
const PROBLEMS_MAX = 40;

/** The total of several bodies, as the Mass properties panel adds them (surface bodies add area and box only). */
function totalOf(list: readonly BodyFacts[]): Row {
  let volume = 0;
  let area = 0;
  const c = [0, 0, 0];
  let weighted = 0;
  let box: number[] | null = null;
  for (const f of list) {
    if (f.volume !== null) volume += f.volume;
    area += f.area;
    if (f.volume !== null && f.centroid && f.volume > 0) {
      for (let k = 0; k < 3; k++) c[k] += f.centroid[k] * f.volume;
      weighted += f.volume;
    }
    const b = f.bbox;
    box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.min(box[2], b[2]), Math.max(box[3], b[3]), Math.max(box[4], b[4]), Math.max(box[5], b[5])] : [...b];
  }
  return {
    bodies: list.length,
    volume_mm3: sig6(volume),
    area_mm2: sig6(area),
    centroid_mm: weighted > 0 ? vec(c.map((x) => x / weighted)) : null,
    bbox_mm: box ? [vec(box.slice(0, 3)), vec(box.slice(3, 6))] : null,
  };
}

/** A body's problems as the Check panel lists them, each with a point on the sub-shape it is on. */
async function problemsOf(ctx: CallCtx, b: BodyInfo): Promise<{ problems: Row[]; total: number; counts: Record<string, number> }> {
  const { services } = ctx;
  const r = (await services.kernel.call('check', { id: b.shape, max_problems: PROBLEMS_MAX })).result;
  const list: CheckProblem[] = r.problems ?? [];
  let topo: Awaited<ReturnType<ReturnType<typeof topoCacheOf>['topo']>> | null = null;
  try {
    if (list.some((p) => p.type === 'face' || p.type === 'edge' || p.type === 'vertex' || p.in)) topo = await topoCacheOf(services).topo(b.shape, { faces: b.faces, signal: ctx.signal });
  } catch {
    topo = null;
  }
  const pointOf = (type: string, i: number): number[] | null => {
    if (!topo) return null;
    if (type === 'face') return topo.faceAt.get(i)?.centroid ?? null;
    if (type === 'edge') return topo.edgeAt.get(i)?.mid ?? null;
    if (type === 'vertex') return topo.vertexAt.get(i)?.p ?? null;
    return null;
  };
  const problems = list.map((p) => {
    const at = pointOf(p.type, p.index) ?? (p.in ? pointOf(p.in.type, p.in.index) : null);
    return { status: p.status, on: `${p.type} ${p.index + 1}${p.in ? ` of ${p.in.type} ${p.in.index + 1}` : ''}`, ...(at ? { at_mm: vec(at) } : {}) };
  });
  return { problems, total: r.problem_total ?? list.length, counts: { ...(r.problem_counts ?? {}) } };
}

/** The input as the schema gives it (the app checks it; a direct call is checked here too). */
function inputOf(ctx: CallCtx): { targets: string[]; section: string } {
  const { targets, section } = ctx.input;
  const problems: string[] = [];
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > TOTAL_MAX || !targets.every((t) => typeof t === 'string')) problems.push(`targets must hold one or two selectors, or 3 to ${TOTAL_MAX} bodies`);
  if (typeof section !== 'string') problems.push('section must be "" or a plane selector');
  if (problems.length) throw new ToolError('bad_input', `${problems.join('; ')}.`, { detail: { field: problems.length === 1 && problems[0].startsWith('section') ? 'section' : 'targets' } });
  return { targets: targets as string[], section: section as string };
}

/**
 * Where the rollback bar stands when it is not at the end (as get_model's rolled_back says it), and
 * the words for it: the bodies measured are the ones there.
 */
function rolledBack(s: DocState): { rolled: { after: string | null; count: number }; note: string } | null {
  const { rollback } = s.view;
  if (rollback === null || rollback >= s.doc.features.length) return null;
  const last = rollback > 0 ? (s.doc.features[rollback - 1]?.name ?? null) : null;
  return {
    rolled: { after: last, count: s.doc.features.length - rollback },
    note: `The rollback bar is ${last ? `after ${last}` : 'at the top'}: these are the bodies there, not at the end of the history.`,
  };
}

function bodyRow(target: string, f: BodyFacts): Row {
  const row: Row = {
    target,
    kind: 'body',
    body: f.body,
    volume_mm3: f.volume === null ? null : sig6(f.volume),
    area_mm2: sig6(f.area),
    centroid_mm: f.centroid ? vec(f.centroid) : null,
    bbox_mm: [vec(f.bbox.slice(0, 3)), vec(f.bbox.slice(3, 6))],
    solids: f.solids,
    shells: f.shells,
    voids: f.voids,
    faces: f.faces,
    edges: f.edges,
    valid: f.valid,
  };
  if (f.volume === null) row.note = 'A surface body (an open shell): it has no volume and no voids.';
  return row;
}

/** What the selector warned of for a target ("#f3 moved: check", a split face), as `warning`. */
const warningOf = (e: Entity): Row => (e.warnings?.length ? { warning: e.warnings.join('; ') } : {});

function entityRow(target: string, e: Exclude<Entity, { kind: 'body' }>, f: EntityFacts): Row {
  const row: Row = { target, kind: e.kind, ...('body' in e ? { body: e.body.name } : {}), words: e.words, ...warningOf(e) };
  if (f.type) row.type = f.type;
  if (f.area !== undefined) row.area_mm2 = sig6(f.area);
  if (f.length !== undefined) row.length_mm = len(f.length);
  if (f.radius !== undefined) row.radius_mm = len(f.radius);
  if (f.center) row.center_mm = vec(f.center);
  if (f.normal) row.normal = dir(f.normal);
  if (f.axis) row.axis = { point_mm: vec(f.axis.point), dir: dir(f.axis.dir) };
  if (f.point) row.point_mm = vec(f.point);
  if (f.circumference !== undefined) row.circumference_mm = len(f.circumference);
  if (f.arcDeg !== undefined) row.arc_deg = len(f.arcDeg);
  return row;
}

function entityText(e: Entity, f: EntityFacts): string {
  const at = (p: readonly number[]) => `(${vec(p).join(', ')})`;
  if (e.kind === 'face') return `${e.words}: ${f.type ?? 'face'}, area ${sig6(f.area ?? 0)} mm2${f.radius !== undefined ? `, radius ${len(f.radius)} mm` : ''}`;
  if (e.kind === 'edge') return `${e.words}: ${f.type ?? 'edge'}, length ${len(f.length ?? 0)} mm${f.radius !== undefined ? `, radius ${len(f.radius)} mm` : ''}`;
  if (e.kind === 'plane') return `${e.words}: through ${at(f.point ?? [0, 0, 0])}, normal (${dir(f.normal ?? [0, 0, 1]).join(', ')})`;
  if (e.kind === 'axis') return `${e.words}: through ${at(f.axis?.point ?? [0, 0, 0])}, along (${dir(f.axis?.dir ?? [0, 0, 1]).join(', ')})`;
  return `${e.words}: at ${at(f.point ?? [0, 0, 0])}`;
}

function bodyText(f: BodyFacts): string {
  if (f.volume === null) return `${f.body}: a surface body, area ${sig6(f.area)} mm2, ${plural(f.faces, 'face')}`;
  return `${f.body}: volume ${sig6(f.volume)} mm3, ${plural(f.solids, 'solid')}, ${plural(f.voids ?? 0, 'void')}${f.valid ? '' : ', not valid'}`;
}

function pairRow(targets: string[], a: Entity, b: Entity, p: PairFacts, o: OverlapFacts | null): Row {
  const short = (t: string, e: Entity) => ({ target: t, kind: e.kind, words: e.words, ...warningOf(e) });
  const row: Row = {
    targets: [short(targets[0], a), short(targets[1], b)],
    distance_mm: len(p.distance),
    p1_mm: vec(p.p1),
    p2_mm: vec(p.p2),
    delta_mm: vec(p.delta),
  };
  if (p.angleDeg !== undefined) row.angle_deg = len(p.angleDeg);
  if (p.parallel !== undefined) row.parallel = p.parallel;
  if (p.centerDistance !== undefined) row.center_distance_mm = len(p.centerDistance);
  if (o) {
    row.overlap_mm3 = o.overlap === null ? null : sig6(o.overlap);
    row.touching = p.distance < TOUCH_MM;
    row.union_solids = o.unionSolids;
    row.union_voids = o.unionVoids;
    if (o.note) row.note = o.note;
  }
  return row;
}

function pairText(a: Entity, b: Entity, p: PairFacts, o: OverlapFacts | null): string {
  let t = `${a.words} to ${b.words}: distance ${len(p.distance)} mm`;
  if (o && o.overlap !== null) t += `, overlap ${sig6(o.overlap)} mm3, joined ${plural(o.unionSolids ?? 0, 'solid')} and ${plural(o.unionVoids ?? 0, 'void')}`;
  if (p.angleDeg !== undefined) t += `, angle ${len(p.angleDeg)} deg`;
  return t;
}

function sectionRow(target: string, b: BodyInfo, plane: SectionPlane, f: SectionFacts): Row {
  const section: Row = {
    plane: plane.words,
    origin_mm: vec(f.plane.origin),
    normal: dir(f.plane.normal),
    area_mm2: sig6(f.area),
    loops: f.loops,
    holes: f.holes,
    regions: f.regions.slice(0, SECTION_REGIONS_MAX).map((r) => ({ area_mm2: sig6(r.area), holes: r.holes })),
  };
  if (f.regions.length > SECTION_REGIONS_MAX) section.regions_more = f.regions.length - SECTION_REGIONS_MAX;
  if (f.open) section.open = f.open;
  if (!f.loops && !f.open) section.note = `The plane misses ${b.name}.`;
  else if (f.open) section.note = `${plural(f.open, 'loop')} of the cut ${f.open === 1 ? 'is' : 'are'} open (a surface body, or a cut along a face): the area counts the closed loops only.`;
  return { target, kind: 'body', body: b.name, section };
}

function sectionText(b: BodyInfo, plane: SectionPlane, f: SectionFacts): string {
  if (!f.loops && !f.open) return `${b.name} cut at ${plane.words}: the plane misses it`;
  return `${b.name} cut at ${plane.words}: area ${sig6(f.area)} mm2 in ${plural(f.regions.length, 'piece')}, ${plural(f.holes, 'hole')}`;
}

/** Whether two entities are the same thing (a body twice, the same face twice). */
function sameEntity(a: Entity, b: Entity): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'body' && b.kind === 'body') return a.body.id === b.body.id;
  if ((a.kind === 'face' || a.kind === 'edge' || a.kind === 'vertex') && (b.kind === 'face' || b.kind === 'edge' || b.kind === 'vertex')) return a.body.id === b.body.id && a.index === b.index;
  return false;
}

/** A body's solids, from its eager properties or a measure. */
async function solidsOf(ctx: CallCtx, b: BodyInfo): Promise<number> {
  if (typeof b.solids === 'number') return b.solids;
  return (await bodyFacts(ctx.services, b)).solids;
}

/** One measurement on the Part as it is now. */
async function measureOnce(ctx: CallCtx, targets: string[], section: string): Promise<ToolReply> {
  const { services } = ctx;
  const s = services.doc.state.get();
  const ents: Entity[] = [];
  for (let i = 0; i < targets.length; i++) ents.push(await resolveTarget(ctx, s, targets[i], `targets[${i}]`));
  const rolled = rolledBack(s);
  const withNote = (data: Row): Row => (rolled ? { ...data, rolled_back: rolled.rolled, note: data.note ? `${String(data.note)} ${rolled.note}` : rolled.note } : data);

  if (ents.length > 2) {
    if (section.trim()) throw new ToolError('bad_section', 'A section takes one body: give one target with section, or section "" for a total.', { detail: { field: 'section' } });
    const other = ents.findIndex((e) => e.kind !== 'body');
    if (other >= 0) throw new ToolError('bad_input', `targets[${other}]: ${ents[other].words} is not a body: three or more targets are bodies, added up.`, { detail: { field: `targets[${other}]` } });
    const bodies = ents.map((e) => (e as Extract<Entity, { kind: 'body' }>).body);
    const ids = new Set(bodies.map((b) => b.id));
    if (ids.size !== bodies.length) throw new ToolError('bad_input', 'targets: a body is named twice: name each body once.', { detail: { field: 'targets' } });
    const facts: BodyFacts[] = [];
    for (const b of bodies) {
      facts.push(await bodyFacts(services, b));
      ctx.checkAbort();
    }
    const total = totalOf(facts);
    const rows: Row[] = facts.map((f, i) => ({ body: f.body, volume_mm3: f.volume === null ? null : sig6(f.volume), valid: f.valid, target: targets[i] }));
    const bad = facts.filter((f) => !f.valid).map((f) => f.body);
    const text = `${facts.length} bodies: volume ${String(total.volume_mm3)} mm3, area ${String(total.area_mm2)} mm2${bad.length ? `; not valid: ${bad.join(', ')}` : ''}`;
    return { text, data: withNote({ kind: 'total', total, bodies: rows, ...(bad.length ? { not_valid: bad, note: 'measure one of them alone for its problems.' } : {}) }), summary: `Measured ${text}` };
  }

  if (section.trim()) {
    if (ents.length !== 1) throw new ToolError('bad_section', 'A section takes one body: give one target with section, or section "" for two targets.', { detail: { field: 'section' } });
    const e = ents[0];
    if (e.kind !== 'body') throw new ToolError('bad_section', `A section cuts a body; ${e.words} is ${e.kind === 'axis' ? 'an' : 'a'} ${e.kind}. Give a body, or section "".`, { detail: { field: 'section' } });
    const plane = await resolveSectionPlane(ctx, s, section, (f) => planeOfFace(services, f));
    ctx.checkAbort();
    const facts = await sectionFacts(services, e.body, plane.frame);
    const text = sectionText(e.body, plane, facts);
    return { text, data: withNote(sectionRow(targets[0], e.body, plane, facts)), summary: `Measured ${text}` };
  }

  if (ents.length === 1) {
    const e = ents[0];
    if (e.kind === 'body') {
      const f = await bodyFacts(services, e.body);
      const text = bodyText(f);
      const row = bodyRow(targets[0], f);
      // Not valid: the Check panel's list of what is wrong and where.
      if (!f.valid) {
        const c = await problemsOf(ctx, e.body);
        Object.assign(row, { problems: c.problems, problem_total: c.total, problem_counts: c.counts });
      }
      return { text, data: withNote(row), summary: `Measured ${text}` };
    }
    const f = await entityFacts(services, e);
    const text = entityText(e, f);
    return { text, data: withNote(entityRow(targets[0], e, f)), summary: `Measured ${text}` };
  }

  const [a, b] = ents;
  if (sameEntity(a, b)) throw new ToolError('bad_input', `Both targets are ${a.words}: give two different things, or one target.`, { detail: { field: 'targets' } });
  const p = await pairFacts(services, a, b);
  ctx.checkAbort();
  let o: OverlapFacts | null = null;
  if (a.kind === 'body' && b.kind === 'body') o = await overlapFacts(services, a.body, b.body, { a: await solidsOf(ctx, a.body), b: await solidsOf(ctx, b.body) });
  const text = pairText(a, b, p, o);
  const row = pairRow(targets, a, b, p, o);
  // Two bodies: their mass properties total too (the Mass properties panel's).
  if (a.kind === 'body' && b.kind === 'body') row.total = totalOf([await bodyFacts(services, a.body), await bodyFacts(services, b.body)]);
  return { text, data: withNote(row), summary: `Measured ${text}` };
}

export const tool: ToolImpl = {
  kind: 'read',
  async run(ctx) {
    const { targets, section } = inputOf(ctx);
    await waitForRead(ctx);
    const settle = () => heartbeat(ctx, ctx.services.doc.settled(ctx.signal), 'Waiting for the rebuild');
    for (let attempt = 0; ; attempt++) {
      await settle();
      if (attempt === 0) {
        await ctx.hold('after-settled');
        // A change while the call was held: the rebuild catches up first (at once when nothing changed).
        await settle();
      }
      ctx.checkAbort();
      const before = stampOf(ctx);
      try {
        const reply = await heartbeat(ctx, measureOnce(ctx, targets, section), 'Measuring');
        if (sameStamp(before, stampOf(ctx))) return reply;
      } catch (e) {
        // What failed on a Part that stayed as it was is the answer; on one that changed, measure again.
        if (ctx.signal.aborted || sameStamp(before, stampOf(ctx))) throw e;
      }
      if (attempt >= 1) throw new ToolError('changed', 'The Part changed again while it was being measured: nothing was measured.');
    }
  },
};
