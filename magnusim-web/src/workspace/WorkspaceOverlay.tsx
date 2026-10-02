import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHashRoute } from '../app/routes';
import { onTreeAction } from '../chrome/treeSession';
import type { StudyRecord } from '../plugin-sdk/workspace';
import { Toast, type ToastKind } from '../plugin-ui';
import { prefersImperial } from '../prefs';
import { pluginStudyScope } from '../scope';
import { useProjectStore } from '../store/project';
import { WorkspaceBridge, WorkspaceCalls, type BridgeHooks, type BridgeScope } from './bridge';
import {
  exitFrameFullscreen,
  frameMayTakeFocus,
  leaveApproved,
  leaveWorkspaceTo,
  openWorkspaceRoute,
  registerOpenWorkspace,
  setWorkspaceDirty,
  subscribeWorkspaceDirty,
  workspaceDirty,
  type GuardedWorkspace,
} from './leaveGuard';
import { openPluginResults } from './pluginResults';
import type { WorkspaceRoute } from './route';

// When the host gives the keyboard to the frame (it lives with the leave guard, which needs it too).
export { frameMayTakeFocus };

/** A frame that has not said hello this long after it started loading did not start. */
export const HANDSHAKE_MS = 5000;

/** The card's extra line when the page had unsaved work that went with it. */
const LOST = 'Changes that were not saved in the workspace were lost.';

/** The app's own UI over the workspace: when one closes, the keyboard goes back to the frame. */
const HOST_UI = ['modal-confirm', 'modal-prompt', 'setup-wizard', 'job-queue-chip'];

type PluginRow = {
  key: string;
  name?: string;
  status?: string;
  error?: string;
  workspaces?: Array<{ key: string; title: string; entry: string }>;
};

/**
 * Why the workspace is not showing. `gone`: its study was deleted (nothing to set up in Settings).
 * `lost`: the page had unsaved work when it closed.
 */
type Blocked = { title: string; detail: string; retry: boolean; gone?: boolean; lost?: boolean };

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

/** Make the workbench under the overlay inert (no Tab, no clicks); returns how to undo it. */
function coverWorkbench(): () => void {
  const app = document.getElementById('app');
  const overlay = document.getElementById('workspace-overlay');
  const made: HTMLElement[] = [];
  for (const el of Array.from(app ? app.children : [])) {
    if (!(el instanceof HTMLElement) || el === overlay || el.inert) continue;
    el.inert = true;
    made.push(el);
  }
  return () => {
    for (const el of made) el.inert = false;
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
  const headerRef = useRef<HTMLElement>(null);
  const bridgeRef = useRef<WorkspaceBridge | null>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const [row, setRow] = useState<PluginRow | null>(null);
  const [study, setStudy] = useState<StudyRecord | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The page's toast, one at a time: each message gets a new id, so it replaces the one showing.
  const [toast, setToast] = useState<{ id: number; text: string; kind: ToastKind } | null>(null);
  const toastSerial = useRef(0);
  const [unsaved, setUnsaved] = useState({ dirty: false, message: '' });
  const [fullscreen, setFullscreen] = useState(false);
  const name = (row && row.name) || route.plugin;
  const title = (study && study.title) || route.studyId;
  const projectHash = `#/p/${encodeURIComponent(route.projectId)}`;
  // What the leave question names, kept current.
  const named = useRef({ name, title });
  useEffect(() => {
    named.current = { name, title };
  });
  // This workspace as the leave guard knows it (registered while it is open).
  const [guarded] = useState<GuardedWorkspace>(() => ({
    route,
    pluginName: () => named.current.name,
    studyTitle: () => named.current.title,
    frame: () => frameRef.current,
  }));
  const mine = () => openWorkspaceRoute() === guarded.route;
  // Unsaved work that closing the page now would lose (the user did not choose to leave).
  const lostNow = () => mine() && workspaceDirty();
  // The keyboard goes to the page unless the app's own UI has it.
  const focusFrame = () => {
    const frame = frameRef.current;
    if (frame && frameMayTakeFocus(document, frame, headerRef.current)) frame.focus({ preventScroll: true });
  };
  // Found gone by the host (open, a bridge call): the card, and the tree drops the row.
  // (The tree-sync listener below only shows the card, so this cannot loop.)
  const studyGone = () => {
    const lost = lostNow();
    setBlocked((b) => (b && b.gone ? b : { ...STUDY_GONE, lost }));
    window.dispatchEvent(new CustomEvent('cfd:tree-sync'));
  };
  const entry = row && row.workspaces ? row.workspaces.find((w) => w.key === route.workspace)?.entry : undefined;
  const scopeKey = pluginStudyScope(route.projectId, route.plugin, route.studyId);

  // Covering the workbench: its Queue and Settings move into this header, the rest
  // of it is inert (no Tab or clicks into it); the viewport pauses.
  useEffect(() => {
    document.body.classList.add('workspace-open');
    window.dispatchEvent(new CustomEvent('cfd:workspace-open'));
    const restore = slotRef.current ? borrowHeaderControls(['queue-menu', 'wb-prefs'], slotRef.current) : () => undefined;
    const uncover = coverWorkbench();
    return () => {
      try {
        restore();
      } finally {
        // Once the controls are back, and whatever happened: nothing stays inert.
        uncover();
      }
      document.body.classList.remove('workspace-open');
      window.dispatchEvent(new CustomEvent('cfd:workspace-close'));
    };
  }, []);

  // The leave guard knows this workspace while it is open; its unsaved work shows in the header.
  // Each attempt is a new page: it starts clean, and a leave approved for the one before is over.
  useEffect(() => {
    const unsubscribe = subscribeWorkspaceDirty((s) => {
      if (openWorkspaceRoute() === guarded.route) setUnsaved(s);
    });
    const unregister = registerOpenWorkspace(guarded);
    return () => {
      unregister();
      unsubscribe();
    };
  }, [guarded, attempt]);

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
          if (r.status === 404) {
            const lost = lostNow();
            setBlocked((b) => (b && b.gone ? b : { ...STUDY_GONE, lost }));
          }
          return r.ok ? r.json() : null;
        })
        .then((j) => j && j.study && setStudy(j.study as StudyRecord))
        .catch(() => undefined);
    };
    window.addEventListener('cfd:tree-sync', refresh);
    return () => window.removeEventListener('cfd:tree-sync', refresh);
  }, [route.plugin, route.projectId, route.studyId]);

  // The plugin turned off (in Settings here, in another tab, by a script) closes the
  // page into the "is off" card. Checked when the plugins changed here and when this
  // tab comes back to the front; never polled.
  useEffect(() => {
    let dead = false;
    const recheck = () => {
      void fetch('/api/plugins', { cache: 'no-store' })
        .then((r) => r.json() as Promise<{ plugins?: PluginRow[] }>)
        .then((list) => {
          const hit = (list.plugins || []).find((p) => p.key === route.plugin) || null;
          if (dead || (hit && hit.status === 'enabled')) return;
          // Unsaved work went with it, unless the user chose to turn it off here.
          const lost = lostNow();
          setBlocked((b) => b || { ...pluginNotReady(route.plugin, hit), lost });
        })
        .catch(() => undefined);
    };
    const onSync = (e: Event) => {
      if ((e as CustomEvent<{ plugins?: boolean } | null>).detail?.plugins === true) recheck();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') recheck();
    };
    window.addEventListener('cfd:tree-sync', onSync);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      dead = true;
      window.removeEventListener('cfd:tree-sync', onSync);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [route.plugin]);

  const ready = !!(row && study && entry && !blocked);
  const hooks = useMemo<BridgeHooks>(() => {
    // The page's own questions: out of full screen first, one at a time with the app's
    // other dialogs, then the keyboard goes back to the page. One is dropped unseen when
    // its turn comes after the page load that asked is gone or the user chose to leave,
    // and closes (as Cancel) if that page load goes while it is on screen.
    const pageDialog = async <T,>(show: (opts: { skipIf: () => boolean; signal?: AbortSignal }) => Promise<T>): Promise<T> => {
      // The channel this call came over (a reload of the page gets a new one).
      const asker = bridgeRef.current?.channelSignal() ?? null;
      await exitFrameFullscreen();
      try {
        return await show({ skipIf: () => !asker || asker.aborted || leaveApproved(), signal: asker ?? undefined });
      } finally {
        focusFrame();
      }
    };
    const appConfirm = (opts: { title: string; copy: string; yes: string }) =>
      pageDialog((turn) =>
        window.__CFD_CONFIRM__ ? window.__CFD_CONFIRM__({ ...opts, ...turn }) : Promise.resolve(window.confirm(opts.copy || opts.title)),
      );
    return {
      back: () => leaveWorkspaceTo(projectHash, 'frame-back'),
      setDirty: (dirty, message) => {
        if (mine()) setWorkspaceDirty(dirty, message);
      },
      connected: () => {
        setConnected(true);
        requestAnimationFrame(() => focusFrame());
      },
      studyChanged: (next) => setStudy(next),
      studyGone,
      toast: (text, kind) => setToast({ id: ++toastSerial.current, text, kind }),
      confirm: appConfirm,
      prompt: (opts) =>
        pageDialog((turn) =>
          window.__CFD_PROMPT_NAME__
            ? window.__CFD_PROMPT_NAME__({ ...opts, ...turn })
            : Promise.resolve(window.prompt(opts.title, opts.value)),
        ),
      units: () => (prefersImperial() ? 'imperial' : 'metric'),
      log: (message, detail) => console.warn(`[workspace] ${message}`, detail ?? ''),
      // A case's results in the project's 3D view: asks before replacing results on screen, then leaves.
      openResults: (caseRel) =>
        openPluginResults(
          {
            projectId: route.projectId,
            plugin: route.plugin,
            pluginName: named.current.name,
            studyId: route.studyId,
            studyTitle: named.current.title,
          },
          caseRel,
          {
            ask: appConfirm,
            leave: (hash) => leaveWorkspaceTo(hash, 'results'),
            resultsShown: () => window.__CFD_RESULTS_VIEW__ === true,
          },
        ),
    };
  }, [route.projectId]);

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
      // The page's full screen ends with its frame.
      if (document.fullscreenElement === frame) void document.exitFullscreen().catch(() => undefined);
    };
    // The bridge lives as long as this frame (a new attempt makes a new frame).
  }, [ready, attempt]);

  // No page, no unsaved work: the card's Back needs no question.
  useEffect(() => {
    if (blocked && mine()) setWorkspaceDirty(false);
  }, [blocked]);

  // Whether the page has its frame in full screen (Esc or any app dialog ends it).
  useEffect(() => {
    const onChange = () => setFullscreen(!!frameRef.current && document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // When the app's own UI over the page closes (a dialog, Settings, the Queue), the
  // keyboard goes back to the page if nothing else took it. Chromium can still name
  // the clicked button of a panel that just closed as the active element.
  // Only a change from shown to hidden counts: the Queue's sync hides its chip again
  // when it is hidden already, and that must not take the keyboard from the page body.
  useEffect(() => {
    if (!connected) return undefined;
    const closed = new Set<HTMLElement>();
    let raf = 0;
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as HTMLElement;
        if (r.oldValue === null && el.hidden) closed.add(el);
      }
      if (!closed.size || raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const panels = Array.from(closed);
        closed.clear();
        const active = document.activeElement;
        if (!active || active === document.body || panels.some((el) => el.contains(active))) focusFrame();
      });
    });
    for (const id of HOST_UI) {
      const el = document.getElementById(id);
      if (el) observer.observe(el, { attributes: true, attributeFilter: ['hidden'], attributeOldValue: true });
    }
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [connected]);

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

  // Back to the project; with unsaved work the app asks first.
  const back = () => void leaveWorkspaceTo(projectHash, 'back');

  return (
    <div
      className="ws-shell"
      data-workspace={`${route.plugin}/${route.workspace}`}
      data-workspace-connected={connected ? '1' : undefined}
      data-workspace-dirty={unsaved.dirty ? '1' : undefined}
      data-workspace-fullscreen={fullscreen && !blocked ? '1' : undefined}
    >
      <header className="ws-header" data-workspace-header="1" ref={headerRef}>
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
            {unsaved.dirty ? <span className="ws-dirty" data-ws-dirty="1" title={unsaved.message || 'Not saved'} aria-label="Not saved" /> : null}
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
            allow="clipboard-write; fullscreen"
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
            {blocked.lost ? <p data-ws-lost="1">{LOST}</p> : null}
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
        {/* The kit Toast closes itself (3.8 s, errors 9 s); a new message remounts it (key). */}
        {toast ? (
          <div className="ws-toast-slot">
            <Toast key={toast.id} message={toast.text} kind={toast.kind} onClose={() => setToast(null)} attrs={{ 'data-ws-toast': '1' }} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
