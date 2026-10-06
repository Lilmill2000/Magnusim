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
// never finishes the sketch (also in a field). Ctrl+Shift+Z redoes inside the
// sketch. Only commands that work end to end are registered.
// Owner: P3-SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../types/app';
import type { CommandDef } from '../types/commands';
import type { OriginPlaneRef } from '../types/doc';
import type { SketchToolId } from '../types/sketch';
import type { SelectionItem } from '../types/selection';
import type { OverlayLayer } from '../types/viewport';
import { clearSelection, userItems } from '../lib/selection';
import { WELL_KNOWN_COMMANDS } from '../types/modules';
import { uiFor } from '../ui/controller';
import { constructOf, constructOutput } from '../features/refgeom/api';
import { CONSTRAIN_COMMANDS, planConstraint } from './constraints';
import { SketchBuilder, toggleConstruction } from './edit';
import { SKETCH_ICONS } from './icons';
import { entityOf, ORIGIN, RELATION_LABELS } from './model';
import { planeY, type SketchMode } from './mode';

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

const DRAW: { id: string; tool: SketchToolId; label: string; icon: string; shortcut?: string; hint: string }[] = [
  { id: 'sketch.line', tool: 'line', label: 'Line', icon: SKETCH_ICONS.line, shortcut: 'L', hint: 'Chained lines, click by click; A or a drag from the end makes a tangent arc' },
  { id: 'sketch.rectangle', tool: 'rectangle-corner', label: 'Rectangle', icon: SKETCH_ICONS.rectangle, shortcut: 'R', hint: 'Two opposite corners' },
  { id: 'sketch.rectangle-center', tool: 'rectangle-center', label: 'Center rectangle', icon: SKETCH_ICONS.rectangleCenter, hint: 'The centre, then a corner' },
  { id: 'sketch.circle', tool: 'circle', label: 'Circle', icon: SKETCH_ICONS.circle, shortcut: 'C', hint: 'The centre, then the radius' },
  { id: 'sketch.arc', tool: 'arc-3pt', label: '3-point arc', icon: SKETCH_ICONS.arc, shortcut: 'A', hint: 'Start, end, then a point on the arc' },
  { id: 'sketch.arc-tangent', tool: 'arc-tangent', label: 'Tangent arc', icon: SKETCH_ICONS.arcTangent, hint: 'From the end of a line or an arc, tangent to it' },
  { id: 'sketch.point', tool: 'point', label: 'Point', icon: SKETCH_ICONS.point, hint: 'A sketch point' },
  { id: 'sketch.centerline', tool: 'centerline', label: 'Centerline', icon: SKETCH_ICONS.centerline, hint: 'A construction line, an axis to mirror or revolve about' },
];

/** Picked sketch items as constraint references (a point entity is a point; curves by id). */
function picks(mode: SketchMode): string[] {
  return mode.selected().filter((h) => h.what !== 'constraint').map((h) => h.id);
}

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
      shortcut: d.shortcut,
      hint: d.hint,
      order: 10 + i,
      activeWhen: { sketchTool: d.tool },
      enabled: editable,
      run: () => {
        // A in a line chain: the next segment is a tangent arc (SolidWorks' autotransition).
        if (d.tool === 'arc-3pt' && mode.tool?.toggleArc?.()) return;
        mode.setTool(d.tool);
      },
    }),
  );
  reg({
    id: 'sketch.construction',
    label: 'Construction',
    group: 'draw',
    mode: 'sketch',
    icon: SKETCH_ICONS.construction,
    shortcut: 'X',
    hint: 'Turn the selected lines, circles and arcs into construction geometry (dashed, never part of a profile), or back',
    order: 30,
    explainRefusal: true,
    enabled: () => {
      const e = editable();
      if (e !== true) return e;
      const d = mode.draft();
      const ids = mode.selected().filter((h) => h.what === 'entity').map((h) => h.id);
      if (!d || !ids.some((id) => entityOf(d, id) && entityOf(d, id)!.kind !== 'point')) return 'Select lines, circles or arcs';
      return true;
    },
    run: () => {
      const ids = mode.selected().filter((h) => h.what === 'entity').map((h) => h.id);
      void mode.apply('Construction', (d) => {
        const next = toggleConstruction(d, ids);
        return next ? { ok: true, draft: next, optional: [], removed: [] } : { ok: false, reason: 'select lines, circles or arcs' };
      });
    },
  });

  // ---- sketch mode: CONSTRAIN (select first)
  CONSTRAIN_COMMANDS.forEach((c, i) =>
    reg({
      id: `sketch.${c.kind}`,
      label: c.label,
      group: 'constrain',
      mode: 'sketch',
      icon: SKETCH_ICONS[c.kind === 'point_on_line' ? 'onCurve' : (c.kind as keyof typeof SKETCH_ICONS)] ?? SKETCH_ICONS.coincident,
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
        const sel = picks(mode);
        void mode
          .apply(RELATION_LABELS[c.kind], (d) => {
            const p = planConstraint(d, c.kind, sel);
            if (!p.ok) return { ok: false, reason: p.reason };
            const b = new SketchBuilder(d);
            for (const r of p.add) b.addRelation(r.kind, r.refs, r.value ? { value: r.value } : {});
            return b.result();
          })
          .then((r) => {
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
    shortcut: 'D',
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
    shortcut: 'T',
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
  reg({
    id: WELL_KNOWN_COMMANDS.sketchFinish,
    label: 'Finish sketch',
    group: 'draw',
    mode: 'sketch',
    icon: SKETCH_ICONS.finish,
    shortcut: 'Enter',
    hint: 'Leave the sketch (the whole sketch session is one undo step)',
    primary: true,
    run: () => mode.finish(),
  });
  reg({
    id: 'sketch.delete',
    label: 'Delete',
    mode: 'sketch',
    shortcut: 'Delete',
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
    shortcut: 'Ctrl+Z',
    hint: 'Undo the last change in this sketch',
    enabled: () => (mode.undoDepth > 0 ? true : 'Nothing to undo in this sketch'),
    run: () => mode.undo(),
  });
  reg({
    id: WELL_KNOWN_COMMANDS.sketchRedo,
    label: 'Redo',
    mode: 'sketch',
    icon: SKETCH_ICONS.redo,
    shortcut: 'Ctrl+Y',
    hint: 'Redo in this sketch',
    enabled: () => (mode.redoDepth > 0 ? true : 'Nothing to redo in this sketch'),
    run: () => mode.redo(),
  });
  reg({
    id: 'view.sketch-look',
    label: 'Look at',
    mode: 'sketch',
    icon: SKETCH_ICONS.lookAt,
    hint: 'Turn the camera to face the sketch',
    order: 50,
    run: () => {
      const p = mode.plane();
      const h = services.viewport.get().handle;
      if (p && h) h.lookAt(p.normal, planeY(p));
    },
  });

  // ---- keys that are not one command's shortcut
  const kb = services.keyboard;
  offs.push(
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
    kb.bind({
      combo: 'Ctrl+Shift+Z',
      run: () => {
        if (!mode.active) return false;
        mode.redo();
        return true;
      },
    }),
  );

  return () => {
    for (const off of offs.splice(0).reverse()) off();
  };
}
