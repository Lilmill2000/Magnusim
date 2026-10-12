import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { pluginTreeNodes, type PluginTreeNode } from '../plugin-api';
import { useProjectStore } from '../store/project';
import { defaultFluidName } from '../materialModel';
import { pluginStudyScope, scopeBelongsToProject } from '../scope';
import { headerKinds, kindKey } from '../workspace/startActions';
import { bodyDisplay, faceDisplay, faceNamesGeometry, subscribeFaceNames } from '../workbench/faceNames';
import { chooseLinkFromRow, linkJobOf, noteTreeGeometries, subscribeLinkedGeometries } from '../workbench/geometryRev';
import {
  linkedGeometryByStudy,
  readSetupTree,
  type GeomLink,
  type GeomNode,
  type MeshNode,
  type PluginStudyKind,
  type PluginStudyRow,
  type ProjectTreeDoc,
  type RunConverged,
  type StudyNode,
} from './treeModel';
import { formatSimTime } from '../plugin-ui/format/time';
import { onProjectTree, readProjectTree } from './treeFeed';
import { getTreeSession, onTreeAction, subscribeTreeSession, treeExpanded } from './treeSession';
import { GeometryMenu, type GeometryMenuExtra } from './GeometryMenu';
import { bodyHidden, bodyMenuItems, getBodyView, requestBodyView, subscribeBodyView } from '../workbench/bodyView';
import { actionsFor, rememberTreeActions } from '../workspace/geometryActions';

function Mark({ ok, busy, queuePos }: { ok?: boolean; busy?: boolean; queuePos?: number }) {
  if (ok) return <span className="tree-check" aria-hidden="true">✓</span>;
  if (busy) return <span className="tree-spin" aria-hidden="true" title="Running" />;
  if (queuePos) {
    return (
      <span className="tree-queue" aria-hidden="true" title={`Queued · ${queuePos}`}>
        {queuePos}
      </span>
    );
  }
  return null;
}

/** A converged run's tree badge (API 1.4): "Converged", and when and how in its title. */
function ConvergedBadge({ converged: c }: { converged: RunConverged }) {
  const it = Number(c.iteration);
  const t = Number(c.time);
  const at = it > 0 ? `after ${it} iterations` : c.time != null && Number.isFinite(t) ? `at t = ${formatSimTime(t)}` : '';
  const title = 'Converged' + (at ? ` ${at}` : '') + (c.by === 'monitor' && c.text ? `: ${c.text}` : '');
  return (
    <span className="tree-converged" data-run-converged="1" title={title}>
      Converged
    </span>
  );
}

function Tw({ label, fallback = false }: { label: string; fallback?: boolean }) {
  return <span className="tw">{treeExpanded(label, fallback) ? '-' : '+'}</span>;
}

function Node({
  label,
  expandedLabel,
  className,
  selected,
  attrs,
  mark,
  busy,
  queuePos,
  extra,
  children,
  onContextMenu,
}: {
  label: string;
  expandedLabel?: string;
  className?: string;
  selected?: boolean;
  attrs?: Record<string, string | undefined>;
  mark?: boolean;
  busy?: boolean;
  queuePos?: number;
  extra?: ReactNode;
  children?: ReactNode;
  /** The row's right-click (and Shift+F10 or the menu key, at the row): true when it showed a menu. */
  onContextMenu?: (at: { x: number; y: number; row: HTMLElement }) => boolean;
}) {
  const key = expandedLabel || label;
  const exp = children ? treeExpanded(key) : false;
  const cls = ['tree-node', exp ? 'expanded' : '', selected ? 'selected' : '', className || '']
    .filter(Boolean)
    .join(' ');
  const dataAttrs: Record<string, string> = {};
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null && v !== '') dataAttrs[k] = v;
    }
  }
  // A row with a menu takes the focus (Tab), so Shift+F10 and the menu key reach it.
  const rowMenu = onContextMenu
    ? {
        tabIndex: 0,
        onContextMenu: (e: ReactMouseEvent<HTMLDivElement>) => {
          if (onContextMenu({ x: e.clientX, y: e.clientY, row: e.currentTarget })) {
            e.preventDefault();
            e.stopPropagation();
          }
        },
        onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
          if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            const r = e.currentTarget.getBoundingClientRect();
            if (onContextMenu({ x: r.left + 24, y: r.bottom, row: e.currentTarget })) {
              e.preventDefault();
              e.stopPropagation();
            }
          }
        },
      }
    : {};
  return (
    <li className={cls} data-label={key} {...dataAttrs}>
      <div className="tree-row" {...rowMenu}>
        {children ? <Tw label={key} /> : null}
        <span className="tl">{label}</span>
        {extra}
        {mark != null || busy || queuePos ? <Mark ok={!!mark} busy={busy} queuePos={queuePos} /> : null}
      </div>
      {children ? <ul>{children}</ul> : null}
    </li>
  );
}

function MediaNodes({ ownerKind, id, selectedKey }: { ownerKind: 'run' | 'mesh'; id: string; selectedKey: string | null }) {
  const rows = ownerKind === 'run'
    ? [['graphs', 'Graphs'], ['screenshot', 'Screenshots'], ['recording', 'Recordings']]
    : [['screenshot', 'Screenshots'], ['recording', 'Recordings']];
  return <>{rows.map(([kind, label]) => {
    const key = `media:${ownerKind}:${id}:${kind}`;
    return (
      <Node
        key={key}
        label={label}
        expandedLabel={key}
        selected={selectedKey === key}
        attrs={{ 'data-w28-key': key, 'data-media-owner': `${ownerKind}-${id}` }}
      />
    );
  })}</>;
}

function MeshItem({ mesh, selected, selectedKey }: { mesh: MeshNode; selected: boolean; selectedKey: string | null }) {
  const meshKey = mesh.scopeKey || `mesh:${mesh.id}`;
  const refs = mesh.refinements || [];
  return (
    <Node
      label={mesh.name}
      expandedLabel={meshKey}
      selected={selected}
      attrs={{
        'data-w20-mesh-item': mesh.id,
        'data-scope-key': mesh.scopeKey,
        ...(mesh.ready ? { 'data-w20-mesh1': '1' } : {}),
      }}
      mark={mesh.ready}
      busy={mesh.busy}
      queuePos={mesh.queuePos}
      extra={
        mesh.outOfDate ? (
          <span className="tree-sub" data-mesh-out-of-date="1" title="Made from an older version of its geometry. Generate it again.">
            Out of date
          </span>
        ) : undefined
      }
    >
      <Node
        label="Refinements"
        expandedLabel={`Refinements:${mesh.id}`}
        selected={selectedKey === `refs:${mesh.id}`}
        attrs={{ 'data-w26-refs': '1', 'data-w26-refs-mesh': mesh.id }}
        mark={refs.length > 0}
        extra={
          <button type="button" className="ref-plus" data-refs-plus={mesh.id} title="Add refinement">
            +
          </button>
        }
      >
        {refs.length
          ? refs.map((ref) => (
              <Node
                key={ref.id}
                label={ref.name}
                expandedLabel={ref.name}
                selected={selectedKey === `refid:${ref.id}`}
                attrs={{ 'data-w26-ref': ref.id, 'data-w26-ref-mesh': mesh.id }}
              >
                {ref.faces.length
                  ? ref.faces.map((f) => (
                      <Node key={f} label={f} attrs={{ 'data-w26-face': f, 'data-w26-parent': ref.id }} />
                    ))
                  : null}
              </Node>
            ))
          : null}
      </Node>
      {mesh.ready ? <MediaNodes ownerKind="mesh" id={mesh.id} selectedKey={selectedKey} /> : null}
    </Node>
  );
}

function StudyBlock({ study, selectedKey }: { study: StudyNode; selectedKey: string | null }) {
  const skey = study.scopeKey || `study:${study.id}`;
  const matKey = study.scopeKey ? `${study.scopeKey}/item:materials` : `Materials:${study.id}`;
  const airKey = study.scopeKey ? `${study.scopeKey}/item:air` : `Air:${study.id}`;
  // Re-read when the registry arrives: a material with no name shows its model's default fluid.
  useProjectStore((s) => s.registry);
  const fluidLabel = study.materialName || defaultFluidName() || 'Fluid';
  const bcKey = study.scopeKey ? `${study.scopeKey}/item:bcs` : `Boundary conditions:${study.id}`;
  const meshKey = study.scopeKey ? `${study.scopeKey}/item:mesh` : `Mesh:${study.id}`;
  const simKey = study.scopeKey ? `${study.scopeKey}/item:simulation` : `Simulation:${study.id}`;
  const meshKids = study.meshes.map((m) => (
    <MeshItem key={m.id} mesh={m} selectedKey={selectedKey} selected={study.active && selectedKey === `meshid:${m.id}`} />
  ));
  const runKids = study.runs.map((r) => {
    const runKey = r.scopeKey || `run:${r.id}`;
    return (
      <Node
        key={r.id}
        label={r.name}
        expandedLabel={runKey}
        selected={study.active && selectedKey === `runid:${r.id}`}
        attrs={{ 'data-w27-run': r.id, 'data-scope-key': r.scopeKey }}
        mark={r.ready}
        busy={r.busy}
        queuePos={r.queuePos}
        extra={
          r.olderGeometry || r.converged ? (
            <>
              {r.converged ? <ConvergedBadge converged={r.converged} /> : null}
              {r.olderGeometry ? (
                <span className="tree-sub" data-run-older-geometry="1" title="Made on an older version of its geometry.">
                  Older geometry
                </span>
              ) : null}
            </>
          ) : undefined
        }
      >
        <Node label="Mesh" expandedLabel={`run-mesh:${r.id}`} attrs={{ 'data-w27-run-mesh': r.id }}>
          {r.meshId ? (
            <Node
              label={r.meshName || 'Mesh'}
              attrs={{ 'data-w27-run-mesh-item': r.meshId, 'data-w27-mesh-run': r.id }}
              mark={r.ready}
            />
          ) : null}
        </Node>
        <Node
          label="Monitors"
          expandedLabel={`run-rc:${r.id}`}
          attrs={{ 'data-w27-run-rcs': r.id }}
          extra={
            <button type="button" className="rc-plus" data-w27-run-plus={r.id} title="Add result control">
              +
            </button>
          }
        >
          {(r.resultControls || []).map((rc) => (
            <Node
              key={rc.id}
              label={rc.name}
              expandedLabel={`${rc.name}:${rc.id}`}
              selected={study.active && selectedKey === `aaid:${rc.id}`}
              attrs={{ 'data-w27-aa': rc.id, 'data-w27-aa-run': r.id }}
              mark={rc.placed ?? rc.faces.length > 0}
            >
              {rc.faces.map((f) => (
                <Node
                  key={f}
                  label={f}
                  attrs={{ 'data-w27-aa-face': f, 'data-w27-aa-run': r.id, 'data-w27-aa': rc.id }}
                />
              ))}
            </Node>
          ))}
        </Node>
        {r.hasResults || r.ready ? (
          <Node label="Results" expandedLabel={`run-results:${r.id}`} attrs={{ 'data-w27-run-results': r.id }} selected={study.active && selectedKey === `runresults:${r.id}`} mark={r.ready}>
            <MediaNodes ownerKind="run" id={r.id} selectedKey={selectedKey} />
          </Node>
        ) : null}
      </Node>
    );
  });

  return (
    <Node
      label={study.name}
      expandedLabel={skey}
      selected={study.active && selectedKey === 'study-settings'}
      attrs={{ 'data-w17-sim-id': study.id, 'data-w17-sim': '1', 'data-scope-key': study.scopeKey }}
    >
      <Node
        label="Materials"
        expandedLabel={matKey}
        selected={study.active && selectedKey === 'materials'}
        attrs={{ 'data-w18-materials': '1' }}
        mark={study.materialsAssigned}
        extra={
          !study.materialsAssigned ? (
            <button
              type="button"
              className="mat-plus"
              id={study.active ? 'btn-materials-plus' : undefined}
              data-w18-mat-plus={study.id}
              title="Add material"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (study.scopeKey) onTreeAction(study.scopeKey, 'add-material');
              }}
            >
              +
            </button>
          ) : null
        }
      >
        {study.materialVolumes.length ? (
          <Node label={fluidLabel} expandedLabel={airKey} attrs={{ 'data-w18-air': '1' }}>
            {study.materialVolumes.map((v, i) => (
              <Node
                key={v}
                label={v}
                attrs={{ 'data-w18-assign': v, 'data-body-index': String(i + 1) }}
              />
            ))}
          </Node>
        ) : null}
      </Node>
      <Node
        label="Boundary conditions"
        expandedLabel={bcKey}
        selected={study.active && selectedKey === 'bcs'}
        attrs={{ 'data-w19-bcs': '1' }}
        mark={study.bcs.length > 0}
        extra={
          <button
            type="button"
            className="bc-plus"
            id={study.active ? 'btn-bcs-plus' : undefined}
            data-w19-bc-plus={study.id}
            title="Add boundary condition"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (study.scopeKey) onTreeAction(study.scopeKey, 'add-bc');
            }}
          >
            +
          </button>
        }
      >
        <Node
          label="Defaults"
          expandedLabel={`bc-defaults:${study.id}`}
          selected={study.active && selectedKey === 'bc-defaults'}
          attrs={{ 'data-w19-defaults': '1' }}
          extra={<span className="tree-sub">{study.wallDefault} walls</span>}
        />
        {study.bcs.map((bc) => (
          <Node
            key={bc.id}
            label={bc.name}
            expandedLabel={bc.scopeKey || `bcid:${bc.id}`}
            selected={study.active && selectedKey === `bcid:${bc.id}`}
            attrs={{ 'data-w19-bc': bc.id, 'data-scope-key': bc.scopeKey, 'data-lost': bc.lost ? String(bc.lost) : undefined }}
            extra={bc.lost ? <span className="tree-sub" data-bc-lost-count="1">{lostText(bc.lost)}</span> : undefined}
          >
            {bc.faces.map((f) => (
              <Node
                key={f}
                label={study.geometryId === faceNamesGeometry() ? faceDisplay(f) : f}
                attrs={{ 'data-w19-face': f, 'data-w19-parent': bc.id }}
              />
            ))}
          </Node>
        ))}
      </Node>
      <Node
        label="Mesh"
        expandedLabel={meshKey}
        selected={study.active && selectedKey === 'mesh'}
        attrs={{ 'data-w20-mesh': '1' }}
        mark={study.meshes.some((m) => m.ready)}
      >
        {meshKids}
      </Node>
      <Node
        label="Simulation"
        expandedLabel={simKey}
        selected={study.active && selectedKey === 'sim-hub'}
        attrs={{ 'data-w27-sim-control': '1' }}
      >
        {runKids}
      </Node>
    </Node>
  );
}

function lostText(n: number): string {
  return `${n} lost face${n === 1 ? '' : 's'}`;
}

/** What a linked geometry's row says about its link now (API 1.5, proposal 5.18). */
export function linkStatusText(
  geomName: string,
  link: GeomLink,
  job: { status: string; stage: string | null; label: string | null; adding?: string | null } | null,
): string {
  if (job && job.status === 'choosing') return `Waiting for your choice: ${link.studyTitle} changed`;
  if (job && job.adding && (job.status === 'queued' || job.status === 'running')) return `Adding ${job.adding}…`;
  if (job && job.status === 'queued') return 'Queued';
  if (job && job.status === 'running') return job.label || (job.stage ? `Updating… (${job.stage})` : 'Updating…');
  if (link.updating) return `Couldn't finish updating ${geomName}`;
  if (link.behind) return `Not up to date with ${link.studyTitle}.`;
  return '';
}

/** A linked geometry's row: "from <study>", its Edit button, its link state and its lost faces. */
function LinkRow({ geom, link }: { geom: GeomNode; link: GeomLink }) {
  const missing = link.sourceState === 'plugin_missing';
  const off = link.sourceState === 'plugin_off';
  const job = linkJobOf(geom.id);
  const status = linkStatusText(geom.name, link, job);
  return (
    <span className="tree-link-row" data-geom-link={geom.id}>
      <span className="tree-sub" data-geom-from="1">
        from {link.studyTitle}
        {missing ? ' (plugin not installed)' : ''}
      </span>
      {!missing && link.workspace ? (
        <button
          type="button"
          className="tree-link-edit"
          data-geom-edit={geom.id}
          disabled={off}
          title={off ? link.reason : `Edit in ${link.workspaceTitle || link.studyTitle}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!off && link.studyScopeKey) onTreeAction(link.studyScopeKey, 'plugin-study-open', { workspace: link.workspace });
          }}
        >
          Edit
        </button>
      ) : null}
      {off ? (
        <span className="tree-sub plugin-study-reason" data-geom-link-reason="1">
          {link.reason}.{' '}
          <button
            type="button"
            className="plugin-study-settings"
            data-geom-link-settings="1"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onTreeAction(link.studyScopeKey, 'open-plugin-settings');
            }}
          >
            Open Settings → Plugins
          </button>
        </span>
      ) : null}
      {status ? (
        <span className="tree-sub" data-geom-link-status="1">
          {status}
        </span>
      ) : null}
      {job && job.status === 'choosing' ? (
        <button
          type="button"
          className="tree-link-edit"
          data-geom-choose={geom.id}
          title={`Choose how the simulation gets the new shape of ${link.studyTitle}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void chooseLinkFromRow(geom.id);
          }}
        >
          Choose…
        </button>
      ) : null}
      {link.lostFaces ? (
        <span className="tree-sub" data-geom-lost="1">
          {lostText(link.lostFaces)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * A plain geometry a study is editing (API 1.7: a geometry action opened it, and no edit went
 * back yet): "Being edited in <study>" and its Edit button. The study is not listed in STUDIES
 * meanwhile: nothing of the project changed.
 */
function EditedInRow({ geom }: { geom: GeomNode }) {
  const studies = geom.editedIn || [];
  return (
    <span className="tree-link-row" data-geom-edited-in={geom.id}>
      {studies.map((s) => (
        <span key={`${s.plugin}|${s.id}`} className="tree-sub" data-geom-edited-by={s.id}>
          Being edited in {s.title}
          {s.available && s.workspace ? (
            <button
              type="button"
              className="tree-link-edit"
              data-geom-edited-open={s.id}
              title={`Open ${s.title}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (s.scopeKey) onTreeAction(s.scopeKey, 'plugin-study-open', { workspace: s.workspace });
              }}
            >
              Edit
            </button>
          ) : null}
        </span>
      ))}
    </span>
  );
}

function GeomBlock({ geom, selectedKey }: { geom: GeomNode; selectedKey: string | null }) {
  const gkey = geom.scopeKey || `geom:${geom.id}`;
  // The right-click menu of the geometry and its body rows (API 1.7): its geometry actions;
  // a body row of the shown geometry also hides or shows bodies in the view.
  const [menu, setMenu] = useState<{ x: number; y: number; row: HTMLElement; extra: GeometryMenuExtra[] } | null>(null);
  const entries = actionsFor({ edit_actions: geom.editActions }, 'tree');
  const view = getBodyView();
  const multiPicked = !!geom.id && view.geometryId === geom.id && view.selected.length > 1;
  const bodyExtra = (body: number): GeometryMenuExtra[] =>
    bodyMenuItems(view, geom.id, body).map((item) => ({
      key: item.act,
      label: item.label,
      attrs: { 'data-body-act': item.act },
      onPick: () => requestBodyView(item.act === 'show-all' ? { kind: 'show-all' } : { kind: item.act, bodies: item.bodies }),
    }));
  const openMenu = (at: { x: number; y: number; row: HTMLElement }, extra: GeometryMenuExtra[] = []): boolean => {
    if ((!entries.length && !extra.length) || !geom.id) return false;
    setMenu({ ...at, extra });
    return true;
  };
  const projectId = useProjectStore.getState().projectId || '';
  return (
    <>
    {menu ? (
      <GeometryMenu
        x={menu.x}
        y={menu.y}
        projectId={projectId}
        geometryId={geom.id}
        geometryName={geom.name}
        entries={entries}
        extra={menu.extra}
        onClose={(refocus) => {
          const row = menu.row;
          setMenu(null);
          if (refocus) row.focus();
        }}
      />
    ) : null}
    <Node
      label={geom.name}
      expandedLabel={gkey}
      onContextMenu={entries.length ? openMenu : undefined}
      selected={selectedKey === gkey}
      attrs={{ 'data-w16-geom': geom.id, 'data-scope-key': geom.scopeKey, 'data-geom-linked': geom.link ? '1' : undefined }}
      // No ✓ over a part that is not up to date with its study (or whose update did not finish).
      mark={!!geom.id && !(geom.link && (geom.link.behind || geom.link.updating))}
      extra={
        geom.link ? (
          <LinkRow geom={geom} link={geom.link} />
        ) : geom.editedIn && geom.editedIn.length ? (
          <EditedInRow geom={geom} />
        ) : geom.unlinkedLost ? (
          <span className="tree-sub" data-geom-lost="1">
            {lostText(geom.unlinkedLost)}
          </span>
        ) : undefined
      }
    >
      {geom.bodies.length ? (
        <Node label="Geometry" attrs={{ 'data-w17-geo': '1' }} mark>
          {geom.bodies.map((b, i) => {
            const extra = bodyExtra(i + 1);
            const hidden = bodyHidden(view, geom.id, i + 1);
            return (
              <Node
                key={`${b}-${i}`}
                label={bodyDisplay(b, geom.bodyLabels ? geom.bodyLabels[b] || null : null)}
                className={hidden ? 'is-hidden-body' : undefined}
                selected={selectedKey === `body-${i + 1}` || (multiPicked && view.selected.includes(i + 1))}
                attrs={{
                  'data-w16-body': '1',
                  'data-body-index': String(i + 1),
                  'data-body-hidden': hidden ? '1' : undefined,
                  title: hidden ? 'Hidden in the view' : undefined,
                }}
                onContextMenu={entries.length || extra.length ? (at) => openMenu(at, extra) : undefined}
              />
            );
          })}
        </Node>
      ) : null}
      {geom.studies.map((s) => (
        <StudyBlock key={s.id} study={s} selectedKey={selectedKey} />
      ))}
    </Node>
    </>
  );
}

export function SetupTreeView({
  model,
  pluginNodes = [],
}: {
  model: ReturnType<typeof readSetupTree>;
  pluginNodes?: PluginTreeNode[];
}) {
  if (!model.geoms.length && !pluginNodes.length) {
    return (
      <li className="sim-empty" id="sim-empty">
        No simulation yet
      </li>
    );
  }
  return (
    <>
      {model.geoms.map((g: GeomNode) => (
        <GeomBlock key={g.id || g.name} geom={g} selectedKey={model.selectedKey} />
      ))}
      {pluginNodes.map((node, index) => (
        <li key={`${node.label}:${index}`} data-plugin-node={node.label}>
          {node.label}
        </li>
      ))}
    </>
  );
}

function StudyIcon({ path }: { path: string }) {
  return (
    <svg className="plugin-study-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
      <path
        d={path || 'M5 4h10l4 4v12H5z M15 4v4h4'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * STUDIES shows when the project has a plugin study, or a plugin kind that can be made
 * only from here: it stays hidden while every kind opens from a start action's header
 * button (after the cap) and no study exists yet (API 1.4).
 */
export function studiesSectionShown(
  projectId: string | null | undefined,
  rows: readonly PluginStudyRow[],
  kinds: readonly PluginStudyKind[],
): boolean {
  if (!projectId) return false;
  if (rows.length) return true;
  const inHeader = headerKinds(kinds);
  return kinds.some((k) => !inHeader.has(kindKey(k)));
}

function stop(e: { preventDefault(): void; stopPropagation(): void }) {
  e.preventDefault();
  e.stopPropagation();
}

/**
 * Project-level studies plugins own (plugins/<key>/studies). Not bound to a
 * geometry: shown in every stage, the empty project included. A study whose
 * plugin is off or missing stays, greyed, with the reason and a link to
 * Settings → Plugins; it can be deleted but not opened or renamed. "+ New"
 * names a study and opens it in its workspace when its kind has one.
 */
export function PluginStudiesView({
  projectId,
  studies,
  kinds,
  linked = {},
}: {
  projectId: string;
  studies: PluginStudyRow[];
  kinds: PluginStudyKind[];
  /** The geometry each linking study links now (API 1.5): "→ <geometry>". */
  linked?: Record<string, { id: string; name: string }>;
}) {
  const links = (st: PluginStudyRow) => kinds.some((k) => k.plugin === st.plugin && k.key === st.kind && k.links_geometry);
  return (
    <>
      <div className="geo-head">
        <span data-plugin-studies-count="1">STUDIES ({studies.length})</span>
        <span className="plugin-study-new">
          {kinds.map((k) => (
            <button
              key={`${k.plugin}:${k.key}`}
              type="button"
              className="js-btn"
              data-plugin-study-new={`${k.plugin}:${k.key}`}
              title={`New ${k.title} (${k.plugin_name})`}
              onClick={() =>
                // The plugin's study titles, so the name prompt offers a free "<Kind> N".
                onTreeAction(pluginStudyScope(projectId, k.plugin), 'plugin-study-new', {
                  kind: k.key,
                  title: k.title,
                  titles: studies.filter((st) => st.plugin === k.plugin).map((st) => st.title),
                })
              }
            >
              + New {k.title}
            </button>
          ))}
        </span>
      </div>
      <ul className="tree-root" data-plugin-studies-tree="1">
        {studies.length ? null : (
          <li className="sim-empty" data-plugin-studies-empty="1">
            No study yet
          </li>
        )}
        {studies.map((st) => (
          <li
            key={st.scope_key}
            className={['tree-node', 'plugin-study', st.available ? '' : 'is-unavailable'].filter(Boolean).join(' ')}
            data-label={st.scope_key}
            data-scope-key={st.scope_key}
            data-plugin-study={st.id}
            data-plugin={st.plugin}
            data-unavailable={st.available ? undefined : '1'}
          >
            <div
              className="tree-row"
              title={st.available ? `${st.kind_title} (${st.plugin_name})` : st.reason}
              data-plugin-study-open={st.available && st.workspace ? '1' : undefined}
              onClick={() => {
                // A study opens in its plugin's workspace (a sandboxed frame over the workbench).
                if (st.available && st.workspace) onTreeAction(st.scope_key, 'plugin-study-open', { workspace: st.workspace });
              }}
            >
              <StudyIcon path={st.icon} />
              <span className="tl">{st.title}</span>
              {st.read_only ? <span className="plugin-study-tag">read-only</span> : null}
              {st.available && !st.read_only ? (
                <button
                  type="button"
                  className="mesh-rename"
                  title="Rename study"
                  aria-label={`Rename ${st.title}`}
                  data-plugin-study-act="rename"
                  onClick={(e) => {
                    stop(e);
                    onTreeAction(st.scope_key, 'plugin-study-rename', { title: st.title, rev: st.rev });
                  }}
                >
                  <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">
                    <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 16.8V20h3.2L18.4 8.8l-3.2-3.2L4 16.8z" />
                      <path d="M13.8 6.9l3.2 3.2" />
                    </g>
                  </svg>
                </button>
              ) : null}
              <button
                type="button"
                className="mesh-rename"
                title="Delete study"
                aria-label={`Delete ${st.title}`}
                data-plugin-study-act="delete"
                onClick={(e) => {
                  stop(e);
                  onTreeAction(st.scope_key, 'plugin-study-delete', {
                    title: st.title,
                    available: st.available,
                    plugin_name: st.plugin_name,
                    // A study that links a geometry: say what goes and what stays (the two may share a name).
                    ...deleteWords(st, linked[`${st.plugin}|${st.id}`]),
                  });
                }}
              >
                <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false">
                  <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" />
                  </g>
                </svg>
              </button>
            </div>
            {linked[`${st.plugin}|${st.id}`] ? (
              <button
                type="button"
                className="plugin-study-geometry"
                data-plugin-study-geometry={linked[`${st.plugin}|${st.id}`].id}
                title="Show the geometry this study links"
                onClick={(e) => {
                  stop(e);
                  onTreeAction(st.scope_key, 'plugin-study-geometry', { geometryId: linked[`${st.plugin}|${st.id}`].id });
                }}
              >
                {`\u2192 ${linked[`${st.plugin}|${st.id}`].name}`}
              </button>
            ) : st.available && links(st) ? (
              <div className="plugin-study-geometry is-none" data-plugin-study-geometry="">
                Not in the simulation yet
              </div>
            ) : null}
            {st.available ? null : (
              <div className="plugin-study-reason" data-plugin-study-reason="1">
                {st.reason}.{' '}
                <button
                  type="button"
                  className="plugin-study-settings"
                  onClick={(e) => {
                    stop(e);
                    onTreeAction(st.scope_key, 'open-plugin-settings');
                  }}
                >
                  Open Settings → Plugins
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * The delete question of a study that links a project geometry (API 1.5/1.7): what is deleted
 * (the study) and what stays (the geometry), named apart: a CAD part and the geometry it edits
 * often share a name. {} for any other study (the app's own question).
 */
export function deleteWords(st: PluginStudyRow, geometry: { id: string; name: string } | undefined): { confirm_title?: string; confirm_copy?: string } {
  if (!geometry) return {};
  const ws = String(st.workspace_title || '').trim();
  const kind = String(st.kind_title || 'study').trim();
  const what = ws && !kind.toLowerCase().includes(ws.toLowerCase()) ? `${ws} ${kind.toLowerCase()}` : kind;
  return {
    confirm_title: `Delete the ${what}?`,
    confirm_copy: `Delete the ${what} '${st.title}'? The geometry '${geometry.name}' stays in the project, with its simulations.`,
  };
}

/** React setup tree. Same collapse keys and [data-w20-mesh-item] as the runtime tree. */
export function LeftTree() {
  const projectId = useProjectStore((s) => s.projectId);
  const generation = useProjectStore((s) => s.generation);
  const docRef = useRef<ProjectTreeDoc | null>(null);
  const [model, setModel] = useState(() => readSetupTree(null));
  const [pluginNodes, setPluginNodes] = useState<PluginTreeNode[]>([]);
  const [studies, setStudies] = useState<{ rows: PluginStudyRow[]; kinds: PluginStudyKind[]; linked: Record<string, { id: string; name: string }> }>({
    rows: [],
    kinds: [],
    linked: {},
  });
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [studiesHost, setStudiesHost] = useState<HTMLElement | null>(null);

  function paint() {
    const session = getTreeSession();
    const projectId = useProjectStore.getState().projectId || '';
    setModel(readSetupTree(docRef.current, session.activity, session.selectedKey, session.studies));
    const fromServer = (docRef.current?.plugin_nodes || [])
      .map((node) => ({
        label: String(node.label || node.name || ''),
        scope: node.scope || node.key,
        projectId: node.projectId || node.project_id,
      }))
      .filter((node) => {
        if (!node.label) return false;
        const pid = node.projectId || '';
        if (pid && pid !== projectId) return false;
        if (node.scope && !scopeBelongsToProject(node.scope, projectId)) return false;
        return !!(pid || node.scope);
      });
    setPluginNodes([...pluginTreeNodes(projectId), ...fromServer]);
    const doc = docRef.current;
    const own = (row: { scope_key?: string }) => !!row.scope_key && scopeBelongsToProject(row.scope_key, projectId);
    setStudies({
      // A study still editing a plain geometry (API 1.7) shows on that geometry's row instead.
      rows: projectId ? (doc?.plugin_studies || []).filter(own).filter((row) => !row.editing) : [],
      kinds: projectId ? doc?.plugin_study_kinds || [] : [],
      linked: projectId ? linkedGeometryByStudy(doc) : {},
    });
  }

  useEffect(() => subscribeTreeSession(paint), []);
  // A linked geometry's job state and the shown geometry's face names repaint the rows.
  useEffect(() => subscribeLinkedGeometries(paint), []);
  useEffect(() => subscribeFaceNames(paint), []);
  // Bodies hidden in the view (or picked together) repaint their rows.
  useEffect(() => subscribeBodyView(paint), []);

  useEffect(() => {
    const left = document.getElementById('left-tree');
    const tree = document.getElementById('simulations-tree');
    if (left) left.setAttribute('data-react-tree', '1');
    if (tree) {
      tree.replaceChildren();
      setHost(tree);
    }
    setStudiesHost(document.getElementById('plugin-studies-section'));
  }, []);

  // The SIMULATIONS heading counts the studies this tree lists, once it has read the
  // project's tree: a study the workbench has not loaded yet (made by another tab or a
  // plugin) is listed by the read, so it is counted too.
  useEffect(() => {
    const doc = docRef.current;
    if (!doc || !projectId || String(doc.project_id || '') !== projectId) return;
    const el = document.getElementById('simulations-count-label');
    if (el) el.textContent = `SIMULATIONS (${model.geoms.reduce((n, g) => n + g.studies.length, 0)})`;
  }, [model, projectId]);

  const showStudies = studiesSectionShown(projectId, studies.rows, studies.kinds);
  useEffect(() => {
    if (studiesHost) studiesHost.hidden = !showStudies;
  }, [studiesHost, showStudies]);

  useEffect(() => {
    if (!projectId) {
      docRef.current = null;
      paint();
      window.addEventListener('cfd:tree-sync', paint);
      return () => window.removeEventListener('cfd:tree-sync', paint);
    }
    let dead = false;
    const gen = generation;
    // One tree read per project at a time (treeFeed.ts), so answers land in order; still,
    // paint an answer only if no later one has painted, or a stale tree replaces the new run.
    let painted = 0;
    // While plugin studies are being upgraded, read the tree again (a while at most).
    let followUps = 0;
    let followTimer: ReturnType<typeof setTimeout> | null = null;
    // Read now and on every cfd:tree-sync. Hears only reads sent from here on: not one
    // sent for the project's previous load.
    const stop = onProjectTree(projectId, ({ seq, doc, error }) => {
      if (dead) return;
      if (error) {
        paint();
        return;
      }
      if (seq < painted) return;
      const live = useProjectStore.getState();
      if (live.generation !== gen || live.projectId !== projectId) return;
      painted = seq;
      docRef.current = doc;
      // A linked geometry whose rev or names changed is loaded again (a second tab, API 1.5).
      if (doc) noteTreeGeometries(projectId, doc.geometries as Parameters<typeof noteTreeGeometries>[1]);
      // The geometry actions (API 1.7), for the Geometry panel and the viewport's menu.
      if (doc) rememberTreeActions(projectId, doc.geometries);
      paint();
      if (doc && doc.plugin_studies_migrating && followUps < 30 && !followTimer) {
        followUps += 1;
        followTimer = setTimeout(() => {
          followTimer = null;
          if (!dead) readProjectTree(projectId);
        }, 1000);
      }
    });
    readProjectTree(projectId);
    return () => {
      dead = true;
      stop();
      if (followTimer) clearTimeout(followTimer);
    };
  }, [projectId, generation]);

  if (!host) return null;
  return (
    <>
      {createPortal(<SetupTreeView model={model} pluginNodes={pluginNodes} />, host)}
      {studiesHost && showStudies
        ? createPortal(
            <PluginStudiesView projectId={projectId || ''} studies={studies.rows} kinds={studies.kinds} linked={studies.linked} />,
            studiesHost,
          )
        : null}
    </>
  );
}
