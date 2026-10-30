// direct: the person's direct edits and CFD prep in one step, the same records as their panels
// (src/features/{press_pull,delete_faces,split,enclosure,delete_body,move_body}), and their Try repair / Retry on a
// failed feature (DocService.repair / retry). edit "" makes a new feature; edit "<name>" replaces
// that feature's inputs (its type must be the kind's); repair and retry take the feature in edit.
//   press_pull    faces of one body move along their own normals by distance (> 0 adds, < 0 removes)
//   delete_faces  faces of one body go and their neighbours grow to close the gap
//   split         bodies split by tool: Top, Front or Right moved distance along its normal, the
//                 plane of a flat face, or another body (keep_tool keeps it)
//   enclosure     a box or a cylinder (about X, Y or Z) around bodies ([] every solid body made
//                 before it), each side out by the padding: zero, percent (distance "10") or fixed
//                 (distance a length); sides rows set single sides on their own
//   delete_body   bodies leave the model from this point in the history (the person's Delete on a
//                 body in the tree): one Delete body feature for them all
//   move_body     bodies turn by turn.angle about turn.axis (X, Y or Z through turn.pivot, [] the
//                 centre of their box; or an axis, an edge, "axis of <round face>"), then move by
//                 move (X, Y, Z); copy keeps them and moves copies (the person's Move/copy body)
//   repair        the person's Try repair: the feature's booleans again with a looser tolerance
//   retry         the person's Retry: build again a feature the geometry kernel stopped
// Selectors read the bodies built now, or for an edit the bodies just before the feature. The
// person's own panel opens read-only, filled, and its Done keeps the feature; a feature that does
// not build changes nothing. get_model full shows these features as this tool's input.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { deriveBodyId } from '../../doc/features/body-ids';
import type { AppServices } from '../../types/app';
import type { CallCtx, EditData, ToolImpl, ToolReply } from '../../types/assistant';
import type { DocState } from '../../types/doc-service';
import type { BodyId, DeleteBodyFeature, DeleteFacesFeature, EnclosureFeature, EnclosureSide, ExprVec3, Feature, FeatureId, FeatureType, MoveAbout, MoveBodyFeature, OriginAxisRef, OriginPlaneRef, PersistentRef, PressPullFeature, SplitFeature, SplitTool } from '../../types/doc';
import type { AxisRef } from '../../types/references';
import { nameForCopy } from '../../features/move_body/feature';
import { isZeroExpr, moveWords } from '../../features/move_body/words';
import { ToolError } from '../errors';
import { andList, axisText, bodyText, createdLabels, editTarget, faceText, fillFeature, nameFor, partOf, str, strings, type RefBodies } from '../feature-tools';
import { registerFeatureIo } from '../features-io';
import { bodyWords } from '../judge';
import { featureByName, stateWord } from '../model';
import { runtimeOf } from '../runtime';
import { axisRefOf, faceRefOf } from '../selectors/refs';
import { echo, faceLabel, hitWords, selectAny, selectOne, selectSet, withScene, type AxisHit, type FaceHit, type Scene } from '../selectors/resolve';
import { vec } from '../numbers';
import { storeExpr } from '../sketch/compile';
import { runEdit, type EditCtx, type EditPlan, type EditTool } from '../step';
import { closestName, closestWords } from '../closest';

export const DIRECT_KINDS = ['press_pull', 'delete_faces', 'split', 'enclosure', 'delete_body', 'move_body', 'repair', 'retry'] as const;
type Kind = (typeof DIRECT_KINDS)[number];
type MakeKind = Exclude<Kind, 'repair' | 'retry'>;
const TYPE: Record<MakeKind, FeatureType> = { press_pull: 'press_pull', delete_faces: 'delete_faces', split: 'split', enclosure: 'enclosure', delete_body: 'delete_body', move_body: 'move_body' };
export const ENCLOSURE_SHAPES = ['box', 'cylinder_x', 'cylinder_y', 'cylinder_z'] as const;
export const ENCLOSURE_SIDES: readonly EnclosureSide[] = ['+x', '-x', '+y', '-y', '+z', '-z', 'radius', 'top', 'bottom'];
const BOX_SIDES: readonly EnclosureSide[] = ['+x', '-x', '+y', '-y', '+z', '-z'];
const CYLINDER_SIDES: readonly EnclosureSide[] = ['radius', 'top', 'bottom'];
const PADDINGS: readonly EnclosureFeature['padding'][] = ['zero', 'percent', 'fixed'];
/** The schema's most faces, and so the most get_model writes back. */
const FACES_MAX = 60;
const BODIES_MAX = 32;
const ORIGIN_PLANE: Record<string, OriginPlaneRef> = { top: 'origin:top', front: 'origin:front', right: 'origin:right' };
const PLANE_WORD: Record<OriginPlaneRef, string> = { 'origin:top': 'Top', 'origin:front': 'Front', 'origin:right': 'Right' };

interface Plan extends EditPlan {
  kind: Kind;
  type: FeatureType | null;
  edit: FeatureId | null;
  name: string | null;
  fields: Partial<Feature>;
  /** repair, retry: the feature. */
  target: { id: FeatureId; name: string } | null;
  what: string;
  warnings: string[];
  /** move_body: the bodies it moves (or copies), for the reply's positions. */
  moved?: BodyId[];
}

/** Faces of one body (press-pull, delete faces), as the person's face field keeps them. */
async function facesOfOneBody(sc: Scene, texts: readonly string[]): Promise<{ body: BodyId; bodyName: string; faces: PersistentRef[]; words: string; warnings: string[] }> {
  const hits: FaceHit[] = [];
  const echoes: string[] = [];
  const warnings: string[] = [];
  for (const [i, t] of texts.entries()) {
    const sel = await selectSet(sc, t, 'face', `faces[${i}]`);
    for (const h of sel.hits) if (h.kind === 'face' && !hits.some((x) => x.bi === h.bi && x.index === h.index)) hits.push(h);
    echoes.push(echo(sc, sel));
    for (const w of sel.warnings) if (!warnings.includes(w)) warnings.push(w);
  }
  const on = [...new Set(hits.map((h) => h.body.name))];
  if (on.length > 1) throw new ToolError('bad_selector', `faces are on ${andList(on)}: the faces of one body per call.`, { detail: { field: 'faces', bodies: on } });
  if (hits.length > FACES_MAX) throw new ToolError('bad_input', `faces: ${hits.length} faces; at most ${FACES_MAX} per call.`, { detail: { field: 'faces' } });
  const faces: PersistentRef[] = [];
  for (const h of hits) faces.push((await faceRefOf(sc, h)).ref);
  return { body: hits[0].body.id, bodyName: hits[0].body.name, faces, words: echoes.join('; '), warnings };
}

/** Bodies by selector (split targets, enclosure bodies, bodies to delete or move), deduplicated. */
async function bodiesOf(sc: Scene, texts: readonly string[]): Promise<{ ids: BodyId[]; names: string[] }> {
  const ids: BodyId[] = [];
  const names: string[] = [];
  for (const [i, t] of texts.entries()) {
    const sel = await selectSet(sc, t, 'body', `bodies[${i}]`);
    for (const h of sel.hits) {
      if (h.kind === 'body' && !ids.includes(h.body.id)) {
        ids.push(h.body.id);
        names.push(h.body.name);
      }
    }
  }
  return { ids, names };
}

/** A split's tool: an origin plane by its word, else one flat face or one body. */
async function splitToolOf(sc: Scene, text: string, offset: string, keepTool: boolean): Promise<{ tool: SplitTool; words: string; toolBody: BodyId | null; warnings: string[] }> {
  const plane = ORIGIN_PLANE[text.trim().toLowerCase()];
  if (plane) return { tool: { kind: 'plane', plane, offset }, words: `${PLANE_WORD[plane]}${offset !== '0' ? ` offset ${offset}` : ''}`, toolBody: null, warnings: [] };
  const sel = await selectAny(sc, text, 'tool');
  if (!sel.hits.length) throw new ToolError('nothing_selected', `tool: "${text}" names nothing: Top, Front, Right, a flat face or a body.`, { detail: { field: 'tool', candidates: [] } });
  if (sel.hits.length > 1) throw new ToolError('selector_ambiguous', `tool: "${text}" names ${sel.hits.length} things; a split takes one plane, flat face or body.`, { detail: { field: 'tool', count: sel.hits.length } });
  const h = sel.hits[0];
  if (h.kind === 'body') return { tool: { kind: 'body', body: h.body.id, keepTool }, words: h.body.name, toolBody: h.body.id, warnings: h.warnings };
  if (h.kind === 'face') {
    const words = faceLabel(sc, h) ?? hitWords(sc, h);
    if (h.topo.type !== 'plane') throw new ToolError('not_flat', `tool: ${words} is curved: a split by a face needs a flat face.`, { detail: { field: 'tool' } });
    const r = await faceRefOf(sc, h);
    return { tool: { kind: 'face', body: r.body, face: r.ref }, words: `the plane of ${words}`, toolBody: null, warnings: h.warnings };
  }
  throw new ToolError('bad_selector', `tool: "${text}" names ${h.kind === 'edge' ? 'an edge' : `a ${h.kind}`}: a split takes Top, Front, Right, a flat face or a body.`, { detail: { field: 'tool' } });
}

const direct: EditTool<Plan> = {
  async plan(ctx) {
    const { services } = ctx;
    const s = services.doc.state.get();
    const units = services.doc.units;
    const kind = ctx.input.kind as Kind;
    // Magnusim CAD (no projects, no simulation) has no Enclosure command, and no enclosure kind here.
    const kinds: readonly Kind[] = services.bridge.projectLinks() ? DIRECT_KINDS : DIRECT_KINDS.filter((k) => k !== 'enclosure');
    if (!kinds.includes(kind)) throw new ToolError('bad_input', `kind: one of ${kinds.join(', ')}.`, { detail: { field: 'kind' } });
    const faces = strings(ctx.input.faces);
    const bodies = strings(ctx.input.bodies);
    const distance = str(ctx.input.distance);
    const toolText = str(ctx.input.tool);
    const keepTool = ctx.input.keep_tool === true;
    const shape = (str(ctx.input.shape) || 'box') as (typeof ENCLOSURE_SHAPES)[number];
    const padding = (str(ctx.input.padding) || 'zero') as EnclosureFeature['padding'];
    const sides = (Array.isArray(ctx.input.sides) ? ctx.input.sides : []) as { side?: unknown; value?: unknown }[];
    const move = strings(ctx.input.move);
    const turn = (ctx.input.turn && typeof ctx.input.turn === 'object' ? ctx.input.turn : {}) as { angle?: unknown; axis?: unknown; pivot?: unknown };
    const angle = str(turn.angle);
    const axisWords = str(turn.axis);
    const pivot = strings(turn.pivot);
    const copy = ctx.input.copy === true;
    const problems: string[] = [];
    const usesFaces = kind === 'press_pull' || kind === 'delete_faces';
    if (usesFaces && !faces.length) problems.push('faces: at least one face of the body');
    if (!usesFaces && faces.length) problems.push(`faces: [] with ${kind}`);
    faces.forEach((t, i) => {
      if (!t) problems.push(`faces[${i}]: a face selector, not ""`);
    });
    if (kind === 'press_pull' && !distance) problems.push('distance: how far the faces move ("5 mm"; below 0 removes material)');
    if ((kind === 'delete_faces' || kind === 'delete_body' || kind === 'move_body' || kind === 'repair' || kind === 'retry') && distance) problems.push(`distance: "" with ${kind}`);
    if (kind === 'split' && !bodies.length) problems.push('bodies: the bodies to split');
    if (kind === 'delete_body' && !bodies.length) problems.push('bodies: the bodies to delete');
    if (kind === 'move_body' && !bodies.length) problems.push('bodies: the bodies to move');
    if (kind !== 'split' && kind !== 'enclosure' && kind !== 'delete_body' && kind !== 'move_body' && bodies.length) problems.push(`bodies: [] with ${kind}`);
    if (kind === 'move_body') {
      if (move.length && move.length !== 3) problems.push('move: three lengths X, Y, Z ("20 mm", "0", "0"), or [] for no move');
      move.forEach((t, i) => {
        if (!t) problems.push(`move[${i}]: a length ("0" for none), not ""`);
      });
      if (pivot.length && pivot.length !== 3) problems.push("turn.pivot: three lengths X, Y, Z, or [] for the centre of the bodies' box");
      if (angle && !axisWords) problems.push('turn.axis: X, Y or Z (through the pivot), or an axis, a straight or round edge, "axis of <round face>"');
      if (!angle && (axisWords || pivot.length)) problems.push('turn: angle "" turns nothing; send axis "" and pivot [] with it');
      if (pivot.length && axisWords && !/^[xyz]$/i.test(axisWords)) problems.push('turn.pivot: [] with an axis that is not X, Y or Z (it turns about that axis itself)');
    } else {
      if (move.length) problems.push(`move: [] with ${kind}`);
      if (angle || axisWords || pivot.length) problems.push(`turn: angle "", axis "", pivot [] with ${kind}`);
      if (copy) problems.push(`copy: false with ${kind}`);
    }
    bodies.forEach((t, i) => {
      if (!t) problems.push(`bodies[${i}]: a body, not ""`);
    });
    if (kind === 'split' && !toolText) problems.push('tool: Top, Front, Right, a flat face or a body');
    if (kind !== 'split' && toolText) problems.push(`tool: "" with ${kind}`);
    if (kind === 'split' && distance && !ORIGIN_PLANE[toolText.toLowerCase()]) problems.push('distance: "" unless the tool is Top, Front or Right (the offset)');
    if (keepTool && kind !== 'split') problems.push(`keep_tool: false with ${kind}`);
    if (kind === 'enclosure') {
      if (!ENCLOSURE_SHAPES.includes(shape)) problems.push(`shape: ${ENCLOSURE_SHAPES.join(', ')}`);
      if (!PADDINGS.includes(padding)) problems.push('padding: zero, percent or fixed');
      if (padding === 'zero' && distance) problems.push('distance: "" with padding zero');
      if (padding !== 'zero' && !distance) problems.push(padding === 'percent' ? 'distance: the percent of the part\'s size ("10")' : 'distance: how far out each side sits ("10 mm")');
      const allowed = shape === 'box' ? BOX_SIDES : CYLINDER_SIDES;
      const seen = new Set<string>();
      sides.forEach((row, i) => {
        const side = str(row?.side) as EnclosureSide;
        if (!allowed.includes(side)) problems.push(`sides[${i}].side: a ${shape === 'box' ? 'box has +x, -x, +y, -y, +z, -z' : 'cylinder has radius, top, bottom'}`);
        if (seen.has(side)) problems.push(`sides[${i}]: ${side} is set twice`);
        seen.add(side);
        if (!str(row?.value)) problems.push(`sides[${i}].value: a length out from the part ("5 mm")`);
      });
    } else {
      if (str(ctx.input.shape) && str(ctx.input.shape) !== 'box') problems.push(`shape: box with ${kind} (only an enclosure has a shape)`);
      if (str(ctx.input.padding) && str(ctx.input.padding) !== 'zero') problems.push(`padding: zero with ${kind}`);
      if (sides.length) problems.push(`sides: [] with ${kind}`);
    }
    if ((kind === 'repair' || kind === 'retry') && !str(ctx.input.edit)) problems.push(`edit: the feature to ${kind === 'repair' ? 'repair' : 'build again'}`);
    if ((kind === 'repair' || kind === 'retry') && str(ctx.input.name)) problems.push(`name: "" with ${kind}`);
    if (problems.length) throw new ToolError('bad_input', `${problems.join('; ')}.`, { detail: { problems } });

    if (kind === 'repair' || kind === 'retry') return planAction(services, kind, str(ctx.input.edit));

    const type = TYPE[kind];
    const word = services.doc.features.get(type)?.label.toLowerCase() ?? kind;
    const editing = editTarget(services, ctx.input.edit, [type], word, (f) => {
      const k = (Object.keys(TYPE) as MakeKind[]).find((x) => TYPE[x] === f.type);
      return k ? `send kind ${k} to change it` : null;
    });
    const name = nameFor(services, ctx.input.name, editing);
    const self = editing?.id ?? null;
    const resolved: Record<string, string> = { kind };
    let fields: Partial<Feature>;
    let what = '';
    const warnings: string[] = [];
    if (kind === 'press_pull' || kind === 'delete_faces') {
      const r = await withScene(ctx, { before: self, self }, (sc) => facesOfOneBody(sc, faces));
      warnings.push(...r.warnings);
      resolved.faces = r.words;
      if (kind === 'press_pull') {
        const d = storeExpr(distance, 'length', units);
        fields = { body: r.body, faces: r.faces, distance: d } as Partial<PressPullFeature>;
        resolved.distance = d;
        what = `moved ${r.faces.length} ${r.faces.length === 1 ? 'face' : 'faces'} of ${r.bodyName} by ${d}`;
      } else {
        fields = { body: r.body, faces: r.faces } as Partial<DeleteFacesFeature>;
        what = `deleted ${r.faces.length} ${r.faces.length === 1 ? 'face' : 'faces'} of ${r.bodyName} and healed it`;
      }
    } else if (kind === 'split') {
      const offset = distance ? storeExpr(distance, 'length', units) : '0';
      const r = await withScene(ctx, { before: self, self }, async (sc) => ({ targets: await bodiesOf(sc, bodies), tool: await splitToolOf(sc, toolText, offset, keepTool) }));
      if (keepTool && r.tool.tool.kind !== 'body') throw new ToolError('bad_input', 'keep_tool: only a split by another body has a tool body to keep; send false.', { detail: { field: 'keep_tool' } });
      if (r.tool.toolBody && r.targets.ids.includes(r.tool.toolBody)) throw new ToolError('bad_input', `bodies: ${r.tool.words} is the tool: it cannot split itself; take it out of bodies.`, { detail: { field: 'bodies' } });
      warnings.push(...r.tool.warnings);
      fields = { targets: r.targets.ids, tool: r.tool.tool } as Partial<SplitFeature>;
      resolved.bodies = andList(r.targets.names);
      resolved.tool = r.tool.words;
      what = `split ${andList(r.targets.names)} by ${r.tool.words}${r.tool.tool.kind === 'body' ? (keepTool ? ' (kept)' : ' (used up)') : ''}`;
    } else if (kind === 'delete_body') {
      // An edit names the bodies as they are just before it (the ones it deletes are there then).
      const r = await withScene(ctx, { before: self, self }, (sc) => bodiesOf(sc, bodies));
      fields = { bodies: r.ids } as Partial<DeleteBodyFeature>;
      resolved.bodies = andList(r.names);
      what = `deleted ${andList(r.names)} from the model here on`;
    } else if (kind === 'move_body') {
      // An edit names the bodies and the axis as they are just before it (where the bodies were).
      const xyz = /^[xyz]$/i.test(axisWords) ? (axisWords.toLowerCase() as MoveAbout) : null;
      const r = await withScene(ctx, { before: self, self }, async (sc) => {
        const named = await bodiesOf(sc, bodies);
        let axis: AxisRef | null = null;
        let words = '';
        if (angle && !xyz) {
          const one = await selectOne(sc, axisWords, 'axis', 'turn.axis');
          // The person's panel turns about an axis, an edge, a round face's axis or a sketch line, never a plane's normal (parity).
          if ((one.hit as AxisHit).source.s === 'normal')
            throw new ToolError('bad_selector', `turn.axis: "${axisWords}" is a plane's normal: give X, Y or Z (through pivot), an axis, a sketch line, a straight or round edge, or "axis of <round face>".`, { detail: { field: 'turn.axis' } });
          axis = await axisRefOf(sc, one.hit as AxisHit);
          words = echo(sc, one.selected);
          for (const w of one.hit.warnings ?? []) if (!warnings.includes(w)) warnings.push(w);
        }
        return { ...named, axis, words };
      });
      const about: MoveAbout = xyz ?? (r.axis ? 'axis' : 'z');
      const f = {
        bodies: r.ids,
        move: (move.length ? move.map((m) => storeExpr(m, 'length', units)) : ['0 mm', '0 mm', '0 mm']) as ExprVec3,
        angle: angle ? storeExpr(angle, 'angle', units) : '0 deg',
        about,
        axis: r.axis,
        pivot: xyz && pivot.length ? (pivot.map((p) => storeExpr(p, 'length', units)) as ExprVec3) : null,
        copy,
      };
      fields = f as Partial<MoveBodyFeature>;
      // Keep a copy names it as the person's panel does: Body-Move 1 becomes Body-Copy 1 (a name given stays).
      if (editing && !name && (editing as MoveBodyFeature).copy !== copy) {
        const renamed = nameForCopy(editing.name, copy, s.doc.features.filter((g) => g.id !== editing.id).map((g) => g.name));
        if (renamed !== editing.name) fields = { ...fields, name: renamed } as Partial<MoveBodyFeature>;
      }
      resolved.bodies = andList(r.names);
      if (angle) resolved.turn = `${f.angle} about ${xyz ? `${xyz.toUpperCase()} through ${f.pivot ? `(${f.pivot.join(', ')})` : "the centre of the bodies' box"}` : r.words}`;
      if (move.length) resolved.move = `(${f.move.join(', ')})`;
      what = moveWords({ ...(editing ?? {}), ...f, type: 'move_body' } as MoveBodyFeature, (id) => r.names[r.ids.indexOf(id)] ?? id, () => axisWords);
    } else {
      const r = bodies.length ? await withScene(ctx, { before: self, self }, (sc) => bodiesOf(sc, bodies)) : { ids: [], names: [] };
      const own = (editing as EnclosureFeature | null)?.creates;
      const refused = r.ids.find((id) => id === own || s.doc.features.some((g) => g.type === 'enclosure' && (g as EnclosureFeature).creates === id));
      if (refused) throw new ToolError('bad_input', `bodies: ${r.names[r.ids.indexOf(refused)]} is ${refused === own ? 'this enclosure\'s own body' : 'the body of another enclosure'}: name the part.`, { detail: { field: 'bodies' } });
      const def = services.doc.features.get('enclosure')!;
      const base = (editing ?? def.create(s.doc, {})) as EnclosureFeature;
      const axis: OriginAxisRef = shape === 'box' ? base.axis : (`origin:${shape.slice(-1)}` as OriginAxisRef);
      const amount = padding === 'percent' ? distance.replace(/\s*%$/, '') : padding === 'fixed' ? storeExpr(distance, 'length', units) : '';
      const sideMap: Partial<Record<EnclosureSide, string>> = {};
      for (const row of sides) sideMap[str(row.side) as EnclosureSide] = storeExpr(str(row.value), 'length', units);
      fields = {
        shape: shape === 'box' ? 'box' : 'cylinder',
        axis,
        bodies: r.ids,
        padding,
        percent: padding === 'percent' ? amount : base.percent,
        distance: padding === 'fixed' ? amount : base.distance,
        sides: sideMap,
      } as Partial<EnclosureFeature>;
      resolved.bodies = r.names.length ? andList(r.names) : 'every solid body before it';
      resolved.shape = shape === 'box' ? 'box' : `cylinder about ${shape.slice(-1).toUpperCase()}`;
      resolved.padding = padding === 'zero' ? 'zero' : padding === 'percent' ? `${amount} % of the part's size` : `${amount} out`;
      if (sides.length) resolved.sides = Object.entries(sideMap).map(([k, v]) => `${k} ${v}`).join(', ');
      what = `${resolved.shape} around ${resolved.bodies}`;
    }
    // The dry run: the feature as its type checks it, before anything changes.
    const def = services.doc.features.get(type)!;
    const draft = { ...(editing ?? def.create(s.doc, {})), ...fields } as Feature;
    const why = def.incomplete(draft, units);
    if (why) {
      const field =
        kind === 'move_body'
          ? /^Move/.test(why)
            ? 'move'
            : /^Angle/.test(why)
              ? 'turn.angle'
              : /^Pivot/.test(why)
                ? 'turn.pivot'
                : /axis/i.test(why)
                  ? 'turn.axis'
                  : /^Nothing to move/.test(why)
                    ? 'move'
                    : 'bodies'
          : /^(Distance|Offset|Percent)/i.test(why)
            ? 'distance'
            : /side|Top|Bottom|Radius|[+-][XYZ]/.test(why) && kind === 'enclosure'
              ? 'sides'
              : kind === 'split'
                ? 'tool'
                : kind === 'delete_body'
                  ? 'bodies'
                  : 'faces';
      // A value that does not evaluate is expr_error; Move/copy body's "Nothing to move" and "Pick ..." ask for what is missing.
      const reason = kind === 'move_body' ? (/^(Move [XYZ]|Angle|Pivot [XYZ]): /.test(why) ? 'expr_error' : 'incomplete') : /: /.test(why) ? 'expr_error' : 'bad_input';
      throw new ToolError(reason, `${field}: ${why}.`, { detail: { field } });
    }
    if (editing) resolved.edit = editing.name;
    return {
      part: partOf(services, type, name ?? editing?.name ?? def.label, !!editing),
      value: false,
      own: self,
      feature: self,
      resolved,
      kind,
      type,
      edit: self,
      name,
      fields,
      target: null,
      what,
      warnings,
      ...(kind === 'move_body' ? { moved: (fields as Partial<MoveBodyFeature>).bodies ?? [] } : {}),
    };
  },

  async apply(plan, ctx: EditCtx) {
    const { services } = ctx;
    const { doc } = services;
    if (plan.target) {
      const id = plan.target.id;
      await ctx.checkpoint({ pace: 'open', label: `${plan.kind === 'repair' ? 'Try repair' : 'Retry'} ${plan.target.name}` });
      const r = ctx.step.run(() => (plan.kind === 'repair' ? doc.repair(id) : doc.retry(id)));
      if (!r.ok) throw new ToolError('bad_input', `edit: ${r.reason}.`, { detail: { field: 'edit' } });
      await ctx.checkpoint({ pace: 'commit' });
      return;
    }
    const editName = plan.edit ? doc.state.get().doc.features.find((f) => f.id === plan.edit)?.name : null;
    const label = plan.name ?? editName ?? doc.features.get(plan.type!)?.label ?? plan.kind;
    const id = await fillFeature(ctx, plan, { edit: plan.edit, type: plan.type!, fields: (plan.name ? { ...plan.fields, name: plan.name } : plan.fields) as Partial<Feature>, label });
    const made = doc.state.get().doc.features.find((f) => f.id === id);
    if (made) plan.part = partOf(services, plan.type!, made.name, !!plan.edit);
  },

  sealed(plan, ctx) {
    if (!plan.edit && !plan.target && plan.own) runtimeOf(ctx.services)?.madeBy.add(plan.own);
  },

  reply(plan, data: EditData, ctx): ToolReply {
    const s = ctx.services.doc.state.get();
    const id = plan.target?.id ?? plan.own!;
    const f = s.doc.features.find((g) => g.id === id);
    const body = bodyWords(data);
    const name = f?.name ?? plan.name ?? plan.kind;
    if (plan.target) {
      const st = s.rebuild.features[id];
      const state = stateWord(st);
      const still = state === 'error' ? `; it still fails: ${st?.message ?? 'it does not build'}${st?.actions?.length ? ` (it offers ${st.actions.join(', ')})` : ''}` : '';
      const text = `${plan.kind === 'repair' ? 'Try repair' : 'Retry'} ${name}: ${state}${still}${body ? ` · ${body}` : ''}`;
      return { text, summary: text, data: { ...data, feature: { name, type: f?.type ?? '', state }, ...(state === 'error' ? { message: st?.message ?? null, actions: [...(st?.actions ?? [])] } : {}) } };
    }
    const created = createdLabels(ctx.services, id);
    // Move/copy body: where the bodies (or their copies) are now, by the middle of their box.
    const now = plan.moved ? movedNow(s, f as MoveBodyFeature | undefined, plan.moved) : null;
    const where = now?.length ? `: ${now.map((b) => `${b.name} at (${b.at_mm.join(', ')})`).join(', ')}` : '';
    const text = `${name} ${data.feature?.state ?? 'ok'}${plan.edit ? ' (replaced)' : ''}: ${plan.what}${where}${body ? ` · ${body}` : ''}`;
    return { text, summary: text, data: { ...data, created: created.labels, ...(created.more ? { created_more: created.more } : {}), ...(now ? { [(f as MoveBodyFeature | undefined)?.copy ? 'copies' : 'moved']: now } : {}), warnings: [...plan.warnings, ...data.warnings].slice(0, 20) } };
  },
};

/** The bodies a Move/copy body moved (or the copies it made, by their derived ids), built now: name and the middle of the box (mm). */
function movedNow(s: DocState, f: MoveBodyFeature | undefined, sources: readonly BodyId[]): { name: string; at_mm: number[] }[] {
  const ids = f?.copy ? sources.map((id) => deriveBodyId(f.id, id, 1)) : [...sources];
  return ids.flatMap((id) => {
    const b = s.rebuild.bodies.find((x) => x.id === id);
    if (!b) return [];
    const box = b.bbox;
    return [{ name: b.name, at_mm: vec([(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2]) }];
  });
}

/** repair, retry: the feature, and whether its build offers that action. */
function planAction(services: AppServices, kind: 'repair' | 'retry', featureName: string): Plan {
  const s = services.doc.state.get();
  const f = featureByName(s, featureName);
  if (!f) {
    const names = s.doc.features.map((g) => g.name);
    const near = closestName(featureName, names);
    throw new ToolError('not_found', `edit: no feature is called "${featureName}".${closestWords(near)} Features: ${names.length ? names.slice(0, 30).join(', ') : 'none yet'}.`, { detail: { field: 'edit', names: names.slice(0, 30), ...(near ? { closest: near } : {}) } });
  }
  const st = s.rebuild.features[f.id];
  if (!st?.actions?.includes(kind)) {
    const why = kind === 'repair' ? `${f.name} offers no Try repair (${stateWord(st) === 'error' ? `it fails: ${st?.message ?? 'it does not build'}` : `it is ${stateWord(st)}`})` : `${f.name} was not stopped by the geometry kernel, so there is nothing to retry`;
    throw new ToolError('bad_input', `edit: ${why}.`, { detail: { field: 'edit', feature: f.name, actions: [...(st?.actions ?? [])] } });
  }
  const label = kind === 'repair' ? 'Try repair' : 'Retry';
  return {
    part: `${label} ${f.name}`,
    // Structural: what it changes downstream is kept and listed.
    value: false,
    own: null,
    feature: f.id,
    resolved: { kind, edit: f.name },
    kind,
    type: null,
    edit: null,
    name: null,
    fields: {},
    target: { id: f.id, name: f.name },
    what: '',
    warnings: [],
  };
}

export const tool: ToolImpl = {
  kind: 'edit',
  run: (ctx: CallCtx) => runEdit(ctx, direct),
};

// ------------------------------------------------------------------ get_model full

const NO_TURN = { angle: '', axis: '', pivot: [] as string[] };
const BLANK = { faces: [] as string[], distance: '', bodies: [] as string[], tool: '', keep_tool: false, move: [] as string[], turn: NO_TURN, copy: false, shape: 'box', padding: 'zero', sides: [] as { side: string; value: string }[] };

function facesText(services: AppServices, body: BodyId, faces: readonly PersistentRef[], at: RefBodies | null): string[] | null {
  if (faces.length > FACES_MAX) return null;
  const s = services.doc.state.get();
  return faces.map((r) => faceText(s, body, r, at));
}

registerFeatureIo('press_pull', {
  tool: 'direct',
  refs: true,
  inputsOf(f, services, at = null) {
    const g = f as PressPullFeature;
    const faces = facesText(services, g.body, g.faces, at);
    return faces ? { edit: g.name, name: '', kind: 'press_pull', ...BLANK, faces, distance: g.distance } : null;
  },
});

registerFeatureIo('delete_faces', {
  tool: 'direct',
  refs: true,
  inputsOf(f, services, at = null) {
    const g = f as DeleteFacesFeature;
    const faces = facesText(services, g.body, g.faces, at);
    return faces ? { edit: g.name, name: '', kind: 'delete_faces', ...BLANK, faces } : null;
  },
});

registerFeatureIo('split', {
  tool: 'direct',
  refs: true,
  inputsOf(f, services, at = null) {
    const g = f as SplitFeature;
    const s = services.doc.state.get();
    if (g.targets.length > BODIES_MAX) return null;
    const t = g.tool;
    const base = { edit: g.name, name: '', kind: 'split', ...BLANK, bodies: g.targets.map((id) => bodyText(s, id)) };
    if (t.kind === 'plane') return { ...base, tool: PLANE_WORD[t.plane], distance: t.offset === '0' ? '' : t.offset };
    if (t.kind === 'face') return t.face ? { ...base, tool: faceText(s, t.body, t.face, at) } : null;
    return t.body ? { ...base, tool: bodyText(s, t.body), keep_tool: !!t.keepTool } : null;
  },
});

registerFeatureIo('delete_body', {
  tool: 'direct',
  inputsOf(f, services) {
    const g = f as DeleteBodyFeature;
    if ((g.bodies ?? []).length > BODIES_MAX) return null;
    const s = services.doc.state.get();
    return { edit: g.name, name: '', kind: 'delete_body', ...BLANK, bodies: (g.bodies ?? []).map((id) => bodyText(s, id)) };
  },
});

registerFeatureIo('move_body', {
  tool: 'direct',
  refs: true,
  inputsOf(f, services, at = null) {
    const g = f as MoveBodyFeature;
    if ((g.bodies ?? []).length > BODIES_MAX) return null;
    const s = services.doc.state.get();
    const turning = !isZeroExpr(g.angle);
    const axis = g.about === 'axis' ? axisText(s, g.axis, at) : g.about.toUpperCase();
    return {
      edit: g.name,
      name: '',
      kind: 'move_body',
      ...BLANK,
      bodies: (g.bodies ?? []).map((id) => bodyText(s, id)),
      move: (g.move ?? []).every((e) => isZeroExpr(e)) ? [] : [...g.move],
      turn: turning ? { angle: g.angle, axis, pivot: g.about !== 'axis' && g.pivot ? [...g.pivot] : [] } : NO_TURN,
      copy: !!g.copy,
    };
  },
});

registerFeatureIo('enclosure', {
  tool: 'direct',
  inputsOf(f, services) {
    const g = f as EnclosureFeature;
    const s = services.doc.state.get();
    if ((g.bodies ?? []).length > BODIES_MAX) return null;
    const shape = g.shape === 'box' ? 'box' : `cylinder_${g.axis.slice(-1)}`;
    const sides = Object.entries(g.sides ?? {})
      .filter(([k, v]) => typeof v === 'string' && v && (g.shape === 'box' ? BOX_SIDES : CYLINDER_SIDES).includes(k as EnclosureSide))
      .map(([side, value]) => ({ side, value: value as string }));
    return {
      edit: g.name,
      name: '',
      kind: 'enclosure',
      ...BLANK,
      bodies: (g.bodies ?? []).map((id) => bodyText(s, id)),
      shape,
      padding: g.padding,
      distance: g.padding === 'percent' ? g.percent : g.padding === 'fixed' ? g.distance : '',
      sides,
    };
  },
});
