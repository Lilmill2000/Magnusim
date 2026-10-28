/**
 * Magnusim CAD's project page: an open project's Parts, where Magnusim has its workbench.
 * A Part opens in CAD's workspace (the overlay over this page); New part makes one with
 * CAD's start action; each Part can be renamed and deleted. Studies of plugins this app
 * does not have (a project made in Magnusim) are listed greyed, kept as they are.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHashRoute } from '../app/routes';
import { renamePluginStudy } from '../chrome/studyName';
import { confirmAction, promptName } from '../workbench/dialogs';
import { loadStartActions, startStudy } from '../workspace/startActions';
import { workspaceHash } from '../workspace/route';
import { openProjectNow, type CadProject } from './shell';

export interface PartRow {
  id: string;
  plugin: string;
  plugin_name: string;
  kind_title: string;
  workspace: string;
  title: string;
  rev: number;
  available: boolean;
  reason: string;
  icon?: string;
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function notice(title: string, copy: string): Promise<void> {
  await confirmAction({ title, copy, yes: 'OK', notice: true });
}

function useOpenProject(): CadProject | null {
  const [project, setProject] = useState<CadProject | null>(() => openProjectNow());
  useEffect(() => {
    const on = () => setProject(openProjectNow());
    window.addEventListener('cad:project', on);
    return () => window.removeEventListener('cad:project', on);
  }, []);
  return project;
}

function PartIcon({ d }: { d?: string }) {
  return (
    <svg className="cad-part-icon" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
      <path d={d || 'M4 8l8-4 8 4v8l-8 4-8-4z M4 8l8 4 8-4 M12 12v8'} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function ProjectPage({ host }: { host: HTMLElement }) {
  const route = useHashRoute();
  const project = useOpenProject();
  const [parts, setParts] = useState<PartRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const pid = project?.id || '';
  const onWorkspace = route.view === 'workbench' && !!(route as { workspace?: unknown }).workspace;
  // Each read of the list; only the newest one's answer is shown (Back starts two at once, and
  // an older answer landing last would put back rows read before the Part saved).
  const reads = useRef(0);

  const reload = useCallback(async () => {
    if (!pid) return;
    const serial = ++reads.current;
    const r = await fetch(`/api/plugin-studies?${new URLSearchParams({ project_id: pid })}`, { cache: 'no-store' });
    const j = (await r.json().catch(() => ({}))) as { studies?: PartRow[] };
    if (serial !== reads.current) return;
    setParts(Array.isArray(j.studies) ? j.studies : []);
  }, [pid]);

  useEffect(() => {
    setParts(null);
    void reload();
  }, [reload]);
  // Back from a Part: its title or a new Part from the Assistant shows here.
  useEffect(() => {
    if (!onWorkspace) void reload();
  }, [onWorkspace, reload]);
  useEffect(() => {
    const on = () => void reload();
    window.addEventListener('cfd:tree-sync', on);
    return () => window.removeEventListener('cfd:tree-sync', on);
  }, [reload]);

  if (!project) return null;

  const open = (part: PartRow) => {
    if (!part.available) return;
    location.hash = workspaceHash({ projectId: pid, plugin: part.plugin, workspace: part.workspace, studyId: part.id });
  };

  const newPart = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const entries = await loadStartActions({ force: true });
      const entry = entries.find((e) => e.plugin === 'cad');
      if (!entry) {
        await notice('CAD is not available', 'Magnusim CAD could not load its Part workspace.');
        return;
      }
      await startStudy(entry, {
        projectId: pid,
        titles: (parts || []).map((p) => p.title),
        notice: (title, copy) => notice(title, copy),
        where: () => pid,
        sync: () => void reload(),
      });
    } finally {
      setBusy(false);
    }
  };

  // Magnusim's rename (chrome/studyName.ts) in this page's words. The row's rev can be older than
  // the record: the Part writes its own fields while it is open (its document pointer on first
  // open, which can even land after Back), and the list read on Back may not have answered when
  // Rename is clicked. So the record is read once the name is typed, and its rev is sent when its
  // title is still the one shown (a rename writes only the title, so the Part's fields stay); a
  // record renamed elsewhere keeps the row's rev and is refused. A rev that changes between that
  // read and the rename is read again once (renamePluginStudy). A refused rename shows the list as
  // it is now behind its notice.
  const rename = (part: PartRow) => {
    const read = async (): Promise<{ title?: unknown; rev?: unknown } | null> => {
      const q = new URLSearchParams({ project_id: pid, plugin: part.plugin, study_id: part.id });
      const r = await fetch(`/api/plugin-studies/get?${q}`, { cache: 'no-store' }).catch(() => null);
      const j = (r && r.ok ? await r.json().catch(() => null) : null) as { study?: { title?: unknown; rev?: unknown } } | null;
      return j?.study ?? null;
    };
    return renamePluginStudy(part, {
      promptName: (o) => promptName({ ...o, title: 'Rename part', copy: 'A new name for this part.' }),
      rename: async (body) => {
        const now = await read();
        const rev = now && String(now.title ?? '') === part.title && now.rev != null ? now.rev : body.rev;
        const got = await postJson('/api/plugin-studies/rename', { project_id: pid, plugin: part.plugin, study_id: part.id, ...body, rev });
        const ok = got.ok && got.json.ok !== false;
        return { response: { status: got.status }, json: { ...got.json, ok, ...(ok ? {} : { error: String(got.json.error || `The app answered ${got.status}.`) }) } };
      },
      read,
      notice: (_title, copy) => {
        void reload();
        return notice('Could not rename the part', copy);
      },
      sync: () => void reload(),
    });
  };

  const remove = async (part: PartRow) => {
    const yes = await confirmAction({
      title: `Delete ${part.title}?`,
      copy: 'The part and its files are removed from this project. This cannot be undone.',
      yes: 'Delete',
      safe: true,
    });
    if (!yes) return;
    const got = await postJson('/api/plugin-studies/delete', { project_id: pid, plugin: part.plugin, study_id: part.id });
    if (!got.ok) await notice('Could not delete the part', String(got.json.error || `The app answered ${got.status}.`));
    await reload();
  };

  return createPortal(
    <section className="cad-project" aria-label="Project" data-cad-project={pid}>
      <header className="cad-project-head">
        <button type="button" className="cad-back" id="cad-home" onClick={() => (location.hash = '#/')}>
          ← Projects
        </button>
        <h1 className="cad-project-title">{project.title || pid}</h1>
        <button type="button" className="cad-new-part primary" id="cad-new-part" disabled={busy} onClick={() => void newPart()}>
          New part
        </button>
      </header>
      {parts === null ? (
        <p className="cad-parts-note">Loading parts…</p>
      ) : parts.length === 0 ? (
        <div className="cad-parts-empty">
          <p>This project has no parts yet.</p>
          <button type="button" className="primary" onClick={() => void newPart()} disabled={busy}>
            Design a part
          </button>
        </div>
      ) : (
        <ul className="cad-parts" aria-label="Parts">
          {parts.map((part) => (
            <li key={`${part.plugin}/${part.id}`} className={`cad-part${part.available ? '' : ' is-unavailable'}`} data-part-id={part.id} data-part-rev={part.rev}>
              <button
                type="button"
                className="cad-part-open"
                disabled={!part.available}
                title={part.available ? `Open ${part.title}` : part.reason}
                onClick={() => open(part)}
              >
                <PartIcon d={part.icon} />
                <span className="cad-part-title">{part.title}</span>
                <span className="cad-part-kind">{part.available ? part.kind_title || 'Part' : part.reason}</span>
              </button>
              {part.available && part.plugin === 'cad' ? (
                <span className="cad-part-actions">
                  <button type="button" onClick={() => void rename(part)} aria-label={`Rename ${part.title}`}>
                    Rename
                  </button>
                  <button type="button" className="danger" onClick={() => void remove(part)} aria-label={`Delete ${part.title}`}>
                    Delete
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>,
    host,
  );
}
