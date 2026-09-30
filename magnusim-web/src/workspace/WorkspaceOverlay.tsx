import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHashRoute } from '../app/routes';
import { onTreeAction } from '../chrome/treeSession';
import type { StudyRecord } from '../plugin-sdk/workspace';
import { prefersImperial } from '../prefs';
import { pluginStudyScope } from '../scope';
import { useProjectStore } from '../store/project';
import { WorkspaceBridge, WorkspaceCalls, type BridgeHooks, type BridgeScope } from './bridge';
import type { WorkspaceRoute } from './route';

/** A frame that has not said hello this long after it started loading did not start. */
export const HANDSHAKE_MS = 5000;

type PluginRow = {
  key: string;
  name?: string;
  status?: string;
  error?: string;
  workspaces?: Array<{ key: string; title: string; entry: string }>;
};

/** Why the workspace is not showing. `gone`: its study was deleted (nothing to set up in Settings). */
type Blocked = { title: string; detail: string; retry: boolean; gone?: boolean };

/** The study was deleted (in another tab), or a link names one that is gone. */
const STUDY_GONE: Blocked = {
  title: 'This study no longer exists.',
  detail: 'It was deleted, or the link is out of date.',
  retry: false,
  gone: true,
};

/** Why a plugin that is not "enabled" cannot open its workspace, as Settings → Plugins would say it. */
export function pluginNotReady(key: string, row: PluginRow | null): Blocked {
  if (!row) return { title: `The ${key} plugin is not installed.`, detail: 'Its studies stay in the project; install the plugin to open them.', retry: false };
  const who = row.name || key;
  if (row.status === 'disabled') return { title: `${who} is off.`, detail: 'Turn it on in Settings → Plugins to open its workspace.', retry: true };
  if (row.status === 'needs setup') return { title: `${who} needs setup.`, detail: 'Install its dependencies in Settings → Plugins, then try again.', retry: true };
  return { title: `${who} did not load.`, detail: row.error || `Settings → Plugins lists it as "${row.status || 'unknown'}".`, retry: true };
}

function projectTitle(projectId: string): string {
  const w16 = (window as unknown as { __CFD_W16__?: { project?: { id?: string; title?: string; name?: string } } }).__CFD_W16__;
  const p = w16 && w16.project;
  return (p && p.id === projectId && (p.title || p.name)) || projectId;
}

/** Move the header's Queue and Settings into the workspace header; returns how to put them back. */
function borrowHeaderControls(ids: string[], into: HTMLElement): () => void {
  const moved: Array<{ el: HTMLElement; parent: Node; next: Node | null }> = [];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el || !el.parentNode) continue;
    moved.push({ el, parent: el.parentNode, next: el.nextSibling });
    into.appendChild(el);
  }
  return () => {
    for (const m of moved.reverse()) {
      m.parent.insertBefore(m.el, m.next && m.next.parentNode === m.parent ? m.next : null);
    }
  };
}

/**
 * A plugin workspace over its project's workbench (`#/p/<pid>/ws/<plugin>/<ws>/<sid>`).
 * The workbench stays underneath with its tree and scope; Back returns to it.
 */
export function WorkspaceOverlay() {
  const route = useHashRoute();
  const projectId = useProjectStore((s) => s.projectId);
  const host = typeof document !== 'undefined' ? document.getElementById('workspace-overlay') : null;
  const ws = route.view === 'workbench' ? (route as { workspace?: WorkspaceRoute | null }).workspace || null : null;
  const open = !!(host && ws && ws.projectId === projectId);
  useEffect(() => {
    if (host) host.hidden = !open;
  }, [host, open]);
  if (!open || !host || !ws) return null;
  return createPortal(<WorkspaceView key={`${ws.projectId}/${ws.plugin}/${ws.workspace}/${ws.studyId}`} route={ws} />, host);
}

function WorkspaceView({ route }: { route: WorkspaceRoute }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<WorkspaceBridge | null>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const [row, setRow] = useState<PluginRow | null>(null);
  const [study, setStudy] = useState<StudyRecord | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [toast, setToast] = useState<{ text: string; kind: string } | null>(null);
  const name = (row && row.name) || route.plugin;
  // Found gone by the host (open, a bridge call): the card, and the tree drops the row.
  // (The tree-sync listener below only shows the card, so this cannot loop.)
  const studyGone = () => {
    setBlocked(STUDY_GONE);
    window.dispatchEvent(new CustomEvent('cfd:tree-sync'));
  };
  const entry = row && row.workspaces ? row.workspaces.find((w) => w.key === route.workspace)?.entry : undefined;
  const scopeKey = pluginStudyScope(route.projectId, route.plugin, route.studyId);

  // Covering the workbench: its Queue and Settings move into this header; the viewport pauses.
  useEffect(() => {
    document.body.classList.add('workspace-open');
    window.dispatchEvent(new CustomEvent('cfd:workspace-open'));
    const restore = slotRef.current ? borrowHeaderControls(['queue-menu', 'wb-prefs'], slotRef.current) : () => undefined;
    return () => {
      restore();
      document.body.classList.remove('workspace-open');
      window.dispatchEvent(new CustomEvent('cfd:workspace-close'));
    };
  }, []);

  // What opens: the plugin (on, with this workspace) and the study.
  useEffect(() => {
    let dead = false;
    setBlocked(null);
    setConnected(false);
    void (async () => {
      try {
        const list = (await (await fetch('/api/plugins', { cache: 'no-store' })).json()) as { plugins?: PluginRow[] };
        const hit = (list.plugins || []).find((p) => p.key === route.plugin) || null;
        if (dead) return;
        setRow(hit);
        const who = (hit && hit.name) || route.plugin;
        if (!hit || hit.status !== 'enabled') {
          setBlocked(pluginNotReady(route.plugin, hit));
          return;
        }
        if (!(hit.workspaces || []).some((w) => w.key === route.workspace)) {
          setBlocked({ title: `${who} has no workspace "${route.workspace}".`, detail: 'The plugin may have changed since this link was made.', retry: false });
          return;
        }
        const q = new URLSearchParams({ project_id: route.projectId, plugin: route.plugin, study_id: route.studyId });
        const r = await fetch(`/api/plugin-studies/get?${q}`, { cache: 'no-store' });
        const j = (await r.json().catch(() => ({}))) as { study?: StudyRecord; error?: string };
        if (dead) return;
        if (r.status === 404) {
          studyGone();
          return;
        }
        if (!r.ok || !j.study) {
          setBlocked({ title: 'This study cannot open.', detail: String(j.error || `The app answered ${r.status}.`), retry: true });
          return;
        }
        setStudy(j.study);
      } catch (err) {
        if (!dead) setBlocked({ title: `${route.plugin} didn't start.`, detail: String(err instanceof Error ? err.message : err), retry: true });
      }
    })();
    return () => {
      dead = true;
    };
  }, [route.plugin, route.workspace, route.projectId, route.studyId, attempt]);

  // A rename (here or in the tree) shows in the header; a deleted study closes the frame.
  useEffect(() => {
    const refresh = () => {
      const q = new URLSearchParams({ project_id: route.projectId, plugin: route.plugin, study_id: route.studyId });
      void fetch(`/api/plugin-studies/get?${q}`, { cache: 'no-store' })
        .then((r) => {
          if (r.status === 404) setBlocked(STUDY_GONE);
          return r.ok ? r.json() : null;
        })
        .then((j) => j && j.study && setStudy(j.study as StudyRecord))
        .catch(() => undefined);
    };
    window.addEventListener('cfd:tree-sync', refresh);
    return () => window.removeEventListener('cfd:tree-sync', refresh);
  }, [route.plugin, route.projectId, route.studyId]);

  const ready = !!(row && study && entry && !blocked);
  const hooks = useMemo<BridgeHooks>(
    () => ({
      back: () => {
        location.hash = `#/p/${encodeURIComponent(route.projectId)}`;
      },
      connected: () => setConnected(true),
      studyChanged: (next) => setStudy(next),
      studyGone,
      toast: (text, kind) => setToast({ text, kind }),
      confirm: (opts) => (window.__CFD_CONFIRM__ ? window.__CFD_CONFIRM__(opts) : Promise.resolve(window.confirm(opts.copy || opts.title))),
      prompt: (opts) =>
        window.__CFD_PROMPT_NAME__ ? window.__CFD_PROMPT_NAME__(opts) : Promise.resolve(window.prompt(opts.title, opts.value)),
      units: () => (prefersImperial() ? 'imperial' : 'metric'),
      log: (message, detail) => console.warn(`[workspace] ${message}`, detail ?? ''),
    }),
    [route.projectId],
  );

  // The frame's bridge; no hello within 5 s is an error card.
  useEffect(() => {
    const frame = frameRef.current;
    if (!ready || !frame) return undefined;
    const scope: BridgeScope = {
      plugin: route.plugin,
      pluginName: name,
      workspace: route.workspace,
      projectId: route.projectId,
      projectTitle: projectTitle(route.projectId),
      studyId: route.studyId,
    };
    const bridge = new WorkspaceBridge(frame, new WorkspaceCalls(scope, hooks), hooks);
    bridgeRef.current = bridge;
    const detach = bridge.attach();
    const timer = setTimeout(() => {
      if (!bridge.connected()) {
        setBlocked({ title: `${name} didn't start.`, detail: 'Its workspace page did not connect within 5 seconds.', retry: true });
      }
    }, HANDSHAKE_MS);
    return () => {
      clearTimeout(timer);
      detach();
    };
    // The bridge lives as long as this frame (a new attempt makes a new frame).
  }, [ready, attempt]);

  // Every change of the study the host sees after the welcome (a rename in the
  // header, the frame's own save) reaches the frame, so its next save has the current rev.
  const sentRev = useRef<number | null>(null);
  useEffect(() => {
    if (!connected) {
      sentRev.current = null;
      return;
    }
    if (!study) return;
    if (sentRev.current === null) {
      sentRev.current = study.rev;
      return;
    }
    if (study.rev === sentRev.current) return;
    sentRev.current = study.rev;
    bridgeRef.current?.pushStudy(study);
  }, [study, connected]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const back = () => {
    location.hash = `#/p/${encodeURIComponent(route.projectId)}`;
  };
  const title = (study && study.title) || route.studyId;

  return (
    <div className="ws-shell" data-workspace={`${route.plugin}/${route.workspace}`} data-workspace-connected={connected ? '1' : undefined}>
      <header className="ws-header" data-workspace-header="1">
        <div className="ws-header-left">
          <button type="button" className="home-btn ws-back" data-ws-back="1" onClick={back}>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
              <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Back to project
          </button>
          <span className="ws-crumb" data-ws-crumb="1">
            <span className="ws-plugin">{name}</span>
            <span className="ws-sep" aria-hidden="true">
              ›
            </span>
            <button
              type="button"
              className="ws-title"
              data-ws-title="1"
              title="Rename study"
              disabled={!study}
              onClick={() => study && onTreeAction(scopeKey, 'plugin-study-rename', { title: study.title, rev: study.rev })}
            >
              {title}
            </button>
          </span>
        </div>
        <div className="ws-header-right" ref={slotRef} />
      </header>
      <div className="ws-body">
        {ready && !blocked ? (
          <iframe
            key={attempt}
            ref={frameRef}
            id="workspace-frame"
            className="ws-frame"
            title={`${name}: ${title}`}
            sandbox="allow-scripts allow-downloads"
            allow="clipboard-write"
            src={`/plugins/${encodeURIComponent(route.plugin)}/${entry}`}
          />
        ) : null}
        {!blocked && !connected ? (
          <div className="ws-loading" data-ws-loading="1" role="status">
            Starting {name}…
          </div>
        ) : null}
        {blocked ? (
          <div className="ws-error" role="alert" data-ws-error="1">
            <h2>{blocked.title}</h2>
            <p>{blocked.detail}</p>
            <div className="ws-error-actions">
              {blocked.gone ? (
                <button type="button" className="home-btn" data-ws-error-back="1" onClick={back}>
                  Back to project
                </button>
              ) : (
                <button type="button" className="home-btn" data-ws-settings="1" onClick={() => onTreeAction(scopeKey, 'open-plugin-settings')}>
                  Open Settings → Plugins
                </button>
              )}
              {blocked.retry ? (
                <button type="button" className="home-btn" data-ws-retry="1" onClick={() => setAttempt((n) => n + 1)}>
                  Try again
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {toast ? (
          <div className={`ws-toast is-${toast.kind}`} role="status" data-ws-toast="1">
            <span>{toast.text}</span>
            <button type="button" className="ws-toast-close" aria-label="Close" onClick={() => setToast(null)}>
              ×
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
