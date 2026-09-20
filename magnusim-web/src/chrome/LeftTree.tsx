import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useProjectStore } from '../store/project';
import { readSetupTree, treeExpanded, type GeomNode, type MeshNode, type StudyNode } from './treeModel';

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
    return <Node key={key} label={label} expandedLabel={key} selected={selectedKey === key} attrs={{ 'data-w28-key': key }} />;
  })}</>;
}

function MeshItem({ mesh, selected, selectedKey }: { mesh: MeshNode; selected: boolean; selectedKey: string | null }) {
  const meshKey = `mesh:${mesh.id}`;
  const refs = mesh.refinements || [];
  return (
    <Node
      label={mesh.name}
      expandedLabel={meshKey}
      selected={selected}
      attrs={{
        'data-w20-mesh-item': mesh.id,
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
  const skey = `study:${study.id}`;
  const matKey = `Materials:${study.id}`;
  const airKey = `Air:${study.id}`;
  const bcKey = `Boundary conditions:${study.id}`;
  const meshKey = `Mesh:${study.id}`;
  const simKey = `Simulation:${study.id}`;
  const meshKids = study.meshes.map((m) => (
    <MeshItem key={m.id} mesh={m} selectedKey={selectedKey} selected={study.active && selectedKey === `meshid:${m.id}`} />
  ));
  const runKids = study.runs.map((r) => {
    const runKey = `run:${r.id}`;
    return (
      <Node
        key={r.id}
        label={r.name}
        expandedLabel={runKey}
        selected={study.active && selectedKey === `runid:${r.id}`}
        attrs={{ 'data-w27-run': r.id }}
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
      attrs={{ 'data-w17-sim-id': study.id, 'data-w17-sim': '1' }}
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
                const add = window.__CFD_ADD_MATERIAL__;
                if (typeof add === 'function') add(study.id);
              }}
            >
              +
            </button>
          ) : null
        }
      >
        {study.materialVolumes.length ? (
          <Node label="Air" expandedLabel={airKey} attrs={{ 'data-w18-air': '1' }}>
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
              const add = window.__CFD_ADD_BC__;
              if (typeof add === 'function') add(study.id);
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
            expandedLabel={`bcid:${bc.id}`}
            selected={study.active && selectedKey === `bcid:${bc.id}`}
            attrs={{ 'data-w19-bc': bc.id }}
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
  const gkey = `geom:${geom.id}`;
  return (
    <Node
      label={geom.name}
      expandedLabel={gkey}
      selected={selectedKey === gkey}
      attrs={{ 'data-w16-geom': geom.id }}
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

export function SetupTreeView({ model }: { model: ReturnType<typeof readSetupTree> }) {
  if (!model.geoms.length) {
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
    </>
  );
}

/** React setup tree. Same collapse keys and [data-w20-mesh-item] as the runtime tree. */
export function LeftTree() {
  const hydrate = useProjectStore((s) => s.hydrate);
  const [model, setModel] = useState(() => readSetupTree());
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const left = document.getElementById('left-tree');
    const tree = document.getElementById('simulations-tree');
    if (left) left.setAttribute('data-react-tree', '1');
    if (tree) {
      tree.replaceChildren();
      setHost(tree);
    }
    const refresh = () => setModel(readSetupTree());
    window.addEventListener('cfd:tree-sync', refresh);
    refresh();
    return () => window.removeEventListener('cfd:tree-sync', refresh);
  }, []);

  useEffect(() => {
    setModel(readSetupTree());
  }, [hydrate]);

  if (!host) return null;
  return createPortal(<SetupTreeView model={model} />, host);
}
