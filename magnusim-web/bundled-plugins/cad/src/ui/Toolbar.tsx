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
// arrange the icons however they want"): model mode shows by default only each
// group's main command (KEEP_IN_VIEW, the compact layout seen at 1280 px) at
// every width, the rest in More; sketch mode shows every command by default.
// Users rearrange both: right-click a command (or a More item) for Move to More /
// Show in toolbar / Move left / Move right / Reset toolbar, or drag a command
// along its group. The layout is kept in the project (toolbar-layout.ts).
// UX 0.1.0 (Daniel 2026-10-07: "I need to be able to drag something from More onto the main
// toolbar and it replaced the last thing there"): a command dragged out of its group's More menu
// onto the bar goes in where it is dropped, and the group's last command on the bar goes to More
// (dropped on the last slot or after it, it takes that slot); a bar command dragged into its
// group's open More menu (or onto its More button) goes to More. While dragging, a marker shows
// where it lands, the command that will leave is highlighted and a note under the pointer says so
// ("Spline moves to More"); over another group the note says it can only go in its own group, the
// pointer shows not-allowed, and a drop there changes nothing. The keyboard's way: a More item's
// right-click menu has "Swap with <the bar's last>" (useToolbarDrag, customizer).
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
// The model toolbar is the same ribbon, so the two modes are the same height. When the ribbon does
// not fit the frame (useFitLevel) VIEW and EDIT go to icons, then each group's small buttons go to
// icons one group at a time (SQUEEZE_ORDER), then commands fold into More (FOLD_ORDER), then the
// groups sit closer, then whole groups collapse into one dropdown button each (SQUEEZE_ORDER).
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useServices } from '../lib/services';
import { useStateStore } from '../lib/store';
import type { AppServices } from '../types/app';
import type { CommandDef, Mode } from '../types/commands';
import { WELL_KNOWN_COMMANDS } from '../types/modules';
import { PARAMS_ID, REDO_ID, UNDO_ID } from './commands';
import { uiFor, type UiState } from './controller';
import { Icon, ICONS } from './Icon';
import { hideTip, useTip, type MenuEntry } from './kit';
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
  withRows,
  withSwapIn,
  withWidth,
  type LayoutMode,
  type ModeLayout,
  type ToolbarPrefs,
} from './toolbar-layout';

/**
 * The order in which commands fold into their group's "More" menu when the labelled toolbar does
 * not fit the frame, the first one first (after VIEW and EDIT have gone to icons). A command not
 * listed never folds: each group keeps its most-used command in view (Sketch, Extrude, Fillet,
 * Plane, Enclosure, Measure, Import STEP; in sketch mode Line, Rectangle, Circle, 3-point arc,
 * Dimension, Trim and Finish sketch; Chamfer stays beside Fillet). The order follows how often SolidWorks and Fusion users
 * reach for each command, weighted for Magnusim's CFD preparation (press-pull, Combine and the
 * enclosure stay longest): ARCHITECTURE.md §7 "Toolbar" gives the reasons. Since P4b fix round 1
 * model mode starts compact (only KEEP_IN_VIEW on the bar), so this order matters there only for
 * the commands a user put on the bar; in sketch mode it is the ribbon's fold order.
 */
export const FOLD_ORDER: readonly string[] = [
  // Model mode.
  // The person's side of the Assistant's view, find and hole tools (parity both ways): Picture and
  // Find fold first; Hole stays with the solid commands longest of the three.
  'file.picture',
  'inspect.find',
  'modify.parameters',
  'inspect.check',
  'construct.point',
  'solid.loft',
  'solid.hole',
  'inspect.mass',
  // Split and Delete faces before Axis (P4a review: the reference axis is reached for more often).
  'modify.split',
  'modify.delete-faces',
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
  // headline tools (Spline, Mirror, the patterns) stay longest of the new ones.
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
 * The toolbar commands that never fold: each group's most-used command (and CONSTRAIN, whose
 * buttons are the constraints' own glyphs). Every toolbar command is either here or in
 * FOLD_ORDER (tests/app/bootstrap.test.tsx checks it, so a new command needs a decision).
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
const KEEP_SET: ReadonlySet<string> = new Set(KEEP_IN_VIEW);

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
  onContextMenu(e: React.MouseEvent<HTMLButtonElement>): void;
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
      onContextMenu={custom?.onContextMenu}
      onPointerDown={custom?.onPointerDown}
      onKeyDown={onKeyDown}
      onClick={() => {
        // A More menu left open beside this button (a press here no longer closes it: a bar
        // command may be dragged into it) closes on the click.
        const ui = uiFor(services);
        if (ui.state.get().menu) ui.closeMenu();
        if (reason) return;
        if (variant && c.flyout) setLastUsed(services, c.flyout, variant.id);
        void services.commands.run(shown.id);
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
      run: () => {
        setLastUsed(services, def.id, x.id);
        void services.commands.run(x.id);
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
      run: () => void services.commands.run(c.id),
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

/** What a registry group needs to let the user rearrange it. */
interface GroupCustom {
  /** The right-click menu of a command shown in the group. */
  barMenu(c: CommandDef, shown: string[], x: number, y: number): void;
  /**
   * The right-click menu of a command in the group's More (`shown`: the group's commands on the bar;
   * `narrow`: it is there because the person narrowed the group).
   */
  moreMenu(c: CommandDef, shown: string[], x: number, y: number, narrow: boolean): void;
  /** Dragged onto the bar from More: folds last when the group is narrowed. */
  isHeld(id: string): boolean;
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
}: {
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
  /** VIEW, EDIT and the primary action: their right-click menu (Reset toolbar). */
  menu?(x: number, y: number): void;
  /** The toolbar's drag in progress (any group's), to draw its marks here. */
  drag?: DragView | null;
  /** A press on one of the group's commands, on the bar or in its More: it may become a drag. */
  startDrag?(c: CommandDef, from: 'bar' | 'more', e: React.PointerEvent<HTMLButtonElement>): void;
}) {
  // v0.5.0 ribbon: a group the person narrowed puts what does not fit into its More, the least
  // used first (FOLD_ORDER), then from its end; never its first command; a command dragged onto the
  // bar (held) last. Measured before paint, again from none whenever the width or the rows change,
  // so a widened group gets its commands back.
  const itemsRef = useRef<HTMLDivElement | null>(null);
  const open = commands.filter((c) => !folded?.has(c.id));
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
          const isHeld = (x: string) => !!custom?.isHeld(x);
          return [...all.filter((x) => !isHeld(x)), ...all.filter(isHeld)];
        })();
  const fitKey = `${width}|${rows}|${open.map((c) => c.id).join(' ')}|${icons ? 1 : 0}`;
  const [wf, setWf] = useState({ key: '', n: 0 });
  const nNarrow = wf.key === fitKey ? wf.n : 0;
  useLayoutEffect(() => {
    const el = itemsRef.current;
    if (!el || width == null) return;
    if (nNarrow < candidates.length && el.scrollWidth > el.clientWidth + 1) setWf({ key: fitKey, n: nNarrow + 1 });
  });
  const narrow = new Set(candidates.slice(0, nNarrow));
  const more = commands.filter((c) => folded?.has(c.id) || narrow.has(c.id));
  /** A variant listed in More stands for its flyout (moved, dragged and shown as one). */
  const barOf = (c: CommandDef): CommandDef => more.find((m) => flyouts?.variants.get(m.id)?.some((v) => v.id === c.id)) ?? c;
  const shown = commands.filter((c) => !more.includes(c)).map((c) => c.id);
  const at = drag?.at;
  const mark = at && (at.kind === 'bar' || at.kind === 'move') && at.group === id ? at.mark : null;
  const customFor = (c: CommandDef): ButtonCustom | undefined => {
    if (!custom) return menu ? { onContextMenu: (e) => (e.preventDefault(), e.stopPropagation(), menu(e.clientX, e.clientY)) } : undefined;
    return {
      onContextMenu(e) {
        e.preventDefault();
        e.stopPropagation();
        custom.barMenu(c, shown, e.clientX, e.clientY);
      },
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
      data-width={width ?? undefined}
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
      <div className="tb-group-label" style={width != null ? { maxWidth: `calc(${width}px * var(--cad-toolbar-scale))` } : undefined}>
        {label}
      </div>
      {/* data-menu-keep: a press on the group's buttons leaves its open More menu open (a bar command may be dragged into it). */}
      <div ref={itemsRef} className={`tb-items${width != null && !collapsed ? ' is-sized' : ''}`} data-menu-keep={custom ? '1' : undefined} style={width != null && !collapsed ? { width: `calc(${width}px * var(--cad-toolbar-scale))` } : undefined}>
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
            {...(custom ? { itemMenu: (c: CommandDef, x: number, y: number) => custom.moreMenu(barOf(c), shown, x, y, narrow.has(barOf(c).id)) } : {})}
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
          aria-valuenow={width ?? undefined}
          aria-valuemin={MIN_GROUP_W}
          aria-valuemax={MAX_GROUP_W}
          tabIndex={-1}
          title="Drag to make the group narrower or wider; double-click: as wide as its commands"
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
}

/**
 * The right-click menus that rearrange the toolbar (P4b fix round 1). A command on the bar: Move to
 * More, Move left / Move right (the keyboard's and the mouse's way to reorder, besides a drag),
 * Reset toolbar. A command in More: Show in toolbar (greyed with the reason when the frame is too
 * narrow for it), Swap with <the bar's last> (UX 0.1.0: the keyboard's way to do what a drag from
 * More onto the bar's last slot does), Reset toolbar. Anywhere else on the toolbar: Reset toolbar.
 * "Show in toolbar" still adds the command without sending another to More: it is the only way to
 * give a group more commands on the bar (model mode starts with one or two per group).
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
  const forGroup = (group: string, order: string[]): GroupCustom => ({
    barMenu(c, shown, x, y) {
      const i = shown.indexOf(c.id);
      const after = (id: string) => order[order.indexOf(id) + 1] ?? null;
      ui.showMenu(
        x,
        y,
        [
          { id: 'tb-to-more', label: 'Move to More', run: () => set(withPlace(m, c.id, 'more', mode, KEEP_SET)) },
          {
            id: 'tb-left',
            label: 'Move left',
            disabled: i <= 0 ? `${c.label} is the first of its group` : null,
            run: () => set(withMove(m, group, order, c.id, shown[i - 1])),
          },
          {
            id: 'tb-right',
            label: 'Move right',
            disabled: i < 0 || i >= shown.length - 1 ? `${c.label} is the last of its group` : null,
            run: () => set(withMove(m, group, order, c.id, after(shown[i + 1]))),
          },
          { sep: true, id: 'tb-sep' },
          reset,
        ],
        `Toolbar: ${c.label}`,
      );
    },
    isHeld: (id) => held(m, id),
    moreMenu(c, shown, x, y, narrow) {
      const stuck = pinned(m, c.id) && (fitFolded.has(c.id) || narrow);
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
            run: () => set(withPlace(m, c.id, 'bar', mode, KEEP_SET)),
          },
          ...(last
            ? [
                {
                  id: 'tb-swap',
                  label: `Swap with ${labelOf(last)}`,
                  run: () => set(withSwapIn(m, group, order, shown, c.id, shown.length, mode, KEEP_SET)),
                },
              ]
            : []),
          { sep: true, id: 'tb-sep' },
          reset,
        ],
        `Toolbar: ${c.label}`,
      );
    },
  });
  const menu = (x: number, y: number) => ui.showMenu(x, y, [reset], 'Toolbar');
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
 * button, three rows tall: right of its middle).
 */
export function pastButton(r: { left: number; right: number; top: number; bottom: number }, x: number, y: number): boolean {
  if (x >= r.right) return true;
  if (x < r.left) return false;
  return r.bottom - r.top > 40 ? x > (r.left + r.right) / 2 : y > (r.top + r.bottom) / 2;
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
      const index = btns.filter((el) => pastButton(el.getBoundingClientRect(), x, y)).length;
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
      if (!best || dist < best.dist) best = { target: el.dataset.command ?? '', after: pastButton(r, x, y), dist };
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
      prefs.setMode(mode, withSwapIn(m, d.group, g.order, shown, d.id, at.index, mode, KEEP_SET));
      uiFor(services).closeMenu();
    } else if (at.kind === 'more' && at.group === d.group) {
      prefs.setMode(mode, withPlace(m, d.id, 'more', mode, KEEP_SET));
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

/**
 * Sets the toolbar's scale (every size of the ribbon follows it: icons, rows, names, widths). The
 * one place the host's appearance setting ("toolbar icon size") is to be wired in.
 */
export function setToolbarScale(scale: number, root: HTMLElement = document.documentElement): void {
  if (Number.isFinite(scale) && scale > 0) root.style.setProperty('--cad-toolbar-scale', String(scale));
  else root.style.removeProperty('--cad-toolbar-scale');
}

/** A group's width step for the arrow keys on the line at its right (px at scale 1). */
const WIDTH_STEP = 16;

/**
 * Resizing the ribbon (v0.5.0, Daniel: as Excel's): the line at a group's right sets its width
 * (pointer drag, Left / Right arrows, double-click or its menu back to auto), the bottom edge the
 * toolbar's rows (drag, Up / Down, double-click back to three). Shown live (`preview`), kept in the
 * person's layout on release (toolbar-layout.ts withWidth / withRows).
 */
function useRibbonResize(
  bar: React.RefObject<HTMLDivElement | null>,
  live: React.RefObject<DragLive>,
  setPreview: (p: { group?: string; width?: number; rows?: number } | null) => void,
  rows: number,
) {
  const save = (m: ModeLayout) => live.current.prefs.setMode(live.current.mode, m);
  const itemsOf = (g: string) => bar.current?.querySelector<HTMLElement>(`.tb-group[data-group="${CSS.escape(g)}"] .tb-items`) ?? null;
  const widthNow = (g: string) => {
    const set = widthOf(live.current.m, g);
    if (set != null) return set;
    const el = itemsOf(g);
    return el ? el.getBoundingClientRect().width / scaleOf(bar.current) : MIN_GROUP_W;
  };
  const clampW = (w: number) => Math.round(Math.min(MAX_GROUP_W, Math.max(MIN_GROUP_W, w)));
  const clampR = (r: number) => Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.round(r)));
  /** A pointer drag on a handle: `at(dx, dy)` while moving, `done(dx, dy)` on release. */
  const follow = (e: React.PointerEvent<HTMLDivElement>, cursor: string, at: (dx: number, dy: number) => void, done: (dx: number, dy: number) => void) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const x0 = e.clientX;
    const y0 = e.clientY;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    const root = document.documentElement;
    root.classList.add(cursor);
    const move = (ev: PointerEvent) => at(ev.clientX - x0, ev.clientY - y0);
    const end = (ev: PointerEvent, keep: boolean) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      root.classList.remove(cursor);
      if (keep) done(ev.clientX - x0, ev.clientY - y0);
      setPreview(null);
    };
    const up = (ev: PointerEvent) => end(ev, true);
    const cancel = (ev: PointerEvent) => end(ev, false);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
  };
  const group: ResizeHandlers = {
    start(g, e) {
      const w0 = widthNow(g);
      const s = scaleOf(bar.current);
      follow(
        e,
        'cad-tb-resizing',
        (dx) => setPreview({ group: g, width: clampW(w0 + dx / s) }),
        (dx) => {
          if (Math.abs(dx) >= 1) save(withWidth(live.current.m, g, clampW(w0 + dx / s)));
        },
      );
    },
    auto(g) {
      save(withWidth(live.current.m, g, null));
    },
    key(g, e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        save(withWidth(live.current.m, g, clampW(widthNow(g) + (e.key === 'ArrowRight' ? WIDTH_STEP : -WIDTH_STEP))));
      } else if (e.key === 'Home' || e.key === 'Delete') {
        e.preventDefault();
        save(withWidth(live.current.m, g, null));
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
            run: () => save(withWidth(live.current.m, g, null)),
          },
          { sep: true, id: 'tb-sep' },
          {
            id: 'tb-reset',
            label: 'Reset toolbar',
            disabled: isDefault(live.current.m) ? 'The toolbar is already as it was at first' : null,
            run: () => live.current.prefs.reset(live.current.mode),
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
          if (r !== r0) save(withRows(live.current.m, r));
        },
      );
    },
    auto() {
      save(withRows(live.current.m, null));
    },
    key(e: React.KeyboardEvent<HTMLDivElement>) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        save(withRows(live.current.m, clampR(rows + (e.key === 'ArrowDown' ? 1 : -1))));
      } else if (e.key === 'Home') {
        e.preventDefault();
        save(withRows(live.current.m, null));
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
  const placedMore = new Set(groups.flatMap((g) => g.order.filter((x) => placeOf(x, lmode, ml, KEEP_SET) === 'more')));
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
  const fit = useFitLevel(mode, `${[...present].join(' ')}|${JSON.stringify(ml)}`, 2 + labelGroups.length + foldable.length + collapseGroups.length);
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
  // v0.5.0 ribbon (Daniel: as Excel's): the person drags the line at a group's right to set its
  // width, and the toolbar's bottom edge to set its rows; shown live while dragging, kept on release.
  const [preview, setPreview] = useState<{ group?: string; width?: number; rows?: number } | null>(null);
  const rows = preview?.rows ?? rowsOf(ml);
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
          />
        ))}
        {primary.length ? <Group id="primary" label={mode === 'sketch' ? 'SKETCH' : ''} commands={primary} services={services} panel={panel} sketchTool={sketchTool} primary menu={cz.menu} drag={drag.view} rows={rows} /> : null}
        {view.length ? <Group id="view" label="VIEW" commands={view} services={services} panel={panel} sketchTool={sketchTool} icons={viewIcons} menu={cz.menu} drag={drag.view} rows={rows} width={widthFor('view')} resize={resize.group} /> : null}
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
          />
        ))}
        {edit.length ? <Group id="edit" label="EDIT" commands={edit} services={services} panel={panel} sketchTool={sketchTool} end icons={viewIcons} menu={cz.menu} drag={drag.view} rows={rows} width={widthFor('edit')} resize={resize.group} /> : null}
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
          tabIndex={-1}
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
