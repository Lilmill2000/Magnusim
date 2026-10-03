// The command toolbar (core .toolbar / .tb-btn recipe, style.css:133-224,
// 3746-3761). It shows only registered commands, which are the ones that work
// end to end: the registry's groups in mode order (SOLID, MODIFY, ...), then a
// VIEW group for the viewport's ungrouped view.* commands, then EDIT (Undo,
// Redo) at the right end. With nothing registered it renders nothing.
// A command that cannot run right now is aria-disabled and its tooltip says why.
// Sketch mode (services.mode 'sketch') shows the sketch groups, the primary
// Finish sketch button, VIEW, and sketch mode's own Undo / Redo.
// Every command fits the frame from 1280 px wide: when the labelled buttons do
// not fit, VIEW and EDIT show icons only, then every group but the primary
// action (the label stays in the tooltip and the accessible name). Review
// P2/P3 round 1: at 1280 px Undo, Redo and some views were scrolled out of
// reach, with no scrollbar in real Chrome.
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
import { useTip } from './kit';

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

function ToolbarButton({ c, services, active, primary = false }: { c: CommandDef; services: AppServices; active: boolean; primary?: boolean }) {
  let ok: true | string = true;
  try {
    ok = c.enabled ? c.enabled(services) : true;
  } catch (err) {
    ok = err instanceof Error ? err.message : String(err);
  }
  const reason = ok === true ? null : ok;
  const tip = useTip({ text: c.label, shortcut: c.shortcut, detail: reason ?? c.hint });
  return (
    <button
      type="button"
      className={`tb-btn${primary ? ' is-primary' : ''}${active ? ' is-active' : ''}${reason ? ' is-disabled' : ''}`}
      data-command={c.id}
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

function Group({
  id,
  label,
  commands,
  services,
  panel,
  sketchTool,
  end = false,
  primary = false,
}: {
  id: string;
  label: string;
  commands: CommandDef[];
  services: AppServices;
  panel: UiState['panel'];
  sketchTool: string | null;
  end?: boolean;
  primary?: boolean;
}) {
  return (
    <div className={`tb-group${end ? ' is-end' : ''}`} data-group={id} role="group" aria-label={label}>
      <div className="tb-group-label">{label}</div>
      <div className="tb-items">
        {commands.map((c) => (
          <ToolbarButton key={c.id} c={c} services={services} active={isActive(c, panel, sketchTool)} primary={primary} />
        ))}
      </div>
    </div>
  );
}

/**
 * How compact the toolbar must be to show every command without scrolling:
 * 0 labels everywhere, 1 VIEW and EDIT as icons, 2 every group but the primary
 * action as icons. Measured after each render (before paint); measured again
 * from 0 when the toolbar's width or the mode changes.
 */
function useFitLevel(mode: Mode): { ref: (node: HTMLDivElement | null) => void; level: number } {
  const node = useRef<HTMLDivElement | null>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((n: HTMLDivElement | null) => {
    node.current = n;
    setEl(n);
  }, []);
  const [width, setWidth] = useState(0);
  const [fit, setFit] = useState({ key: '', level: 0 });
  // A new mode or width starts again from labels everywhere.
  const key = `${mode}|${width}`;
  const level = fit.key === key ? fit.level : 0;
  useLayoutEffect(() => {
    const n = node.current;
    if (n && level < 2 && n.scrollWidth > n.clientWidth + 1) setFit({ key, level: level + 1 });
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
  const fit = useFitLevel(mode);

  const groups = services.commands.toolbar(mode);
  const view = viewCommands(services, mode);
  // Sketch mode undoes inside the sketch (its own Undo / Redo); model mode the document's.
  const editIds = mode === 'sketch' ? [WELL_KNOWN_COMMANDS.sketchUndo, WELL_KNOWN_COMMANDS.sketchRedo] : [UNDO_ID, REDO_ID];
  const edit = editIds.map((id) => services.commands.get(id)).filter((c): c is CommandDef => !!c && !!c.icon && modeOk(c, mode));
  // The mode's primary action (Finish sketch), on its own after the mode's groups.
  const primary = services.commands.all().filter((c) => c.primary && c.icon && modeOk(c, mode));
  if (!groups.length && !view.length && !edit.length && !primary.length) return null;
  return (
    <div ref={fit.ref} className={`toolbar cad-toolbar${fit.level ? ` is-fit-${fit.level}` : ''}`} role="toolbar" aria-label="Commands" data-cad-toolbar={mode} data-fit={fit.level}>
      {groups.map((g) => (
        <Group key={g.group} id={g.group} label={g.label} commands={g.commands} services={services} panel={panel} sketchTool={sketchTool} />
      ))}
      {primary.length ? <Group id="primary" label={mode === 'sketch' ? 'SKETCH' : ''} commands={primary} services={services} panel={panel} sketchTool={sketchTool} primary /> : null}
      {view.length ? <Group id="view" label="VIEW" commands={view} services={services} panel={panel} sketchTool={sketchTool} /> : null}
      {edit.length ? <Group id="edit" label="EDIT" commands={edit} services={services} panel={panel} sketchTool={sketchTool} end /> : null}
    </div>
  );
}
