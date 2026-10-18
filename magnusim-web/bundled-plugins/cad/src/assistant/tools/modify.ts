// modify: fillet or chamfer edges, or shell a body, in one step (CAD tools spec §3.2.11). edit ""
// makes one; edit "<name>" replaces that feature's inputs (its type must be the kind's). targets
// are selectors (help selectors) read on the bodies built now, or for an edit on the bodies just
// before the feature (a feature never picks what it made):
//   - fillet, chamfer: a face, and "edges of <face>" with no filter, is kept as a face, a live set
//     (every edge of it, as the part changes); an edge is kept as that edge, a fixed set. The
//     kernel takes each edge's tangent chain;
//   - shell: the faces to open (at least one); size is the wall, inward true keeps the outer size.
// Every target is on one body. The person's own panel opens read-only, filled, the Part rebuilds,
// and its Done keeps the feature. One the kernel cannot make (a radius larger than its wall)
// changes nothing and answers feature_failed with CAD's own words, which name the edges and the
// largest size that works.
// get_model full shows these features as this tool's input (registerFeatureIo), and edit_feature
// sets size (the radius, the distance or the wall) and size2 (a chamfer's second distance).
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../../types/app';
import type { CallCtx, EditData, ToolImpl, ToolReply } from '../../types/assistant';
import type { BodyId, ChamferFeature, Feature, FeatureId, FilletFeature, PersistentRef, ShellFeature } from '../../types/doc';
import type { EdgeChainOutput } from '../../types/doc-service';
import { ToolError } from '../errors';
import { andList, createdLabels, edgeText, editTarget, faceText, fillFeature, nameFor, partOf, pathIn, str, strings, type RefBodies } from '../feature-tools';
import { registerFeatureIo } from '../features-io';
import { bodyWords } from '../judge';
import { runtimeOf } from '../runtime';
import { edgeRefOf, faceRefOf } from '../selectors/refs';
import { echo, evaluate, parseFor, selectSet, withScene, type EdgeHit, type FaceHit, type Selected } from '../selectors/resolve';
import { runEdit, type EditCtx, type EditPlan, type EditTool } from '../step';

type Kind = 'fillet' | 'chamfer' | 'shell';
const KINDS: readonly Kind[] = ['fillet', 'chamfer', 'shell'];
/** The most targets one call takes (the schema's), and so the most get_model can write back. */
const TARGETS_MAX = 60;

const SIZE_WORDS: Record<Kind, string> = { fillet: 'the radius', chamfer: 'the distance', shell: 'the wall thickness' };

interface Plan extends EditPlan {
  kind: Kind;
  /** The feature an edit replaces, or null. */
  edit: FeatureId | null;
  /** The name asked for, or null (the next free one; an edit's own). */
  name: string | null;
  fields: Partial<Feature>;
  bodyName: string;
  /** What the feature keeps, in words: faces (a live set) or edges (a fixed set). */
  keptAs: string;
  warnings: string[];
}

/** What the targets resolved to: the one body, its faces and edges as references. */
interface Resolved {
  body: BodyId;
  bodyName: string;
  faces: PersistentRef[];
  edges: PersistentRef[];
  echoes: string[];
  warnings: string[];
}

/** Read every target on one scene: faces and edges (a fillet's or chamfer's), or faces (a shell's). */
async function resolveTargets(ctx: CallCtx, kind: Kind, targets: string[], editing: Feature | null): Promise<Resolved> {
  return withScene(ctx, { before: editing?.id ?? null, self: editing?.id ?? null }, async (sc) => {
    const faces: FaceHit[] = [];
    const edges: EdgeHit[] = [];
    const echoes: string[] = [];
    const warnings: string[] = [];
    for (const [i, text] of targets.entries()) {
      const field = `targets[${i}]`;
      let sel: Selected;
      if (kind === 'shell') sel = await selectSet(sc, text, 'face', field);
      else {
        sel = await evaluate(sc, parseFor(sc, text, 'any', field), 'any');
        const other = sel.hits.find((h) => h.kind !== 'face' && h.kind !== 'edge');
        if (other) {
          throw new ToolError('bad_selector', `${field}: "${text}" names ${other.kind === 'body' ? 'a body' : `a ${other.kind}`}: a ${kind} takes faces (every edge of each) or edges, such as "edges of Base.end" or "Base.end & Base.side(l1)".`, {
            detail: { field, selector: text },
          });
        }
        if (!sel.hits.length) throw new ToolError('nothing_selected', `${field}: "${text}" names no face or edge.`, { detail: { field, candidates: [] } });
      }
      if (sel.live) faces.push(...sel.live);
      else {
        for (const h of sel.hits) {
          if (h.kind === 'face') faces.push(h);
          else if (h.kind === 'edge') edges.push(h);
        }
      }
      echoes.push(echo(sc, sel));
      for (const w of sel.warnings) if (!warnings.includes(w)) warnings.push(w);
    }
    const on = new Map<BodyId, string>();
    for (const h of [...faces, ...edges]) on.set(h.body.id, h.body.name);
    if (on.size > 1) throw new ToolError('bad_selector', `targets are on ${andList([...on.values()])}: one body per call.`, { detail: { field: 'targets', bodies: [...on.values()] } });
    const body = [...faces, ...edges][0].body;
    const seen = new Set<string>();
    const once = (h: FaceHit | EdgeHit) => {
      const k = `${h.kind}:${h.index}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    };
    const faceRefs: PersistentRef[] = [];
    for (const h of faces) if (once(h)) faceRefs.push((await faceRefOf(sc, h)).ref);
    const edgeRefs: PersistentRef[] = [];
    for (const h of edges) if (once(h)) edgeRefs.push((await edgeRefOf(sc, h)).ref);
    return { body: body.id, bodyName: body.name, faces: faceRefs, edges: edgeRefs, echoes, warnings };
  });
}

const modify: EditTool<Plan> = {
  async plan(ctx) {
    const { services } = ctx;
    const s = services.doc.state.get();
    const kind = ctx.input.kind as Kind;
    if (!KINDS.includes(kind)) throw new ToolError('bad_input', 'kind: fillet, chamfer or shell.', { detail: { field: 'kind' } });
    const editing = editTarget(services, ctx.input.edit, [kind], kind, (f) => (KINDS.includes(f.type as Kind) ? `send kind ${f.type} to change it` : null));
    const name = nameFor(services, ctx.input.name, editing);
    const targets = strings(ctx.input.targets);
    const size = str(ctx.input.size);
    const size2 = str(ctx.input.size2);
    const problems: string[] = [];
    if (!targets.length) problems.push(`targets: at least one ${kind === 'shell' ? 'face to open' : 'face or edge'}`);
    if (targets.length > TARGETS_MAX) problems.push(`targets: at most ${TARGETS_MAX}`);
    targets.forEach((t, i) => {
      if (!t) problems.push(`targets[${i}]: a selector, not ""`);
    });
    if (!size) problems.push(`size: ${SIZE_WORDS[kind]} ("2 mm", "r")`);
    if (size2 && kind !== 'chamfer') problems.push('size2: only a chamfer has a second distance; send ""');
    if (problems.length) throw new ToolError('bad_input', `${problems.join('; ')}.`, { detail: { problems } });
    const r = await resolveTargets(ctx, kind, targets, editing);
    let fields: Partial<FilletFeature | ChamferFeature | ShellFeature>;
    if (kind === 'fillet') fields = { body: r.body, edges: r.edges, faces: r.faces, radius: size };
    else if (kind === 'chamfer') fields = { body: r.body, edges: r.edges, faces: r.faces, mode: size2 ? 'two' : 'distance', distance: size, distance2: size2 || size, flip: ctx.input.flip === true };
    else fields = { body: r.body, faces: r.faces, thickness: size, direction: ctx.input.inward === true ? 'inside' : 'outside' };
    // The dry run: the feature as its type checks it (a bad size is refused before anything changes).
    const def = services.doc.features.get(kind)!;
    const draft = { ...(editing ?? def.create(s.doc, {})), ...fields } as Feature;
    const why = def.incomplete(draft, services.doc.units);
    if (why) {
      const field = /^Distance 2/.test(why) ? 'size2' : 'size';
      throw new ToolError('expr_error', `${field}: ${why}.`, { detail: { field } });
    }
    const keptAs =
      kind === 'shell'
        ? `${r.faces.length} ${r.faces.length === 1 ? 'face' : 'faces'} to open`
        : [r.faces.length ? `${r.faces.length} ${r.faces.length === 1 ? 'face' : 'faces'} (every edge of each, a live set)` : '', r.edges.length ? `${r.edges.length} ${r.edges.length === 1 ? 'edge' : 'edges'} (a fixed set)` : ''].filter(Boolean).join(' and ');
    const label = services.doc.features.get(kind)?.label ?? kind;
    const resolved: Record<string, string> = { targets: r.echoes.join('; '), body: r.bodyName, kept: keptAs, size: size2 ? `${size}, ${size2}` : size };
    if (editing) resolved.edit = editing.name;
    return {
      part: partOf(services, kind, name ?? editing?.name ?? label, !!editing),
      value: false,
      own: editing?.id ?? null,
      feature: editing?.id ?? null,
      resolved,
      kind,
      edit: editing?.id ?? null,
      name,
      fields: fields as Partial<Feature>,
      bodyName: r.bodyName,
      keptAs,
      warnings: r.warnings,
    };
  },

  async apply(plan, ctx: EditCtx) {
    const { services } = ctx;
    const editName = plan.edit ? services.doc.state.get().doc.features.find((f) => f.id === plan.edit)?.name : null;
    const label = plan.name ?? editName ?? services.doc.features.get(plan.kind)?.label ?? plan.kind;
    const id = await fillFeature(ctx, plan, { edit: plan.edit, type: plan.kind, fields: plan.name ? { ...plan.fields, name: plan.name } : plan.fields, label });
    const made = services.doc.state.get().doc.features.find((f) => f.id === id);
    if (made) plan.part = partOf(services, plan.kind, made.name, !!plan.edit);
  },

  sealed(plan, ctx) {
    if (!plan.edit && plan.own) runtimeOf(ctx.services)?.madeBy.add(plan.own);
  },

  reply(plan, data: EditData, ctx): ToolReply {
    const s = ctx.services.doc.state.get();
    const id = plan.own!;
    const f = s.doc.features.find((g) => g.id === id);
    const created = createdLabels(ctx.services, id);
    const out = s.rebuild.outputs[id] as EdgeChainOutput | undefined;
    const body = bodyWords(data);
    const name = f?.name ?? plan.name ?? plan.kind;
    const text = `${name} ${data.feature?.state ?? 'ok'}${plan.edit ? ' (replaced)' : ''}: ${plan.keptAs} on ${plan.bodyName}${body ? ` · ${body}` : ''}`;
    return {
      text,
      summary: text,
      data: {
        ...data,
        created: created.labels,
        ...(created.more ? { created_more: created.more } : {}),
        warnings: [...plan.warnings, ...data.warnings].slice(0, 20),
        body: plan.bodyName,
        kept_as: plan.keptAs,
        ...(out?.type === 'edge-chain' ? { edges: { picked: out.picked, rounded: out.done } } : {}),
      },
    };
  },
};

export const tool: ToolImpl = {
  kind: 'edit',
  run: (ctx) => runEdit(ctx, modify),
};

// ------------------------------------------------------------------ get_model full and edit_feature

/** A fillet's, chamfer's or shell's targets as selectors (null when there are more than one call takes). */
function targetsOf(services: AppServices, f: FilletFeature | ChamferFeature | ShellFeature, at: RefBodies | null): string[] | null {
  const s = services.doc.state.get();
  const faces = f.faces.map((r) => (f.type === 'shell' ? faceText(s, f.body, r, at) : `edges of ${faceText(s, f.body, r, at)}`));
  const edges = f.type === 'shell' ? [] : f.edges.map((r) => edgeText(s, f.body, r, at));
  const all = [...faces, ...edges];
  return all.length && all.length <= TARGETS_MAX ? all : null;
}

registerFeatureIo('fillet', {
  tool: 'modify',
  refs: true,
  inputsOf(f, services, at = null) {
    const g = f as FilletFeature;
    const targets = targetsOf(services, g, at);
    return targets ? { edit: g.name, name: '', kind: 'fillet', targets, size: g.radius, size2: '', flip: false, inward: false } : null;
  },
  values: (f) => [{ field: 'size', expr: (f as FilletFeature).radius }],
  pathOf: (f, field, services) => pathIn(services, f, field, { size: 'radius' }),
});

registerFeatureIo('chamfer', {
  tool: 'modify',
  refs: true,
  inputsOf(f, services, at = null) {
    const g = f as ChamferFeature;
    const targets = targetsOf(services, g, at);
    return targets ? { edit: g.name, name: '', kind: 'chamfer', targets, size: g.distance, size2: g.mode === 'two' ? g.distance2 : '', flip: g.mode === 'two' && !!g.flip, inward: false } : null;
  },
  values(f) {
    const g = f as ChamferFeature;
    return [{ field: 'size', expr: g.distance }, ...(g.mode === 'two' ? [{ field: 'size2', expr: g.distance2 }] : [])];
  },
  pathOf: (f, field, services) => pathIn(services, f, field, (f as ChamferFeature).mode === 'two' ? { size: 'distance', size2: 'distance2' } : { size: 'distance' }),
});

registerFeatureIo('shell', {
  tool: 'modify',
  refs: true,
  inputsOf(f, services, at = null) {
    const g = f as ShellFeature;
    const targets = targetsOf(services, g, at);
    return targets ? { edit: g.name, name: '', kind: 'shell', targets, size: g.thickness, size2: '', flip: false, inward: g.direction !== 'outside' } : null;
  },
  values: (f) => [{ field: 'size', expr: (f as ShellFeature).thickness }],
  pathOf: (f, field, services) => pathIn(services, f, field, { size: 'thickness' }),
});
