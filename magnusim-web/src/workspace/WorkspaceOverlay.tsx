import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useHashRoute } from '../app/routes';
import { onTreeAction } from '../chrome/treeSession';
import type { StudyRecord, ViewState } from '../plugin-sdk/workspace';
import { Toast, type ToastKind } from '../plugin-ui';
import { prefersImperial } from '../prefs';
import { pluginStudyScope } from '../scope';
import { useProjectStore } from '../store/project';
import { WorkspaceBridge, WorkspaceCalls, type BridgeHooks, type BridgeScope } from './bridge';
import {
  cancelLeave,
  continueLeaveInBackground,
  exitFrameFullscreen,
  frameMayTakeFocus,
  lastLeaveReason,
  leaveApproved,
  leaveInProgress,
  leaveWorkspaceTo,
  openWorkspaceRoute,
  registerOpenWorkspace,
  setWorkspaceDirty,
  subscribeLeaveProgress,
  subscribeWorkspaceDirty,
  workspaceDirty,
  type GuardedWorkspace,
  type LeaveProgress,
} from './leaveGuard';
import { openPluginResults } from './pluginResults';
import type { WorkspaceRoute } from './route';
import { linkReportText } from './linkReport';
import { savedAsNewText, showLinkChoice } from './linkChoice';

// When the host gives the keyboard to the frame (it lives with the leave guard, which needs it too).
export { frameMayTakeFocus };

/** A frame that has not said hello this long after it started loading did not start. */
export const HANDSHAKE_MS = 5000;

/** The card's extra line when the page had unsaved work that went with it. */
const LOST = 'Changes that were not saved in the workspace were lost.';

/** The app's own UI over the workspace: when one closes, the keyboard goes back to the frame. */
const HOST_UI = ['modal-confirm', 'modal-prompt', 'modal-link-choice', 'setup-wizard', 'job-queue-chip'];

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

/**
 * Why a plugin that is not "enabled" cannot open its workspace, as Settings → Plugins would say it.
 * `knownAs`: the plugin's name as the project tree has it (its studies keep the name their
 * plugin had), for a plugin that is not installed and so has no row of its own.
 */
export function pluginNotReady(key: string, row: PluginRow | null, knownAs = ''): Blocked {
  if (!row) return { title: `The ${knownAs || key} plugin is not installed.`, detail: 'Its studies stay in the project; install the plugin to open them.', retry: false };
  const who = row.name || key;
  if (row.status === 'disabled') return { title: `${who} is off.`, detail: 'Turn it on in Settings → Plugins to open its workspace.', retry: true };
  if (row.status === 'needs setup') return { title: `${who} needs setup.`, detail: 'Install its dependencies in Settings → Plugins, then try again.', retry: true };
  return { title: `${who} did not load.`, detail: row.error || `Settings → Plugins lists it as "${row.status || 'unknown'}".`, retry: true };
}

/** The study as the project tree lists it (/api/plugin-studies): its title and its plugin's name. */
type ListedStudy = { pluginName: string; title: string };

/** The tree's names for a study whose plugin cannot open it (not installed, off): null when not listed. */
async function listedStudy(projectId: string, plugin: string, studyId: string): Promise<ListedStudy | null> {
  try {
    const r = await fetch(`/api/plugin-studies?${new URLSearchParams({ project_id: projectId })}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = (await r.json()) as { studies?: Array<{ id?: unknown; plugin?: unknown; plugin_name?: unknown; title?: unknown }> };
    const hit = (j.studies || []).find((s) => s && s.plugin === plugin && s.id === studyId);
    return hit ? { pluginName: String(hit.plugin_name || ''), title: String(hit.title || '') } : null;
  } catch {
    return null;
  }
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
  // The last geometry this page linked (API 1.5), whether the host showed its report here
  // already, and whether it is leaving for the results; the camera the page wants to land
  // with (API 1.6: linkGeometry's view, or the exit hook's; the last one wins).
  const linked = useRef<{ geometryId: string; jobId: string | null; created: boolean; reported: boolean } | null>(null);
  const toResults = useRef(false);
  const landView = useRef<ViewState | null>(null);
  // The page's exit hook ran in this visit: the workbench lands on the study's geometry
  // (LINK 6.5) even when nothing was linked, with the camera the hook returned.
  const hookRan = useRef(false);
  // The update's report held back during a leave: shown if the user stays after all.
  const heldReport = useRef<{ title: string; copy: string } | null>(null);
  // What the header shows while a leave runs the page's exit hook (API 1.6).
  const [leaveUi, setLeaveUi] = useState<LeaveProgress>({ running: false, shown: false, label: '', choosing: false, background: false, started: false });
  const [row, setRow] = useState<PluginRow | null>(null);
  const [study, setStudy] = useState<StudyRecord | null>(null);
  // The tree's names for the study when its plugin cannot open it (no row, no record read).
  const [listed, setListed] = useState<ListedStudy | null>(null);
  const [blocked, setBlocked] = useState<Blocked | null>(null);
  const [connected, setConnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The page's toast, one at a time: each message gets a new id, so it replaces the one showing.
  const [toast, setToast] = useState<{ id: number; text: string; kind: ToastKind } | null>(null);
  const toastSerial = useRef(0);
  const [unsaved, setUnsaved] = useState({ dirty: false, message: '' });
  const [fullscreen, setFullscreen] = useState(false);
  const name = (row && row.name) || (listed && listed.pluginName) || route.plugin;
  const title = (study && study.title) || (listed && listed.title) || route.studyId;
  const projectHash = `#/p/${encodeURIComponent(route.projectId)}`;
  // What the leave question names, kept current.
  const named = useRef({ name, title });
  useEffect(() => {
    named.current = { name, title };
  });
  // This workspace as the leave guard knows it (registered while it is open), with its
  // page's exit hook (API 1.6) through the bridge of the page now loaded.
  const [guarded] = useState<GuardedWorkspace>(() => ({
    route,
    pluginName: () => named.current.name,
    studyTitle: () => named.current.title,
    frame: () => frameRef.current,
    hook: {
      on: () => !!bridgeRef.current && bridgeRef.current.hookOn(),
      probe: () => (bridgeRef.current ? bridgeRef.current.probe() : Promise.resolve(false)),
      run: (reason, o) => {
        if (!bridgeRef.current) return Promise.resolve({ ok: true });
        hookRan.current = true;
        return bridgeRef.current.runLeave(reason, o);
      },
      geometryName: () => (bridgeRef.current ? bridgeRef.current.geometryName() : Promise.resolve('')),
      lastGeometryName: () => (bridgeRef.current ? bridgeRef.current.lastGeometryName() : ''),
    },
    // The user stays after a leave whose hook updated the project: its report, held back
    // for the landing, shows here now.
    stayed: () => {
      const held = heldReport.current;
      heldReport.current = null;
      if (!held || !linked.current || linked.current.reported) return;
      linked.current.reported = true;
      void (async () => {
        await exitFrameFullscreen();
        if (window.__CFD_CONFIRM__) await window.__CFD_CONFIRM__({ title: held.title, copy: held.copy, yes: 'OK', notice: true });
        const frame = frameRef.current;
        const header = headerRef.current;
        if (frame && frameMayTakeFocus(document, frame, header)) frame.focus({ preventScroll: true });
      })();
    },
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
      // The page linked a geometry, or its exit hook ran: the workbench lands on the study's
      // geometry (showLinkedGeometry, LINK 6.5; with no link here it looks the geometry up).
      // Back (the header's or the page's) is the full landing; the results or anywhere else
      // refresh data only. The reason is the way out the leave guard let through; a change
      // of address it never saw is read from where the address went.
      const link = linked.current;
      if (link || hookRan.current) {
        const hash = window.location.hash || '';
        const guess = toResults.current ? 'results' : hash === projectHash || hash.startsWith(`${projectHash}?`) ? 'back' : 'project';
        const reason = lastLeaveReason(guarded) || guess;
        const { reported, ...rest } = link || { reported: true };
        window.dispatchEvent(
          new CustomEvent('cfd:workspace-left', {
            detail: {
              projectId: route.projectId,
              plugin: route.plugin,
              studyId: route.studyId,
              studyTitle: named.current.title,
              reason,
              ...rest,
              view: landView.current,
              // The landing shows the update's report when this page did not show it.
              report: !reported,
            },
          }),
        );
      }
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

  // A leave running the page's exit hook: the header's status line, Cancel and "Continue in
  // background"; the page under it takes no input meanwhile.
  useEffect(() => subscribeLeaveProgress((p) => setLeaveUi(p)), []);
  useEffect(() => {
    const frame = frameRef.current;
    if (frame) frame.inert = leaveUi.running;
  }, [leaveUi.running]);

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
          // The header and the card name the plugin and the study as the project tree does,
          // also when the plugin is not installed (never its key and the study's id).
          const names = await listedStudy(route.projectId, route.plugin, route.studyId);
          if (dead) return;
          setListed(names);
          setBlocked(pluginNotReady(route.plugin, hit, names ? names.pluginName : ''));
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
          setBlocked((b) => b || { ...pluginNotReady(route.plugin, hit, named.current.name), lost });
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
      // A linked geometry's update the page made: what was lost, came back or must be picked (API 1.5).
      linkStarted: (link) => {
        linked.current = { ...link, reported: false };
      },
      // Inside a leave the landing shows the report, after the part (LINK 6.5); here only
      // for a link the page made while it stays open.
      linkReport: (result) => {
        if (leaveInProgress() || leaveApproved()) {
          heldReport.current = linkReportText(result);
          return;
        }
        if (linked.current) linked.current.reported = true;
        const t = linkReportText(result);
        void pageDialog((turn) =>
          window.__CFD_CONFIRM__ ? window.__CFD_CONFIRM__({ title: t.title, copy: t.copy, yes: 'OK', notice: true, ...turn }) : Promise.resolve(true),
        );
      },
      linkView: (view) => {
        landView.current = view;
      },
      // The host's question when the page links a new shape onto a geometry in use (LINK 5.0):
      // over the covered workspace; dropped unanswered when the page goes or the job ends.
      linkChoice: (question, signal) =>
        pageDialog((turn) => {
          const both = turn.signal ? AbortSignal.any([turn.signal, signal]) : signal;
          return showLinkChoice(question, { skipIf: () => turn.skipIf() || signal.aborted, signal: both });
        }),
      linkSavedAsNew: (info) => {
        if (leaveInProgress() || leaveApproved()) {
          heldReport.current = savedAsNewText(info.newName, info.oldName, info.copies);
          return;
        }
        if (linked.current) linked.current.reported = true;
        const t = savedAsNewText(info.newName, info.oldName, info.copies);
        void pageDialog((turn) =>
          window.__CFD_CONFIRM__ ? window.__CFD_CONFIRM__({ title: t.title, copy: t.copy, yes: 'OK', notice: true, ...turn }) : Promise.resolve(true),
        );
      },
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
            leave: (hash) => {
              toResults.current = true;
              return leaveWorkspaceTo(hash, 'results');
            },
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

  // Back to the project; with unsaved work the app asks first, and the page's exit hook runs.
  const back = () => void leaveWorkspaceTo(projectHash, 'back');
  const leaveShown = leaveUi.running && leaveUi.shown;

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
          <button type="button" className="home-btn ws-back" data-ws-back="1" onClick={back} disabled={leaveUi.running}>
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
        {leaveShown ? (
          <div className="ws-leave" data-ws-leave="1">
            <span className="ws-leave-status" role="status" data-ws-leave-status="1">
              {leaveUi.label}
            </span>
            {leaveUi.background ? (
              <button type="button" className="home-btn" data-ws-leave-background="1" onClick={() => continueLeaveInBackground()}>
                Continue in background
              </button>
            ) : null}
            {!leaveUi.choosing ? (
              // Once the link's job exists it goes on whatever happens here: this only keeps the workspace open.
              <button
                type="button"
                className="home-btn"
                data-ws-leave-cancel="1"
                title={leaveUi.started ? 'The update goes on; the workspace stays open' : undefined}
                onClick={() => cancelLeave()}
              >
                {leaveUi.started ? 'Stay here' : 'Cancel'}
              </button>
            ) : null}
          </div>
        ) : null}
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
        {/* While the exit hook runs, nothing is edited after its snapshot (the frame is inert too). */}
        {leaveShown ? <div className="ws-leave-cover" data-ws-leave-cover="1" aria-hidden="true" /> : null}
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
