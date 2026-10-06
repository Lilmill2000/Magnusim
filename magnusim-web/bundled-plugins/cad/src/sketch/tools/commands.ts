// The P4b sketch tools' commands: Spline (S) and Control-point spline in DRAW;
// Mirror (M), Linear pattern, Circular pattern, Offset (O), Fillet and Chamfer
// in MODIFY. Each one is the tool (activeWhen), so its button shows pressed
// while it is on. Enter places an open tool step (a spline being drawn, a
// pattern being set up) and otherwise finishes the sketch, as before.
// Only tools that work end to end are registered.
// Owner: P4b SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../../types/app';
import type { CommandDef } from '../../types/commands';
import type { SketchToolId } from '../../types/sketch';
import { uiFor } from '../../ui/controller';
import type { SketchMode } from '../mode';

const dot = (x: number, y: number, r = 1.4) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

/** Outline icons (24 viewBox, as src/sketch/icons.ts). */
export const P4B_ICONS = {
  spline: `M3 17C6 5 10 5 12 12S18 19 21 7 ${dot(3, 17)} ${dot(12, 12)} ${dot(21, 7)}`,
  splineControl: `M3 18C7 4 17 4 21 18 M3 18L7 5 M7 5h10 M17 5l4 13 ${dot(7, 5, 1.2)} ${dot(17, 5, 1.2)}`,
  mirror: 'M12 3v2 M12 8v2 M12 13v2 M12 18v2 M9 7L4 17h5z M15 7l5 10h-5z',
  patternLinear: 'M3 9h4v6H3z M10 9h4v6h-4z M17 9h4v6h-4z',
  patternCircular: `M12 12m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0 ${dot(12, 5, 1.6)} ${dot(18, 15.5, 1.6)} ${dot(6, 15.5, 1.6)}`,
  offset: 'M4 18V9a5 5 0 0 1 5-5h11 M8 18v-8a2 2 0 0 1 2-2h10',
  fillet: 'M4 4v8a8 8 0 0 0 8 8h8',
  chamfer: 'M4 4v9l7 7h9',
} as const;

interface ToolCmd {
  id: string;
  tool: SketchToolId;
  label: string;
  icon: string;
  group: 'draw' | 'sketch-modify';
  order: number;
  shortcut?: string;
  hint: string;
}

/** The tools whose code is in (src/sketch/tools/*): each one registered only when it works end to end. */
export const P4B_TOOLS: ToolCmd[] = [
  { id: 'sketch.spline', tool: 'spline-fit', label: 'Spline', icon: P4B_ICONS.spline, group: 'draw', order: 18, shortcut: 'S', hint: 'A smooth curve through the points you click (fit points)' },
  { id: 'sketch.spline-control', tool: 'spline-control', label: 'Control-point spline', icon: P4B_ICONS.splineControl, group: 'draw', order: 19, hint: 'A smooth curve pulled by its control points (degree 3 or 5)' },
  { id: 'sketch.mirror', tool: 'mirror', label: 'Mirror', icon: P4B_ICONS.mirror, group: 'sketch-modify', order: 40, shortcut: 'M', hint: 'Copies of the picked entities mirrored about a line, kept symmetric' },
  { id: 'sketch.pattern-linear', tool: 'pattern-linear', label: 'Linear pattern', icon: P4B_ICONS.patternLinear, group: 'sketch-modify', order: 41, hint: 'Copies in a row (or a grid): count, spacing and direction, editable later' },
  { id: 'sketch.pattern-circular', tool: 'pattern-circular', label: 'Circular pattern', icon: P4B_ICONS.patternCircular, group: 'sketch-modify', order: 42, hint: 'Copies round a centre point: count, full circle or an angle, editable later' },
  { id: 'sketch.offset', tool: 'offset', label: 'Offset', icon: P4B_ICONS.offset, group: 'sketch-modify', order: 30, shortcut: 'O', hint: 'A copy of a chain of curves at a distance, to one side or both, that follows it' },
  { id: 'sketch.fillet', tool: 'fillet', label: 'Fillet', icon: P4B_ICONS.fillet, group: 'sketch-modify', order: 31, hint: 'Round a corner of two lines (or a line and an arc) with a tangent arc' },
  { id: 'sketch.chamfer', tool: 'chamfer', label: 'Chamfer', icon: P4B_ICONS.chamfer, group: 'sketch-modify', order: 32, hint: 'Cut a corner of two lines with a line at set distances' },
];

export function registerSketchToolCommands(services: AppServices, mode: SketchMode): () => void {
  const offs: (() => void)[] = [];
  const ui = uiFor(services);
  const editable = () => ui.editBlock() ?? (mode.active ? true : 'Edit a sketch first');
  const reg = (def: CommandDef) => offs.push(services.commands.register(def));
  for (const c of P4B_TOOLS) {
    reg({
      id: c.id,
      label: c.label,
      group: c.group,
      mode: 'sketch',
      icon: c.icon,
      shortcut: c.shortcut,
      hint: c.hint,
      order: c.order,
      activeWhen: { sketchTool: c.tool },
      enabled: editable,
      run: () => mode.setTool(c.tool),
    });
  }
  // Enter: the tool's open step first (a spline being drawn), else Finish sketch as before. The
  // newest command of the mode with a shortcut takes the key, so this one runs instead of Finish
  // sketch's and calls it when no step is open.
  reg({
    id: 'sketch.enter',
    label: 'Place or finish',
    mode: 'sketch',
    shortcut: 'Enter',
    hint: 'Places what the tool is drawing; with nothing open, finishes the sketch',
    run: () => {
      if (mode.tool?.commit?.()) return;
      void mode.finish();
    },
  });
  return () => {
    for (const off of offs.splice(0).reverse()) off();
  };
}
