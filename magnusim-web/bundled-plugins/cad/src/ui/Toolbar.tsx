// The command toolbar (core .toolbar / .tb-btn recipe, style.css:133-224,
// 3746-3761). It shows only registered commands, which are the ones that work
// end to end: the registry's groups in mode order (SOLID, MODIFY, ...), then a
// VIEW group for the viewport's ungrouped view.* commands, then EDIT (Undo,
// Redo) at the right end. With nothing registered it renders nothing.
// A command that cannot run right now is aria-disabled and its tooltip says why.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { useServices } from '../lib/services';
import { useStateStore } from '../lib/store';
import type { AppServices } from '../types/app';
import type { CommandDef, Mode } from '../types/commands';
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

function isActive(c: CommandDef, panel: UiState['panel']): boolean {
  if (!panel) return false;
  if (c.id === PARAMS_ID) return panel.kind === 'params';
  return panel.kind === 'feature' && c.id === `solid.${panel.type}`;
}

function ToolbarButton({ c, services, active }: { c: CommandDef; services: AppServices; active: boolean }) {
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
      className={`tb-btn${active ? ' is-active' : ''}${reason ? ' is-disabled' : ''}`}
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

function Group({ id, label, commands, services, panel, end = false }: { id: string; label: string; commands: CommandDef[]; services: AppServices; panel: UiState['panel']; end?: boolean }) {
  return (
    <div className={`tb-group${end ? ' is-end' : ''}`} data-group={id} role="group" aria-label={label}>
      <div className="tb-group-label">{label}</div>
      <div className="tb-items">
        {commands.map((c) => (
          <ToolbarButton key={c.id} c={c} services={services} active={isActive(c, panel)} />
        ))}
      </div>
    </div>
  );
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

  const groups = services.commands.toolbar(mode);
  const view = viewCommands(services, mode);
  const edit = [UNDO_ID, REDO_ID].map((id) => services.commands.get(id)).filter((c): c is CommandDef => !!c && !!c.icon && modeOk(c, mode));
  if (!groups.length && !view.length && !edit.length) return null;
  return (
    <div className="toolbar cad-toolbar" role="toolbar" aria-label="Commands" data-cad-toolbar={mode}>
      {groups.map((g) => (
        <Group key={g.group} id={g.group} label={g.label} commands={g.commands} services={services} panel={panel} />
      ))}
      {view.length ? <Group id="view" label="VIEW" commands={view} services={services} panel={panel} /> : null}
      {edit.length ? <Group id="edit" label="EDIT" commands={edit} services={services} panel={panel} end /> : null}
    </div>
  );
}
