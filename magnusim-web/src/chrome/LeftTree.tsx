import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { pluginTreeNodes, type PluginTreeNode } from '../plugin-api';
import { useProjectStore } from '../store/project';
import { pluginStudyScope, scopeBelongsToProject } from '../scope';
import {
  readSetupTree,
  type GeomNode,
  type MeshNode,
  type PluginStudyKind,
  type PluginStudyRow,
  type ProjectTreeDoc,
  type StudyNode,
} from './treeModel';
import { onProjectTree, readProjectTree } from './treeFeed';
import { getTreeSession, onTreeAction, subscribeTreeSession, treeExpanded } from './treeSession';

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
  return (
    <li className={cls} data-label={key} {...dataAttrs}>
      <div className="tree-row">
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
              mark={rc.faces.length > 0}
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
      selected={study.active && selectedKey === 'incompressible'}
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
          <Node label={study.materialName || 'Air'} expandedLabel={airKey} attrs={{ 'data-w18-air': '1' }}>
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
            attrs={{ 'data-w19-bc': bc.id, 'data-scope-key': bc.scopeKey }}
          >
            {bc.faces.map((f) => (
              <Node key={f} label={f} attrs={{ 'data-w19-face': f, 'data-w19-parent': bc.id }} />
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

function GeomBlock({ geom, selectedKey }: { geom: GeomNode; selectedKey: string | null }) {
  const gkey = geom.scopeKey || `geom:${geom.id}`;
  return (
    <Node
      label={geom.name}
      expandedLabel={gkey}
      selected={selectedKey === gkey}
      attrs={{ 'data-w16-geom': geom.id, 'data-scope-key': geom.scopeKey }}
      mark={!!geom.id}
    >
      {geom.bodies.length ? (
        <Node label="Geometry" attrs={{ 'data-w17-geo': '1' }} mark>
          {geom.bodies.map((b, i) => (
            <Node
              key={`${b}-${i}`}
              label={b}
              selected={selectedKey === `body-${i + 1}`}
              attrs={{ 'data-w16-body': '1', 'data-body-index': String(i + 1) }}
            />
          ))}
        </Node>
      ) : null}
      {geom.studies.map((s) => (
        <StudyBlock key={s.id} study={s} selectedKey={selectedKey} />
      ))}
    </Node>
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

function stop(e: { preventDefault(): void; stopPropagation(): void }) {
  e.preventDefault();
  e.stopPropagation();
}

/**
 * Project-level studies plugins own (plugins/<key>/studies). Not bound to a
 * geometry: shown in every stage, the empty project included. A study whose
 * plugin is off or missing stays, greyed, with the reason and a link to
 * Settings → Plugins; it can be deleted but not opened or renamed.
 */
export function PluginStudiesView({
  projectId,
  studies,
  kinds,
}: {
  projectId: string;
  studies: PluginStudyRow[];
  kinds: PluginStudyKind[];
}) {
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
              onClick={() => onTreeAction(pluginStudyScope(projectId, k.plugin), 'plugin-study-new', { kind: k.key, title: k.title })}
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
            <div className="tree-row" title={st.available ? `${st.kind_title} (${st.plugin_name})` : st.reason}>
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
            {st.available ? null : (
              <div className="plugin-study-reason" data-plugin-study-reason="1">
                {st.reason}.{' '}
                <button
                  type="button"
                  className="sim-fix-go"
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

/** React setup tree. Same collapse keys and [data-w20-mesh-item] as the runtime tree. */
export function LeftTree() {
  const projectId = useProjectStore((s) => s.projectId);
  const generation = useProjectStore((s) => s.generation);
  const docRef = useRef<ProjectTreeDoc | null>(null);
  const [model, setModel] = useState(() => readSetupTree(null));
  const [pluginNodes, setPluginNodes] = useState<PluginTreeNode[]>([]);
  const [studies, setStudies] = useState<{ rows: PluginStudyRow[]; kinds: PluginStudyKind[] }>({ rows: [], kinds: [] });
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
      rows: projectId ? (doc?.plugin_studies || []).filter(own) : [],
      kinds: projectId ? doc?.plugin_study_kinds || [] : [],
    });
  }

  useEffect(() => subscribeTreeSession(paint), []);

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

  // The section shows when the project has a plugin study or a plugin that can make one.
  const showStudies = !!projectId && (studies.rows.length > 0 || studies.kinds.length > 0);
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
        ? createPortal(<PluginStudiesView projectId={projectId || ''} studies={studies.rows} kinds={studies.kinds} />, studiesHost)
        : null}
    </>
  );
}
