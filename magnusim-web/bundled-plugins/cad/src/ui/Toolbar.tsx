// The command toolbar (core .toolbar / .tb-btn recipe, style.css:133-224,
// 3746-3761). It shows only registered commands, which are the ones that work
// end to end: the registry's groups in mode order (SOLID, MODIFY, ...), then a
// VIEW group for the viewport's ungrouped view.* commands, then EDIT (Undo,
// Redo) at the right end. With nothing registered it renders nothing.
// A command that cannot run right now is aria-disabled and its tooltip says why.
// Sketch mode (services.mode 'sketch') shows the sketch groups, the primary
// Finish sketch button, VIEW, and sketch mode's own Undo / Redo.
// Every command fits the frame from 1280 px wide, with its label (P4a, Daniel
// works on 1280-1920 px screens): when the toolbar does not fit, it gets more
// compact step by step (useFitLevel; since v0.5.0 the ribbon's steps, below),
// commands folding into their group's "More" menu (Fusion style: "SOLID:
// Extrude, More ▾"); the menu lists each one with its icon, shortcut and
// tooltip.
// Review P2/P3 round 1: at 1280 px Undo, Redo and some views were scrolled out
// of reach, with no scrollbar in real Chrome.
// P4b fix round 1 (Daniel, 2026-10-06: "I prefer 1280 px (model) but let people
// arrange the icons however they want"). Since the v0.5.0 ribbon (Daniel
// 2026-10-27: "yes show the rest as small buttons") both modes show every command
// by default, model mode too: More holds only what the person moved there and
// what does not fit (the frame, or a group the person narrowed).
// Users rearrange both: right-click a command (or a More item) for Move to More /
// Show in toolbar / Move earlier / Move later / Reset toolbar, or drag a command
// along its group. The layout is the person's (toolbar-layout.ts).
// UX 0.1.0 (Daniel 2026-10-07: "I need to be able to drag something from More onto the main
// toolbar and it replaced the last thing there"): a command dragged out of its group's More menu
// onto the bar goes in where it is dropped, and the group's last command on the bar goes to More
// (dropped on the last slot or after it, it takes that slot); a bar command dragged into its
// group's open More menu (or onto its More button) goes to More. While dragging, a marker shows
// where it lands, the command that will leave is highlighted and a note under the pointer says so
// ("Spline moves to More"); over another group the note says it can only go in its own group, the
// pointer shows not-allowed, and a drop there changes nothing. The keyboard's way: a More item's
// right-click menu has "Swap with <the bar's last>" (useToolbarDrag, customizer).
// v0.5.0 keybinds: every command's right-click menu has Set keybind... (src/ui/keybinds): on a
// flyout, for the variant on its button; on a More item, for that command.
// v0.5.0 (Daniel: the sketch toolbar as SolidWorks lays it out): the drawing tools come in
// flyouts (src/ui/flyouts.ts): one button per group (Line, Rectangle, Circle, Arc, Slot, Spline,
// Ellipse) that runs its last-used variant, and a small arrow beside it that lists every variant
// with its icon, name, shortcut and hint. For the layout a flyout is one command (its bar id); in
// a More menu its variants are listed one by one.
// v0.5.0 ribbon (Daniel: "you can stack them on each other instead of it just being one line of
// stuff", SolidWorks's CommandManager): every group's buttons are stacked in three rows. A group's
// key tools are large buttons (RIBBON_LARGE and the primary action: a bigger icon with the name
// under it, three rows tall); the rest are small buttons (icon and name side by side, one row
// tall) filling the rows column by column after them. A flyout is one button of either size with
// its arrow (beside a small one, under a large one). CONSTRAIN's buttons are their glyphs alone.
// The model toolbar is the same ribbon (each group's main command large, the rest small), so the
// two modes are the same height. When the ribbon does
// not fit the frame (useFitLevel) VIEW and EDIT go to icons, then each group's small buttons go to
// icons one group at a time (SQUEEZE_ORDER), then commands fold into More (FOLD_ORDER), then the
// groups sit closer, then whole groups collapse into one dropdown button each (SQUEEZE_ORDER).
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toolKeyAgain } from '../app/keyboard';
import { useServices } from '../lib/services';
import { useStateStore } from '../lib/store';
import type { AppServices } from '../types/app';
import type { CommandDef, Mode } from '../types/commands';
import { WELL_KNOWN_COMMANDS } from '../types/modules';
import { PARAMS_ID, REDO_ID, UNDO_ID } from './commands';
import { uiFor, type UiState } from './controller';
import { Icon, ICONS } from './Icon';
import { hideTip, useTip, type MenuEntry } from './kit';
import { keybindMenuItem } from './keybinds';
import { collapseFlyouts, currentVariant, setLastUsed, type FlyoutDef } from './flyouts';
import {
  held,
  isDefault,
  layoutModeOf,
  MAX_GROUP_W,
  MAX_ROWS,
  MIN_GROUP_W,
  MIN_ROWS,
  orderIds,
  pinned,
  placeOf,
  RIBBON_ROWS,
  rowsOf,
  toolbarPrefs,
  widthOf,
  withMove,
  withPlace,
  withSwapIn,
  type LayoutMode,
  type ModeLayout,
  type ToolbarPrefs,
} from './toolbar-layout';

/**
 * The order in which commands fold into their group's "More" menu when the ribbon does not fit
 * the frame, the first one first (after VIEW and EDIT have gone to icons and the groups' small
 * buttons to their icons). A command not listed never folds for the frame (KEEP_IN_VIEW): each
 * group keeps its most-used command in view (Sketch, Extrude, Fillet, Plane, Enclosure, Measure,
 * Import STEP; in sketch mode Line, Rectangle, Circle, 3-point arc, Dimension, Trim and Finish
 * sketch; Chamfer stays beside Fillet). The order follows how often SolidWorks and Fusion users
 * reach for each command, weighted for Magnusim's CFD preparation (press-pull, Combine and the
 * enclosure stay longest): ARCHITECTURE.md §7 "Toolbar" gives the reasons. Since the v0.5.0 ribbon
 * both modes show every command by default, so this is the fold order of both.
 */
export const FOLD_ORDER: readonly string[] = [
  // Model mode.
  // The person's side of the Assistant's view, find and hole tools (parity both ways): Picture and
  // Find fold first; Hole stays with the solid commands longest of the three.
  'file.picture',
  'inspect.find',
  // See-through (a view setting the body's menu also has) folds right after Find.
  'inspect.see-through',
  'modify.parameters',
  'inspect.check',
  'construct.point',
  'solid.loft',
  'solid.hole',
  'inspect.mass',
  // Section view (Daniel did not find it in the view tools strip) stays longer than Mass properties.
  'inspect.section',
  // Split and Delete faces before Axis (P4a review: the reference axis is reached for more often).
  'modify.split',
  'modify.delete-faces',
  // Move/copy body after them (a body is moved more often than split), still before Axis.
  'modify.move-body',
  'construct.axis',
  // P4b (PATTERN): Circular pattern and Mirror fold before Sweep (Linear pattern stays in view).
  'pattern.circular',
  'pattern.mirror',
  'solid.sweep',
  'modify.shell',
  'file.export-step',
  'solid.revolve',
  'modify.combine',
  'modify.press-pull',
  // Sketch mode (CONSTRAIN is icons by design: its glyphs are the constraints' own).
  // P4b fix round 1 (sketch review P2): Intersect and Project fold first (a greyed Project held its
  // slot while every new tool folded at 1600 px), then the least-used drawing helpers; Daniel's
  // headline tools (Spline, Mirror, the patterns) stay longest of the new ones. Import SVG/DXF, a
  // once-a-sketch command, folds before them.
  'sketch.import',
  'sketch.intersect',
  'sketch.project',
  'sketch.point',
  'sketch.construction',
  'sketch.chamfer',
  'sketch.extend',
  // The Ellipse flyout (its bar command): its variants fold with it. v0.5.0: the drawing groups
  // fold after the least-used sketch tools (Daniel: every drawing group on the bar).
  'sketch.ellipse',
  'sketch.polygon',
  'sketch.slot',
  'sketch.offset',
  'sketch.fillet',
  'sketch.pattern-circular',
  'sketch.pattern-linear',
  'sketch.mirror',
  'sketch.spline',
];

/**
 * The toolbar commands that never fold for the frame's width: each group's most-used command (and
 * CONSTRAIN, whose buttons are the constraints' own glyphs). Every toolbar command is either here
 * or in FOLD_ORDER (tests/app/bootstrap.test.tsx checks it, so a new command needs a decision).
 * (Before the v0.5.0 ribbon these were also the only model commands shown by default.)
 */
export const KEEP_IN_VIEW: readonly string[] = [
  'sketch.new',
  'solid.extrude',
  // P4b (PATTERN): PATTERN's most used command.
  'pattern.linear',
  'modify.fillet',
  // Chamfer beside Fillet: the two edge treatments sit together (P4a review).
  'modify.chamfer',
  'construct.plane',
  'cfd.enclosure',
  'inspect.measure',
  'file.import-step',
  'sketch.line',
  'sketch.rectangle',
  'sketch.circle',
  'sketch.arc',
  'sketch.dimension',
  'sketch.trim',
  // ux010: SCALE MODELS' Banana for scale (both modes). Never folded: it goes to its icon alone
  // (its group's title hidden) with VIEW and EDIT, the first step when the frame is narrow
  // (ui.css), so it never takes a label from a modelling command (smaller than a More would be).
  'scale.banana',
  'scale.sketch-banana',
];

/**
 * ux010 (Daniel: "a 'Banana for scale' button next to the 'View' section ... a new section called
 * [Scale Models]"): registry groups drawn right after VIEW (before EDIT) instead of with the
 * modelling groups. They rearrange, fold and keep their layout as the other groups do.
 */
export const AFTER_VIEW: ReadonlySet<string> = new Set(['scale']);

/**
 * The ribbon's squeeze order, the least-used group first (v0.5.0 ribbon). When the ribbon does not
 * fit with VIEW and EDIT as icons, the groups' small buttons go to their icons one group at a time
 * in this order (the name stays the tooltip and the accessible name); after every foldable command
 * is folded and the groups sit closer, the groups collapse into one dropdown button each in this
 * order (its menu lists the group's every command). DRAW goes last.
 */
export const SQUEEZE_ORDER: readonly string[] = ['file', 'inspect', 'construct', 'pattern', 'modify', 'cfd', 'solid', 'sketch', 'constrain', 'sketch-modify', 'dimension', 'scale', 'draw'];

/**
 * The large buttons of the ribbon (v0.5.0, Daniel: key tools large, "Finish sketch, Smart
 * Dimension, Line, Trim"): three rows tall, a bigger icon with the name under it. The mode's
 * primary action (Finish sketch) is always large; every other command is a small button.
 * Model mode: each group's main command (the one it shows by default).
 */
export const RIBBON_LARGE: ReadonlySet<string> = new Set([
  'sketch.new',
  'solid.extrude',
  'pattern.linear',
  'modify.fillet',
  'construct.plane',
  'cfd.enclosure',
  'inspect.measure',
  'file.import-step',
  'scale.banana',
  'scale.sketch-banana',
  'sketch.line',
  'sketch.trim',
  'sketch.dimension',
]);

/** Sentence case for the More menu's name: "MODIFY" -> "Modify", "CFD PREP" -> "Cfd prep". */
function groupWords(label: string): string {
  return label ? label[0] + label.slice(1).toLowerCase() : 'toolbar';
}

function modeOk(c: CommandDef, mode: Mode): boolean {
  return c.mode === 'any' || (c.mode ?? 'model') === mode;
}

/**
 * The VIEW group: the viewport's view commands (VIEWPORT registers and runs
 * them; they have no toolbar group or icon of their own), in this order, with
 * these icons. Any other ungrouped view.* command that brings an icon follows.
 */
export const VIEW_TOOLBAR: { id: string; icon: string }[] = [
  { id: 'view.fit', icon: ICONS.fit },
  { id: 'view.front', icon: ICONS.viewFront },
  { id: 'view.top', icon: ICONS.viewTop },
  { id: 'view.right', icon: ICONS.viewRight },
  { id: 'view.iso', icon: ICONS.viewIso },
];

function viewCommands(services: AppServices, mode: Mode): CommandDef[] {
  const out: CommandDef[] = [];
  for (const v of VIEW_TOOLBAR) {
    const c = services.commands.get(v.id);
    if (c && !c.group && modeOk(c, mode)) out.push({ ...c, icon: c.icon || v.icon, run: c.run, enabled: c.enabled });
  }
  const extra = services.commands
    .all()
    .filter((c) => !c.group && c.icon && c.id.startsWith('view.') && !VIEW_TOOLBAR.some((v) => v.id === c.id) && modeOk(c, mode))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));
  return [...out, ...extra];
}

function isActive(c: CommandDef, panel: UiState['panel'], sketchTool: string | null): boolean {
  if (c.pressed?.()) return true; // ux010 (DRAW): a toggled mode (sketch.construction)
  if (c.activeWhen?.sketchTool && sketchTool === c.activeWhen.sketchTool) return true;
  if (!panel) return false;
  if (c.id === PARAMS_ID) return panel.kind === 'params';
  if (panel.kind === 'tool') return c.activeWhen?.tool === panel.tool;
  if (panel.kind !== 'feature') return false;
  return c.id === `solid.${panel.type}` || c.activeWhen?.featureType === panel.type;
}

/**
 * A toolbar click (a button, a flyout's row, a More menu's item): the sketch tool in hand clicked
 * again is put down, exactly as its key pressed again (Daniel 2026-10-29; src/app/keyboard.ts
 * toolKeyAgain); any other command runs, so a click on a different tool switches to it.
 */
function runClicked(services: AppServices, id: string): void {
  const c = services.commands.get(id);
  if (c && toolKeyAgain(services.apis.get().sketch, c)) return;
  void services.commands.run(id);
}

/** Why a command cannot run right now, or null. */
function reasonOf(c: CommandDef, services: AppServices): string | null {
  let ok: true | string = true;
  try {
    ok = c.enabled ? c.enabled(services) : true;
  } catch (err) {
    ok = err instanceof Error ? err.message : String(err);
  }
  return ok === true ? null : ok;
}

/** What a group's button may do besides running its command: its right-click menu and a drag (useToolbarDrag). */
interface ButtonCustom {
  /** `keybindId`: the command Set keybind is for (a flyout's: the variant on its button). */
  onContextMenu(e: React.MouseEvent<HTMLButtonElement>, keybindId?: string): void;
  /** The same menu at a point, for one of a flyout's variants in its list (review 3: Set keybind for that variant). */
  menuAt?(x: number, y: number, keybindId: string): void;
  onPointerDown?(e: React.PointerEvent<HTMLButtonElement>): void;
  dragging?: boolean;
  drop?: 'before' | 'after' | null;
  /** UX 0.1.0: the command a drop from More would send to More ("Spline moves to More"). */
  displaced?: boolean;
}

function ToolbarButton({
  c,
  services,
  active,
  index,
  primary = false,
  custom,
  variant,
  onKeyDown,
  size = 'small',
  text,
}: {
  c: CommandDef;
  services: AppServices;
  active: boolean;
  index: number;
  primary?: boolean;
  custom?: ButtonCustom;
  /** A flyout's bar button: the variant it shows and runs (its own id stays the flyout's bar id). */
  variant?: CommandDef;
  onKeyDown?(e: React.KeyboardEvent<HTMLButtonElement>): void;
  /** The ribbon's large button (three rows, the name under the icon) or a small one (one row). */
  size?: 'large' | 'small';
  /** The name shown on the button when not the command's (a flyout shows its own: "Slot"). */
  text?: string;
}) {
  const shown = variant ?? c;
  const reason = reasonOf(shown, services);
  const tip = useTip(custom?.dragging ? null : { text: shown.label, shortcut: shown.shortcut, detail: reason ?? shown.hint });
  const drop = custom?.drop ? ` is-drop-${custom.drop}` : '';
  return (
    <button
      type="button"
      className={`tb-btn is-${size}${primary ? ' is-primary' : ''}${active ? ' is-active' : ''}${reason ? ' is-disabled' : ''}${custom?.dragging ? ' is-dragging' : ''}${drop}${custom?.displaced ? ' is-displaced' : ''}`}
      data-command={c.id}
      data-variant={variant ? variant.id : undefined}
      data-index={index}
      aria-label={shown.label}
      aria-disabled={reason ? true : undefined}
      aria-pressed={active || undefined}
      aria-keyshortcuts={shown.shortcut ? shown.shortcut.replace(/Ctrl/g, 'Control') : undefined}
      data-disabled-reason={reason ?? undefined}
      {...tip}
      onContextMenu={custom ? (e) => custom.onContextMenu(e, variant?.id) : undefined}
      onPointerDown={custom?.onPointerDown}
      onKeyDown={onKeyDown}
      onClick={() => {
        // A More menu left open beside this button (a press here no longer closes it: a bar
        // command may be dragged into it) closes on the click.
        const ui = uiFor(services);
        if (ui.state.get().menu) ui.closeMenu();
        if (reason) return;
        if (variant && c.flyout) setLastUsed(services, c.flyout, variant.id);
        runClicked(services, shown.id);
      }}
    >
      <span className="tb-ico">{shown.icon ? <Icon d={shown.icon} size={size === 'large' ? 24 : 16} stroke={1.7} className="tb-svg" {...(shown.iconColors ? { colors: shown.iconColors } : {})} /> : null}</span>
      <span className="tb-txt">{text ?? shown.label}</span>
    </button>
  );
}

/**
 * A flyout (v0.5.0): its bar button, which runs the variant in use or last used, and the arrow
 * beside it that lists every variant (icon, name, shortcut, hint; disabled ones say why).
 * Keyboard: Down (or Up) on the button or the arrow opens the list on its first (last) variant;
 * the menu's arrows, Home, End, Enter and Escape as in a More menu.
 */
function FlyoutButton({
  c,
  def,
  variants,
  services,
  panel,
  sketchTool,
  index,
  primary,
  custom,
  size,
}: {
  size: 'large' | 'small';
  c: CommandDef;
  def: FlyoutDef;
  variants: CommandDef[];
  services: AppServices;
  panel: UiState['panel'];
  sketchTool: string | null;
  index: number;
  primary: boolean;
  custom?: ButtonCustom;
}) {
  const ui = uiFor(services);
  const owner = `tb-flyout:${c.id}`;
  const open = useStateStore(ui.state, (s) => s.menu?.owner === owner);
  const ref = useRef<HTMLButtonElement>(null);
  const activeOf = (x: CommandDef) => isActive(x, panel, sketchTool);
  const cur = currentVariant(services, c.id, variants, activeOf, def.id);
  const inUse = variants.find(activeOf);
  // The variant in use is the one the button runs next time.
  useEffect(() => {
    if (inUse) setLastUsed(services, def.id, inUse.id);
  }, [inUse, services, def.id]);
  const name = `${def.label} tools`;
  const tip = useTip(open ? null : { text: name, detail: variants.map((x) => x.label).join(', ') });
  const show = (last = false) => {
    const el = ref.current;
    if (!el) return;
    // Under the flyout (its button and arrow).
    const r = (el.parentElement ?? el).getBoundingClientRect();
    const items: MenuEntry[] = variants.map((x) => ({
      id: x.id,
      command: x.id,
      label: x.label,
      ...(x.icon ? { icon: x.icon } : {}),
      ...(x.shortcut ? { shortcut: x.shortcut } : {}),
      ...(x.hint ? { hint: x.hint } : {}),
      disabled: reasonOf(x, services),
      active: activeOf(x),
      // A right-click on a variant: the flyout's menu with Set keybind for that variant.
      ...(custom?.menuAt ? { onContext: (mx: number, my: number) => custom.menuAt!(mx, my, x.id) } : {}),
      run: () => {
        setLastUsed(services, def.id, x.id);
        runClicked(services, x.id);
      },
    }));
    ui.showMenu(r.left, r.bottom + 2, items, name, { owner, anchor: el });
    if (last) {
      requestAnimationFrame(() => {
        const all = document.querySelectorAll<HTMLButtonElement>('[data-cad-menu] button[role="menuitem"]');
        all[all.length - 1]?.focus();
      });
    }
  };
  const keys = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
      e.preventDefault();
      show(e.key === 'ArrowUp');
    }
  };
  return (
    // The button and its arrow as one item of the ribbon: the arrow beside a small button, under a large one.
    <div className={`tb-split is-${size}`} data-tb-split={c.id}>
      <ToolbarButton c={c} services={services} active={variants.some(activeOf)} index={index} primary={primary} custom={custom} variant={cur} onKeyDown={keys} size={size} text={def.label} />
      <button
        ref={ref}
        type="button"
        className={`tb-btn tb-flyout-arrow${open ? ' is-open' : ''}`}
        data-tb-flyout={c.id}
        data-tb-flyout-group={def.id}
        // Out of the Tab order (Tab goes button to button as before): Down on the button opens the list.
        tabIndex={-1}
        data-flyout-commands={variants.map((x) => x.id).join(' ')}
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={open}
        {...tip}
        // Its right-click: the flyout's menu, Set keybind for the variant on the button.
        onContextMenu={custom ? (e) => custom.onContextMenu(e, cur.id) : undefined}
        onClick={() => (open ? ui.closeMenu() : show())}
        onKeyDown={keys}
      >
        <span className="tb-caret" aria-hidden="true">
          ▾
        </span>
      </button>
    </div>
  );
}

/**
 * A group's "More ▾": its folded commands in a menu with the core's menu look (the context
 * menu's), each with its icon, label, shortcut and tooltip; disabled ones say why. Keyboard: Enter,
 * Space or Down opens it on the first command (Up on the last), the arrows, Home and End move,
 * Enter runs, Escape or Tab closes it and gives this button the keyboard back. Drawn pressed
 * while one of its commands' panels is open.
 */
function MoreButton({
  group,
  label,
  commands,
  first,
  services,
  panel,
  sketchTool,
  itemMenu,
  onItemPress,
  dropInto = false,
  collapsed = false,
  large = true,
}: {
  /** A collapsed group's button is large (three rows or more) or small. */
  large?: boolean;
  /**
   * v0.5.0 ribbon: the whole group collapsed into this one dropdown (the frame too narrow): a large
   * button with the group's name and its first command's icon; the menu lists every command.
   */
  collapsed?: boolean;
  group: string;
  label: string;
  commands: CommandDef[];
  first: number;
  services: AppServices;
  panel: UiState['panel'];
  sketchTool: string | null;
  /** The right-click menu of one of its items (Show in toolbar, Reset toolbar). */
  itemMenu?(c: CommandDef, x: number, y: number): void;
  /** UX 0.1.0: a press on one of its items (it may be dragged onto the bar). */
  onItemPress?(c: CommandDef, e: React.PointerEvent<HTMLButtonElement>): void;
  /** A bar command dragged here would go to More. */
  dropInto?: boolean;
}) {
  const ui = uiFor(services);
  const owner = collapsed ? `tb-group-menu:${group}` : `tb-more:${group}`;
  const open = useStateStore(ui.state, (s) => s.menu?.owner === owner);
  const ref = useRef<HTMLButtonElement>(null);
  const active = commands.some((c) => isActive(c, panel, sketchTool));
  const name = collapsed ? `${groupWords(label)} commands` : `More ${groupWords(label)} commands`;
  const tip = useTip(open ? null : { text: name, detail: commands.map((c) => c.label).join(', ') });
  const show = (last = false) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const items: MenuEntry[] = commands.map((c) => ({
      id: c.id,
      command: c.id,
      label: c.label,
      ...(c.icon ? { icon: c.icon } : {}),
      ...(c.iconColors ? { iconColors: c.iconColors } : {}),
      ...(c.shortcut ? { shortcut: c.shortcut } : {}),
      ...(c.hint ? { hint: c.hint } : {}),
      disabled: reasonOf(c, services),
      active: isActive(c, panel, sketchTool),
      // ux010 (review N2): a toggle (Construction drawing) is a checkbox item with its check mark.
      ...(c.pressed ? { checked: !!c.pressed() } : {}),
      ...(itemMenu ? { onContext: (x: number, y: number) => itemMenu(c, x, y) } : {}),
      ...(onItemPress ? { onPress: (e: React.PointerEvent<HTMLButtonElement>) => onItemPress(c, e) } : {}),
      run: () => runClicked(services, c.id),
    }));
    ui.showMenu(r.left, r.bottom + 2, items, name, { owner, anchor: el });
    if (last) {
      // Up opens it on its last command.
      requestAnimationFrame(() => {
        const all = document.querySelectorAll<HTMLButtonElement>('[data-cad-menu] button[role="menuitem"]');
        all[all.length - 1]?.focus();
      });
    }
  };
  return (
    <button
      ref={ref}
      type="button"
      className={`tb-btn ${collapsed ? `${large ? 'is-large' : 'is-small'} tb-group-menu` : 'is-small tb-more'}${active ? ' is-active' : ''}${open ? ' is-open' : ''}${dropInto ? ' is-drop-into' : ''}`}
      data-tb-more={collapsed ? undefined : group}
      data-tb-group-menu={collapsed ? group : undefined}
      data-index={first}
      data-more-commands={commands.map((c) => c.id).join(' ')}
      aria-label={name}
      aria-haspopup="menu"
      aria-expanded={open}
      {...tip}
      onClick={() => (open ? ui.closeMenu() : show())}
      onKeyDown={(e) => {
        if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
          e.preventDefault();
          show(e.key === 'ArrowUp');
        }
      }}
    >
      <span className="tb-ico">
        <Icon d={collapsed && commands[0]?.icon ? commands[0].icon : ICONS.more} size={collapsed ? 24 : 16} stroke={1.7} className="tb-svg" {...(collapsed && commands[0]?.iconColors ? { colors: commands[0].iconColors } : {})} />
      </span>
      <span className="tb-txt">
        {collapsed ? groupWords(label) : 'More'} <span className="tb-caret" aria-hidden="true">▾</span>
      </span>
    </button>
  );
}

/**
 * Why a More item is there because of the group's width: false (not the width), 'fits' (pinned it
 * would come out, another command folding instead), 'too-narrow' (it would not fit even with every
 * other command folded: Show in toolbar is greyed with the reason, review 6).
 */
type NarrowFold = false | 'fits' | 'too-narrow';

/** What a registry group needs to let the user rearrange it. */
interface GroupCustom {
  /** The right-click menu of a command shown in the group (`keybindId`: Set keybind's command). */
  barMenu(c: CommandDef, shown: string[], x: number, y: number, keybindId?: string): void;
  /**
   * The right-click menu of a command in the group's More (`shown`: the group's commands on the bar;
   * `narrow`: it is there because the person narrowed the group).
   */
  moreMenu(c: CommandDef, shown: string[], x: number, y: number, narrow: NarrowFold, keybindId?: string): void;
  /** A command's own right-click menu (Set keybind, Reset toolbar): a collapsed group's dropdown items. */
  commandMenu(x: number, y: number, commandId: string): void;
  /** Dragged onto the bar from More: folds last when the group is narrowed. */
  isHeld(id: string): boolean;
  /** Shown by the person ("Show in toolbar"): folds after the others when the group is narrowed. */
  isPinned(id: string): boolean;
}

/** The drop mark on a bar button: the dragged command lands before or after it. */
interface Mark {
  target: string;
  after: boolean;
}

/** Where a toolbar drag would drop now (useToolbarDrag). */
type DropAt =
  /** A More command onto its group's bar, at gap `index`; `displaced` goes to More. */
  | { kind: 'bar'; group: string; index: number; mark: Mark | null; displaced: string | null }
  /** A bar command along its group. */
  | { kind: 'move'; group: string; mark: Mark }
  /** A bar command into its group's More (the open menu, or the More button). */
  | { kind: 'more'; group: string; menu: boolean }
  /** Over another group: refused, nothing changes. */
  | { kind: 'refused'; group: string }
  | { kind: 'none' };

/** The drag in progress, as the toolbar draws it. */
interface DragView {
  id: string;
  group: string;
  from: 'bar' | 'more';
  label: string;
  icon?: string;
  x: number;
  y: number;
  at: DropAt;
  /** The note under the pointer ("Spline moves to More"), or null. */
  note: string | null;
}

const DRAG_PX = 6;
/** A More item becomes a drag when the pointer leaves it or goes this far up (toward the bar). */
const MORE_PX = 10;

function Group({
  id,
  label,
  commands,
  folded,
  services,
  panel,
  sketchTool,
  end = false,
  primary = false,
  icons = false,
  custom,
  menu,
  drag,
  startDrag,
  flyouts,
  collapsed = false,
  rows = RIBBON_ROWS,
  width = null,
  resize,
  scaleTick = 0,
}: {
  /** Bumped when the toolbar's scale changes (setToolbarScale): the group measures again. */
  scaleTick?: number;
  /** v0.5.0 ribbon: the frame is too narrow for the group: one dropdown button lists its commands. */
  collapsed?: boolean;
  /** The toolbar's rows (large buttons only from three rows). */
  rows?: number;
  /** The group's width the person set (px at scale 1), or null: as wide as its commands. */
  width?: number | null;
  /** The line at its right: dragged, double-clicked or arrowed to set the group's width. */
  resize?: ResizeHandlers;
  id: string;
  label: string;
  commands: CommandDef[];
  /** v0.5.0: the group's flyouts (bar id -> variants, def). */
  flyouts?: { variants: Map<string, CommandDef[]>; defs: Map<string, FlyoutDef> };
  folded?: ReadonlySet<string>;
  services: AppServices;
  panel: UiState['panel'];
  sketchTool: string | null;
  end?: boolean;
  primary?: boolean;
  /** Its small buttons show their icons alone (CONSTRAIN always; others when the frame is narrow, SQUEEZE_ORDER). */
  icons?: boolean;
  custom?: GroupCustom;
  /** VIEW, EDIT and the primary action: their right-click menu (Set keybind on a command, Reset toolbar). */
  menu?(x: number, y: number, commandId?: string): void;
  /** The toolbar's drag in progress (any group's), to draw its marks here. */
  drag?: DragView | null;
  /** A press on one of the group's commands, on the bar or in its More: it may become a drag. */
  startDrag?(c: CommandDef, from: 'bar' | 'more', e: React.PointerEvent<HTMLButtonElement>): void;
}) {
  // v0.5.0 ribbon: a group the person narrowed puts what does not fit into its More, as the frame's
  // fold does: the least used first (FOLD_ORDER), then from its end; a command the person showed
  // ("Show in toolbar", pinned) after those, and one dragged onto the bar (held) last; never its
  // first command. Measured before paint, again from none whenever the width, the rows, the scale or
  // what is pinned change, so a widened group gets its commands back.
  // The group is never narrower than its first command and its More (review 1: a narrower width
  // clipped the More, and with it every folded command): that minimum is measured once there is a
  // More (or for a one-command group, its command), and the width applied is at least that
  // (`data-min-width`; Toolbar's handlers and the Assistant keep the stored width to it).
  const itemsRef = useRef<HTMLDivElement | null>(null);
  // The group going away (its toolbar's mode changed) ends a drag of its line (review 5).
  const resizeRef = useRef(resize);
  resizeRef.current = resize;
  useEffect(() => () => resizeRef.current?.gone(id), [id]);
  const open = commands.filter((c) => !folded?.has(c.id));
  const isHeld = (x: string) => !!custom?.isHeld(x);
  const isPinned = (x: string) => !!custom?.isPinned(x);
  const candidates =
    width == null || collapsed || open.length < 2
      ? []
      : (() => {
          const rest = open.slice(1);
          const byFold = FOLD_ORDER.filter((x) => rest.some((c) => c.id === x));
          const others = rest
            .map((c) => c.id)
            .filter((x) => !byFold.includes(x))
            .reverse();
          const all = [...byFold, ...others];
          return [...all.filter((x) => !isHeld(x) && !isPinned(x)), ...all.filter((x) => !isHeld(x) && isPinned(x)), ...all.filter(isHeld)];
        })();
  const fitKey = `${width}|${rows}|${scaleTick}|${open.map((c) => `${c.id}${isPinned(c.id) ? '+' : ''}${isHeld(c.id) ? '!' : ''}`).join(' ')}|${icons ? 1 : 0}`;
  const [wf, setWf] = useState({ key: '', n: 0 });
  const nNarrow = wf.key === fitKey ? wf.n : 0;
  const [minW, setMinW] = useState({ key: '', px: 0 });
  const need = minW.key === fitKey ? minW.px : 0;
  const applied = width == null ? null : Math.max(width, Math.ceil(need));
  // Each item's width as last drawn at this fit (px at scale 1; a flyout's with its arrow), and the
  // More's: so a narrowed group can tell whether a folded command would fit if shown (review 6).
  const sizes = useRef<{ key: string; gap: number; w: Map<string, { w: number; large: boolean }> }>({ key: '', gap: 0, w: new Map() });
  useLayoutEffect(() => {
    const el = itemsRef.current;
    const box = el?.parentElement;
    if (!el || width == null || collapsed) {
      if (box) delete box.dataset.tooNarrowFor;
      return;
    }
    const s = scaleOf(el);
    const kids = Array.from(el.children) as HTMLElement[];
    // Each item's own width, not stretched to its column's (a small button beside a wider one in its
    // column fills the column): measured with the items set to their start for a moment, before
    // paint (integration verify 6a: Shell took Press-pull's width and was greyed "too narrow").
    el.style.justifyItems = 'start';
    const own = new Map(kids.map((k) => [k, k.getBoundingClientRect()] as const));
    el.style.justifyItems = '';
    if (sizes.current.key !== fitKey) sizes.current = { key: fitKey, gap: (parseFloat(getComputedStyle(el).columnGap) || 0) / s, w: new Map() };
    for (const k of kids) {
      const cmd = k.dataset.tbMore != null ? '__more' : (k.dataset.command ?? k.querySelector<HTMLElement>('[data-command]')?.dataset.command);
      if (cmd) sizes.current.w.set(cmd, { w: own.get(k)!.width / s, large: k.classList.contains('is-large') });
    }
    // The minimum: the first command, and the More beside it, or under it when the first is a
    // small button sharing its column (a group of one: its command).
    const moreEl = el.querySelector<HTMLElement>(':scope > [data-tb-more]');
    const first = kids.find((k) => k !== moreEl);
    if (first && (moreEl || !candidates.length)) {
      const f = own.get(first)!;
      const m = moreEl ? own.get(moreEl)! : null;
      const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
      const px = (!m ? f.width : Math.abs(m.left - f.left) < 1 ? Math.max(f.width, m.width) : f.width + gap + m.width) / s;
      if (Math.abs(px - need) > 0.5) setMinW({ key: fitKey, px });
    }
    if (nNarrow < candidates.length && el.scrollWidth > el.clientWidth + 1) setWf({ key: fitKey, n: nNarrow + 1 });
    // A fit with nothing to fold is kept as this key's too (integration verify 6b): a width the
    // group comes back to later is measured from nothing folded again, so the sizes of the commands
    // it folds are always known when Show in toolbar asks.
    else if (wf.key !== fitKey) setWf({ key: fitKey, n: nNarrow });
    // The folded commands that would not fit even if shown (the Assistant's toolbar_show reads it).
    if (box) {
      const no = candidates.slice(0, nNarrow).filter((x) => !wouldFit(x));
      if (no.length) box.dataset.tooNarrowFor = no.join(' ');
      else delete box.dataset.tooNarrowFor;
    }
  });
  const narrow = new Set(candidates.slice(0, nNarrow));
  /**
   * Whether `x` (folded for the group's width) would fit if the person showed it: with every
   * unpinned command but the first folded, the pinned and held ones kept, laid out in the rows
   * column by column beside the More. Unknown sizes: assume it fits.
   */
  const wouldFit = (x: string): boolean => {
    const known = sizes.current.key === fitKey ? sizes.current : null;
    const moreW = known?.w.get('__more');
    if (!known || !moreW || applied == null) return true;
    const keep = open.filter((c, i) => i === 0 || c.id === x || isPinned(c.id) || isHeld(c.id)).map((c) => known.w.get(c.id));
    if (keep.some((k) => !k)) return true;
    let total = 0;
    let cols = 0;
    let colW = 0;
    let inCol = 0;
    const flush = () => {
      if (!inCol) return;
      total += colW;
      cols++;
      colW = 0;
      inCol = 0;
    };
    for (const it of [...(keep as { w: number; large: boolean }[]), moreW]) {
      if (it.large) {
        flush();
        total += it.w;
        cols++;
        continue;
      }
      colW = Math.max(colW, it.w);
      if (++inCol === rows) flush();
    }
    flush();
    return total + known.gap * Math.max(0, cols - 1) <= applied + 1;
  };

  const more = commands.filter((c) => folded?.has(c.id) || narrow.has(c.id));
  /** A variant listed in More stands for its flyout (moved, dragged and shown as one). */
  const barOf = (c: CommandDef): CommandDef => more.find((m) => flyouts?.variants.get(m.id)?.some((v) => v.id === c.id)) ?? c;
  const shown = commands.filter((c) => !more.includes(c)).map((c) => c.id);
  const at = drag?.at;
  const mark = at && (at.kind === 'bar' || at.kind === 'move') && at.group === id ? at.mark : null;
  const customFor = (c: CommandDef): ButtonCustom | undefined => {
    if (!custom)
      return menu
        ? {
            onContextMenu: (e, kb) => (e.preventDefault(), e.stopPropagation(), menu(e.clientX, e.clientY, kb ?? c.id)),
            menuAt: (x, y, kb) => menu(x, y, kb),
          }
        : undefined;
    return {
      onContextMenu(e, kb) {
        e.preventDefault();
        e.stopPropagation();
        custom.barMenu(c, shown, e.clientX, e.clientY, kb ?? c.id);
      },
      menuAt: (x, y, kb) => custom.barMenu(c, shown, x, y, kb),
      onPointerDown(e) {
        startDrag?.(c, 'bar', e);
      },
      dragging: drag?.from === 'bar' && drag.id === c.id,
      drop: mark && mark.target === c.id ? (mark.after ? 'after' : 'before') : null,
      displaced: at?.kind === 'bar' && at.group === id && at.displaced === c.id,
    };
  };
  return (
    <div
      className={`tb-group${end ? ' is-end' : ''}${icons ? ' is-icons' : ''}${collapsed ? ' is-collapsed' : ''}${at?.kind === 'refused' && at.group === id ? ' is-drop-refused' : ''}`}
      data-group={id}
      data-icons={icons ? '1' : undefined}
      data-collapsed={collapsed ? '1' : undefined}
      data-width={applied ?? undefined}
      data-width-set={width ?? undefined}
      data-min-width={width != null && need ? Math.ceil(need) : undefined}
      data-width-folded={width != null ? nNarrow : undefined}
      data-drop-refused={at?.kind === 'refused' && at.group === id ? '1' : undefined}
      role="group"
      aria-label={label}
      onContextMenu={
        menu
          ? (e) => {
              e.preventDefault();
              menu(e.clientX, e.clientY);
            }
          : undefined
      }
    >
      <div className="tb-group-label" style={applied != null ? { maxWidth: `calc(${applied}px * var(--cad-toolbar-scale))` } : undefined}>
        {label}
      </div>
      {/* data-menu-keep: a press on the group's buttons leaves its open More menu open (a bar command may be dragged into it). */}
      <div ref={itemsRef} className={`tb-items${applied != null && !collapsed ? ' is-sized' : ''}`} data-menu-keep={custom ? '1' : undefined} style={applied != null && !collapsed ? { width: `calc(${applied}px * var(--cad-toolbar-scale))` } : undefined}>
        {collapsed ? (
          <MoreButton
            group={id}
            label={label}
            commands={commands.flatMap((c) => flyouts?.variants.get(c.id) ?? [c])}
            first={0}
            services={services}
            panel={panel}
            sketchTool={sketchTool}
            collapsed
            large={rows >= RIBBON_ROWS}
            // Review 3: each command of the dropdown has its right-click (Set keybind, Reset toolbar).
            {...(custom || menu ? { itemMenu: (c: CommandDef, x: number, y: number) => (custom ? custom.commandMenu(x, y, c.id) : menu!(x, y, c.id)) } : {})}
          />
        ) : null}
        {commands.map((c, i) => {
          if (collapsed || more.includes(c)) return null;
          const size = rows >= RIBBON_ROWS && (primary || RIBBON_LARGE.has(c.id)) ? 'large' : 'small';
          const vs = flyouts?.variants.get(c.id);
          const def = flyouts?.defs.get(c.id);
          if (vs && def) return <FlyoutButton key={c.id} c={c} def={def} variants={vs} services={services} panel={panel} sketchTool={sketchTool} index={i} primary={primary} custom={customFor(c)} size={size} />;
          return <ToolbarButton key={c.id} c={c} services={services} active={isActive(c, panel, sketchTool)} index={i} primary={primary} custom={customFor(c)} size={size} />;
        })}
        {more.length && !collapsed ? (
          <MoreButton
            group={id}
            label={label}
            commands={more.flatMap((c) => flyouts?.variants.get(c.id) ?? [c])}
            first={commands.indexOf(more[0])}
            services={services}
            panel={panel}
            sketchTool={sketchTool}
            dropInto={at?.kind === 'more' && at.group === id}
            {...(custom
              ? { itemMenu: (c: CommandDef, x: number, y: number) => custom.moreMenu(barOf(c), shown, x, y, narrow.has(barOf(c).id) ? (wouldFit(barOf(c).id) ? 'fits' : 'too-narrow') : false, c.id) }
              : menu
                ? // VIEW's and EDIT's More (a narrowed group): Set keybind, Reset toolbar (review 3).
                  { itemMenu: (c: CommandDef, x: number, y: number) => menu(x, y, c.id) }
                : {})}
            {...(custom && startDrag ? { onItemPress: (c: CommandDef, e: React.PointerEvent<HTMLButtonElement>) => startDrag(barOf(c), 'more', e) } : {})}
          />
        ) : null}
      </div>
      {resize ? (
        <div
          className="tb-resize"
          data-tb-resize={id}
          role="separator"
          aria-orientation="vertical"
          aria-label={`${groupWords(label)} width`}
          aria-valuenow={applied ?? undefined}
          aria-valuetext={applied == null ? 'as wide as its commands' : `${applied} px`}
          aria-valuemin={Math.max(MIN_GROUP_W, Math.ceil(need))}
          aria-valuemax={MAX_GROUP_W}
          // In the Tab order (review 5): Left / Right step it, Home sets it back to auto.
          tabIndex={0}
          title="Drag (or Left / Right) to make the group narrower or wider; double-click or Home: as wide as its commands"
          onPointerDown={(e) => resize.start(id, e)}
          onDoubleClick={() => resize.auto(id)}
          onKeyDown={(e) => resize.key(id, e)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            resize.menu(id, e.clientX, e.clientY);
          }}
        />
      ) : null}
    </div>
  );
}

/** The line at a group's right (v0.5.0 ribbon): Toolbar's handlers. */
interface ResizeHandlers {
  start(group: string, e: React.PointerEvent<HTMLDivElement>): void;
  auto(group: string): void;
  key(group: string, e: React.KeyboardEvent<HTMLDivElement>): void;
  menu(group: string, x: number, y: number): void;
  /** The group's line went away (its toolbar's mode changed): a drag on it ends, keeping nothing. */
  gone(group: string): void;
}

/**
 * The right-click menus that rearrange the toolbar (P4b fix round 1). A command on the bar: Move to
 * More, Move earlier / Move later (the keyboard's and the mouse's way to reorder, besides a drag;
 * one step in the ribbon's reading order, which is up or down its column for a small button),
 * Reset toolbar. A command in More: Show in toolbar (greyed with the reason when the frame is too
 * narrow for it), Swap with <the bar's last> (UX 0.1.0: the keyboard's way to do what a drag from
 * More onto the bar's last slot does), Reset toolbar. Anywhere else on the toolbar: Reset toolbar.
 * "Show in toolbar" adds the command without sending another to More (in a narrowed group the
 * group's other commands fold first to make room).
 */
function customizer(services: AppServices, prefs: ToolbarPrefs, mode: LayoutMode, m: ModeLayout, fitFolded: ReadonlySet<string>) {
  const ui = uiFor(services);
  const set = (next: ModeLayout) => prefs.setMode(mode, next);
  const reset: MenuEntry = {
    id: 'tb-reset',
    label: 'Reset toolbar',
    disabled: isDefault(m) ? 'The toolbar is already as it was at first' : null,
    run: () => prefs.reset(mode),
  };
  const labelOf = (id: string) => services.commands.get(id)?.label ?? id;
  /** Set keybind for a command, in its own section above Reset toolbar. */
  const keybind = (id: string | undefined): MenuEntry[] => (id ? [{ sep: true, id: 'tb-sep-keys' }, keybindMenuItem(services, id)] : []);
  // Finish sketch's menu sets Place or finish's key too (Enter: it places what a tool draws, else finishes the sketch).
  const keybindItems = (id: string): MenuEntry[] =>
    id === WELL_KNOWN_COMMANDS.sketchFinish ? [keybindMenuItem(services, id), keybindMenuItem(services, 'sketch.enter', 'Set keybind for Place or finish…')] : [keybindMenuItem(services, id)];
  const menu = (x: number, y: number, commandId?: string) =>
    ui.showMenu(x, y, commandId ? [...keybindItems(commandId), { sep: true, id: 'tb-sep' }, reset] : [reset], commandId ? `Toolbar: ${labelOf(commandId)}` : 'Toolbar');
  const forGroup = (group: string, order: string[]): GroupCustom => ({
    commandMenu: (x, y, commandId) => menu(x, y, commandId),
    barMenu(c, shown, x, y, keybindId) {
      const i = shown.indexOf(c.id);
      const after = (id: string) => order[order.indexOf(id) + 1] ?? null;
      ui.showMenu(
        x,
        y,
        [
          { id: 'tb-to-more', label: 'Move to More', run: () => set(withPlace(m, c.id, 'more')) },
          {
            id: 'tb-left',
            label: 'Move earlier',
            disabled: i <= 0 ? `${c.label} is the first of its group` : null,
            run: () => set(withMove(m, group, order, c.id, shown[i - 1])),
          },
          {
            id: 'tb-right',
            label: 'Move later',
            disabled: i < 0 || i >= shown.length - 1 ? `${c.label} is the last of its group` : null,
            run: () => set(withMove(m, group, order, c.id, after(shown[i + 1]))),
          },
          ...keybind(keybindId ?? c.id),
          { sep: true, id: 'tb-sep' },
          reset,
        ],
        `Toolbar: ${c.label}`,
      );
    },
    isHeld: (id) => held(m, id),
    isPinned: (id) => pinned(m, id),
    moreMenu(c, shown, x, y, narrow, keybindId) {
      // Greyed with why when showing it would change nothing (review 6): the group would still be too
      // narrow for it with every other command folded, or the frame folded it although pinned.
      const stuck = narrow === 'too-narrow' || (pinned(m, c.id) && fitFolded.has(c.id));
      const last = shown.length ? shown[shown.length - 1] : null;
      ui.showMenu(
        x,
        y,
        [
          {
            id: 'tb-to-bar',
            label: 'Show in toolbar',
            disabled: stuck
              ? narrow
                ? 'The group is too narrow for it: widen it (drag the line at its right) or move another command to More'
                : 'The toolbar is full at this width: move another command to More to make room'
              : null,
            run: () => set(withPlace(m, c.id, 'bar')),
          },
          ...(last
            ? [
                {
                  id: 'tb-swap',
                  label: `Swap with ${labelOf(last)}`,
                  run: () => set(withSwapIn(m, group, order, shown, c.id, shown.length)),
                },
              ]
            : []),
          ...keybind(keybindId ?? c.id),
          { sep: true, id: 'tb-sep' },
          reset,
        ],
        `Toolbar: ${c.label}`,
      );
    },
  });
  return { forGroup, menu };
}

/** What the toolbar's drag needs from the current render (read when the pointer moves or lets go). */
interface DragLive {
  services: AppServices;
  prefs: ToolbarPrefs;
  mode: LayoutMode;
  m: ModeLayout;
  groups: { group: string; label: string; order: string[] }[];
}

const rectHas = (r: DOMRect, x: number, y: number) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

/**
 * Whether the point is past the button in the ribbon's reading order (v0.5.0 ribbon: column by
 * column, top to bottom in each): right of its column, or in its column below its middle (a large
 * button, the rows tall: right of its middle). Large or small by its class, not its height, so it
 * holds at every scale (review 6).
 */
export function pastButton(r: { left: number; right: number; top: number; bottom: number }, x: number, y: number, large: boolean): boolean {
  if (x >= r.right) return true;
  if (x < r.left) return false;
  return large ? x > (r.left + r.right) / 2 : y > (r.top + r.bottom) / 2;
}

/**
 * Dragging a command (UX 0.1.0): from a group's More menu onto its bar, from the bar into its More,
 * or along the bar. Pointer events on the window (the menu's item goes away while it is dragged,
 * so nothing is captured there), so it works with a mouse in the sandboxed frame. A press becomes
 * a drag after DRAG_PX; Escape cancels it; the click that ends a drag runs nothing.
 */
function useToolbarDrag(bar: React.RefObject<HTMLDivElement | null>, live: React.RefObject<DragLive>) {
  const [view, setView] = useState<DragView | null>(null);
  const cur = useRef<(DragView & { pointer: number; x0: number; y0: number; active: boolean }) | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const menuEl = () => document.querySelector<HTMLElement>('[data-cad-menu]');
  const groupEl = (g: string) => bar.current?.querySelector<HTMLElement>(`:scope > .tb-group[data-group="${CSS.escape(g)}"]`) ?? null;
  /** The toolbar group under (or nearest above or below) the pointer, or null off the toolbar. */
  const groupAt = (x: number, y: number): string | null => {
    const root = bar.current;
    if (!root) return null;
    const r = root.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top - 4 || y > r.bottom + 12) return null;
    let best: { g: string; d: number } | null = null;
    for (const el of root.querySelectorAll<HTMLElement>(':scope > .tb-group')) {
      const gr = el.getBoundingClientRect();
      const d = x < gr.left ? gr.left - x : x > gr.right ? x - gr.right : 0;
      if (!best || d < best.d) best = { g: el.dataset.group ?? '', d };
    }
    return best && best.d <= 12 ? best.g : null;
  };
  const buttonsOf = (g: string, except?: string) =>
    [...(groupEl(g)?.querySelectorAll<HTMLElement>('.tb-items .tb-btn[data-command]') ?? [])].filter((el) => el.dataset.command !== except);

  const dropAt = (d: DragView, x: number, y: number): DropAt => {
    const menu = menuEl();
    const ui = uiFor(live.current.services);
    if (menu && rectHas(menu.getBoundingClientRect(), x, y)) {
      // In the open menu: a More command is back home; a bar command goes into its own group's More.
      if (d.from === 'more') return { kind: 'none' };
      return ui.state.get().menu?.owner === `tb-more:${d.group}` ? { kind: 'more', group: d.group, menu: true } : { kind: 'none' };
    }
    const g = groupAt(x, y);
    if (g == null) return { kind: 'none' };
    if (g !== d.group) return { kind: 'refused', group: g };
    if (d.from === 'more') {
      const btns = buttonsOf(g);
      const shown = btns.map((el) => el.dataset.command ?? '');
      const index = btns.filter((el) => pastButton(el.getBoundingClientRect(), x, y, el.classList.contains('is-large'))).length;
      const mark = index < shown.length ? { target: shown[index], after: false } : shown.length ? { target: shown[shown.length - 1], after: true } : null;
      return { kind: 'bar', group: g, index, mark, displaced: shown.length ? shown[shown.length - 1] : null };
    }
    // A bar command: onto its group's More button is Move to More; elsewhere in the group, a move.
    const mr = groupEl(g)?.querySelector<HTMLElement>('[data-tb-more]')?.getBoundingClientRect();
    // (The More button is one of the ribbon's small buttons: over the button itself.)
    if (mr && rectHas(mr, x, y)) return { kind: 'more', group: g, menu: false };
    let best: { target: string; after: boolean; dist: number } | null = null;
    for (const el of buttonsOf(g, d.id)) {
      const r = el.getBoundingClientRect();
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const dist = Math.hypot(dx, dy);
      if (!best || dist < best.dist) best = { target: el.dataset.command ?? '', after: pastButton(r, x, y, el.classList.contains('is-large')), dist };
    }
    return best ? { kind: 'move', group: g, mark: { target: best.target, after: best.after } } : { kind: 'none' };
  };

  const noteOf = (d: DragView, at: DropAt): string | null => {
    const label = (id: string) => live.current.services.commands.get(id)?.label ?? id;
    if (at.kind === 'bar') return at.displaced ? `${label(at.displaced)} moves to More` : `${d.label} goes on the toolbar`;
    if (at.kind === 'more') return `${d.label} moves to More`;
    if (at.kind === 'refused') {
      const own = live.current.groups.find((g) => g.group === d.group)?.label ?? '';
      return `${d.label} can only go in ${groupWords(own)}`;
    }
    return null;
  };

  const apply = (d: DragView, at: DropAt) => {
    const { services, prefs, mode, m, groups } = live.current;
    const g = groups.find((x) => x.group === d.group);
    if (!g) return;
    if (at.kind === 'bar' && at.group === d.group) {
      const shown = buttonsOf(d.group).map((el) => el.dataset.command ?? '');
      prefs.setMode(mode, withSwapIn(m, d.group, g.order, shown, d.id, at.index));
      uiFor(services).closeMenu();
    } else if (at.kind === 'more' && at.group === d.group) {
      prefs.setMode(mode, withPlace(m, d.id, 'more'));
      // The open menu lists the group's More as it was: it closes (the More button lists it now).
      uiFor(services).closeMenu();
    } else if (at.kind === 'move' && at.group === d.group) {
      const rest = g.order.filter((x) => x !== d.id);
      const before = at.mark.after ? (rest[rest.indexOf(at.mark.target) + 1] ?? null) : at.mark.target;
      prefs.setMode(mode, withMove(m, d.group, g.order, d.id, before));
    }
  };

  const start = (c: CommandDef, group: string, from: 'bar' | 'more', e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    stop.current?.();
    const pressed = e.currentTarget;
    if (from === 'bar') {
      try {
        pressed.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events */
      }
    }
    // A More item: the drag starts once the pointer leaves the item or goes MORE_PX toward the bar,
    // so a click with a moving hand still runs it (review S6).
    const item = from === 'more' ? pressed.getBoundingClientRect() : null;
    const d: DragView & { pointer: number; x0: number; y0: number; active: boolean } = {
      id: c.id,
      group,
      from,
      label: c.label,
      ...(c.icon ? { icon: c.icon } : {}),
      x: e.clientX,
      y: e.clientY,
      at: { kind: 'none' },
      note: null,
      pointer: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      active: false,
    };
    cur.current = d;
    const root = document.documentElement;
    let menuDrop = false;
    const setMenuDrop = (on: boolean) => {
      if (on === menuDrop) return;
      menuDrop = on;
      const el = menuEl();
      if (el) {
        if (on) el.dataset.dropInto = '1';
        else delete el.dataset.dropInto;
      }
    };
    /** What the toolbar draws for the drop changed: the marks and the note (one render per change, not per move). */
    let drawn = '';
    const show = (x: number, y: number) => {
      const at = dropAt(d, x, y);
      d.x = x;
      d.y = y;
      d.at = at;
      d.note = noteOf(d, at);
      const ghost = ghostRef.current;
      if (ghost) {
        ghost.style.left = `${x + 14}px`;
        ghost.style.top = `${y + 16}px`;
      }
      const key = JSON.stringify([at, d.note]);
      if (key !== drawn || !ghost) {
        drawn = key;
        root.classList.toggle('cad-tb-drag-refused', at.kind === 'refused');
        setMenuDrop(at.kind === 'more' && at.menu);
        setView({ id: d.id, group: d.group, from: d.from, label: d.label, ...(d.icon ? { icon: d.icon } : {}), x, y, at, note: d.note });
      }
      return at;
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== d.pointer) return;
      // No button held: the press ended where this frame did not hear it (review S5). Drop nothing.
      if ((ev.buttons & 1) === 0) {
        end();
        return;
      }
      if (!d.active) {
        const far = item
          ? !rectHas(item, ev.clientX, ev.clientY) || d.y0 - ev.clientY > MORE_PX
          : Math.max(Math.abs(ev.clientX - d.x0), Math.abs(ev.clientY - d.y0)) >= DRAG_PX;
        if (!far) return;
        d.active = true;
        root.classList.add('cad-tb-drag');
      }
      hideTip();
      const at = show(ev.clientX, ev.clientY);
      // From a More menu: it stays open until the pointer leaves it toward the bar (above it, or over the toolbar).
      if (d.from === 'more') {
        const ui = uiFor(live.current.services);
        const menu = menuEl();
        if (menu && ui.state.get().menu?.owner === `tb-more:${d.group}`) {
          const r = menu.getBoundingClientRect();
          if (!rectHas(r, ev.clientX, ev.clientY) && (ev.clientY < r.top || at.kind !== 'none')) ui.closeMenu();
        }
      }
    };
    const listen = (on: boolean) => {
      const f = on ? window.addEventListener.bind(window) : window.removeEventListener.bind(window);
      f('pointermove', move as EventListener, true);
      f('pointerup', up as EventListener, true);
      f('pointercancel', cancel as EventListener, true);
      f('pointerdown', again as EventListener, true);
      f('keydown', key as EventListener, true);
      f('blur', lost);
      if (on) document.addEventListener('visibilitychange', hidden);
      else document.removeEventListener('visibilitychange', hidden);
      if (from === 'bar') {
        if (on) pressed.addEventListener('lostpointercapture', lost);
        else pressed.removeEventListener('lostpointercapture', lost);
      }
    };
    const end = () => {
      listen(false);
      root.classList.remove('cad-tb-drag', 'cad-tb-drag-refused');
      setMenuDrop(false);
      if (cur.current === d) cur.current = null;
      if (stop.current === end) stop.current = null;
      setView(null);
    };
    // The click that ends a drag (on the dragged button, or wherever it ended) runs nothing.
    const eatClick = () => {
      const eat = (ce: MouseEvent) => {
        ce.stopPropagation();
        ce.preventDefault();
      };
      window.addEventListener('click', eat, true);
      setTimeout(() => window.removeEventListener('click', eat, true), 0);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== d.pointer) return;
      const was = d.active;
      const at = was ? dropAt(d, ev.clientX, ev.clientY) : null;
      end();
      if (!was || !at) return;
      // Let go back on the More item it started from: a click (the item runs), not a drop.
      if (at.kind === 'none' && item && rectHas(item, ev.clientX, ev.clientY) && menuEl()) return;
      eatClick();
      apply(d, at);
    };
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId === d.pointer) end();
    };
    // The press is gone without a pointerup here (the window lost focus, the tab was hidden, the
    // button lost its capture, or a new press began): end the drag and drop nothing (review S5).
    const lost = () => end();
    const hidden = () => {
      if (document.visibilityState === 'hidden') end();
    };
    const again = () => end();
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && d.active) {
        ev.preventDefault();
        ev.stopPropagation();
        end();
        // Cancelled: letting go afterwards runs nothing either. Only that release: a later press
        // (or the window losing focus) forgets it, so no later click is ever eaten.
        const forget = () => {
          window.removeEventListener('pointerup', late, true);
          window.removeEventListener('pointerdown', forget, true);
          window.removeEventListener('blur', forget);
        };
        const late = (ue: PointerEvent) => {
          if (ue.pointerId !== d.pointer) return;
          forget();
          eatClick();
        };
        window.addEventListener('pointerup', late, true);
        window.addEventListener('pointerdown', forget, true);
        window.addEventListener('blur', forget);
      }
    };
    listen(true);
    stop.current = end;
  };
  return { view, start, ghostRef };
}

/** The dragged command under the pointer, and the note on where it goes (or why it cannot go there). */
function DragGhost({ view, ghostRef }: { view: DragView; ghostRef: React.RefObject<HTMLDivElement | null> }) {
  const refused = view.at.kind === 'refused';
  return (
    <div
      ref={ghostRef}
      className={`tb-drag-ghost${refused ? ' is-refused' : ''}`}
      data-tb-ghost={view.id}
      data-drop={view.at.kind}
      aria-hidden="true"
      style={{ left: view.x + 14, top: view.y + 16 }}
    >
      <div className="tb-drag-chip">
        <span className="tb-drag-ico">{view.icon ? <Icon d={view.icon} size={16} stroke={1.7} /> : null}</span>
        <span>{view.label}</span>
        {refused ? <span className="tb-drag-no" /> : null}
      </div>
      {view.note ? (
        <div className="tb-drag-note" data-tb-drop-note>
          {view.note}
        </div>
      ) : null}
    </div>
  );
}

/** The toolbar's scale (--cad-toolbar-scale, 1 unless the host's appearance sets it). */
function scaleOf(el: Element | null): number {
  const v = el ? parseFloat(getComputedStyle(el).getPropertyValue('--cad-toolbar-scale')) : NaN;
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** Sent on the window when setToolbarScale changed the scale: the toolbar measures its fit again. */
export const TOOLBAR_SCALE_EVENT = 'cad:toolbar-scale';

/**
 * Sets the toolbar's scale (every size of the ribbon follows it: icons, rows, names, widths) and
 * has the ribbon measure its fit again (review 6). The one place the host's appearance setting
 * ("toolbar icon size") is to be wired in.
 */
export function setToolbarScale(scale: number, root: HTMLElement = document.documentElement): void {
  if (Number.isFinite(scale) && scale > 0) root.style.setProperty('--cad-toolbar-scale', String(scale));
  else root.style.removeProperty('--cad-toolbar-scale');
  window.dispatchEvent(new Event(TOOLBAR_SCALE_EVENT));
}

/** A group's width step for the arrow keys on the line at its right (px at scale 1). */
const WIDTH_STEP = 16;

/** One frame later (or 50 ms: a hidden tab runs no animation frames). */
function nextFrame(): Promise<void> {
  return new Promise((done) => {
    let over = false;
    const end = () => {
      if (over) return;
      over = true;
      done();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(end);
    setTimeout(end, 50);
  });
}

/** A group's width as the person sees it (review 9: the Assistant reads what the person sees). */
export interface GroupWidthNow {
  mode: LayoutMode;
  group: string;
  /** Its toolbar is on screen now (the other mode's is not: only `set` is known then). */
  shown: boolean;
  /** The width stored (px at scale 1), or null: as wide as its commands. */
  set: number | null;
  /** Its width on screen (px at scale 1), when shown. */
  width: number | null;
  /** The narrowest it can be (its first command and its More), once measured. */
  min: number | null;
  /** The commands in its More now (a flyout's variants one by one). */
  more: string[];
  /** The commands on the bar now. */
  bar: string[];
}

function groupEl(mode: LayoutMode, group: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-cad-toolbar="${mode}"] .tb-group[data-group="${group.replace(/["\\]/g, '')}"]`);
}

/**
 * The group's width once the toolbar has drawn the layout, its stored width kept to the group's
 * minimum (review 1: never narrower than its first command and its More, so the More is never
 * clipped). The person's handles and the Assistant's toolbar_width both settle through this.
 */
export async function settleGroupWidth(prefs: ToolbarPrefs, mode: LayoutMode, group: string): Promise<GroupWidthNow> {
  await nextFrame();
  await nextFrame();
  let el = groupEl(mode, group);
  const set0 = widthOf(prefs.state.get().layout[mode], group);
  const min0 = el?.dataset.minWidth ? Number(el.dataset.minWidth) : null;
  if (el && set0 != null && min0 != null && set0 < min0) {
    prefs.setWidth(mode, group, min0);
    await nextFrame();
    await nextFrame();
    el = groupEl(mode, group);
  }
  const set = widthOf(prefs.state.get().layout[mode], group);
  if (!el) return { mode, group, shown: false, set, width: null, min: null, more: [], bar: [] };
  const items = el.querySelector<HTMLElement>('.tb-items');
  const s = scaleOf(el);
  const more = el.querySelector<HTMLElement>('[data-tb-more], [data-tb-group-menu]');
  return {
    mode,
    group,
    shown: true,
    set,
    width: items ? Math.round(items.getBoundingClientRect().width / s) : null,
    min: el.dataset.minWidth ? Number(el.dataset.minWidth) : null,
    more: (more?.getAttribute('data-more-commands') ?? '').split(' ').filter(Boolean),
    bar: Array.from(el.querySelectorAll('.tb-btn[data-command]')).map((b) => b.getAttribute('data-command') ?? ''),
  };
}

/**
 * Where a command is on its toolbar now, once the toolbar has drawn the layout: on the bar, in its
 * group's More (`narrowed`: the group's width holds it there), or `hidden` (its toolbar is not on
 * screen). For the Assistant's toolbar_show (review 2: it said "on the toolbar" while the person
 * saw it in More).
 */
export async function commandOnToolbar(mode: LayoutMode, id: string): Promise<{ where: 'bar' | 'more' | 'hidden'; narrowed: boolean; width: number | null }> {
  await nextFrame();
  await nextFrame();
  const bar = document.querySelector<HTMLElement>(`[data-cad-toolbar="${mode}"]`);
  if (!bar) return { where: 'hidden', narrowed: false, width: null };
  if (bar.querySelector(`.tb-btn[data-command="${id}"]`)) return { where: 'bar', narrowed: false, width: null };
  const more = Array.from(bar.querySelectorAll<HTMLElement>('[data-tb-more], [data-tb-group-menu]')).find((m) => (m.getAttribute('data-more-commands') ?? '').split(' ').includes(id));
  const g = more?.closest<HTMLElement>('.tb-group');
  const narrowed = !!g && Number(g.dataset.widthFolded) > 0;
  return { where: more ? 'more' : 'hidden', narrowed, width: narrowed && g?.dataset.width ? Number(g.dataset.width) : null };
}

/**
 * The narrowed group that holds `id` in its More and could not fit it even with its other commands
 * folded (`data-too-narrow-for`), as drawn now; null when there is none (review 6: the Assistant's
 * toolbar_show answers as the person's greyed Show in toolbar does).
 */
export function narrowedOut(mode: LayoutMode, id: string): { group: string; width: number } | null {
  const g = Array.from(document.querySelectorAll<HTMLElement>(`[data-cad-toolbar="${mode}"] .tb-group[data-too-narrow-for]`)).find((el) =>
    (el.dataset.tooNarrowFor ?? '').split(' ').includes(id),
  );
  return g ? { group: g.dataset.group ?? '', width: Number(g.dataset.width) || 0 } : null;
}

/** The live preview of a resize drag (a group's width, or the rows). */
type ResizePreview = { group?: string; width?: number; rows?: number } | null;

/**
 * Resizing the ribbon (v0.5.0, Daniel: as Excel's): the line at a group's right sets its width
 * (pointer drag, Left / Right arrows, double-click or its menu back to auto; EDIT's line is at its
 * left, so there the drag and the arrows go the other way round, review 3), the bottom edge the
 * toolbar's rows (drag, Up / Down, double-click back to three). Both lines are in the Tab order and
 * take the keyboard when pressed (review 5). Shown live (`preview`), kept in the person's layout on
 * release (ToolbarPrefs setWidth / setRows), a width never under the group's minimum
 * (settleGroupWidth). A lost release (the window or the tab losing the pointer, the handle going
 * away with its toolbar, a move with no button held) ends the drag and keeps nothing (review 4).
 */
function useRibbonResize(bar: React.RefObject<HTMLDivElement | null>, live: React.RefObject<DragLive>, setPreview: (p: ResizePreview) => void, rows: number) {
  /** The drag in progress: its stop, and the group whose line it is (null: the bottom edge). */
  const active = useRef<{ stop: () => void; group: string | null } | null>(null);
  // The toolbar goes away mid-drag: the drag ends with it. A group's line going away (the mode
  // changed, the toolbar stays) ends it through ResizeHandlers.gone (review 5 of the integration).
  useEffect(() => () => active.current?.stop(), []);
  const prefs = () => live.current.prefs;
  const mode = () => live.current.mode;
  const setWidth = (g: string, w: number | null) => {
    prefs().setWidth(mode(), g, w);
    if (w != null) void settleGroupWidth(prefs(), mode(), g);
  };
  const setRows = (r: number | null) => prefs().setRows(mode(), r);
  const itemsOf = (g: string) => bar.current?.querySelector<HTMLElement>(`.tb-group[data-group="${g}"] .tb-items`) ?? null;
  const widthNow = (g: string) => {
    const el = itemsOf(g);
    if (el) return el.getBoundingClientRect().width / scaleOf(bar.current);
    return widthOf(live.current.m, g) ?? MIN_GROUP_W;
  };
  const minOf = (g: string) => Number(bar.current?.querySelector<HTMLElement>(`.tb-group[data-group="${g}"]`)?.dataset.minWidth) || MIN_GROUP_W;
  const clampW = (g: string, w: number) => Math.round(Math.min(MAX_GROUP_W, Math.max(MIN_GROUP_W, minOf(g), w)));
  const clampR = (r: number) => Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.round(r)));
  /** EDIT's line is on its left (the group sits at the right end): its width grows to the left. */
  const signOf = (el: Element) => (el.closest('.tb-group')?.classList.contains('is-end') ? -1 : 1);
  /** A pointer drag on a handle: `at(dx, dy)` while moving, `done(dx, dy)` on release. */
  const follow = (e: React.PointerEvent<HTMLDivElement>, cursor: string, at: (dx: number, dy: number) => void, done: (dx: number, dy: number) => void, group: string | null = null) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    active.current?.stop();
    const el = e.currentTarget;
    // The press gives the line the keyboard (preventDefault keeps the browser from doing it).
    el.focus({ preventScroll: true });
    const pointer = e.pointerId;
    const x0 = e.clientX;
    const y0 = e.clientY;
    try {
      el.setPointerCapture(pointer);
    } catch {
      /* synthetic events */
    }
    const root = document.documentElement;
    root.classList.add(cursor);
    // On the window (capture) and the document, not the handle: a handle taken out of the page
    // mid-drag hears nothing more, and its lost capture goes to the document.
    const end = (keep: boolean, dx = 0, dy = 0) => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      document.removeEventListener('lostpointercapture', cancel, true);
      window.removeEventListener('blur', lost);
      document.removeEventListener('visibilitychange', hidden);
      root.classList.remove(cursor);
      if (active.current?.stop === stop) active.current = null;
      if (keep) done(dx, dy);
      setPreview(null);
    };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointer) return;
      // No button held: the release went where this frame did not hear it. Keep nothing.
      if ((ev.buttons & 1) === 0) return end(false);
      at(ev.clientX - x0, ev.clientY - y0);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId === pointer) end(true, ev.clientX - x0, ev.clientY - y0);
    };
    const lost = () => end(false);
    const cancel = (ev: PointerEvent) => {
      if (ev.pointerId === pointer) end(false);
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') end(false);
    };
    const stop = () => end(false);
    active.current = { stop, group };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    document.addEventListener('lostpointercapture', cancel, true);
    window.addEventListener('blur', lost);
    document.addEventListener('visibilitychange', hidden);
  };
  const group: ResizeHandlers = {
    start(g, e) {
      const w0 = widthNow(g);
      const s = scaleOf(bar.current);
      const sign = signOf(e.currentTarget);
      follow(
        e,
        'cad-tb-resizing',
        (dx) => setPreview({ group: g, width: clampW(g, w0 + (sign * dx) / s) }),
        (dx) => {
          if (Math.abs(dx) >= 1) setWidth(g, clampW(g, w0 + (sign * dx) / s));
        },
        g,
      );
    },
    gone(g) {
      if (active.current?.group === g) active.current.stop();
    },
    auto(g) {
      setWidth(g, null);
    },
    key(g, e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const step = (e.key === 'ArrowRight' ? WIDTH_STEP : -WIDTH_STEP) * signOf(e.currentTarget);
        setWidth(g, clampW(g, widthNow(g) + step));
      } else if (e.key === 'Home' || e.key === 'Delete') {
        e.preventDefault();
        setWidth(g, null);
      }
    },
    menu(g, x, y) {
      const label = live.current.groups.find((x2) => x2.group === g)?.label ?? g.toUpperCase();
      uiFor(live.current.services).showMenu(
        x,
        y,
        [
          {
            id: 'tb-width-auto',
            label: 'Width to fit its commands',
            disabled: widthOf(live.current.m, g) == null ? `${groupWords(label)} is already as wide as its commands` : null,
            run: () => setWidth(g, null),
          },
          { sep: true, id: 'tb-sep' },
          {
            id: 'tb-reset',
            label: 'Reset toolbar',
            disabled: isDefault(live.current.m) ? 'The toolbar is already as it was at first' : null,
            run: () => prefs().reset(mode()),
          },
        ],
        `Toolbar: ${groupWords(label)}`,
      );
    },
  };
  const rowPx = () => {
    const el = bar.current?.querySelector<HTMLElement>('.tb-items');
    const h = el ? el.getBoundingClientRect().height : 0;
    return h > 0 ? h / rows : 23 * scaleOf(bar.current);
  };
  const rowsHandle = {
    start(e: React.PointerEvent<HTMLDivElement>) {
      const r0 = rows;
      const px = rowPx();
      follow(
        e,
        'cad-tb-resizing-rows',
        (_dx, dy) => setPreview({ rows: clampR(r0 + dy / px) }),
        (_dx, dy) => {
          const r = clampR(r0 + dy / px);
          if (r !== r0) setRows(r);
        },
      );
    },
    auto() {
      setRows(null);
    },
    key(e: React.KeyboardEvent<HTMLDivElement>) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        setRows(clampR(rows + (e.key === 'ArrowDown' ? 1 : -1)));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setRows(null);
      }
    },
  };
  return { group, rows: rowsHandle };
}

/**
 * How compact the toolbar must be to show every command without scrolling (v0.5.0 ribbon): 0 every
 * name shown, 1 VIEW and EDIT as icons, then the labelled groups' small buttons as icons one group
 * at a time, then the foldable commands (FOLD_ORDER) into their group's More one by one, then the
 * groups closer together, then the groups collapsed into one dropdown each (SQUEEZE_ORDER). Measured
 * after each render (before paint); measured again from 0 when the toolbar's width, the mode or its
 * commands change.
 */
function useFitLevel(mode: Mode, content: string, max: number): { ref: (node: HTMLDivElement | null) => void; level: number } {
  const node = useRef<HTMLDivElement | null>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((n: HTMLDivElement | null) => {
    node.current = n;
    setEl(n);
  }, []);
  const [width, setWidth] = useState(0);
  const [fit, setFit] = useState({ key: '', level: 0 });
  // A new mode or width starts again from labels everywhere.
  const key = `${mode}|${width}|${content}`;
  const level = fit.key === key ? fit.level : 0;
  useLayoutEffect(() => {
    const n = node.current;
    if (n && level < max && n.scrollWidth > n.clientWidth + 1) setFit({ key, level: level + 1 });
  });
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    // Only the width counts (the toolbar's own height changes with the level).
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return { ref, level };
}

/** The sketch tool in use (sketch mode's state, when sketch mode is installed). */
function useSketchTool(services: AppServices): string | null {
  const api = useStateStore(services.apis, (s) => s.sketch);
  const [tool, setTool] = useState<string | null>(api ? api.state.get().tool : null);
  useEffect(() => {
    if (!api) {
      setTool(null);
      return;
    }
    setTool(api.state.get().tool);
    return api.state.subscribe((s) => setTool(s.tool));
  }, [api]);
  return tool;
}

export function Toolbar() {
  const services = useServices();
  const ui = uiFor(services);
  const mode = useStateStore(services.mode, (s) => s.mode);
  const [, bump] = useState(0);
  useEffect(() => services.commands.subscribe(() => bump((n) => n + 1)), [services.commands]);
  // Whether a command can run depends on the document, the kernel, the open
  // panel and the selection: re-render when any of them changes.
  useStateStore(services.doc.state);
  useStateStore(services.kernel.status);
  useStateStore(services.selection);
  const panel = useStateStore(ui.state, (s) => s.panel);
  const sketchTool = useSketchTool(services);

  const prefs = toolbarPrefs(services);
  const { layout } = useStateStore(prefs.state);
  const lmode = layoutModeOf(mode);
  const ml = layout[lmode];
  // The mode's groups in the user's order.
  // v0.5.0: each flyout is one command of its group (its bar id); its variants go with it.
  const flyVariants = new Map<string, CommandDef[]>();
  const flyDefs = new Map<string, FlyoutDef>();
  const groups = services.commands.toolbar(mode).map((g) => {
    const fly = collapseFlyouts(g.commands);
    for (const [k, x] of fly.variants) flyVariants.set(k, x);
    for (const [k, x] of fly.flyouts) flyDefs.set(k, x);
    const byId = new Map(fly.commands.map((c) => [c.id, c] as const));
    const order = orderIds(
      fly.commands.map((c) => c.id),
      ml.order[g.group],
    );
    return { ...g, commands: order.map((x) => byId.get(x)!), order };
  });
  const flyouts = { variants: flyVariants, defs: flyDefs };
  // In More by the user's layout (or the default: model mode shows each group's main command).
  const placedMore = new Set(groups.flatMap((g) => g.order.filter((x) => placeOf(x, ml) === 'more')));
  // The commands that may fold here, in folding order (only the mode's groups' own commands on the bar).
  const present = new Set(groups.flatMap((g) => g.order));
  // What the user asked to see ("Show in toolbar") folds last, after the rest in FOLD_ORDER. A
  // command dragged onto the bar from More (UX 0.1.0, `held`) never folds for the width: the
  // group's other commands fold first (review B2).
  const foldable = [
    ...FOLD_ORDER.filter((x) => present.has(x) && !placedMore.has(x) && !held(ml, x) && !pinned(ml, x)),
    ...FOLD_ORDER.filter((x) => present.has(x) && !placedMore.has(x) && !held(ml, x) && pinned(ml, x)),
  ];
  // v0.5.0 ribbon: the groups in squeeze order (any group SQUEEZE_ORDER does not name goes last).
  const squeeze = [...groups].sort((x, y) => {
    const i = (g: string) => (SQUEEZE_ORDER.includes(g) ? SQUEEZE_ORDER.indexOf(g) : SQUEEZE_ORDER.length);
    return i(x.group) - i(y.group);
  });
  // The groups with a small labelled button on the bar (a More is one): their names go first.
  // CONSTRAIN's buttons are their glyphs at every width.
  const labelGroups = squeeze
    .filter((g) => g.group !== 'constrain' && (g.order.some((x) => placedMore.has(x)) || g.order.some((x) => !placedMore.has(x) && !RIBBON_LARGE.has(x))))
    .map((g) => g.group);
  // The groups that may collapse into one dropdown (two commands or more; a flyout counts its variants).
  const collapseGroups = squeeze.filter((g) => g.commands.flatMap((c) => flyVariants.get(c.id) ?? [c]).length > 1).map((g) => g.group);
  // v0.5.0 ribbon (Daniel: as Excel's): the person drags the line at a group's right to set its
  // width, and the toolbar's bottom edge to set its rows; shown live while dragging, kept on release.
  const [preview, setPreview] = useState<ResizePreview>(null);
  const rows = preview?.rows ?? rowsOf(ml);
  // setToolbarScale: the ribbon measures its fit again (review 6).
  const [scaleTick, setScaleTick] = useState(0);
  useEffect(() => {
    const bump = () => setScaleTick((n) => n + 1);
    window.addEventListener(TOOLBAR_SCALE_EVENT, bump);
    return () => window.removeEventListener(TOOLBAR_SCALE_EVENT, bump);
  }, []);
  // The fit is measured again from the start whenever a resize's preview changes or ends (review 7:
  // a drag let go where it started left the ribbon squeezed), the rows or the scale change.
  const fit = useFitLevel(
    mode,
    `${[...present].join(' ')}|${JSON.stringify(ml)}|${rows}|${preview?.group ?? ''}:${preview?.width ?? ''}|${scaleTick}`,
    2 + labelGroups.length + foldable.length + collapseGroups.length,
  );
  // Tests wait for the stored layout: the attribute is set without a render.
  const bar = useRef<HTMLDivElement | null>(null);
  const fitRef = fit.ref;
  const barRef = useCallback(
    (n: HTMLDivElement | null) => {
      bar.current = n;
      fitRef(n);
    },
    [fitRef],
  );
  useEffect(() => {
    let live = true;
    void prefs.loaded.then(() => {
      if (live && bar.current) bar.current.dataset.layoutReady = '1';
    });
    return () => {
      live = false;
    };
  }, [prefs, mode]);
  // Steps: 0 every label; 1 VIEW and EDIT icons; then each labelled group's small buttons to icons
  // (labelGroups, one by one); then the folds (FOLD_ORDER, one by one); then the groups closer
  // together (tight); then the groups collapse into one dropdown each (collapseGroups, one by one).
  const level = fit.level;
  const clampTo = (n: number, max: number) => Math.max(0, Math.min(n, max));
  const viewIcons = level >= 1;
  const fitLabels = new Set(labelGroups.slice(0, clampTo(level - 1, labelGroups.length)));
  const fitFolded = new Set(foldable.slice(0, clampTo(level - 1 - labelGroups.length, foldable.length)));
  const tight = level >= 2 + labelGroups.length + foldable.length;
  const fitCollapsed = new Set(collapseGroups.slice(0, clampTo(level - (2 + labelGroups.length + foldable.length), collapseGroups.length)));
  const folded = new Set([...placedMore, ...fitFolded]);
  const cz = customizer(services, prefs, lmode, ml, fitFolded);
  // UX 0.1.0: dragging between a group's More and its bar (the handlers read this render's layout).
  const live = useRef<DragLive>({ services, prefs, mode: lmode, m: ml, groups: [] });
  live.current = { services, prefs, mode: lmode, m: ml, groups: groups.map((g) => ({ group: g.group, label: g.label, order: g.order })) };
  const drag = useToolbarDrag(bar, live);
  const widthFor = (g: string) => (preview?.group === g && preview.width != null ? preview.width : widthOf(ml, g));
  const resize = useRibbonResize(bar, live, setPreview, rows);
  const view = viewCommands(services, mode);
  // Sketch mode undoes inside the sketch (its own Undo / Redo); model mode the document's.
  const editIds = mode === 'sketch' ? [WELL_KNOWN_COMMANDS.sketchUndo, WELL_KNOWN_COMMANDS.sketchRedo] : [UNDO_ID, REDO_ID];
  const edit = editIds.map((id) => services.commands.get(id)).filter((c): c is CommandDef => !!c && !!c.icon && modeOk(c, mode));
  // The mode's primary action (Finish sketch), on its own after the mode's groups.
  const primary = services.commands.all().filter((c) => c.primary && c.icon && modeOk(c, mode));
  if (!groups.length && !view.length && !edit.length && !primary.length) return null;
  return (
    <>
      <div
        ref={barRef}
        className={`toolbar cad-toolbar is-ribbon${viewIcons ? ' is-fit-1' : ''}${tight ? ' is-fit-tight' : ''}${rows < RIBBON_ROWS ? ' is-short' : ''}`}
        style={{ '--tb-rows': rows } as React.CSSProperties}
        data-rows={rows}
        role="toolbar"
        aria-label="Commands"
        data-cad-toolbar={mode}
        data-fit={viewIcons ? 1 : 0}
        data-fit-labels={[...fitLabels].join(' ')}
        data-fit-tight={tight ? '1' : '0'}
        data-fit-collapsed={[...fitCollapsed].join(' ')}
        data-folded={folded.size}
        data-fit-folded={fitFolded.size}
        data-layout={isDefault(ml) ? 'default' : 'custom'}
        onContextMenu={(e) => {
          e.preventDefault();
          cz.menu(e.clientX, e.clientY);
        }}
      >
        {groups.filter((g) => !AFTER_VIEW.has(g.group)).map((g) => (
          <Group
            key={g.group}
            id={g.group}
            label={g.label}
            commands={g.commands}
            folded={folded}
            services={services}
            panel={panel}
            sketchTool={sketchTool}
            icons={g.group === 'constrain' || fitLabels.has(g.group)}
            collapsed={fitCollapsed.has(g.group)}
            flyouts={flyouts}
            custom={cz.forGroup(g.group, g.order)}
            drag={drag.view}
            startDrag={(c, from, e) => drag.start(c, g.group, from, e)}
            rows={rows}
            width={widthFor(g.group)}
            resize={resize.group}
            scaleTick={scaleTick}
          />
        ))}
        {primary.length ? <Group id="primary" label={mode === 'sketch' ? 'SKETCH' : ''} commands={primary} services={services} panel={panel} sketchTool={sketchTool} primary menu={cz.menu} drag={drag.view} rows={rows} /> : null}
        {view.length ? <Group id="view" label="VIEW" commands={view} services={services} panel={panel} sketchTool={sketchTool} icons={viewIcons} menu={cz.menu} drag={drag.view} rows={rows} width={widthFor('view')} resize={resize.group} scaleTick={scaleTick} /> : null}
        {/* ux010: SCALE MODELS, right after VIEW. */}
        {groups.filter((g) => AFTER_VIEW.has(g.group)).map((g) => (
          <Group
            key={g.group}
            id={g.group}
            label={g.label}
            commands={g.commands}
            folded={folded}
            services={services}
            panel={panel}
            sketchTool={sketchTool}
            icons={fitLabels.has(g.group)}
            collapsed={fitCollapsed.has(g.group)}
            flyouts={flyouts}
            custom={cz.forGroup(g.group, g.order)}
            drag={drag.view}
            startDrag={(c, from, e) => drag.start(c, g.group, from, e)}
            rows={rows}
            width={widthFor(g.group)}
            resize={resize.group}
            scaleTick={scaleTick}
          />
        ))}
        {edit.length ? <Group id="edit" label="EDIT" commands={edit} services={services} panel={panel} sketchTool={sketchTool} end icons={viewIcons} menu={cz.menu} drag={drag.view} rows={rows} width={widthFor('edit')} resize={resize.group} scaleTick={scaleTick} /> : null}
        {/* The bottom edge: drag it for one to four rows (double-click: three). */}
        <div
          className="tb-rows-handle"
          data-tb-rows-handle
          role="separator"
          aria-orientation="horizontal"
          aria-label="Toolbar rows"
          aria-valuenow={rows}
          aria-valuemin={MIN_ROWS}
          aria-valuemax={MAX_ROWS}
          // In the Tab order (review 5): Up / Down step it, Home sets it back to three.
          tabIndex={0}
          title="Drag to make the toolbar more or fewer rows tall; double-click: three"
          onPointerDown={resize.rows.start}
          onDoubleClick={resize.rows.auto}
          onKeyDown={resize.rows.key}
        />
      </div>
      {drag.view ? <DragGhost view={drag.view} ghostRef={drag.ghostRef} /> : null}
    </>
  );
}
