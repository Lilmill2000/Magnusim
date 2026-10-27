// workspace: what the person controls around the model, through the person's own paths (Daniel's
// rule: whatever a person can do, use or see in the CAD program, the Assistant can too). One
// action per call (schemas.ts WORKSPACE_ACTIONS); target, value and items are "" or [] when unused.
//   The tree and the document's view state (saved, not undoable, so no Assistant step):
//     roll_back_to, roll_to_end      the rollback bar (uiFor.rollBackTo / rollToEnd). A bar this key
//                                    rolled back makes its own edits answer rolled_back at once
//                                    (own-rollback.ts), never a ten-minute wait.
//     show, hide                     the eye of a sketch, a construction feature or a body.
//     origin_planes                  Auto or Always.
//     select, selection_filter       the shared selection and the filter chips.
//     expand, collapse               the Origin and Bodies folders, the tree card, the Sketch panel
//                                    and its Details.
//     toolbar_show/_hide/_move/_reset  the person's toolbar layout (toolbar-layout.ts).
//     banana_show/_hide/_place       the banana for scale (scale module), and a sketch's taped one.
//   The Part and the session:
//     rename_part                    the study's title, as the tree's Rename part.
//     reload, keep_mine              a save conflict's choices; the person confirms in the app's own
//                                    dialog whenever a change would be lost.
//     retry_save, retry_kernel       the save chip's and the kernel chip's Retry.
//     import_step                    the file picker is the person's: they are asked (a toast).
//     reheal                         an import healed again (tolerance, knit): an Assistant step on
//                                    the Import panel's own Heal all (runEdit, one undo step).
//     export_step                    the person's Export STEP panel opened filled in (format, name,
//                                    bodies); the person clicks Export (the download is theirs).
//     send_to_simulation             save, then link, as the app's Back runs it (services.apis.link);
//                                    value "leave": then Back itself, after this call has answered.
//   The person's view (fit, standard_view, normal_to, orbit_pivot, section, projection, display):
//     only with person_asked (the person asked in this request), else only while the camera latch
//     says they have not moved the view in this request (camera.ts); never while a pointer is held
//     in the frame. The moves pass `auto`, so they do not latch the request themselves.
// Every result says what changed and whether it is an undo step.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import { modeFor } from '../../sketch/mode';
import { constructShown } from '../../features/refgeom/scene';
import { stepFileName } from '../../features/export/panel';
import { setExportPrefill } from '../../features/export/prefill';
import { importRunsFor } from '../../features/import/runs';
import { BANANA_COMMAND } from '../../features/scale';
import { placeTaped, sketchPoints } from '../../features/scale/sketch-banana';
import { sketchShown } from '../../features/sketch/view';
import { normalTarget } from '../../viewport/normal';
import { railsFor } from '../../ui/left-rails';
import { KEEP_IN_VIEW } from '../../ui/Toolbar';
import { barIdOf, collapseFlyouts } from '../../ui/flyouts';
import { layoutModeOf, orderIds, toolbarPrefs, withMove, withPlace, type LayoutMode } from '../../ui/toolbar-layout';
import { uiFor } from '../../ui/controller';
import { WELL_KNOWN_COMMANDS } from '../../types/modules';
import type { AppServices } from '../../types/app';
import type { CallCtx, EditData, ToolImpl, ToolReply } from '../../types/assistant';
import { type BodyId, type Feature, type FeatureId, type ImportFeature, type OriginPlaneRef, type OriginRef, type Vec2, type Vec3 } from '../../types/doc';
import type { SelectionItem, SelectKind } from '../../types/selection';
import type { DisplayMode, Projection, StandardView, ViewportHandle } from '../../types/viewport';
import { heartbeat, waitForRead } from '../busy';
import { ToolError } from '../errors';
import { noteOwnRollback } from '../own-rollback';
import { runtimeOf } from '../runtime';
import { WORKSPACE_ACTIONS, type WorkspaceAction } from '../schemas';
import { centreOf, hitWords, selectAny, withScene, type Hit } from '../selectors/resolve';
import { runEdit, type EditCtx, type EditPlan, type EditTool } from '../step';
import { parseSection, sectionAtMiddle, sectionData } from '../view';

interface Input {
  action: WorkspaceAction;
  target: string;
  value: string;
  items: string[];
  asked: boolean;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const bad = (field: string, message: string, detail: Record<string, unknown> = {}) => new ToolError('bad_input', message, { detail: { field, ...detail } });

function readInput(input: Record<string, unknown>): Input {
  const action = input.action as WorkspaceAction;
  if (!(WORKSPACE_ACTIONS as readonly string[]).includes(String(action))) throw bad('action', `action must be one of ${WORKSPACE_ACTIONS.join(', ')}.`);
  const raw = input.items ?? [];
  if (!Array.isArray(raw) || raw.length > 40 || raw.some((x) => typeof x !== 'string')) throw bad('items', 'items must list at most 40 strings.');
  return { action, target: str(input.target), value: str(input.value), items: (raw as string[]).map((x) => x.trim()).filter(Boolean), asked: input.person_asked === true };
}

/** A pure-UI reply: one line, the data, and that it is no undo step. */
function done(text: string, data: Record<string, unknown> = {}): ToolReply {
  return { text, data: { ...data, undo_step: false }, summary: text };
}

const features = (services: AppServices) => services.doc.state.get().doc.features;

/** The feature a name names (any case), or not_found with the names. */
function featureNamed(services: AppServices, name: string, field = 'target'): Feature {
  if (!name) throw bad(field, `${field}: a feature name.`);
  const list = features(services);
  const f = list.find((x) => x.name === name) ?? list.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!f) throw new ToolError('not_found', `No feature is called "${name}". Features: ${list.map((x) => x.name).slice(0, 30).join(', ') || 'none yet'}.`, { detail: { field, names: list.map((x) => x.name).slice(0, 30) } });
  return f;
}

function bodyNamed(services: AppServices, name: string): { id: BodyId; name: string } | null {
  const bodies = services.doc.state.get().rebuild.bodies;
  const b = bodies.find((x) => x.name === name) ?? bodies.find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? bodies.find((x) => x.id === name);
  return b ? { id: b.id, name: b.name } : null;
}

/** What the person has open that a panel or the bar would close or commit: busy person_editing, at once. */
function personOpen(services: AppServices, what: string): void {
  const ui = uiFor(services).state.get();
  const p = ui.panel;
  const open = services.doc.session();
  const words = p && p.owner === 'person' ? (p.kind === 'tool' ? `the ${services.modules?.tool(p.tool)?.label ?? 'tool'} panel is open` : p.kind === 'params' ? 'the Parameters panel is open' : 'a feature panel is open') : open?.open && !open.owner ? 'a feature is being edited' : ui.renaming ? 'a row is being renamed' : ui.menu ? 'a menu is open' : null;
  if (words) throw new ToolError('person_editing', `${what} waits for the person: ${words}. Ask them to close it, then call again.`, { detail: { person: words } });
}

/** "x, y, z" (or more) numbers in mm, through the Part's units ("10 mm", "w/2"). */
function numbers(services: AppServices, text: string, min: number, max: number, field: string, kinds: ('length' | 'angle')[]): number[] {
  const parts = text.replace(/^\(|\)$/g, '').split(',').map((x) => x.trim()).filter((x) => x.length);
  if (parts.length < min || parts.length > max) throw bad(field, `${field}: ${min === max ? min : `${min} to ${max}`} numbers separated by commas, not "${text}".`);
  return parts.map((p, i) => {
    const kind = kinds[Math.min(i, kinds.length - 1)];
    const bare = /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(p);
    const r = services.doc.units.evaluate(bare ? `${p} ${kind === 'angle' ? 'deg' : 'mm'}` : p, kind);
    if (!r.ok) throw new ToolError('expr_error', `${field}: "${p}" is not a ${kind}: ${r.error}`, { detail: { field } });
    return r.value;
  });
}

// ------------------------------------------------------------------ the tree and view state

async function rollBack(ctx: CallCtx, i: Input): Promise<ToolReply> {
  const { services } = ctx;
  personOpen(services, 'The rollback bar');
  const ui = uiFor(services);
  if (i.action === 'roll_to_end') {
    ui.rollToEnd();
    noteOwnRollback(services, ctx.key, null);
  } else {
    const f = featureNamed(services, i.target);
    ui.rollBackTo(f.id);
    noteOwnRollback(services, ctx.key, services.doc.state.get().view.rollback);
  }
  await heartbeat(ctx, services.doc.settled(ctx.signal), 'Waiting for the rebuild');
  const s = services.doc.state.get();
  const n = s.doc.features.length;
  const r = s.view.rollback;
  if (r === null || r >= n) return done('The rollback bar is at the end: every feature builds', { rollback: { at_end: true }, bodies: s.rebuild.bodies.map((b) => b.name) });
  const after = r > 0 ? s.doc.features[r - 1].name : null;
  const rolled = s.doc.features.slice(r).map((f) => f.name);
  return done(`Rolled back ${after ? `after ${after}` : 'to the top'}: ${rolled.length} feature${rolled.length === 1 ? '' : 's'} rolled back; your edits answer rolled_back until roll_to_end`, {
    rollback: { after, rolled_back: rolled.slice(0, 40) },
    bodies: s.rebuild.bodies.map((b) => b.name),
  });
}

function eye(ctx: CallCtx, i: Input): ToolReply {
  const { services } = ctx;
  const { doc } = services;
  const show = i.action === 'show';
  if (!i.target) throw bad('target', 'target: a sketch, a construction feature or a body.');
  const list = features(services);
  const f = list.find((x) => x.name.toLowerCase() === i.target.toLowerCase()) ?? null;
  if (!f) {
    const b = bodyNamed(services, i.target);
    if (!b) throw new ToolError('not_found', `Nothing with an eye is called "${i.target}": name a sketch, a construction feature or a body.`, { detail: { field: 'target' } });
    const hidden = doc.state.get().view.hiddenBodies.includes(b.id);
    if (hidden !== show) return done(`${b.name} is already ${show ? 'shown' : 'hidden'}`, { body: b.name, shown: show });
    uiFor(services).setBodyVisible(b.id, show);
    return done(`${show ? 'Showed' : 'Hid'} ${b.name} in the view`, { body: b.name, shown: show });
  }
  const s = doc.state.get();
  if (f.type === 'sketch') {
    const shownNow = sketchShown(s.doc, s.view, doc.features, f.id);
    if (shownNow === show) return done(`${f.name} is already ${show ? 'shown' : 'hidden'}`, { feature: f.name, shown: show });
    // As the tree's eye: a choice that matches the default is forgotten.
    const byDefault = sketchShown({ features: s.doc.features }, { sketches: {} }, doc.features, f.id);
    doc.setSketchVisibility(f.id, show === byDefault ? null : show ? 'shown' : 'hidden');
    return done(`${show ? 'Showed' : 'Hid'} ${f.name} in the view`, { feature: f.name, shown: show });
  }
  if (f.type === 'ref_plane' || f.type === 'ref_axis' || f.type === 'ref_point') {
    if (constructShown(s.view, f.id) === show) return done(`${f.name} is already ${show ? 'shown' : 'hidden'}`, { feature: f.name, shown: show });
    doc.setSketchVisibility(f.id, show ? null : 'hidden');
    return done(`${show ? 'Showed' : 'Hid'} ${f.name} in the view`, { feature: f.name, shown: show });
  }
  throw bad('target', `${f.name} has no eye: only sketches, construction planes, axes and points, and bodies (the bodies it makes: name them).`);
}

function planes(ctx: CallCtx, i: Input): ToolReply {
  const mode = i.value.toLowerCase();
  if (mode !== 'auto' && mode !== 'always') throw bad('value', 'value: auto (drawn on an empty part and while selected or hovered) or always.');
  const h = ctx.services.viewport.get().handle;
  if (h) h.setPlanes(mode);
  ctx.services.doc.setPlanes(mode);
  return done(`Origin planes: ${mode === 'always' ? 'always drawn' : 'Auto (drawn on an empty part and while one is selected or hovered)'}`, { planes: mode });
}

const KINDS: readonly SelectKind[] = ['face', 'edge', 'vertex', 'body', 'feature', 'origin', 'sketch', 'region'];
const ORIGIN_WORDS: Readonly<Record<string, OriginRef>> = {
  top: 'origin:top',
  'top plane': 'origin:top',
  front: 'origin:front',
  'front plane': 'origin:front',
  right: 'origin:right',
  'right plane': 'origin:right',
  'x axis': 'origin:x',
  'y axis': 'origin:y',
  'z axis': 'origin:z',
  origin: 'origin:point',
};

/** A selector's hits as selection items (what the person's click would pick). */
export function itemsOfHit(h: Hit): SelectionItem[] {
  switch (h.kind) {
    case 'face':
    case 'edge':
    case 'vertex':
      return [{ kind: h.kind, body: h.body.id, index: h.index }];
    case 'body':
      return [{ kind: 'body', body: h.body.id }];
    case 'region':
      return [{ kind: 'region', feature: h.sketch.id, key: h.region.key }];
    case 'plane':
      if (h.offset || h.flip) return [];
      if (h.source.s === 'origin') return [{ kind: 'origin', ref: h.source.plane }];
      if (h.source.s === 'feature') return [{ kind: 'feature', feature: h.source.feature.id }];
      return [{ kind: 'face', body: h.source.face.body.id, index: h.source.face.index }];
    case 'axis':
      if (h.source.s === 'origin') return [{ kind: 'origin', ref: h.source.axis }];
      if (h.source.s === 'feature') return [{ kind: 'feature', feature: h.source.feature.id }];
      if (h.source.s === 'edge') return [{ kind: 'edge', body: h.source.edge.body.id, index: h.source.edge.index }];
      if (h.source.s === 'face-axis') return [{ kind: 'face', body: h.source.face.body.id, index: h.source.face.index }];
      return [];
  }
}

/** One entry of `select` as items, and its words: a feature name, an origin plane or axis, else a selector. */
async function resolveItem(ctx: CallCtx, text: string, field: string): Promise<{ items: SelectionItem[]; words: string[] }> {
  const { services } = ctx;
  const f = features(services).find((x) => x.name.toLowerCase() === text.toLowerCase());
  if (f) return { items: [{ kind: 'feature', feature: f.id }], words: [f.name] };
  const o = ORIGIN_WORDS[text.toLowerCase()];
  if (o) return { items: [{ kind: 'origin', ref: o }], words: [text] };
  return withScene(ctx, {}, async (sc) => {
    const r = await selectAny(sc, text, field);
    if (!r.hits.length) throw new ToolError('nothing_selected', `${field}: "${text}" matches nothing.`, { detail: { field } });
    const items = r.hits.flatMap(itemsOfHit);
    if (!items.length) throw bad(field, `${field}: "${text}" is not something a click selects (an offset plane or a computed axis).`);
    return { items, words: r.hits.slice(0, 8).map((h) => hitWords(sc, h)) };
  });
}

async function select(ctx: CallCtx, i: Input): Promise<ToolReply> {
  const { services } = ctx;
  if (i.action === 'selection_filter') {
    const kinds = i.items.map((k) => k.toLowerCase());
    const wrong = kinds.filter((k) => !(KINDS as readonly string[]).includes(k));
    if (wrong.length) throw bad('items', `items: kinds of ${KINDS.join(', ')}; not ${wrong.join(', ')}.`);
    const filter = [...new Set(kinds)] as SelectKind[];
    services.selection.set((s) => ({ ...s, filter }));
    return done(filter.length ? `Selection filter: ${filter.join(', ')}` : 'Selection filter: everything', { filter });
  }
  await heartbeat(ctx, services.doc.settled(ctx.signal), 'Waiting for the rebuild');
  const items: SelectionItem[] = [];
  const words: string[] = [];
  for (const [k, text] of i.items.entries()) {
    const r = await resolveItem(ctx, text, `items[${k}]`);
    items.push(...r.items);
    words.push(...r.words);
  }
  const seen = new Set<string>();
  const unique = items.filter((it) => {
    const key = JSON.stringify(it);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  services.selection.set((s) => ({ ...s, items: unique }));
  if (!unique.length) return done('Cleared the selection', { selected: 0 });
  return done(`Selected ${unique.length} thing${unique.length === 1 ? '' : 's'}: ${words.slice(0, 6).join(', ')}${words.length > 6 ? ', ...' : ''}`, { selected: unique.length, words: words.slice(0, 20) });
}

function fold(ctx: CallCtx, i: Input): ToolReply {
  const { services } = ctx;
  const open = i.action === 'expand';
  const t = i.target.toLowerCase();
  const rails = railsFor(services);
  const sketching = services.mode.get().mode === 'sketch';
  switch (t) {
    case 'origin':
    case 'bodies':
      services.doc.setExpanded(t, open);
      return done(`${t === 'origin' ? 'Origin' : 'Bodies'} folder ${open ? 'expanded' : 'collapsed'}`, { target: t, expanded: open });
    case 'tree':
      rails.setTreeShown(open, sketching);
      return done(`Design tree ${open ? 'shown' : 'collapsed to its rail'}${sketching ? ' for this sketch' : ''}`, { target: t, expanded: open });
    case 'sketch_panel':
      rails.setSketchCollapsed(!open);
      return done(`Sketch panel ${open ? 'expanded' : 'collapsed to its rail'}`, { target: t, expanded: open });
    case 'sketch_details':
      rails.setSketchDetails(open);
      return done(`Sketch panel Details ${open ? 'open' : 'closed'}`, { target: t, expanded: open });
    default:
      throw bad('target', 'target: origin, bodies, tree, sketch_panel or sketch_details.');
  }
}

function toolbar(ctx: CallCtx, i: Input): ToolReply {
  const { services } = ctx;
  const prefs = toolbarPrefs(services);
  const keep = new Set(KEEP_IN_VIEW);
  if (i.action === 'toolbar_reset') {
    const v = i.value.toLowerCase();
    if (v && v !== 'model' && v !== 'sketch') throw bad('value', 'value: model, sketch, or "" for both.');
    const modes: LayoutMode[] = v ? [v as LayoutMode] : ['model', 'sketch'];
    for (const m of modes) prefs.reset(m);
    return done(`Toolbar back to its default layout (${modes.join(' and ')})`, { reset: modes });
  }
  // A flyout's variant (sketch.centerline) moves with its flyout, as the person's bar button does.
  const asked = services.commands.get(i.target);
  const def = asked?.flyout ? (services.commands.get(barIdOf(services.commands.all(), asked.id)) ?? asked) : asked;
  if (!def || !def.group) {
    const ids = services.commands.all().filter((c) => c.group).map((c) => c.id);
    throw new ToolError('not_found', `"${i.target}" is not a toolbar command. Commands: ${ids.slice(0, 40).join(', ')}.`, { detail: { field: 'target' } });
  }
  const mode: LayoutMode = def.mode === 'sketch' ? 'sketch' : def.mode === 'any' ? layoutModeOf(services.mode.get().mode) : 'model';
  const m = prefs.state.get().layout[mode];
  if (i.action === 'toolbar_show' || i.action === 'toolbar_hide') {
    const place = i.action === 'toolbar_show' ? 'bar' : 'more';
    prefs.setMode(mode, withPlace(m, def.id, place, mode, keep));
    return done(`${def.label} ${place === 'bar' ? 'is on the toolbar' : "is in its group's More menu"} (${mode} mode)`, { command: def.id, place, mode });
  }
  const group = services.commands.toolbar(mode).find((g) => g.group === def.group);
  const registry = group ? collapseFlyouts(group.commands).commands.map((c) => c.id) : [def.id];
  const order = orderIds(registry, m.order[def.group]);
  const v = i.value.trim();
  let before: string | null = null;
  if (v.toLowerCase() !== 'end') {
    const mm = /^before\s+(\S+)$/i.exec(v);
    if (!mm) throw bad('value', 'value: "before <command id>" (of the same group) or end.');
    before = barIdOf(services.commands.all(), mm[1]);
    if (!order.includes(before) || before === def.id) throw bad('value', `${before} is not another command of ${def.label}'s group: ${order.join(', ')}.`);
  }
  prefs.setMode(mode, withMove(m, def.group, order, def.id, before));
  const now = orderIds(registry, prefs.state.get().layout[mode].order[def.group]);
  return done(`Moved ${def.label} ${before ? `before ${services.commands.get(before)?.label ?? before}` : 'to the end of its group'}`, { command: def.id, group: def.group, order: now });
}

async function banana(ctx: CallCtx, i: Input): Promise<ToolReply> {
  const { services } = ctx;
  const { doc } = services;
  if (i.target) {
    // A sketch's taped banana (shown while that sketch is edited).
    const f = featureNamed(services, i.target);
    if (f.type !== 'sketch') throw bad('target', `${f.name} is not a sketch: a taped banana goes in a sketch ("" for the model's banana).`);
    if (i.action === 'banana_hide') {
      doc.setSketchBanana(f.id, null);
      return done(`No banana in ${f.name}`, { sketch: f.name, banana: null });
    }
    let at: Vec2;
    if (i.action === 'banana_place') {
      const n = numbers(services, i.value, 2, 2, 'value', ['length']);
      at = [n[0], n[1]];
    } else {
      const edited = modeFor(services)?.feature === f.id;
      at = placeTaped(edited ? sketchPoints(services) : Object.values(f.points));
    }
    doc.setSketchBanana(f.id, at);
    return done(`The taped banana is in ${f.name} at u ${round(at[0])}, v ${round(at[1])} mm (shown while ${f.name} is edited)`, { sketch: f.name, banana: { u: round(at[0]), v: round(at[1]) } });
  }
  const shown = () => doc.state.get().view.scaleModels?.banana ?? null;
  if (i.action === 'banana_hide') {
    if (!shown()) return done('The banana is not shown', { banana: null });
    doc.setScaleModel('banana', null);
    return done('Took the banana away', { banana: null });
  }
  if (i.action === 'banana_place') {
    const n = numbers(services, i.value, 3, 4, 'value', ['length', 'length', 'length', 'angle']);
    doc.setScaleModel('banana', { at: [n[0], n[1], n[2]], rot: n[3] ?? shown()?.rot ?? 0 });
  } else if (!shown()) {
    const r = await services.commands.run(BANANA_COMMAND);
    if (r !== true) throw new ToolError('not_editable', `The banana cannot be shown now: ${r}.`);
    if (!shown()) throw new ToolError('internal', 'The banana could not be shown (its model did not load).');
  } else return done('The banana is already shown', { banana: placeWords(shown()!) });
  return done(`The banana for scale is at ${placeWords(shown()!).at} (not part of the model or the simulation)`, { banana: placeWords(shown()!) });
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const placeWords = (p: { at: Vec3; rot: number }) => ({ at: `(${p.at.map(round).join(', ')}) mm`, rot_deg: round(p.rot) });

// ------------------------------------------------------------------ the Part and the session

async function renamePart(ctx: CallCtx, i: Input): Promise<ToolReply> {
  const { services } = ctx;
  const title = i.value;
  if (!title) throw bad('value', 'value: the new name of the Part.');
  if (title.length > 120) throw bad('value', 'A Part name can have at most 120 characters.');
  const block = uiFor(services).editBlock();
  if (block) throw new ToolError('not_editable', `The Part cannot be renamed now: ${block}.`);
  const was = String(services.bridge.context.study?.title ?? '');
  if (title === was) return done(`The Part is already called ${title}`, { name: title });
  try {
    const rec = await services.bridge.study.get();
    await services.bridge.study.update({ title }, rec.rev);
  } catch (err) {
    throw new ToolError('not_editable', `The app refused the name: ${err instanceof Error ? err.message : String(err)}.`);
  }
  return done(`Renamed the Part ${title} (was ${was || 'unnamed'})`, { name: title, was });
}

async function session(ctx: CallCtx, i: Input): Promise<ToolReply> {
  const { services } = ctx;
  const { doc, bridge } = services;
  const save = doc.state.get().save;
  const title = String(bridge.context.study?.title ?? '').trim() || 'this Part';
  switch (i.action) {
    case 'retry_save':
      if (save.state !== 'error') return done(`Nothing to retry: the save is ${save.state}`, { save: save.state });
      doc.retrySave();
      return done('Tried the save again now (it also retries by itself)', { save: doc.state.get().save.state });
    case 'retry_kernel': {
      const k = services.kernel.status.get();
      if (k.state !== 'failed') return done(`Nothing to retry: the kernel is ${k.state}`, { kernel: k.state });
      try {
        await heartbeat(ctx, services.kernel.restart('Retry'), 'Starting the kernel again');
      } catch (err) {
        throw new ToolError('kernel_failed', `The kernel did not start: ${err instanceof Error ? err.message : String(err)}.`);
      }
      return done('The geometry kernel started again', { kernel: services.kernel.status.get().state });
    }
    case 'reload': {
      if (save.state !== 'conflict' && save.state !== 'updated') return done(`Nothing to reload: no other tab saved over this one (save ${save.state})`, { save: save.state });
      if (save.state === 'conflict') {
        const ok = await bridge
          .confirm({ title: 'Reload and lose this tab\'s change?', message: `The Assistant asks to reload ${title}: the other tab's save comes in and this tab's change since its last save is lost.`, confirmLabel: 'Reload' })
          .catch(() => false);
        if (!ok) return done('The person kept this tab as it is: nothing was reloaded', { reloaded: false });
      }
      await doc.reload();
      return done(`Reloaded ${title} from the newest save`, { reloaded: true, save: doc.state.get().save.state });
    }
    case 'keep_mine': {
      if (save.state !== 'conflict') return done(`Nothing to keep: there is no save conflict (save ${save.state})`, { save: save.state });
      const ok = await bridge
        .confirm({
          title: "Replace the other tab's save?",
          message: `Another tab saved ${title} after this tab's last save. Keep mine stores this tab's version over it: what the other tab changed since then is lost. The other tab is told to reload the next time it saves.`,
          confirmLabel: 'Keep mine',
        })
        .catch(() => false);
      if (!ok) return done('The person did not confirm Keep mine: nothing was written', { kept: false });
      await doc.keepMine();
      return done(`Kept this tab's version of ${title}`, { kept: true, save: doc.state.get().save.state });
    }
    default:
      throw bad('action', 'not a session action');
  }
}

function importStep(ctx: CallCtx): ToolReply {
  const { services } = ctx;
  if (!services.bridge.files) throw new ToolError('not_editable', 'Importing needs Magnusim 1.2 file storage.');
  services.bridge.toast('The Assistant asks you to pick a STEP file: click Import STEP (FILE), or drop the file on the Part.', 'info');
  return done("Asked the person to pick the STEP file (Import STEP in FILE, or a drop on the Part): the file picker is theirs. Call get_model once they have imported it", { asked_person: true });
}

interface HealPlan extends EditPlan {
  id: FeatureId;
  name: string;
  tolerance: number;
  knit: boolean;
}

/** An import healed again, on its own panel's Heal all, as one Assistant step. */
const healTool: EditTool<HealPlan> = {
  async plan(ctx) {
    const i = readInput(ctx.input);
    const f = featureNamed(ctx.services, i.target);
    if (f.type !== 'import') throw new ToolError('wrong_feature_type', `${f.name} is not an Imported STEP.`, { detail: { field: 'target' } });
    const r = ctx.services.doc.units.evaluate(i.value || `${(f as ImportFeature).heal?.tolerance ?? 0.001} mm`, 'length');
    if (!r.ok) throw new ToolError('expr_error', `value: "${i.value}" is not a length: ${r.error}`, { detail: { field: 'value' } });
    if (!(r.value > 0 && r.value <= 10)) throw bad('value', 'The heal tolerance is more than 0 and at most 10 mm.');
    const knit = i.items.some((x) => x.toLowerCase() === 'knit');
    return { part: `Heal ${f.name}`, value: false, own: f.id, feature: f.id, id: f.id, name: f.name, tolerance: r.value, knit, resolved: { import: f.name } };
  },
  async apply(plan, ctx: EditCtx) {
    const { services } = ctx;
    const ui = uiFor(services);
    const s = ui.openEditForAssistant(ctx.step, plan.id);
    if (typeof s === 'string') throw new ToolError('bad_input', `${plan.name} cannot be opened here: ${s}.`);
    await ctx.checkpoint({ hold: 'after-open', pace: 'open', label: `Heal ${plan.name}` });
    const runs = importRunsFor(services);
    await heartbeat(ctx, runs.healAll(s, plan.tolerance, plan.knit), `Healing ${plan.name}`);
    ctx.wrote(s);
    const err = runs.state.get().runs[plan.id]?.error ?? null;
    if (err) throw new ToolError('feature_failed', err, { detail: { feature: plan.name } });
    await heartbeat(ctx, services.doc.settled(ctx.signal), `Heal ${plan.name}`);
    await ctx.checkpoint({ pace: 'commit', hold: 'before-commit', label: `Heal ${plan.name}` });
    const why = ui.doneForAssistant(ctx.step);
    if (why) throw new ToolError('incomplete', `${plan.name}: ${why}.`);
  },
  reply(plan, data: EditData, ctx): ToolReply {
    const f = features(ctx.services).find((x) => x.id === plan.id) as ImportFeature | undefined;
    const text = `Healed ${plan.name} again at ${plan.tolerance} mm${plan.knit ? ', knit' : ''}: ${data.feature?.state ?? 'ok'}`;
    return { text, data: { ...data, heal: f?.heal ?? null, diagnostics: f?.diagnostics ?? null }, summary: text };
  },
};

function exportStep(ctx: CallCtx, i: Input): ToolReply {
  const { services } = ctx;
  personOpen(services, 'Export STEP');
  const ok = services.commands.canRun(WELL_KNOWN_COMMANDS.exportStep);
  if (ok !== true) throw new ToolError('not_editable', `Export STEP cannot open now: ${ok}.`);
  const schema = (i.target || 'AP214').toUpperCase();
  if (schema !== 'AP214' && schema !== 'AP242') throw bad('target', 'target: AP214, AP242 or "" (AP214).');
  const built = services.doc.state.get().rebuild.bodies;
  let bodies: { id: BodyId; name: string }[];
  if (i.items.length) {
    bodies = i.items.map((n, k) => {
      const b = bodyNamed(services, n);
      if (!b) throw new ToolError('not_found', `items[${k}]: no body is called "${n}". Bodies: ${built.map((x) => x.name).join(', ')}.`, { detail: { field: `items[${k}]` } });
      return b;
    });
  } else bodies = built.filter((b) => b.visible).map((b) => ({ id: b.id, name: b.name }));
  const title = String(services.bridge.context.study?.title ?? 'Part');
  const file = stepFileName(i.value, title);
  setExportPrefill(services, { schema, name: file, bodies: bodies.map((b) => b.id) });
  uiFor(services).openTool(WELL_KNOWN_COMMANDS.exportStep);
  return done(`Opened Export STEP filled in: ${file}, ${schema}, ${bodies.map((b) => b.name).join(', ') || 'no bodies'}; the person clicks Export to download it`, {
    panel: 'Export STEP',
    file,
    schema,
    bodies: bodies.map((b) => b.name),
    person_clicks: 'Export',
  });
}

/** How long after its answer a send with value "leave" runs the app's Back (the answer goes out first). */
export const LEAVE_AFTER_MS = 1500;

async function sendToSimulation(ctx: CallCtx, i: Input): Promise<ToolReply> {
  const { services } = ctx;
  const leave = i.value.toLowerCase();
  if (leave && leave !== 'leave' && leave !== 'stay') throw bad('value', 'value: "" or stay (the Part stays open), or leave (then close it, as Back).');
  const link = services.apis.get().link ?? null;
  if (!link) throw new ToolError('no_link', 'This Magnusim cannot link the Part into the project (it needs host API 1.5).');
  personOpen(services, 'Sending to the simulation');
  const o = await heartbeat(
    ctx,
    link.sync({ signal: ctx.signal, notify: false, onProgress: (p) => ctx.progress(p.fraction, p.label, p.saving ? { waiting: true } : undefined) }),
    'Sending the Part to the project',
  );
  const leaving = leave === 'leave' && (o.outcome === 'linked' || o.outcome === 'unchanged' || o.outcome === 'nothing' || o.outcome === 'superseded' || o.outcome === 'not-now');
  const after = leaving ? '; the Part closes now, as the person\'s Back: no more Part tools after this answer' : '';
  if (leaving) setTimeout(() => void services.bridge.back().catch(() => false), LEAVE_AFTER_MS);
  switch (o.outcome) {
    case 'linked': {
      const r = o.result as { geometryId?: string; created?: boolean };
      return done(`Sent the Part to the project: its geometry is updated (version ${o.sourceVersion})${o.notes?.length ? `; ${o.notes.join(' ')}` : ''}${after}`, { outcome: 'linked', source_version: o.sourceVersion, geometry: r.geometryId ?? null, created: !!r.created, notes: o.notes ?? [], leaving });
    }
    case 'unchanged':
      return done(`The project's geometry already has this design (version ${o.sourceVersion}): nothing was sent${after}`, { outcome: 'unchanged', source_version: o.sourceVersion, leaving });
    case 'nothing':
      return done(`${o.message}${after}`, { outcome: 'nothing', message: o.message, leaving });
    case 'kept-editing':
      return done('The person answered the app\'s question with Keep editing: nothing was sent, the Part stays open', { outcome: 'kept-editing', leaving: false });
    case 'not-now':
      return done(`The person answered "Not now" to adding the Part as a new geometry${o.geometryName ? ` (${o.geometryName} was removed)` : ''}: nothing was linked${after}`, { outcome: 'not-now', leaving });
    case 'superseded':
      return done(`A newer send of this Part replaced this one${after}`, { outcome: 'superseded', leaving });
    case 'unavailable':
      throw new ToolError('no_link', o.message);
    case 'failed':
      throw new ToolError('link_failed', o.message, { detail: { code: o.code } });
  }
}

// ------------------------------------------------------------------ the person's view

/** The person's view, when it may move now: person_asked, or the latch says they have not moved it. */
function personView(ctx: CallCtx, i: Input): ViewportHandle {
  const { services } = ctx;
  const h = services.viewport.get().handle;
  if (!h) throw new ToolError('no_viewport', 'The view is not shown now.');
  const rt = runtimeOf(services);
  if (rt?.soft.held()) throw new ToolError('person_editing', 'The person is moving the view (a pointer is held in it): call again once they let go.', { detail: { person: 'moving the view' } });
  if (!i.asked && rt?.camera.latched(ctx.key)) {
    throw new ToolError('view_latched', 'The person moved their view in this request: it stays where they put it. Call again with person_asked true only if they asked for this.', { detail: { person: 'moved the view' } });
  }
  return h;
}

const STANDARD: readonly StandardView[] = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso', 'iso_back', 'home'];
const DISPLAY: Readonly<Record<string, DisplayMode>> = { shaded_edges: 'shaded-edges', 'shaded-edges': 'shaded-edges', shaded: 'shaded', wireframe: 'wireframe' };
const SECTION_PLANE: Readonly<Record<string, OriginPlaneRef>> = { top: 'origin:top', front: 'origin:front', right: 'origin:right' };

/** The view's words now (the reply's `view`). */
function viewNow(h: ViewportHandle): Record<string, unknown> {
  const st = h.state.get();
  return { display: st.display.replace('-', '_'), projection: st.projection, section: st.section.on ? { plane: st.section.plane.slice('origin:'.length), offset_mm: round(st.section.offset), flip: st.section.flip } : null };
}

async function view(ctx: CallCtx, i: Input): Promise<ToolReply> {
  const { services } = ctx;
  const h = personView(ctx, i);
  const auto = { auto: true, animate: true };
  const data = (extra: Record<string, unknown> = {}) => ({ ...extra, view: viewNow(h), person_asked: i.asked });
  switch (i.action) {
    case 'fit':
      h.fit(auto);
      return done('Framed the shown part in the person\'s view', data());
    case 'standard_view': {
      const v = i.value.toLowerCase() as StandardView;
      if (!STANDARD.includes(v)) throw bad('value', `value: one of ${STANDARD.join(', ')}.`);
      h.setView(v, auto);
      return done(`Turned the person's view to ${v === 'iso' ? 'Isometric' : v === 'iso_back' ? 'Back isometric' : v === 'home' ? 'Home' : v}`, data({ standard_view: v }));
    }
    case 'normal_to': {
      if (!i.target) throw bad('target', 'target: a flat face, a plane or a sketch.');
      const s = services.doc.state.get();
      const f = features(services).find((x) => x.name.toLowerCase() === i.target.toLowerCase());
      const o = ORIGIN_WORDS[i.target.toLowerCase()];
      let t: { normal: Vec3; up: Vec3; what: string } | { reason: string };
      if (f) t = normalTarget(s, h, [{ kind: 'feature', feature: f.id }]);
      else if (o) t = normalTarget(s, h, [{ kind: 'origin', ref: o }]);
      else {
        await heartbeat(ctx, services.doc.settled(ctx.signal), 'Waiting for the rebuild');
        t = await withScene(ctx, {}, async (sc) => {
          const r = await selectAny(sc, i.target, 'target');
          const hit = r.hits[0];
          if (!hit) throw new ToolError('nothing_selected', `target: "${i.target}" matches nothing.`, { detail: { field: 'target' } });
          if (r.hits.length > 1) throw new ToolError('selector_ambiguous', `target: "${i.target}" names ${r.hits.length} things: narrow it to one.`, { detail: { field: 'target', count: r.hits.length } });
          if (hit.kind === 'plane') {
            const n = hit.frame.normal;
            return { normal: [...n] as Vec3, up: upOf(n), what: hit.words };
          }
          return normalTarget(s, h, itemsOfHit(hit));
        });
      }
      if ('reason' in t) throw bad('target', `${i.target}: ${t.reason}.`);
      h.lookAt(t.normal, t.up, auto);
      return done(`Turned the person's view normal to ${t.what}`, data({ normal: t.normal.map(round) }));
    }
    case 'orbit_pivot': {
      const t = i.target.toLowerCase();
      let at: Vec3 | 'center';
      if (t === 'center' || t === 'centre' || t === '') at = 'center';
      else if (t === 'origin') at = [0, 0, 0];
      else if (/^\(.*\)$/.test(i.target)) {
        const n = numbers(services, i.target, 3, 3, 'target', ['length']);
        at = [n[0], n[1], n[2]];
      } else {
        await heartbeat(ctx, services.doc.settled(ctx.signal), 'Waiting for the rebuild');
        at = await withScene(ctx, {}, async (sc) => {
          const r = await selectAny(sc, i.target, 'target');
          const c = r.hits[0] ? centreOf(r.hits[0]) : null;
          if (!c) throw new ToolError('nothing_selected', `target: "${i.target}" names no point to orbit about.`, { detail: { field: 'target' } });
          return c;
        });
      }
      h.orbitAround(at, { auto: true });
      return done(`The person's view orbits about ${at === 'center' ? 'the model centre' : `(${at.map(round).join(', ')}) mm`}`, data({ pivot: at === 'center' ? 'center' : at.map(round) }));
    }
    case 'section': {
      if (!i.value || i.value.toLowerCase() === 'off') {
        h.setSection({ on: false });
        return done('Section view off in the person\'s view', data());
      }
      const drawn = services.doc.state.get().rebuild.bodies.filter((b) => b.visible);
      const c = sectionAtMiddle(
        parseSection(i.value, (e) => services.doc.units.evaluate(e, 'length')),
        drawn.map((b) => b.bbox),
      );
      if (!c) throw bad('value', 'value: off, or "<Top|Front|Right> [offset <length> | middle] [flip]".');
      h.setSection({ on: true, plane: SECTION_PLANE[c.plane], offset: c.offset, flip: c.flip });
      return done(`Section view on in the person's view: ${String(sectionData(c)?.keeps ?? '')}`, data({ section: sectionData(c) }));
    }
    case 'projection': {
      const p = i.value.toLowerCase() as Projection;
      if (p !== 'perspective' && p !== 'orthographic') throw bad('value', 'value: perspective or orthographic.');
      h.setProjection(p);
      return done(`The person's view is ${p}`, data());
    }
    case 'display': {
      const d = DISPLAY[i.value.toLowerCase()];
      if (!d) throw bad('value', 'value: shaded_edges, shaded or wireframe.');
      h.setDisplay(d);
      return done(`The person's view draws the bodies ${d === 'shaded-edges' ? 'shaded with edges' : d}`, data());
    }
    default:
      throw bad('action', 'not a view action');
  }
}

/** A screen-up for looking along `n` (Z up unless looking along Z). */
function upOf(n: readonly number[]): Vec3 {
  return Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
}

// ------------------------------------------------------------------ the tool

const NO_KERNEL_WAIT: ReadonlySet<WorkspaceAction> = new Set(['reload', 'keep_mine', 'retry_save', 'retry_kernel', 'import_step']);

async function run(ctx: CallCtx): Promise<ToolReply> {
  const i = readInput(ctx.input);
  // The heal is a change of the Part: one Assistant step, on the person's own Import panel.
  if (i.action === 'reheal') return runEdit(ctx, healTool);
  // Reload, Keep mine and the retries are what a Part that cannot answer needs: no wait for the kernel.
  if (!NO_KERNEL_WAIT.has(i.action)) await waitForRead(ctx);
  else if (ctx.services.doc.state.get().status === 'loading') throw new ToolError('loading', 'The Part is still opening.');
  ctx.checkAbort();
  switch (i.action) {
    case 'roll_back_to':
    case 'roll_to_end':
      return rollBack(ctx, i);
    case 'show':
    case 'hide':
      return eye(ctx, i);
    case 'origin_planes':
      return planes(ctx, i);
    case 'rename_part':
      return renamePart(ctx, i);
    case 'select':
    case 'selection_filter':
      return select(ctx, i);
    case 'expand':
    case 'collapse':
      return fold(ctx, i);
    case 'toolbar_show':
    case 'toolbar_hide':
    case 'toolbar_move':
    case 'toolbar_reset':
      return toolbar(ctx, i);
    case 'banana_show':
    case 'banana_hide':
    case 'banana_place':
      return banana(ctx, i);
    case 'reload':
    case 'keep_mine':
    case 'retry_save':
    case 'retry_kernel':
      return session(ctx, i);
    case 'import_step':
      return importStep(ctx);
    case 'export_step':
      return exportStep(ctx, i);
    case 'send_to_simulation':
      return sendToSimulation(ctx, i);
    case 'fit':
    case 'standard_view':
    case 'normal_to':
    case 'orbit_pivot':
    case 'section':
    case 'projection':
    case 'display':
      return view(ctx, i);
  }
}

export const tool: ToolImpl = {
  kind: 'edit',
  run,
};
