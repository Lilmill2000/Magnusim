// Toolbar flyouts (v0.5.0, Daniel: the sketch toolbar as SolidWorks lays it out): the drawing
// tools in groups, one button each with a small arrow beside it. The button runs the group's
// last-used variant (its icon and label shown); the arrow lists every variant with its icon,
// name, shortcut and hint. Each variant stays a command of its own (its shortcut, its tooltip,
// commands.run by id), so the keyboard and the Assistant reach it as before.
// A command joins a flyout with `flyout: '<id>'` in its CommandDef (one line per variant): the
// ellipse tools (src/sketch/commands.ts) join 'ellipse' that way. A flyout with no variant registered does not show; one
// with a single variant shows as that command's own button.
// For the toolbar's layout (order, More, fold, the right-click menus) a flyout is one command:
// its bar id, `main` when that variant is registered, else its first variant by order.
// Owner: UI-SHELL (v0.5.0 flyouts).
// SPDX-License-Identifier: GPL-3.0-or-later
/** What the flyouts read of a command (a CommandDef; structural, so tests and e2e specs can use it without the app's types). */
export interface FlyCmd {
  id: string;
  flyout?: string;
  order?: number;
  group?: string;
  mode?: string;
}

export interface FlyoutDef {
  id: string;
  /** "Line": the arrow's name ("Line tools"). */
  label: string;
  /** The variant whose id the flyout keeps on the bar (and the first one run), when registered. */
  main?: string;
  /** The variants' order in the list (ids); others follow by their order. */
  order?: readonly string[];
}

export const FLYOUTS: readonly FlyoutDef[] = [
  { id: 'line', label: 'Line', main: 'sketch.line', order: ['sketch.line', 'sketch.centerline', 'sketch.line-midpoint'] },
  { id: 'rectangle', label: 'Rectangle', main: 'sketch.rectangle', order: ['sketch.rectangle', 'sketch.rectangle-center', 'sketch.rectangle-3pt', 'sketch.rectangle-center-3pt', 'sketch.parallelogram'] },
  { id: 'circle', label: 'Circle', main: 'sketch.circle', order: ['sketch.circle', 'sketch.circle-3pt'] },
  { id: 'arc', label: 'Arc', main: 'sketch.arc', order: ['sketch.arc-center', 'sketch.arc-tangent', 'sketch.arc', 'sketch.sector'] },
  { id: 'slot', label: 'Slot', main: 'sketch.slot', order: ['sketch.slot', 'sketch.slot-overall', 'sketch.slot-center-point', 'sketch.slot-arc-3pt', 'sketch.slot-arc-center'] },
  { id: 'spline', label: 'Spline', main: 'sketch.spline', order: ['sketch.spline', 'sketch.spline-control'] },
  { id: 'ellipse', label: 'Ellipse', main: 'sketch.ellipse', order: ['sketch.ellipse', 'sketch.ellipse-partial', 'sketch.parabola', 'sketch.conic'] },
];

const BY_ID = new Map(FLYOUTS.map((f) => [f.id, f] as const));

export function flyoutDef(id: string): FlyoutDef {
  return BY_ID.get(id) ?? { id, label: id[0].toUpperCase() + id.slice(1) };
}

/** A flyout's variants in their list order. */
function sorted<C extends FlyCmd>(def: FlyoutDef, variants: C[]): C[] {
  const pos = (c: C) => {
    const i = def.order?.indexOf(c.id) ?? -1;
    return i < 0 ? 1000 + (c.order ?? 0) : i;
  };
  return [...variants].sort((a, b) => pos(a) - pos(b) || (a.order ?? 0) - (b.order ?? 0));
}

export interface Collapsed<C extends FlyCmd = FlyCmd> {
  /** The group's commands with each flyout as its bar command (in the place of the first variant). */
  commands: C[];
  /** Bar id -> the flyout's variants in list order (only flyouts of two or more). */
  variants: Map<string, C[]>;
  /** Bar id -> its flyout. */
  flyouts: Map<string, FlyoutDef>;
}

/** The bar command of a flyout: its main variant when registered, else its first by order. */
function barOf<C extends FlyCmd>(def: FlyoutDef, variants: C[]): C {
  return variants.find((c) => c.id === def.main) ?? [...variants].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
}

/** A group's commands (in order) with its flyouts collapsed to one command each. */
export function collapseFlyouts<C extends FlyCmd>(commands: readonly C[]): Collapsed<C> {
  const groups = new Map<string, C[]>();
  for (const c of commands) if (c.flyout) groups.set(c.flyout, [...(groups.get(c.flyout) ?? []), c]);
  const variants = new Map<string, C[]>();
  const flyouts = new Map<string, FlyoutDef>();
  const bars = new Set<string>();
  for (const [id, list] of groups) {
    const def = flyoutDef(id);
    const bar = barOf(def, list);
    bars.add(bar.id);
    flyouts.set(bar.id, def);
    if (list.length > 1) variants.set(bar.id, sorted(def, list));
  }
  return { commands: commands.filter((c) => !c.flyout || bars.has(c.id)), variants, flyouts };
}

/** The toolbar command that stands for `id` on the bar: its flyout's bar command, or itself. */
export function barIdOf(all: readonly FlyCmd[], id: string): string {
  const c = all.find((x) => x.id === id);
  if (!c?.flyout) return id;
  const list = all.filter((x) => x.flyout === c.flyout && x.group === c.group && (x.mode ?? 'model') === (c.mode ?? 'model'));
  return barOf(flyoutDef(c.flyout), list).id;
}

// ---- the last-used variant of each flyout (this app session's: a new window starts at each main)

const LAST = new WeakMap<object, Map<string, string>>();

export function lastUsed(owner: object, flyout: string): string | null {
  return LAST.get(owner)?.get(flyout) ?? null;
}

export function setLastUsed(owner: object, flyout: string, id: string): void {
  let m = LAST.get(owner);
  if (!m) LAST.set(owner, (m = new Map()));
  m.set(flyout, id);
}

/**
 * The variant the flyout's button runs now: the one in use (its tool is the sketch's tool, or
 * its panel is open), else the last one used, else the bar command.
 */
export function currentVariant<C extends FlyCmd>(owner: object, barId: string, variants: readonly C[], active: (c: C) => boolean, flyout: string): C {
  const inUse = variants.find(active);
  if (inUse) return inUse;
  const last = lastUsed(owner, flyout);
  return variants.find((c) => c.id === last) ?? variants.find((c) => c.id === barId) ?? variants[0];
}
