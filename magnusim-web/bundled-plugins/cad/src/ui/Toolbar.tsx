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
import { useTip, type MenuEntry } from './kit';
import { isDefault, layoutModeOf, orderIds, pinned, placeOf, toolbarPrefs, withMove, withPlace, type LayoutMode, type ModeLayout, type ToolbarPrefs } from './toolbar-layout';

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

/** What a group's button may do besides running its command: its right-click menu and the drag along the group. */
interface ButtonCustom {
  onContextMenu(e: React.MouseEvent<HTMLButtonElement>): void;
  onPointerDown?(e: React.PointerEvent<HTMLButtonElement>): void;
  onPointerMove?(e: React.PointerEvent<HTMLButtonElement>): void;
  onPointerUp?(e: React.PointerEvent<HTMLButtonElement>): void;
  onPointerCancel?(e: React.PointerEvent<HTMLButtonElement>): void;
  /** A click that ended a drag does not run the command. */
  takeClick?(): boolean;
  dragging?: boolean;
  drop?: 'before' | 'after' | null;
}

function ToolbarButton({ c, services, active, index, primary = false, custom }: { c: CommandDef; services: AppServices; active: boolean; index: number; primary?: boolean; custom?: ButtonCustom }) {
  const reason = reasonOf(c, services);
  const tip = useTip(custom?.dragging ? null : { text: c.label, shortcut: c.shortcut, detail: reason ?? c.hint });
  const drop = custom?.drop ? ` is-drop-${custom.drop}` : '';
  return (
    <button
      type="button"
      className={`tb-btn${primary ? ' is-primary' : ''}${active ? ' is-active' : ''}${reason ? ' is-disabled' : ''}${custom?.dragging ? ' is-dragging' : ''}${drop}`}
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
      onPointerMove={custom?.onPointerMove}
      onPointerUp={custom?.onPointerUp}
      onPointerCancel={custom?.onPointerCancel}
      onClick={() => {
        if (custom?.takeClick?.()) return;
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
      ...(itemMenu ? { onContext: (x: number, y: number) => itemMenu(c, x, y) } : {}),
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
      className={`tb-btn tb-more${active ? ' is-active' : ''}${open ? ' is-open' : ''}`}
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
  /** The right-click menu of a command in the group's More. */
  moreMenu(c: CommandDef, x: number, y: number): void;
  /** Move `id` to just before `before` (null: the end) in the group's order. */
  move(id: string, before: string | null): void;
}

const DRAG_PX = 6;

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
}) {
  const more = folded ? commands.filter((c) => folded.has(c.id)) : [];
  const shown = commands.filter((c) => !more.includes(c)).map((c) => c.id);
  const items = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; x0: number; pointer: number; active: boolean } | null>(null);
  const ate = useRef(false);
  const [mark, setMark] = useState<{ id: string; target: string; after: boolean } | null>(null);
  /** The shown button nearest the pointer (not the dragged one) and its side. */
  const targetAt = (x: number, from: string): { target: string; after: boolean } | null => {
    const els = [...(items.current?.querySelectorAll<HTMLElement>('.tb-btn[data-command]') ?? [])].filter((el) => el.dataset.command !== from);
    let best: { target: string; after: boolean; d: number } | null = null;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const mid = (r.left + r.right) / 2;
      const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (!best || d < best.d) best = { target: el.dataset.command ?? '', after: x > mid, d };
    }
    return best ? { target: best.target, after: best.after } : null;
  };
  const customFor = (c: CommandDef): ButtonCustom | undefined => {
    if (!custom) return menu ? { onContextMenu: (e) => (e.preventDefault(), e.stopPropagation(), menu(e.clientX, e.clientY)) } : undefined;
    return {
      onContextMenu(e) {
        e.preventDefault();
        e.stopPropagation();
        custom.barMenu(c, shown, e.clientX, e.clientY);
      },
      onPointerDown(e) {
        if (e.button !== 0) return;
        ate.current = false;
        drag.current = { id: c.id, x0: e.clientX, pointer: e.pointerId, active: false };
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic events */
        }
      },
      onPointerMove(e) {
        const d = drag.current;
        if (!d || d.pointer !== e.pointerId || d.id !== c.id) return;
        if (!d.active && Math.abs(e.clientX - d.x0) < DRAG_PX) return;
        d.active = true;
        const t = targetAt(e.clientX, d.id);
        setMark(t ? { id: d.id, ...t } : { id: d.id, target: '', after: false });
      },
      onPointerUp(e) {
        const d = drag.current;
        drag.current = null;
        if (!d || d.pointer !== e.pointerId || !d.active) return;
        ate.current = true;
        setMark(null);
        const t = targetAt(e.clientX, d.id);
        if (!t || !t.target) return;
        const rest = commands.map((x) => x.id).filter((x) => x !== d.id);
        const before = t.after ? (rest[rest.indexOf(t.target) + 1] ?? null) : t.target;
        custom.move(d.id, before);
      },
      onPointerCancel() {
        drag.current = null;
        setMark(null);
      },
      takeClick() {
        const was = ate.current;
        ate.current = false;
        return was;
      },
      dragging: mark?.id === c.id,
      drop: mark && mark.target === c.id ? (mark.after ? 'after' : 'before') : null,
    };
  };
  return (
    <div
      className={`tb-group${end ? ' is-end' : ''}`}
      data-group={id}
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
      <div className="tb-items" ref={items}>
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
            {...(custom ? { itemMenu: (c: CommandDef, x: number, y: number) => custom.moreMenu(c, x, y) } : {})}
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
 * narrow for it), Reset toolbar. Anywhere else on the toolbar: Reset toolbar.
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
    moreMenu(c, x, y) {
      const stuck = pinned(m, c.id) && fitFolded.has(c.id);
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
          { sep: true, id: 'tb-sep' },
          reset,
        ],
        `Toolbar: ${c.label}`,
      );
    },
    move(id, before) {
      set(withMove(m, group, order, id, before));
    },
  });
  const menu = (x: number, y: number) => ui.showMenu(x, y, [reset], 'Toolbar');
  return { forGroup, menu };
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
  // What the user asked to see ("Show in toolbar") folds last, after the rest in FOLD_ORDER.
  const foldable = [
    ...FOLD_ORDER.filter((x) => present.has(x) && !placedMore.has(x) && !pinned(ml, x)),
    ...FOLD_ORDER.filter((x) => present.has(x) && !placedMore.has(x) && pinned(ml, x)),
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
  const iconLevel = fit.level >= foldable.length + 2 ? 2 : fit.level >= 1 ? 1 : 0;
  const view = viewCommands(services, mode);
  // Sketch mode undoes inside the sketch (its own Undo / Redo); model mode the document's.
  const editIds = mode === 'sketch' ? [WELL_KNOWN_COMMANDS.sketchUndo, WELL_KNOWN_COMMANDS.sketchRedo] : [UNDO_ID, REDO_ID];
  const edit = editIds.map((id) => services.commands.get(id)).filter((c): c is CommandDef => !!c && !!c.icon && modeOk(c, mode));
  // The mode's primary action (Finish sketch), on its own after the mode's groups.
  const primary = services.commands.all().filter((c) => c.primary && c.icon && modeOk(c, mode));
  if (!groups.length && !view.length && !edit.length && !primary.length) return null;
  return (
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
        />
      ))}
      {primary.length ? <Group id="primary" label={mode === 'sketch' ? 'SKETCH' : ''} commands={primary} services={services} panel={panel} sketchTool={sketchTool} primary menu={cz.menu} /> : null}
      {view.length ? <Group id="view" label="VIEW" commands={view} services={services} panel={panel} sketchTool={sketchTool} menu={cz.menu} /> : null}
      {edit.length ? <Group id="edit" label="EDIT" commands={edit} services={services} panel={panel} sketchTool={sketchTool} end menu={cz.menu} /> : null}
    </div>
  );
}
