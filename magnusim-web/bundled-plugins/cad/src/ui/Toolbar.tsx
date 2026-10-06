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

/**
 * The order in which commands fold into their group's "More" menu when the labelled toolbar does
 * not fit the frame, the first one first (after VIEW and EDIT have gone to icons). A command not
 * listed never folds: each group keeps its most-used command in view (Sketch, Extrude, Fillet,
 * Plane, Enclosure, Measure, Import STEP; in sketch mode Line, Rectangle, Circle, 3-point arc,
 * Dimension, Trim and Finish sketch; Chamfer stays beside Fillet). The order follows how often SolidWorks and Fusion users
 * reach for each command, weighted for Magnusim's CFD preparation (press-pull, Combine and the
 * enclosure stay longest): ARCHITECTURE.md §7 "Toolbar" gives the reasons. With labels, a
 * 1920 px frame folds nothing, 1600 px folds six, 1440 px nine and 1280 px twelve.
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
  'solid.sweep',
  'modify.shell',
  'file.export-step',
  'solid.revolve',
  'modify.combine',
  'modify.press-pull',
  // Sketch mode (CONSTRAIN is icons by design: its glyphs are the constraints' own).
  'sketch.point',
  'sketch.construction',
  'sketch.arc-tangent',
  'sketch.rectangle-center',
  'sketch.extend',
  'sketch.centerline',
];

/**
 * The toolbar commands that never fold: each group's most-used command (and CONSTRAIN, whose
 * buttons are the constraints' own glyphs). Every toolbar command is either here or in
 * FOLD_ORDER (tests/app/bootstrap.test.tsx checks it, so a new command needs a decision).
 */
export const KEEP_IN_VIEW: readonly string[] = [
  'sketch.new',
  'solid.extrude',
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

function ToolbarButton({ c, services, active, index, primary = false }: { c: CommandDef; services: AppServices; active: boolean; index: number; primary?: boolean }) {
  const reason = reasonOf(c, services);
  const tip = useTip({ text: c.label, shortcut: c.shortcut, detail: reason ?? c.hint });
  return (
    <button
      type="button"
      className={`tb-btn${primary ? ' is-primary' : ''}${active ? ' is-active' : ''}${reason ? ' is-disabled' : ''}`}
      data-command={c.id}
      data-index={index}
      aria-label={c.label}
      aria-disabled={reason ? true : undefined}
      aria-pressed={active || undefined}
      aria-keyshortcuts={c.shortcut ? c.shortcut.replace(/Ctrl/g, 'Control') : undefined}
      data-disabled-reason={reason ?? undefined}
      {...tip}
      onClick={() => {
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
}: {
  group: string;
  label: string;
  commands: CommandDef[];
  first: number;
  services: AppServices;
  panel: UiState['panel'];
  sketchTool: string | null;
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
}) {
  const more = folded ? commands.filter((c) => folded.has(c.id)) : [];
  return (
    <div className={`tb-group${end ? ' is-end' : ''}`} data-group={id} role="group" aria-label={label}>
      <div className="tb-group-label">{label}</div>
      <div className="tb-items">
        {commands.map((c, i) =>
          more.includes(c) ? null : <ToolbarButton key={c.id} c={c} services={services} active={isActive(c, panel, sketchTool)} index={i} primary={primary} />,
        )}
        {more.length ? <MoreButton group={id} label={label} commands={more} first={commands.indexOf(more[0])} services={services} panel={panel} sketchTool={sketchTool} /> : null}
      </div>
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

  const groups = services.commands.toolbar(mode);
  // The commands that may fold here, in folding order (only the mode's groups' own commands).
  const present = new Set(groups.flatMap((g) => g.commands.map((c) => c.id)));
  const foldable = FOLD_ORDER.filter((id) => present.has(id));
  const fit = useFitLevel(mode, [...present].join(' '), foldable.length + 2);
  const folded = new Set(foldable.slice(0, Math.max(0, Math.min(fit.level - 1, foldable.length))));
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
      ref={fit.ref}
      className={`toolbar cad-toolbar${iconLevel ? ` is-fit-${iconLevel}` : ''}`}
      role="toolbar"
      aria-label="Commands"
      data-cad-toolbar={mode}
      data-fit={iconLevel}
      data-folded={folded.size}
    >
      {groups.map((g) => (
        <Group key={g.group} id={g.group} label={g.label} commands={g.commands} folded={folded} services={services} panel={panel} sketchTool={sketchTool} />
      ))}
      {primary.length ? <Group id="primary" label={mode === 'sketch' ? 'SKETCH' : ''} commands={primary} services={services} panel={panel} sketchTool={sketchTool} primary /> : null}
      {view.length ? <Group id="view" label="VIEW" commands={view} services={services} panel={panel} sketchTool={sketchTool} /> : null}
      {edit.length ? <Group id="edit" label="EDIT" commands={edit} services={services} panel={panel} sketchTool={sketchTool} end /> : null}
    </div>
  );
}
