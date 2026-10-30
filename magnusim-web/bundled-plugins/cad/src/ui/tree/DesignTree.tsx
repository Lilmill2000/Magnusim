// The design tree card (core LeftTree recipe), one tree as in SOLIDWORKS:
//   PART     the part's name, Origin (point and planes), Parameters (n) once the
//            document has parameters to edit, Bodies (n) (eye toggle, rename)
//   HISTORY  the features in order, with the draggable rollback bar; rows below
//            it are dimmed, suppressed rows greyed and struck through, failed
//            rows red and warned rows amber with a "What's wrong" tooltip; a
//            feature's note (a Join's pieces left apart) is a quiet info mark
//            with a "Note" tooltip, and follows the warning in a warned row's.
// Click selects (shared with the viewport), Ctrl+click toggles, double-click
// opens the feature's panel, right-click opens the context menu. A feature row dragged onto
// another goes before or after it (doc.move, the order rule of the Assistant's edit_feature move);
// a body's swatch opens its colour picker (doc.setBodyColor, the Assistant's body color).
// Sketch rows (P3-PROFILES): "(-)" / "(+)" / "(?)" before the name as
// SOLIDWORKS shows how defined a sketch is (a lock when fully defined), its
// dimension count, and an eye that shows or hides it in the view; a reference
// Plane, Axis or Point has the same eye. A hidden one's name and icon are dimmed,
// as a hidden body's; its menu's Hide / Show does what the eye does.
// ux010: the PART head's chevron slides the card into its rail (src/ui/LeftStack.tsx, TreeRail.tsx).
// Owner: UI-SHELL; sketch rows P3-PROFILES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import { useServices } from '../../lib/services';
import { isSelected, selectItem } from '../../lib/selection';
import { useStateStore } from '../../lib/store';
import { ORIGIN_PLANES, type OriginPlaneRef, type OriginRef, type Vec3 } from '../../types/doc';
import type { SelectionItem } from '../../types/selection';
import type { ViewportHandle } from '../../types/viewport';
import { PARAMS_ID } from '../commands';
import { errText, uiFor } from '../controller';
import { Icon, ICONS } from '../Icon';
import { DisabledReason, EmptyState, IconButton, InlineRename, TreeNode, TreeSection, useTip } from '../kit';
import { constructKindOfType } from '../../features/refgeom/api';
import { constructView, ORIGIN_AXIS_NAMES, ORIGIN_AXIS_REFS } from '../../features/refgeom/scene';
import { RAIL_COMMAND, railsFor, useRailFocus } from '../left-rails';
import { keybindMenuItem, railKeybindMenu, useKeyLabel } from '../keybinds';
import { CHEVRON_LEFT } from './TreeRail';
import { seeThroughBy } from '../../viewport/bind';
import { barIndexAt, bodyRows, dimensionsText, featureShown, historyRows, rollbackIndex, selectedBodies, selectedFeatures, sketchPrefix, type BodyRow, type HistoryRow } from './model';

/** A padlock (24 viewBox outline): the sketch is fully defined. */
const LOCK_ICON = 'M7.5 11V8a4.5 4.5 0 0 1 9 0v3 M5.5 11h13v9.5h-13z';

const PLANES: OriginPlaneRef[] = ['origin:top', 'origin:front', 'origin:right'];
/** The host keeps study titles to 120 characters (magnusim_sdk.data.rename_study). */
const MAX_PART_NAME = 120;
/** Camera "up" when looking straight at each origin plane. */
const PLANE_UP: Record<OriginPlaneRef, Vec3> = { 'origin:top': [0, 1, 0], 'origin:front': [0, 0, 1], 'origin:right': [0, 0, 1] };

function useCommandPresent(id: string): boolean {
  const { commands } = useServices();
  const [present, setPresent] = useState(() => !!commands.get(id));
  useEffect(() => {
    setPresent(!!commands.get(id));
    return commands.subscribe(() => setPresent(!!commands.get(id)));
  }, [commands, id]);
  return present;
}

function usePartName(): string {
  const { bridge } = useServices();
  const [title, setTitle] = useState(() => bridge.context.study.title);
  useEffect(() => bridge.onStudy((s) => setTitle(s.title)), [bridge]);
  return title;
}

function StatusBadge({ row, onOpen }: { row: HistoryRow; onOpen(): void }) {
  // An error or a warning has the badge; a note alone (said, not wrong) has the quiet info mark.
  const wrong = row.status === 'error' || row.status === 'warning';
  const kind = wrong ? row.status : row.note ? 'note' : null;
  // A warned row's note follows the warning in its tooltip and label.
  const also = wrong && row.note ? `Note: ${row.note}` : null;
  const tip = useTip(wrong && row.message ? { text: "What's wrong", detail: also ? `${row.message}\n${also}` : row.message } : kind === 'note' ? { text: 'Note', detail: row.note! } : null);
  if (!kind) return null;
  const label =
    kind === 'note' ? `Note: ${row.note}` : `What's wrong: ${row.message ?? (row.status === 'error' ? 'the feature failed' : 'the feature has a warning')}${also ? `. ${also}` : ''}`;
  return (
    <button
      type="button"
      className={`cad-badge is-${kind}`}
      aria-label={label}
      data-feature-badge={kind}
      data-message={(kind === 'note' ? row.note : row.message) ?? undefined}
      data-note={also ? row.note! : undefined}
      {...tip}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {kind === 'error' ? <span className="cad-badge-dot" /> : <Icon d={kind === 'note' ? ICONS.info : ICONS.warning} size={13} />}
    </button>
  );
}

function RollbackBar({ index, count, dragging, onPointerDown, onKey }: { index: number; count: number; dragging: boolean; onPointerDown(e: ReactPointerEvent<HTMLLIElement>): void; onKey(e: KeyboardEvent<HTMLLIElement>): void }) {
  const tip = useTip({ text: 'Rollback bar', detail: 'Drag it, or use the arrow keys, to build the part only up to here' });
  const where = index >= count ? 'at the end' : index === 0 ? 'before every feature' : `after feature ${index}`;
  return (
    <li
      className={`cad-rollback${dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Rollback bar"
      aria-valuemin={0}
      aria-valuemax={count}
      aria-valuenow={index}
      aria-valuetext={where}
      tabIndex={0}
      data-rollback-bar="1"
      data-index={index}
      onPointerDown={onPointerDown}
      onKeyDown={onKey}
      {...tip}
    >
      <span className="cad-rollback-grip" aria-hidden="true" />
      <span className="cad-rollback-line" aria-hidden="true" />
    </li>
  );
}

function History() {
  const services = useServices();
  const ui = uiFor(services);
  const { doc, selection } = services;
  const d = useStateStore(doc.state, (s) => ({ features: s.doc.features, rollback: s.view.rollback, sketches: s.view.sketches, rebuild: s.rebuild.features, bodies: s.rebuild.bodies, status: s.status, error: s.error }));
  const sel = useStateStore(selection);
  const uiState = useStateStore(ui.state, (s) => ({ panel: s.panel, renaming: s.renaming }));
  const [drag, setDrag] = useState<number | null>(null);
  // A feature row dragged to a new place in the history (doc.move, as the Assistant's edit_feature move).
  const [moving, setMoving] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; where: 'before' | 'after' } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const count = d.features.length;
  const saved = rollbackIndex({ rollback: d.rollback }, count);
  const bar = drag ?? saved;
  const rows = historyRows({ features: d.features }, { rollback: bar >= count ? null : bar }, { features: d.rebuild });
  const { direct, related } = selectedFeatures(sel, d.bodies);
  const editing = uiState.panel?.kind === 'feature' ? uiState.panel.feature : null;

  const mids = () => {
    const el = listRef.current;
    if (!el) return [];
    return [...el.querySelectorAll<HTMLElement>('[data-feature-row] > .tree-row')].map((r) => {
      const b = r.getBoundingClientRect();
      return b.top + b.height / 2;
    });
  };

  const onBarPointerDown = (e: ReactPointerEvent<HTMLLIElement>) => {
    if (e.button > 0) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    let current = saved;
    setDrag(current);
    const move = (ev: PointerEvent) => {
      current = barIndexAt(ev.clientY, mids());
      setDrag(current);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDrag(null);
      ui.setRollbackIndex(current);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const onBarKey = (e: KeyboardEvent<HTMLLIElement>) => {
    let next: number | null = null;
    if (e.key === 'ArrowUp') next = Math.max(0, saved - 1);
    else if (e.key === 'ArrowDown') next = Math.min(count, saved + 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count;
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    ui.setRollbackIndex(next);
  };

  // Keep keyboard focus on the bar after a key moved it (moving the node in the list drops focus).
  const barKeyAt = useRef(0);
  useEffect(() => {
    if (Date.now() - barKeyAt.current > 1000) return;
    listRef.current?.querySelector<HTMLElement>('[data-rollback-bar]')?.focus({ preventScroll: true });
  }, [saved]);

  const handle = useStateStore(services.viewport, (s) => s.handle);
  const flash = (items: SelectionItem[]) => handle?.flash(items);

  const onRowClick = (row: HistoryRow, e: MouseEvent) => selectItem(selection, { kind: 'feature', feature: row.id }, e.ctrlKey || e.metaKey);
  const onRowMenu = (row: HistoryRow, e: MouseEvent) => {
    e.preventDefault();
    const item = { kind: 'feature' as const, feature: row.id };
    if (!isSelected(selection.get(), item)) selectItem(selection, item, false);
    ui.showMenu(e.clientX, e.clientY, ui.featureMenu(row.id), `${row.name} actions`);
  };
  const onRowOpen = (row: HistoryRow) => {
    if (row.rolledBack && drag == null) {
      services.bridge.toast(`Roll forward to edit ${row.name}`, 'info');
      return;
    }
    ui.openEdit(row.id);
  };

  /** The index the dragged feature ends at when dropped before or after `target` (the list without it, then it put in). */
  const dropIndex = (id: string, target: string, where: 'before' | 'after'): number | null => {
    const from = d.features.findIndex((f) => f.id === id);
    const at = d.features.findIndex((f) => f.id === target);
    if (from < 0 || at < 0 || from === at) return null;
    const to = where === 'before' ? (from < at ? at - 1 : at) : from < at ? at : at + 1;
    return to === from ? null : to;
  };
  const whereIn = (e: DragEvent<HTMLDivElement>): 'before' | 'after' => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? 'before' : 'after';
  };
  const block = ui.editBlock();
  const rowDrag = (row: HistoryRow): Record<string, unknown> => ({
    draggable: !block && !uiState.renaming,
    'data-feature-drag': row.id,
    onDragStart: (e: DragEvent<HTMLDivElement>) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-cad-feature', row.id);
      e.dataTransfer.setData('text/plain', row.name);
      setMoving(row.id);
    },
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      if (!moving || moving === row.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const where = whereIn(e);
      if (drop?.id !== row.id || drop.where !== where) setDrop({ id: row.id, where });
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const id = moving ?? e.dataTransfer.getData('application/x-cad-feature');
      setMoving(null);
      setDrop(null);
      if (!id || id === row.id) return;
      const to = dropIndex(id, row.id, whereIn(e));
      if (to !== null) ui.moveFeature(id, to);
    },
    onDragEnd: () => {
      setMoving(null);
      setDrop(null);
    },
  });

  const items: ReactElement[] = [];
  const barEl = (
    <RollbackBar
      key="rollback-bar"
      index={bar}
      count={count}
      dragging={drag != null}
      onPointerDown={onBarPointerDown}
      onKey={(e) => {
        barKeyAt.current = Date.now();
        onBarKey(e);
      }}
    />
  );
  rows.forEach((row, i) => {
    if (i === bar) items.push(barEl);
    const def = doc.features.get(row.type);
    const renaming = uiState.renaming?.kind === 'feature' && uiState.renaming.id === row.id;
    // A sketch, or (P4a REFERENCE) a reference Plane, Axis or Point: an eye (null: no eye).
    const shown = featureShown({ features: d.features }, { sketches: d.sketches }, doc.features, row.id);
    const construct = constructKindOfType(row.type);
    const cls = [
      row.rolledBack ? 'is-rolled-back' : '',
      row.suppressed ? 'is-suppressed' : '',
      row.status === 'error' ? 'is-error' : '',
      row.status === 'warning' ? 'is-warning' : '',
      related.has(row.id) ? 'is-related' : '',
      editing === row.id ? 'is-editing' : '',
      moving === row.id ? 'is-dragged' : '',
      drop?.id === row.id ? `is-drop-${drop.where}` : '',
      // Dimmed only when the person hid it (a sketch a later feature uses is hidden by default:
      // dimming those would grey most of a history); its eye says hidden either way.
      shown === false && d.sketches?.[row.id] === 'hidden' ? 'is-hidden-feature' : '',
    ]
      .filter(Boolean)
      .join(' ');
    const sk = row.sketch;
    const prefix = sk ? sketchPrefix(sk.state) : '';
    items.push(
      <TreeNode
        key={row.id}
        nodeKey={row.id}
        icon={def?.icon || (ICONS as Record<string, string>)[row.type] || ICONS.part}
        label={
          renaming ? (
            <InlineRename
              name={row.name}
              label="Feature"
              onRename={(next) => ui.renameFeature(row.id, next)}
              onDone={() => ui.endRename()}
              onGiveUp={(why) => ui.fail(`Rename ${row.name}`, why)}
            />
          ) : sk ? (
            <>
              {prefix ? (
                <span className="cad-sketch-prefix" data-sketch-prefix={prefix}>
                  {prefix}{' '}
                </span>
              ) : null}
              {row.name}
              {sk.state === 'fully' && !sk.empty ? (
                <span className="cad-sketch-lock" data-sketch-lock="1" role="img" aria-label="Fully defined">
                  <Icon d={LOCK_ICON} size={11} />
                </span>
              ) : null}
            </>
          ) : (
            row.name
          )
        }
        labelTitle={row.name}
        selected={direct.has(row.id)}
        className={cls}
        attrs={{
          'data-feature-row': '1',
          'data-feature-type': row.type,
          'data-state': row.status,
          'data-suppressed': row.suppressed ? '1' : undefined,
          'data-rolled-back': row.rolledBack ? '1' : undefined,
          'data-sketch-state': sk?.state,
          'data-sketch-shown': sk ? (shown ? '1' : '0') : undefined,
          'data-construct-shown': construct ? (shown ? '1' : '0') : undefined,
        }}
        badge={<StatusBadge row={row} onOpen={() => onRowOpen(row)} />}
        sub={row.suppressed ? 'Suppressed' : sk ? (dimensionsText(sk.dims) ?? undefined) : undefined}
        actions={
          shown === null ? undefined : (
            <IconButton
              size="row"
              icon={shown ? ICONS.eye : ICONS.eyeOff}
              label={shown ? `Hide ${row.name}` : `Show ${row.name}`}
              hint={shown ? 'Shown in the view' : 'Hidden in the view'}
              {...(sk ? { 'data-sketch-act': 'visibility' } : { 'data-construct-act': 'visibility' })}
              data-visible={shown ? '1' : '0'}
              // A sketch's choice that matches the default is forgotten (ui.setFeatureVisible), so a sketch
              // shown by default still hides once a feature uses it.
              onClick={() => ui.setFeatureVisible(row.id, !shown)}
            />
          )
        }
        rowProps={rowDrag(row)}
        onClick={(e) => onRowClick(row, e)}
        onDoubleClick={() => onRowOpen(row)}
        onContextMenu={(e) => onRowMenu(row, e)}
        onMouseEnter={() => {
          flash([{ kind: 'feature', feature: row.id }]);
          if (construct) constructView(services).set({ flash: row.id });
        }}
        onMouseLeave={() => {
          flash([]);
          if (construct) constructView(services).set({ flash: null });
        }}
      />,
    );
  });
  if (count > 0 && bar >= count) items.push(barEl);

  return (
    <div ref={listRef}>
      <TreeSection title="HISTORY" section="history">
        {d.status === 'loading' ? (
          <EmptyState tree attr={{ 'data-tree-empty': 'loading' }}>
            Opening the part…
          </EmptyState>
        ) : d.status === 'error' ? (
          <li className="cad-tree-error" data-tree-error="1">
            <DisabledReason fixes={[{ label: 'Try again', run: () => void doc.reload().catch(() => {}) }]}>{d.error || 'The part could not be read'}</DisabledReason>
          </li>
        ) : count === 0 ? (
          <EmptyState tree attr={{ 'data-tree-empty': 'history' }}>
            No features yet
          </EmptyState>
        ) : (
          items
        )}
      </TreeSection>
    </div>
  );
}

/**
 * A body's colour swatch: a click opens the colour picker (the context menu's "Colour…" too); the
 * colour chosen is one undo step (doc.setBodyColor, as the Assistant's body color). The picker's
 * `change` (its close), not each `input` while dragging in it, is the step.
 */
function BodyColor({ row }: { row: BodyRow }) {
  const services = useServices();
  const ui = uiFor(services);
  const ref = useRef<HTMLInputElement>(null);
  const asked = useStateStore(ui.state, (s) => s.colorFor === row.id);
  const block = ui.editBlock();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onChange = () => {
      const v = el.value.toLowerCase();
      if (v !== row.color.toLowerCase()) ui.setBodyColor(row.id, v);
    };
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, [ui, row.id, row.color]);
  useEffect(() => {
    if (!asked) return;
    ui.pickBodyColor(null);
    const el = ref.current;
    if (!el || el.disabled) return;
    try {
      if (typeof el.showPicker === 'function') el.showPicker();
      else el.click();
    } catch {
      el.click();
    }
  }, [asked, ui]);
  const tip = useTip({ text: `Colour of ${row.name}`, detail: block ?? 'Click to choose its colour' });
  return (
    <label className="cad-swatch-pick" data-body-color-pick={row.id} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} {...tip}>
      <span className="cad-swatch" style={{ background: row.color }} aria-hidden="true" />
      <input
        key={row.color}
        ref={ref}
        type="color"
        className="cad-swatch-input"
        defaultValue={row.color}
        disabled={!!block}
        aria-label={`Colour of ${row.name}`}
        data-body-color={row.id}
        data-color={row.color.toLowerCase()}
      />
    </label>
  );
}

function BodyNode({ row, selected }: { row: BodyRow; selected: boolean }) {
  const services = useServices();
  const ui = uiFor(services);
  const renaming = useStateStore(ui.state, (s) => s.renaming?.kind === 'body' && s.renaming.id === row.id);
  const handle = useStateStore(services.viewport, (s) => s.handle);
  const tipInvalid = useTip(row.valid ? null : { text: "What's wrong", detail: 'The kernel reports this body as invalid geometry' });
  const seeWords = row.seeThrough === 'feature' ? 'Always drawn see-through (the air of an Enclosure)' : 'Drawn see-through: right-click for Make opaque, or INSPECT > See-through';
  const tipSee = useTip(row.seeThrough ? { text: 'See-through', detail: seeWords } : null);
  return (
    <TreeNode
      nodeKey={`body:${row.id}`}
      indent
      label={
        <>
          <BodyColor row={row} />
          {renaming ? (
            <InlineRename name={row.name} label="Body" onRename={(n) => ui.renameBody(row.id, n)} onDone={() => ui.endRename()} onGiveUp={(why) => ui.fail(`Rename ${row.name}`, why)} />
          ) : (
            <span className="cad-body-name">{row.name}</span>
          )}
        </>
      }
      labelTitle={!row.visible && row.inSimulation ? `${row.name} (hidden, still in the simulation)` : row.name}
      selected={selected}
      className={[row.visible ? '' : 'is-hidden-body', row.seeThrough ? 'is-see-through-body' : ''].filter(Boolean).join(' ') || undefined}
      attrs={{
        'data-body-row': row.id,
        'data-visible': row.visible ? '1' : '0',
        'data-see-through': row.seeThrough ?? undefined,
        'data-in-simulation': row.inSimulation == null ? undefined : row.inSimulation ? '1' : '0',
        'data-hidden-in-simulation': !row.visible && row.inSimulation ? '1' : undefined,
      }}
      badge={
        <>
          {/* See-through: its own mark, apart from a hidden body's dimmed name (a hidden body may be see-through too). */}
          {row.seeThrough ? (
            <span className="cad-badge is-see-through" role="img" aria-label={`See-through: ${seeWords}`} tabIndex={0} data-see-through-badge {...tipSee}>
              <Icon d={ICONS.seeThrough} size={13} />
            </span>
          ) : null}
          {row.valid ? null : (
            <span className="cad-badge is-warning" role="img" aria-label="What's wrong: the kernel reports this body as invalid geometry" tabIndex={0} {...tipInvalid}>
              <Icon d={ICONS.warning} size={13} />
            </span>
          )}
        </>
      }
      actions={
        <>
          {row.inSimulation == null ? null : (
            <IconButton
              size="row"
              icon={row.inSimulation ? ICONS.sim : ICONS.simOff}
              label={row.inSimulation ? `Leave ${row.name} out of the simulation` : `Include ${row.name} in the simulation`}
              hint={
                row.inSimulation
                  ? row.visible
                    ? "In the simulation: this body goes to the project's geometry"
                    : "Hidden, still in the simulation: hiding is a view; this body goes to the project's geometry"
                  : "Left out of the simulation: the project's geometry does not get this body"
              }
              pressed={row.inSimulation}
              data-body-act="simulation"
              disabledReason={ui.editBlock()}
              onClick={() => ui.setBodyInSimulation(row.id, !row.inSimulation)}
            />
          )}
          <IconButton
            size="row"
            icon={row.visible ? ICONS.eye : ICONS.eyeOff}
            label={row.visible ? `Hide ${row.name}` : `Show ${row.name}`}
            // A hidden body is still sent to the simulation (link review): its eye says so.
            hint={!row.visible && row.inSimulation ? 'Hidden, still in the simulation' : undefined}
            data-body-act="visibility"
            onClick={() => ui.setBodyVisible(row.id, !row.visible)}
          />
          <IconButton size="row" icon={ICONS.pencil} label={`Rename ${row.name}`} data-body-act="rename" disabledReason={ui.editBlock()} onClick={() => ui.startRename('body', row.id)} />
        </>
      }
      onClick={(e) => selectItem(services.selection, { kind: 'body', body: row.id }, e.ctrlKey || e.metaKey)}
      onContextMenu={(e) => {
        e.preventDefault();
        const item = { kind: 'body' as const, body: row.id };
        if (!isSelected(services.selection.get(), item)) selectItem(services.selection, item, false);
        ui.showMenu(e.clientX, e.clientY, ui.bodyMenu(row.id), `${row.name} actions`);
      }}
      onMouseEnter={() => handle?.flash([{ kind: 'body', body: row.id }])}
      onMouseLeave={() => handle?.flash([])}
    />
  );
}

/**
 * The Origin row's eye: the viewport's origin-planes mode (VIEWPORT's
 * setPlanes, the same setting as its views menu); pressed = always drawn. The
 * glyph says what the viewport shows now: open while the planes are drawn
 * (always, or on an empty part), crossed out while they are not.
 */
function PlanesEye({ handle }: { handle: ViewportHandle }) {
  const v = useStateStore(handle.state, (s) => ({ planes: s.planes, bodies: s.bodies }));
  const always = v.planes === 'always';
  const drawn = always || v.bodies === 0;
  const hint = always
    ? 'On: Top, Front and Right are always drawn'
    : drawn
      ? 'Off: drawn now because the part shows no body; then only while one is selected or hovered'
      : 'Off: drawn on an empty part, and while one is selected or hovered';
  return (
    <IconButton
      size="row"
      icon={drawn ? ICONS.eye : ICONS.eyeOff}
      label="Always draw the origin planes"
      hint={hint}
      pressed={always}
      data-origin-act="planes"
      data-planes={v.planes}
      data-planes-drawn={drawn ? '1' : '0'}
      onClick={() => handle.setPlanes(always ? 'auto' : 'always')}
    />
  );
}

function Part({ collapse }: { collapse: ReactElement | null }) {
  const services = useServices();
  const ui = uiFor(services);
  const { doc, selection } = services;
  const name = usePartName();
  const d = useStateStore(doc.state, (s) => ({
    expanded: s.view.expanded,
    hidden: s.view.hiddenBodies,
    see: s.view.seeThroughBodies,
    bodies: s.rebuild.bodies,
    docBodies: s.doc.bodies,
    features: s.doc.features,
    params: s.doc.params.length,
  }));
  const sel = useStateStore(selection);
  const paramsOpen = useStateStore(ui.state, (s) => s.panel?.kind === 'params');
  const hasParams = useCommandPresent(PARAMS_ID);
  const handle = useStateStore(services.viewport, (s) => s.handle);
  const originOpen = d.expanded.includes('origin');
  const bodiesOpen = d.expanded.includes('bodies');
  // Magnusim CAD (no projects, no simulation): no simulation toggle, hint or mark on a body row.
  // A body is marked see-through when the person made it so, or its feature always draws it so (an Enclosure).
  const bodies = bodyRows({ bodies: d.docBodies }, { hiddenBodies: d.hidden, seeThroughBodies: d.see }, d.bodies, {
    projectLinks: services.bridge.projectLinks(),
    alwaysSeeThrough: (id) => !!seeThroughBy({ doc: { features: d.features } }, services, id),
  });
  const picked = selectedBodies(sel);

  // Double-click the part's own row: rename it, as the header's crumb does (the study's title).
  const renamePart = async () => {
    const block = ui.editBlock();
    if (block) return ui.fail(`Rename ${name}`, block);
    const next = await services.bridge.prompt({ title: 'Rename part', label: 'Name', value: name, confirmLabel: 'Rename' });
    const title = String(next ?? '').trim();
    if (!title || title === name) return;
    if (title.length > MAX_PART_NAME) return ui.fail(`Rename ${name}`, `A name can have at most ${MAX_PART_NAME} characters`);
    try {
      const rec = await services.bridge.study.get();
      await services.bridge.study.update({ title }, rec.rev);
    } catch (err) {
      ui.fail(`Rename ${name}`, errText(err));
    }
  };

  const originRow = (ref: OriginRef, label: string, icon: string) => {
    const item = { kind: 'origin' as const, ref };
    const plane = ref in ORIGIN_PLANES ? (ref as OriginPlaneRef) : null;
    return (
      <TreeNode
        key={ref}
        nodeKey={ref}
        indent
        icon={icon}
        label={label}
        selected={isSelected(sel, item)}
        onClick={(e) => selectItem(selection, item, e.ctrlKey || e.metaKey)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!plane || !handle) return;
          if (!isSelected(selection.get(), item)) selectItem(selection, item, false);
          // P4b SELECT: one name everywhere, "Normal to" (it was "Look at" here).
          ui.showMenu(e.clientX, e.clientY, [{ id: 'normal-to', label: 'Normal to', run: () => handle.lookAt(ORIGIN_PLANES[plane].normal, PLANE_UP[plane]) }], `${label} actions`);
        }}
        onMouseEnter={() => {
          handle?.flash([item]);
          // The origin's axes are drawn by the CONSTRUCT layer: its hover.
          if (!plane) constructView(services).set({ flash: ref });
        }}
        onMouseLeave={() => {
          handle?.flash([]);
          if (!plane) constructView(services).set({ flash: null });
        }}
      />
    );
  };

  return (
    <TreeSection title="PART" section="part" action={collapse ?? undefined}>
      <TreeNode
        nodeKey="part"
        icon={ICONS.part}
        label={name}
        className="is-part"
        attrs={{ 'data-part-name': '1' }}
        onDoubleClick={() => void renamePart()}
        onContextMenu={(e) => {
          e.preventDefault();
          // The Part's own row is always there (an empty Part too): Rename, and the keys of Delete
          // and Rename (keyboard-only actions) are set here as on a feature's row.
          ui.showMenu(
            e.clientX,
            e.clientY,
            [
              { id: 'rename-part', label: `Rename ${name}`, run: () => void renamePart() },
              { sep: true, id: 'sep-keybinds' },
              keybindMenuItem(services, 'ui.delete', 'Set keybind for Delete…'),
              keybindMenuItem(services, 'ui.rename', 'Set keybind for Rename…'),
            ],
            `${name} actions`,
          );
        }}
      />
      <TreeNode
        nodeKey="origin"
        icon={ICONS.origin}
        label="Origin"
        folder={{ expanded: originOpen, onToggle: () => doc.setExpanded('origin', !originOpen) }}
        actions={handle && typeof handle.setPlanes === 'function' ? <PlanesEye handle={handle} /> : null}
      >
        {PLANES.map((ref) => originRow(ref, ORIGIN_PLANES[ref].label, ICONS.plane))}
        {ORIGIN_AXIS_REFS.map((ref) => originRow(ref, ORIGIN_AXIS_NAMES[ref], ICONS.axis))}
      </TreeNode>
      {hasParams ? (
        <TreeNode
          nodeKey="params"
          indent
          icon={ICONS.params}
          label={`Parameters (${d.params})`}
          selected={paramsOpen}
          attrs={{ 'data-params-row': '1' }}
          onClick={() => {
            if (paramsOpen) return ui.closePanel({ why: 'command' });
            // ux010 (review 11): the tree is one rail click away while sketching; opening Parameters
            // would end the sketch with no word. It is refused in the Sketch panel's note instead.
            if (services.mode.get().mode === 'sketch') {
              const p = ui.state.get().panel;
              const name = p?.kind === 'feature' ? (doc.state.get().doc.features.find((f) => f.id === p.feature)?.name ?? 'the sketch') : 'the sketch';
              ui.setPanelNote(`Finish ${name} first to open Parameters`);
              return;
            }
            ui.openParams();
          }}
        />
      ) : null}
      <TreeNode
        nodeKey="bodies"
        icon={ICONS.folder}
        label={`Bodies (${bodies.length})`}
        attrs={{ 'data-bodies-folder': '1' }}
        folder={{ expanded: bodiesOpen, onToggle: () => doc.setExpanded('bodies', !bodiesOpen) }}
      >
        {bodies.length ? (
          bodies.map((b) => <BodyNode key={b.id} row={b} selected={picked.has(b.id)} />)
        ) : (
          <EmptyState tree attr={{ 'data-tree-empty': 'bodies' }}>
            No bodies yet
          </EmptyState>
        )}
      </TreeNode>
    </TreeSection>
  );
}

/** ux010: the chevron at the top right of the card that slides it into its rail at the left edge. */
function CollapseTree({ onCollapse, sketching }: { onCollapse(): void; sketching: boolean }) {
  const services = useServices();
  const rails = railsFor(services);
  const ref = useRef<HTMLButtonElement>(null);
  useRailFocus(rails, 'tree-collapse', ref);
  const key = useKeyLabel(services, RAIL_COMMAND);
  const label = 'Hide the design tree';
  const tip = useTip({ text: label, detail: sketching ? 'Back to its rail for this sketch' : 'It stays a rail at the left edge until you click it', ...(sketching || !key ? {} : { shortcut: key }) });
  return (
    <button type="button" className="cad-collapse-btn" data-tree-collapse="1" aria-label={label} aria-expanded="true" ref={ref} onContextMenu={(e) => railKeybindMenu(services, e)} onClick={() => {
        rails.focusAfter('tree-rail');
        onCollapse();
      }} {...tip}>
      <Icon d={CHEVRON_LEFT} size={15} />
    </button>
  );
}

export function DesignTree({ onCollapse = null, sketching = false }: { onCollapse?: (() => void) | null; sketching?: boolean } = {}) {
  const services = useServices();
  // ux010: the card goes away under the pointer when it slides into its rail (a sketch starts from a
  // plane's row): the hovered row gets no mouseleave, so its hover highlight is cleared here (the Top
  // plane stayed drawn after the sketch).
  useEffect(
    () => () => {
      services.viewport.get().handle?.flash([]);
      constructView(services).set({ flash: null });
    },
    [services],
  );
  return (
    <div className="left-tree" data-cad-tree="1" aria-label="Design tree">
      <Part collapse={onCollapse ? <CollapseTree onCollapse={onCollapse} sketching={sketching} /> : null} />
      <History />
    </div>
  );
}
