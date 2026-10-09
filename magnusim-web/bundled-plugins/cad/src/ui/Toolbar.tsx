// The command toolbar (core .toolbar / .tb-btn recipe, style.css:133-224,
// 3746-3761). It shows only registered commands, which are the ones that work
// end to end: the registry's groups in mode order (SOLID, MODIFY, ...), then a
// VIEW group for the viewport's ungrouped view.* commands, then EDIT (Undo,
// Redo) at the right end. With nothing registered it renders nothing.
// A command that cannot run right now is aria-disabled and its tooltip says why.
// Sketch mode (services.mode 'sketch') shows the sketch groups, the primary
// Finish sketch button, VIEW, and sketch mode's own Undo / Redo.
// Every command fits the frame from 1280 px wide, with its label (P4a, Daniel
// works on 1280-1920 px screens): when the labelled buttons do not fit, VIEW
// and EDIT show icons only first, then the less-used commands go, one by one in
// FOLD_ORDER, into their group's "More" menu (Fusion style: "SOLID: Extrude,
// Revolve, More ▾"); the menu lists each one with its icon, shortcut and
// tooltip. Only below that (narrower than 1280 px) every group but the primary
// action shows icons (the label stays in the tooltip and the accessible name).
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
import { held, isDefault, layoutModeOf, orderIds, pinned, placeOf, toolbarPrefs, withMove, withPlace, withSwapIn, type LayoutMode, type ModeLayout, type ToolbarPrefs } from './toolbar-layout';

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
  'modify.parameters',
  'inspect.check',
  'construct.point',
  'solid.loft',
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
  'sketch.spline-control',
  'sketch.arc-tangent',
  'sketch.rectangle-center',
  'sketch.extend',
  'sketch.centerline',
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
];
const KEEP_SET: ReadonlySet<string> = new Set(KEEP_IN_VIEW);

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

function ToolbarButton({ c, services, active, index, primary = false, custom }: { c: CommandDef; services: AppServices; active: boolean; index: number; primary?: boolean; custom?: ButtonCustom }) {
  const reason = reasonOf(c, services);
  const tip = useTip(custom?.dragging ? null : { text: c.label, shortcut: c.shortcut, detail: reason ?? c.hint });
  const drop = custom?.drop ? ` is-drop-${custom.drop}` : '';
  return (
    <button
      type="button"
      className={`tb-btn${primary ? ' is-primary' : ''}${active ? ' is-active' : ''}${reason ? ' is-disabled' : ''}${custom?.dragging ? ' is-dragging' : ''}${drop}${custom?.displaced ? ' is-displaced' : ''}`}
      data-command={c.id}
      data-index={index}
      aria-label={c.label}
      aria-disabled={reason ? true : undefined}
      aria-pressed={active || undefined}
      aria-keyshortcuts={c.shortcut ? c.shortcut.replace(/Ctrl/g, 'Control') : undefined}
      data-disabled-reason={reason ?? undefined}
      {...tip}
      onContextMenu={custom?.onContextMenu}
      onPointerDown={custom?.onPointerDown}
      onClick={() => {
        // A More menu left open beside this button (a press here no longer closes it: a bar
        // command may be dragged into it) closes on the click.
        const ui = uiFor(services);
        if (ui.state.get().menu) ui.closeMenu();
        if (reason) return;
        void services.commands.run(c.id);
      }}
    >
      <span className="tb-ico">{c.icon ? <Icon d={c.icon} size={18} stroke={1.7} className="tb-svg" /> : null}</span>
      <span className="tb-txt">{c.label}</span>
    </button>
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
}: {
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
  const owner = `tb-more:${group}`;
  const open = useStateStore(ui.state, (s) => s.menu?.owner === owner);
  const ref = useRef<HTMLButtonElement>(null);
  const active = commands.some((c) => isActive(c, panel, sketchTool));
  const name = `More ${groupWords(label)} commands`;
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
      className={`tb-btn tb-more${active ? ' is-active' : ''}${open ? ' is-open' : ''}${dropInto ? ' is-drop-into' : ''}`}
      data-tb-more={group}
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
        <Icon d={ICONS.more} size={18} stroke={1.7} className="tb-svg" />
      </span>
      <span className="tb-txt">
        More <span className="tb-caret" aria-hidden="true">▾</span>
      </span>
    </button>
  );
}

/** What a registry group needs to let the user rearrange it. */
interface GroupCustom {
  /** The right-click menu of a command shown in the group. */
  barMenu(c: CommandDef, shown: string[], x: number, y: number): void;
  /** The right-click menu of a command in the group's More (`shown`: the group's commands on the bar). */
  moreMenu(c: CommandDef, shown: string[], x: number, y: number): void;
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
  custom,
  menu,
  drag,
  startDrag,
}: {
  id: string;
  label: string;
  commands: CommandDef[];
  folded?: ReadonlySet<string>;
  services: AppServices;
  panel: UiState['panel'];
  sketchTool: string | null;
  end?: boolean;
  primary?: boolean;
  custom?: GroupCustom;
  /** VIEW, EDIT and the primary action: their right-click menu (Reset toolbar). */
  menu?(x: number, y: number): void;
  /** The toolbar's drag in progress (any group's), to draw its marks here. */
  drag?: DragView | null;
  /** A press on one of the group's commands, on the bar or in its More: it may become a drag. */
  startDrag?(c: CommandDef, from: 'bar' | 'more', e: React.PointerEvent<HTMLButtonElement>): void;
}) {
  const more = folded ? commands.filter((c) => folded.has(c.id)) : [];
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
      className={`tb-group${end ? ' is-end' : ''}${at?.kind === 'refused' && at.group === id ? ' is-drop-refused' : ''}`}
      data-group={id}
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
      <div className="tb-group-label">{label}</div>
      {/* data-menu-keep: a press on the group's buttons leaves its open More menu open (a bar command may be dragged into it). */}
      <div className="tb-items" data-menu-keep={custom ? '1' : undefined}>
        {commands.map((c, i) =>
          more.includes(c) ? null : <ToolbarButton key={c.id} c={c} services={services} active={isActive(c, panel, sketchTool)} index={i} primary={primary} custom={customFor(c)} />,
        )}
        {more.length ? (
          <MoreButton
            group={id}
            label={label}
            commands={more}
            first={commands.indexOf(more[0])}
            services={services}
            panel={panel}
            sketchTool={sketchTool}
            dropInto={at?.kind === 'more' && at.group === id}
            {...(custom ? { itemMenu: (c: CommandDef, x: number, y: number) => custom.moreMenu(c, shown, x, y) } : {})}
            {...(custom && startDrag ? { onItemPress: (c: CommandDef, e: React.PointerEvent<HTMLButtonElement>) => startDrag(c, 'more', e) } : {})}
          />
        ) : null}
      </div>
    </div>
  );
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
    moreMenu(c, shown, x, y) {
      const stuck = pinned(m, c.id) && fitFolded.has(c.id);
      const last = shown.length ? shown[shown.length - 1] : null;
      ui.showMenu(
        x,
        y,
        [
          {
            id: 'tb-to-bar',
            label: 'Show in toolbar',
            disabled: stuck ? 'The toolbar is full at this width: move another command to More to make room' : null,
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
    [...(groupEl(g)?.querySelectorAll<HTMLElement>('.tb-items > .tb-btn[data-command]') ?? [])].filter((el) => el.dataset.command !== except);

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
      const index = btns.filter((el) => {
        const r = el.getBoundingClientRect();
        return x > (r.left + r.right) / 2;
      }).length;
      const mark = index < shown.length ? { target: shown[index], after: false } : shown.length ? { target: shown[shown.length - 1], after: true } : null;
      return { kind: 'bar', group: g, index, mark, displaced: shown.length ? shown[shown.length - 1] : null };
    }
    // A bar command: onto its group's More button is Move to More; elsewhere in the group, a move.
    const mr = groupEl(g)?.querySelector<HTMLElement>('[data-tb-more]')?.getBoundingClientRect();
    if (mr && x >= mr.left && x <= mr.right) return { kind: 'more', group: g, menu: false };
    let best: { target: string; after: boolean; dist: number } | null = null;
    for (const el of buttonsOf(g, d.id)) {
      const r = el.getBoundingClientRect();
      const dist = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (!best || dist < best.dist) best = { target: el.dataset.command ?? '', after: x > (r.left + r.right) / 2, dist };
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

/**
 * How compact the toolbar must be to show every command without scrolling:
 * 0 labels everywhere, 1 VIEW and EDIT as icons, 1 + k the first k foldable
 * commands (FOLD_ORDER) in their group's More menu, `max` every group but the
 * primary action as icons too. Measured after each render (before paint);
 * measured again from 0 when the toolbar's width, the mode or its commands change.
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
  const groups = services.commands.toolbar(mode).map((g) => {
    const byId = new Map(g.commands.map((c) => [c.id, c] as const));
    const order = orderIds(
      g.commands.map((c) => c.id),
      ml.order[g.group],
    );
    return { ...g, commands: order.map((x) => byId.get(x)!), order };
  });
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
  const fit = useFitLevel(mode, `${[...present].join(' ')}|${JSON.stringify(ml)}`, foldable.length + 2);
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
  const fitFolded = new Set(foldable.slice(0, Math.max(0, Math.min(fit.level - 1, foldable.length))));
  const folded = new Set([...placedMore, ...fitFolded]);
  const cz = customizer(services, prefs, lmode, ml, fitFolded);
  // UX 0.1.0: dragging between a group's More and its bar (the handlers read this render's layout).
  const live = useRef<DragLive>({ services, prefs, mode: lmode, m: ml, groups: [] });
  live.current = { services, prefs, mode: lmode, m: ml, groups: groups.map((g) => ({ group: g.group, label: g.label, order: g.order })) };
  const drag = useToolbarDrag(bar, live);
  const iconLevel = fit.level >= foldable.length + 2 ? 2 : fit.level >= 1 ? 1 : 0;
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
        className={`toolbar cad-toolbar${iconLevel ? ` is-fit-${iconLevel}` : ''}`}
        role="toolbar"
        aria-label="Commands"
        data-cad-toolbar={mode}
        data-fit={iconLevel}
        data-folded={folded.size}
        data-fit-folded={fitFolded.size}
        data-layout={isDefault(ml) ? 'default' : 'custom'}
        onContextMenu={(e) => {
          e.preventDefault();
          cz.menu(e.clientX, e.clientY);
        }}
      >
        {groups.map((g) => (
          <Group
            key={g.group}
            id={g.group}
            label={g.label}
            commands={g.commands}
            folded={folded}
            services={services}
            panel={panel}
            sketchTool={sketchTool}
            custom={cz.forGroup(g.group, g.order)}
            drag={drag.view}
            startDrag={(c, from, e) => drag.start(c, g.group, from, e)}
          />
        ))}
        {primary.length ? <Group id="primary" label={mode === 'sketch' ? 'SKETCH' : ''} commands={primary} services={services} panel={panel} sketchTool={sketchTool} primary menu={cz.menu} drag={drag.view} /> : null}
        {view.length ? <Group id="view" label="VIEW" commands={view} services={services} panel={panel} sketchTool={sketchTool} menu={cz.menu} drag={drag.view} /> : null}
        {edit.length ? <Group id="edit" label="EDIT" commands={edit} services={services} panel={panel} sketchTool={sketchTool} end menu={cz.menu} drag={drag.view} /> : null}
      </div>
      {drag.view ? <DragGhost view={drag.view} ghostRef={drag.ghostRef} /> : null}
    </>
  );
}
