import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { MenuButton, type MenuItem } from '../chrome/MenuButton';
import { takenStudyTitles } from '../chrome/studyName';
import type { ProjectTreeDoc } from '../chrome/treeModel';
import { scopeBelongsToProject } from '../scope';
import { workspaceHash } from './route';
import {
  appNotice,
  entriesFromKinds,
  headerLabel,
  shownStartActions,
  startKey,
  startStudy,
  type StartEntry,
} from './startActions';

function ActionIcon({ path }: { path: string }) {
  if (!path) return null;
  return (
    <svg className="ws-start-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** True while a geometry import runs (runtime.js runGeometryImport: cfd:geometry-import). */
function useImportBusy(): boolean {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const on = (e: Event) => setBusy(!!(e as CustomEvent<{ busy?: boolean } | null>).detail?.busy);
    window.addEventListener('cfd:geometry-import', on);
    return () => window.removeEventListener('cfd:geometry-import', on);
  }, []);
  return busy;
}

/**
 * The start actions inside a project (API 1.4): the header buttons (each with a menu of
 * the project's studies of its kind and "New <kind>") and the empty project's buttons.
 * Both read the tree's kind rows the Workspaces menu reads. A click names the study
 * "<Kind> N" (no prompt), makes it and opens its workspace; the button stays disabled
 * until the route opened or the notice was closed.
 */
export function StartActionPlaces({ projectId, doc }: { projectId: string; doc: ProjectTreeDoc | null }) {
  const headerHost = typeof document !== 'undefined' ? document.getElementById('ws-start-host') : null;
  const emptyHost = typeof document !== 'undefined' ? document.getElementById('wb-empty-start') : null;
  const importing = useImportBusy();
  // The action whose study is being made (`<plugin>:<kind>`), across both places.
  const [making, setMaking] = useState('');
  useEffect(() => setMaking(''), [projectId]);

  if (!projectId || !doc) return null;
  const shown = shownStartActions(entriesFromKinds(doc.plugin_study_kinds));
  const studies = (doc.plugin_studies || []).filter((s) => !!s.scope_key && scopeBelongsToProject(s.scope_key, projectId));

  const start = (entry: StartEntry) => {
    if (making) return;
    setMaking(startKey(entry));
    void startStudy(entry, { projectId, titles: takenStudyTitles(doc), notice: appNotice })
      .catch((e) => console.warn('[CFD] start action', e))
      .finally(() => setMaking(''));
  };

  const header = shown.header.map((entry) => {
    const key = startKey(entry);
    const mine = studies.filter((s) => s.plugin === entry.plugin && s.kind === entry.action.study_kind && s.available);
    const items: MenuItem[] = mine.map((s) => ({
      key: s.scope_key,
      attrs: { 'data-start-study': s.id, 'data-read-only': s.read_only ? '1' : undefined },
      onSelect: () => {
        location.hash = workspaceHash({ projectId, plugin: s.plugin, workspace: s.workspace || entry.action.workspace, studyId: s.id });
      },
      label: (
        <>
          {s.title}
          {s.read_only ? <span className="ws-menu-plugin">Read only</span> : null}
        </>
      ),
    }));
    if (!mine.length) items.push({ kind: 'note', key: 'none', label: `No ${entry.action.kind_title} yet`, attrs: { 'data-start-none': '1' } });
    items.push({ kind: 'separator', key: 'sep' });
    items.push({
      key: 'new',
      attrs: { 'data-start-new': key },
      disabled: !!making,
      onSelect: () => start(entry),
      label: `New ${entry.action.kind_title}`,
    });
    return (
      <MenuButton
        key={key}
        className="ws-menu ws-start"
        buttonClassName="home-btn ws-start-btn"
        title={`${entry.action.kind_title}: open one or start a new one (${entry.plugin_name})`}
        disabled={making === key}
        wrapAttrs={{ 'data-start-header': key }}
        items={items}
        label={
          <>
            <ActionIcon path={entry.action.icon} />
            <span className="ws-start-label">{headerLabel(entry)}</span>
          </>
        }
      />
    );
  });

  const empty = shown.empty_project.map((entry) => {
    const key = startKey(entry);
    return (
      <div className="wb-empty-start-item" key={key}>
        <button
          type="button"
          className="wb-empty-btn"
          data-start-empty={key}
          disabled={importing || !!making}
          onClick={() => start(entry)}
        >
          {entry.action.label}
        </button>
        {entry.action.hint ? <p className="wb-empty-hint">{entry.action.hint}</p> : null}
      </div>
    );
  });

  return (
    <>
      {headerHost && header.length ? createPortal(header, headerHost) : null}
      {emptyHost && empty.length ? createPortal(empty, emptyHost) : null}
    </>
  );
}
