// Sketch mode's commands and keys (docs/p2p3-plan.md §3.4, §3.8):
//   model mode   SKETCH: Sketch (on the selected plane or flat face; with none
//                selected it waits for one to be picked, the origin planes
//                shown, as SolidWorks and Fusion do; Escape stops waiting)
//   sketch mode  DRAW: Line L, Rectangle R, Center rectangle, Circle C, 3-point
//                arc A (in a line chain A makes the next segment a tangent
//                arc), Tangent arc, Point, Centerline, Construction X;
//                CONSTRAIN: the twelve relations (select first);
//                DIMENSION: Dimension D; MODIFY: Trim T, Extend;
//                Finish sketch (primary, Enter); Delete; Undo / Redo
//                (Ctrl+Z / Ctrl+Y, inside the sketch); VIEW: Look at.
// Escape cancels the tool's step, then the tool, then the selection, and
// never finishes the sketch (also in a field). A tool's own key pressed again
// with it in hand, or its toolbar button clicked again, leaves it, as Escape until
// the tool is gone (src/app/keyboard.ts toolKeyAgain). Ctrl+Shift+Z redoes inside the
// sketch. Only commands that work end to end are registered. In a sketch the
// Assistant draws, Escape, Undo, Redo and Finish sketch take it over, and the
// tools and edits are refused with the reason (SketchMode).
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../types/app';
import type { CommandDef } from '../types/commands';
import type { OriginPlaneRef, SketchFeature, SketchRelationKind } from '../types/doc';
import type { SketchToolId } from '../types/sketch';
import type { SelectionItem } from '../types/selection';
import type { OverlayLayer } from '../types/viewport';
import { clearSelection, userItems } from '../lib/selection';
import { WELL_KNOWN_COMMANDS } from '../types/modules';
import { uiFor } from '../ui/controller';
import { constructOf, constructOutput } from '../features/refgeom/api';
import { CONSTRAIN_COMMANDS, curvesCollapsed, curvesMerged, hasRelation, planConstraint, sameRefs, SUPERSEDES, turnedForAngle } from './constraints';
import { SHAPE_TOOL_IDS, SketchBuilder, toggleConstruction, type EditOutcome } from './edit';
import { SKETCH_ICONS } from './icons';
import { entityOf, ORIGIN, RELATION_LABELS } from './model';
import { IMPLIED, type ApplyResult, type SketchMode } from './mode';
import { sketchUp } from '../viewport/normal';
// ux010 (DRAW): Show relations.
import { relationsView } from './relations-view';
import { keyLabel } from '../app/keybinds';
// P4b (SKETCH): spline handles and fit points for Tangent / Coincident.
import { addHandle } from './tools/spline-relations';

/** ux010 (DRAW): Show relations' icon: a perpendicular glyph on its badge. */
const RELATIONS_ICON = 'M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M8 16h8 M12 16V8 M12 13h3v3';

/** ux010 (DRAW): the tools Construction (X) never converts a selection in: it toggles construction drawing. */
const DRAWING_TOOLS = new Set<string>(['line', 'centerline', 'rectangle-corner', 'rectangle-center', 'circle', 'arc-3pt', 'arc-tangent', 'point', 'spline-fit', 'spline-control', ...SHAPE_TOOL_IDS, 'ellipse', 'ellipse-partial', 'parabola', 'conic']);

export const CURVED_FACE = 'Sketches go on flat faces: that face is curved';
/** A CONSTRUCT plane selected that did not build (failed, suppressed or rolled back). */
export const NOT_BUILT = ' is not built: fix it or roll forward first';
export const PICK_PROMPT = 'Select a plane or a flat face for the sketch (Esc stops)';

/** The sketch support a model selection gives: one origin plane, one CONSTRUCT plane (P4a), or one flat face. */
export function supportFromSelection(
  services: AppServices,
  items: readonly SelectionItem[] = userItems(services.selection),
): { kind: 'plane'; plane: OriginPlaneRef } | { kind: 'feature'; feature: string } | { kind: 'pick'; body: string; index: number } | string {
  const reason = 'Select a plane or a flat face, then Sketch';
  if (items.length !== 1) return reason;
  const it = items[0];
  if (it.kind === 'origin' && (it.ref === 'origin:top' || it.ref === 'origin:front' || it.ref === 'origin:right')) return { kind: 'plane', plane: it.ref };
  // A reference Plane (its tree row, or a click on it in the view); one that did not build says so.
  const c = constructOf(services, it);
  if (c?.kind === 'plane') {
    const s = services.doc.state.get();
    if (!constructOutput(s, c.feature)) return `${s.doc.features.find((f) => f.id === c.feature)?.name ?? 'That plane'}${NOT_BUILT}`;
    return { kind: 'feature', feature: c.feature };
  }
  if (it.kind === 'face') {
    const h = services.viewport.get().handle;
    if (h && !h.planeNormal(it)) return CURVED_FACE;
    return { kind: 'pick', body: it.body, index: it.index };
  }
  return reason;
}

// v0.5.0: the drawing tools sit in toolbar flyouts (src/ui/flyouts.ts): `flyout` names the one.
const DRAW: { id: string; tool: SketchToolId; label: string; icon: string; hint: string; order?: number; flyout?: string }[] = [
  // Line's hint names 3-point arc's key (the person's keybind) for the tangent arc: lineHint.
  { id: 'sketch.line', tool: 'line', label: 'Line', icon: SKETCH_ICONS.line, hint: 'Chained lines, click by click; a drag from the end makes a tangent arc', flyout: 'line' },
  { id: 'sketch.rectangle', tool: 'rectangle-corner', label: 'Rectangle', icon: SKETCH_ICONS.rectangle, hint: 'Two opposite corners', flyout: 'rectangle' },
  { id: 'sketch.rectangle-center', tool: 'rectangle-center', label: 'Center rectangle', icon: SKETCH_ICONS.rectangleCenter, hint: 'The centre, then a corner', flyout: 'rectangle' },
  { id: 'sketch.circle', tool: 'circle', label: 'Circle', icon: SKETCH_ICONS.circle, hint: 'The centre, then the radius', flyout: 'circle' },
  { id: 'sketch.arc', tool: 'arc-3pt', label: '3-point arc', icon: SKETCH_ICONS.arc, hint: 'Start, end, then a point on the arc', flyout: 'arc' },
  { id: 'sketch.arc-tangent', tool: 'arc-tangent', label: 'Tangent arc', icon: SKETCH_ICONS.arcTangent, hint: 'From the end of a line or an arc, tangent to it', flyout: 'arc' },
  { id: 'sketch.point', tool: 'point', label: 'Point', icon: SKETCH_ICONS.point, hint: 'A sketch point' },
  { id: 'sketch.centerline', tool: 'centerline', label: 'Centerline', icon: SKETCH_ICONS.centerline, hint: 'A construction line, an axis to mirror or revolve about', flyout: 'line' },
  // The Ellipse flyout (Ellipse, Partial ellipse, Parabola, Conic), after the splines.
  { id: 'sketch.ellipse', tool: 'ellipse', label: 'Ellipse', icon: SKETCH_ICONS.ellipse, hint: 'The centre, an end of the major axis, then the minor radius', order: 20, flyout: 'ellipse' },
  { id: 'sketch.ellipse-partial', tool: 'ellipse-partial', label: 'Partial ellipse', icon: SKETCH_ICONS.ellipsePartial, hint: 'An ellipse (centre, major end, minor radius), then where the arc starts and ends', order: 21, flyout: 'ellipse' },
  { id: 'sketch.parabola', tool: 'parabola', label: 'Parabola', icon: SKETCH_ICONS.parabola, hint: 'The focus, the vertex, then where the parabola starts and ends', order: 22, flyout: 'ellipse' },
  { id: 'sketch.conic', tool: 'conic', label: 'Conic', icon: SKETCH_ICONS.conic, hint: 'Its two ends, the top point where their tangents meet, then rho (where it passes)', order: 23, flyout: 'ellipse' },
];

/** Picked sketch items as constraint references (a point entity is a point; curves by id). */
export function picks(mode: Pick<SketchMode, 'selected'>): string[] {
  return mode.selected().filter((h) => h.what !== 'constraint').map((h) => h.id);
}

/** The CONSTRAIN command's icon for a relation kind (the toolbar's, and the relations palette's). */
export function relationIcon(kind: SketchRelationKind): string {
  return SKETCH_ICONS[kind === 'point_on_line' ? 'onCurve' : (kind as keyof typeof SKETCH_ICONS)] ?? SKETCH_ICONS.coincident;
}

/**
 * The edit a CONSTRAIN command makes for these picks: the planned records the sketch does not have
 * yet (a record already there is not added twice: it would only over-define it), replacing what the
 * new relation makes redundant on the same references (SUPERSEDES).
 */
export function relationEdit(kind: SketchRelationKind, sel: readonly string[], fully?: (point: string) => boolean): (d: SketchFeature) => EditOutcome {
  return (d) => {
    const p = planConstraint(d, kind, sel);
    if (!p.ok) return { ok: false, reason: p.reason };
    const add = p.add.filter((r) => !hasRelation(d, r));
    if (!add.length) return { ok: false, reason: `${RELATION_LABELS[kind]} is already in the sketch` };
    const b = new SketchBuilder(d);
    for (const r of add) {
      const weaker = SUPERSEDES[r.kind] ?? [];
      if (weaker.length) b.removeConstraints(d.constraints.filter((c) => (weaker as string[]).includes(c.kind) && sameRefs(c.refs, r.refs)).map((c) => c.id));
      // P4b (SKETCH): a fit spline's tangent handle first.
      if (r.handle) addHandle(b, r.handle);
      b.addRelation(r.kind, r.refs, r.value ? { value: r.value } : {});
    }
    const draft = b.result();
    // Review (relations lane): an angle relation starts the solver from the free line turned to it.
    const turned = add.length === 1 ? turnedForAngle(d, add[0], fully) : null;
    return { ok: true, draft: turned ? { ...draft, points: { ...draft.points, ...turned } } : draft, optional: [], removed: [] };
  };
}

/**
 * A relation's solution that shrinks a curve to (next to) nothing, or puts two of its curves on top
 * of each other, is refused (curvesCollapsed, curvesMerged).
 */
export function relationRefusal(sel: readonly string[], kind?: SketchRelationKind): (before: SketchFeature, after: SketchFeature) => string | null {
  // Tangent of curves with one centre is degenerate: any coradial result is refused (the arc on the
  // circle). Equal and Concentric may leave an arc on a circle's path.
  return (before, after) => curvesCollapsed(before, after) ?? curvesMerged(before, after, sel, { coradial: kind === 'tangent' });
}

/**
 * What a CONSTRAIN command adds for these picks, as one undo step (the toolbar command, its key,
 * and the relations palette by the selection all add through here: the same records, refused with
 * the same reasons).
 */
/** Whether the sketch's last analysis has this point fully defined (an angle relation never turns it). */
export function fullyDefined(mode: Pick<SketchMode, 'view'>): (point: string) => boolean {
  return (q) => mode.view.get().analysis?.perPoint[q] === 'fully';
}

export function applyRelation(mode: Pick<SketchMode, 'apply' | 'view'>, kind: SketchRelationKind, sel: readonly string[]): Promise<ApplyResult> {
  // Review (relations lane): the sketch's analysis is asked first, as it alone sees a relation the
  // others imply (Parallel of two horizontal lines): added, it only over-defined the sketch.
  return mode.apply(RELATION_LABELS[kind], relationEdit(kind, sel, fullyDefined(mode)), { refuse: relationRefusal(sel, kind), analyzeFirst: true });
}

export { IMPLIED };

/**
 * Sketch with no plane or flat face selected (SD review round 1: Sketch was greyed on an empty
 * Part, the only way to make a solid): the origin planes show, a prompt over the view says what to
 * pick, and the first plane or flat face picked (in the view or the tree) starts the sketch on it.
 * A curved face is refused in the prompt; Escape, a panel or another mode stops waiting.
 */
export function createSupportPicker(services: AppServices, mode: Pick<SketchMode, 'startSketch'>) {
  const ui = uiFor(services);
  let offs: (() => void)[] = [];
  let layer: OverlayLayer | null = null;
  let prompt: HTMLElement | null = null;
  const OWNER = 'sketch.pick';
  const armed = () => offs.length > 0;
  function stop() {
    if (!armed()) return;
    for (const off of offs.splice(0)) off();
    services.viewport.get().handle?.setPlanesWanted(OWNER, false);
    layer?.dispose();
    layer = null;
    prompt = null;
  }
  function onSelection(items: readonly SelectionItem[]) {
    if (!armed() || !items.length) return;
    const sup = supportFromSelection(services, items);
    if (typeof sup === 'string') {
      if (prompt) {
        // One colon: "Sketches go on flat faces: that face is curved: pick…" read as a stammer (SD review round 2).
        prompt.textContent = sup === CURVED_FACE ? 'That face is curved: pick a plane or a flat face for the sketch (Esc stops)' : PICK_PROMPT;
        prompt.dataset.problem = sup === CURVED_FACE ? '1' : '';
      }
      return;
    }
    stop();
    void mode.startSketch(sup).then((r) => {
      if (r !== true) ui.fail('New sketch', r);
    });
  }
  function arm() {
    if (armed()) return;
    clearSelection(services.selection);
    const h = services.viewport.get().handle;
    if (h) {
      h.setPlanesWanted(OWNER, true);
      layer = h.addLayer(OWNER, { order: 60 });
      prompt = document.createElement('div');
      prompt.className = 'cad-sketch-pick';
      prompt.dataset.sketchPick = '1';
      prompt.setAttribute('role', 'status');
      prompt.textContent = PICK_PROMPT;
      layer.html.appendChild(prompt);
    }
    offs = [
      services.selection.subscribe((s) => onSelection(s.items)),
      services.bus.on('app:escape', () => stop()),
      services.mode.subscribe((m) => {
        if (m.mode !== 'model') stop();
      }),
      ui.state.subscribe((s) => {
        if (s.panel) stop();
      }),
    ];
  }
  return { arm, stop, armed };
}

export function registerSketchCommands(services: AppServices, mode: SketchMode): () => void {
  const offs: (() => void)[] = [];
  const reg = (def: CommandDef) => offs.push(services.commands.register(def));
  const ui = uiFor(services);
  const editable = () => ui.editBlock() ?? (mode.active ? true : 'Edit a sketch first');
  const picker = createSupportPicker(services, mode);
  offs.push(() => picker.stop());

  // ---- model mode: SKETCH
  reg({
    id: WELL_KNOWN_COMMANDS.sketchNew,
    label: 'Sketch',
    group: 'sketch',
    mode: 'model',
    icon: SKETCH_ICONS.sketch,
    hint: 'A 2D sketch on a plane or a flat face: the one selected, or pick one after',
    order: 10,
    explainRefusal: true,
    enabled: (s) => {
      const block = ui.editBlock();
      if (block) return block;
      // A curved face selected is a reason; anything else (nothing, an edge) waits for a pick.
      const sup = supportFromSelection(s);
      return sup === CURVED_FACE || (typeof sup === 'string' && sup.includes(NOT_BUILT)) ? sup : true;
    },
    run: async (s) => {
      const sup = supportFromSelection(s);
      if (sup === CURVED_FACE || (typeof sup === 'string' && sup.includes(NOT_BUILT))) return;
      if (typeof sup === 'string') {
        picker.arm();
        return;
      }
      const r = await mode.startSketch(sup);
      if (r !== true) ui.fail('New sketch', r);
    },
  });

  // ---- sketch mode: DRAW
  DRAW.forEach((d, i) =>
    reg({
      id: d.id,
      label: d.label,
      group: 'draw',
      mode: 'sketch',
      icon: d.icon,
      get hint() {
        if (d.id !== 'sketch.line') return d.hint;
        // In a line chain 3-point arc's key (A by default) makes the next segment a tangent arc.
        const arc = keyLabel(services, 'sketch.arc');
        return arc ? `Chained lines, click by click; ${arc} or a drag from the end makes a tangent arc` : d.hint;
      },
      order: d.order ?? 10 + i,
      ...(d.flyout ? { flyout: d.flyout } : {}),
      activeWhen: { sketchTool: d.tool },
      enabled: editable,
      run: () => {
        // A in a line chain: the next segment is a tangent arc (SolidWorks' autotransition).
        if (d.tool === 'arc-3pt' && mode.tool?.toggleArc?.()) return;
        mode.setTool(d.tool);
      },
    }),
  );
  // ux010 (DRAW): Construction (X) turns construction drawing on or off (Daniel: "a toggle ... to have
  // the line I'm drawing be a construction line"), always while a drawing tool is in hand (a selection
  // left from before is not converted). With another tool (Select) and lines, circles or arcs selected,
  // it converts them, as before; right-click > Construction always converts what was clicked
  // (src/sketch/select-menu.ts). Never greyed in an open sketch: it always does one of the two.
  const curvesPicked = (): string[] => {
    const d = mode.draft();
    if (!d || DRAWING_TOOLS.has(mode.tool?.id ?? 'select')) return [];
    return mode
      .selected()
      .filter((h) => h.what === 'entity')
      .map((h) => h.id)
      .filter((id) => {
        const e = entityOf(d, id);
        return !!e && e.kind !== 'point';
      });
  };
  const construction: CommandDef = {
    id: 'sketch.construction',
    label: 'Construction',
    group: 'draw',
    mode: 'sketch',
    icon: SKETCH_ICONS.construction,
    get hint() {
      const ids = curvesPicked();
      const x = keyLabel(services, 'sketch.construction') ?? 'Construction';
      if (!ids.length) return mode.drawConstruction ? `Construction drawing is on: ${x} turns it off` : `Construction drawing is off: ${x} turns it on (what you draw is dashed, never part of a profile)`;
      const d = mode.draft();
      return d && ids.every((id) => entityOf(d, id)?.construction) ? 'Make the selection normal geometry (not construction)' : 'Make the selection construction';
    },
    order: 30,
    explainRefusal: true,
    enabled: editable,
    pressed: () => mode.active && mode.drawConstruction,
    run: () => {
      const ids = curvesPicked();
      if (!ids.length) {
        mode.setDrawConstruction(!mode.drawConstruction);
        return;
      }
      void mode.apply('Construction', (d) => {
        const next = toggleConstruction(d, ids);
        return next ? { ok: true, draft: next, optional: [], removed: [] } : { ok: false, reason: 'select lines, circles or arcs' };
      });
    },
  };
  reg(construction);
  // The toolbar draws the command pressed while construction drawing is on: it redraws when the
  // registry changes, so the same def is registered again when the mode flips.
  let drawingWas = false;
  offs.push(
    mode.state.subscribe((s) => {
      const on = !!s.drawConstruction;
      if (on === drawingWas) return;
      drawingWas = on;
      if (services.commands.get(construction.id) === construction) services.commands.register(construction);
    }),
  );

  // ---- sketch mode: CONSTRAIN (select first)
  CONSTRAIN_COMMANDS.forEach((c, i) =>
    reg({
      id: `sketch.${c.kind}`,
      label: c.label,
      group: 'constrain',
      mode: 'sketch',
      icon: relationIcon(c.kind),
      hint: c.needs,
      order: 10 + i,
      explainRefusal: true,
      enabled: () => {
        const e = editable();
        if (e !== true) return e;
        const d = mode.draft();
        if (!d) return c.needs;
        const p = planConstraint(d, c.kind, picks(mode));
        return p.ok ? true : p.reason;
      },
      run: () => {
        void applyRelation(mode, c.kind, picks(mode)).then((r) => {
          if (r.ok) mode.select([], false);
        });
      },
    }),
  );

  // ---- DIMENSION, MODIFY
  reg({
    id: 'sketch.dimension',
    label: 'Dimension',
    group: 'dimension',
    mode: 'sketch',
    icon: SKETCH_ICONS.dimension,
    hint: 'Smart Dimension: pick a line, a circle, an arc or two items, then where the value goes',
    order: 10,
    activeWhen: { sketchTool: 'dimension' },
    enabled: editable,
    run: () => mode.setTool('dimension'),
  });
  reg({
    id: 'sketch.trim',
    label: 'Trim',
    group: 'sketch-modify',
    mode: 'sketch',
    icon: SKETCH_ICONS.trim,
    hint: 'Remove the piece of a curve between the curves that cross it',
    order: 10,
    activeWhen: { sketchTool: 'trim' },
    enabled: editable,
    run: () => mode.setTool('trim'),
  });
  reg({
    id: 'sketch.extend',
    label: 'Extend',
    group: 'sketch-modify',
    mode: 'sketch',
    icon: SKETCH_ICONS.extend,
    hint: 'Lengthen a line or an arc to the next curve',
    order: 20,
    activeWhen: { sketchTool: 'extend' },
    enabled: editable,
    run: () => mode.setTool('extend'),
  });

  // ---- Finish sketch (primary), Delete, Undo / Redo, Look at
  // In a sketch the Assistant draws, Finish, Undo and Redo take it over (SketchMode): always offered, and they say so.
  const TAKE_OVER = 'Take over from the Assistant: its sketch is discarded';
  reg({
    id: WELL_KNOWN_COMMANDS.sketchFinish,
    label: 'Finish sketch',
    group: 'draw',
    mode: 'sketch',
    icon: SKETCH_ICONS.finish,
    get hint() {
      return mode.byAssistant ? TAKE_OVER : 'Leave the sketch (the whole sketch session is one undo step)';
    },
    primary: true,
    run: async () => {
      await mode.finish();
    },
  });
  reg({
    id: 'sketch.delete',
    label: 'Delete',
    mode: 'sketch',
    explainRefusal: true,
    enabled: () => {
      const e = editable();
      if (e !== true) return e;
      return mode.selected().some((h) => h.id !== ORIGIN) ? true : 'Select sketch geometry, a constraint or a dimension';
    },
    run: () => void mode.deleteSelected(),
  });
  reg({
    id: WELL_KNOWN_COMMANDS.sketchUndo,
    label: 'Undo',
    mode: 'sketch',
    icon: SKETCH_ICONS.undo,
    get hint() {
      return mode.byAssistant ? TAKE_OVER : 'Undo the last change in this sketch';
    },
    enabled: () => (mode.byAssistant || mode.undoDepth > 0 ? true : 'Nothing to undo in this sketch'),
    run: () => mode.undo(),
  });
  reg({
    id: WELL_KNOWN_COMMANDS.sketchRedo,
    label: 'Redo',
    mode: 'sketch',
    icon: SKETCH_ICONS.redo,
    get hint() {
      return mode.byAssistant ? TAKE_OVER : 'Redo in this sketch';
    },
    enabled: () => (mode.byAssistant || mode.redoDepth > 0 ? true : 'Nothing to redo in this sketch'),
    run: () => mode.redo(),
  });
  reg({
    id: 'view.sketch-look',
    // P4b SELECT: one name everywhere ("Look at" before), and N as in model mode.
    label: 'Normal to',
    mode: 'sketch',
    icon: SKETCH_ICONS.lookAt,
    hint: 'Look straight at the sketch',
    order: 50,
    run: () => {
      const p = mode.plane();
      const h = services.viewport.get().handle;
      // P4b SELECT (fix round 1): the same up as every Normal to of a sketch (src/viewport/normal.ts).
      if (p && h) h.lookAt(p.normal, sketchUp(p));
    },
  });

  // ---- ux010 (DRAW): Show relations (VIEW group): every relation glyph, or the selection's only.
  const rv = relationsView(services);
  const showRelations: CommandDef = {
    id: 'view.sketch-relations',
    label: 'Show relations',
    mode: 'sketch',
    icon: RELATIONS_ICON,
    get hint() {
      const k = keyLabel(services, 'view.sketch-relations') ?? 'Show relations';
      return rv.state.get().showAll
        ? `Every relation shows: ${k} shows only those of the selected geometry (a conflict always shows)`
        : `Relations show for the selected geometry only: ${k} shows them all (a conflict always shows)`;
    },
    order: 60,
    pressed: () => mode.active && rv.state.get().showAll,
    run: () => rv.setShowAll(!rv.state.get().showAll),
  };
  reg(showRelations);
  offs.push(
    rv.state.subscribe(() => {
      if (services.commands.get(showRelations.id) === showRelations) services.commands.register(showRelations);
    }),
  );

  // ---- keys that are not one command's shortcut
  const kb = services.keyboard;
  offs.push(
    // Escape is built in (the app's own key, never rebound): it steps back in the sketch.
    kb.bind({
      combo: 'Escape',
      inInputs: true,
      run: (e) => {
        if (!mode.active) return false;
        // The shell's own popovers (context menu, rename) close as usual.
        const u = ui.state.get();
        if (u.menu || u.renaming) return false;
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName?.toLowerCase();
        // A field keeps its Escape; it never closes the sketch.
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
        mode.escape();
        return true;
      },
    }),
  );

  return () => {
    for (const off of offs.splice(0).reverse()) off();
  };
}
