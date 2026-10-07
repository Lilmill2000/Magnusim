import { useEffect, useRef, useState } from 'react';
import { workerRpc } from '../../api/workerRpc';
import { PanelBoundary } from '../../islands';
import { panelsFor, registeredPluginKeys } from '../../plugin-api';
import { loadPluginUi, pluginClientErrors, subscribePluginClients, type ListedPlugin } from '../../plugins/loader';
import { useProjectStore } from '../../store/project';
import { confirmLeaveWorkspace, leaveInProgress, openWorkspaceRoute, withdrawLeaveApproval } from '../../workspace/leaveGuard';

/** A plugin's own environment ([python] in its manifest), as the server reports it. */
type PluginEnv = {
  state: 'ready' | 'needs_setup' | 'failed';
  error?: string;
  tail?: string[];
  service?: boolean;
  python_version?: string;
};

/** A dependency install running (or just finished) on the server. */
type EnvInstall = {
  state: 'installing' | 'ready' | 'failed';
  stage?: string;
  label?: string;
  error?: string;
  tail?: string[];
  log?: string[];
};

/** A copy of the plugin in the user's plugins folder that the app does not use. */
type UnusedCopy = { dir: string; version: string; reason: string };

type PluginRow = ListedPlugin & {
  description?: string;
  python_env?: PluginEnv | null;
  notes?: string[];
  /** Which copy is used: "app" (ships with Magnusim), "update" (a newer copy in the plugins folder) or "user". */
  copy?: 'app' | 'update' | 'user';
  /** The version that ships with Magnusim, for a bundled plugin. */
  bundled_version?: string;
  unused_copies?: UnusedCopy[];
};

/** What a plugin package (a zip) holds and what installing it does (plugins.package_inspect). */
type PackageInfo = {
  upload: string;
  file: string;
  key: string;
  name: string;
  version: string;
  description?: string;
  authors?: string[];
  license?: string;
  files?: number;
  unpacked_bytes?: number;
  bundled_version?: string;
  installed_version?: string;
  action: 'install' | 'update' | 'reinstall' | 'downgrade';
  work?: PluginWork;
};

/** What runs on a plugin now (its cases, a core solve of its analyses among them, and its jobs). */
type PluginWork = { running: string[]; queued: string[] };

/** The confirm card's line on what installing or removing stops; nothing when nothing runs. */
export function WorkLine({ work, doing }: { work?: PluginWork | null; doing: string }) {
  const running = work?.running || [];
  const queued = work?.queued || [];
  if (!running.length && !queued.length) return null;
  const parts: string[] = [];
  if (running.length) parts.push(`${running.length} running (${running.join(', ')}) stop${running.length === 1 ? 's' : ''}`);
  if (queued.length) parts.push(`${queued.length} queued (${queued.join(', ')}) ${queued.length === 1 ? 'is' : 'are'} taken off the queue`);
  return (
    <span className="wiz-plugin-warn" data-plugin-work="1">
      {doing} stops what runs on this plugin now: {parts.join('; ')}.
    </span>
  );
}

/** The one-line summary the confirm card gives of an install. */
export function packageSummary(info: PackageInfo): string {
  const what = `${info.name} ${info.version}`;
  if (info.action === 'reinstall') return `Reinstall ${what} (the same version is installed now).`;
  if (info.action === 'downgrade') return `Install ${what} in place of the newer ${info.installed_version} installed now.`;
  if (info.bundled_version) return `Update ${info.name} from ${info.installed_version || info.bundled_version} to ${info.version}.`;
  if (info.action === 'update') return `Update ${info.name} from ${info.installed_version} to ${info.version}.`;
  return `Install ${what}.`;
}

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const out = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(out.error || `server answered ${response.status}`));
  return out;
}

function scopeNow(): string {
  const projectId = useProjectStore.getState().projectId || '';
  return projectId ? `p:${projectId}` : '';
}

function statusOf(row: PluginRow): string {
  return row.status || (row.enabled ? 'enabled' : 'disabled');
}

function statusLabel(status: string): string {
  if (status === 'enabled') return 'On';
  if (status === 'disabled') return 'Off';
  if (status === 'error') return 'Failed to load';
  if (status === 'needs setup') return 'Needs setup';
  return status;
}

/** What the row says about the plugin's environment (nothing once it is ready). */
function EnvLine({ env, run }: { env: PluginEnv; run?: EnvInstall }) {
  if (run && run.state === 'installing') {
    const last = (run.log || []).slice(-1)[0];
    return (
      <span className="wiz-plugin-env" data-plugin-env="installing" role="status">
        Installing dependencies… {run.label || ''}
        {last ? <span className="wiz-plugin-env-log">{last}</span> : null}
      </span>
    );
  }
  const failed = run && run.state === 'failed' ? run : env.state === 'failed' ? env : null;
  if (failed) {
    const tail = (failed.tail || []).filter(Boolean);
    return (
      <span className="wiz-plugin-error" data-plugin-env="failed" role="alert">
        Setup failed: {failed.error || 'the install did not finish'}
        {tail.length ? (
          <details className="wiz-plugin-env-details">
            <summary>Details</summary>
            <pre>{tail.join('\n')}</pre>
          </details>
        ) : null}
      </span>
    );
  }
  if (env.state === 'needs_setup') {
    return (
      <span className="wiz-plugin-env" data-plugin-env="needs_setup">
        Needs setup: its dependencies are not installed yet.
      </span>
    );
  }
  return null;
}

/** Settings → Plugins step. Rows come from /api/plugins plus plugin UI load failures. */
export function PluginsStep() {
  const [rows, setRows] = useState<PluginRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [client, setClient] = useState<ListedPlugin[]>(pluginClientErrors());
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [installs, setInstalls] = useState<Record<string, EnvInstall>>({});
  const [, setPanelTick] = useState(0);
  // A checked package waiting for Install / Cancel, and a plugin whose user copies wait for Remove / Cancel.
  const [pending, setPending] = useState<PackageInfo | null>(null);
  const [removing, setRemoving] = useState<PluginRow | null>(null);
  const [removingWork, setRemovingWork] = useState<PluginWork | null>(null);
  // The page still runs the old version of these plugins' screens until it is reloaded.
  const [stale, setStale] = useState<string[]>([]);
  const zipInput = useRef<HTMLInputElement | null>(null);

  async function envOf(key: string): Promise<EnvInstall | null> {
    const response = await fetch(`/api/plugins/${encodeURIComponent(key)}/env`, { cache: 'no-store' });
    const body = (await response.json()) as { install?: EnvInstall | null };
    return body.install || null;
  }

  async function refresh() {
    try {
      const response = await fetch('/api/plugins', { cache: 'no-store' });
      const body = (await response.json()) as { plugins?: PluginRow[] };
      const list = Array.isArray(body.plugins) ? body.plugins : [];
      setRows(list);
      // An install started earlier (another tab, before a reload) is still shown.
      for (const row of list) {
        if (!row.python_env || row.python_env.state === 'ready') continue;
        const run = await envOf(row.key).catch(() => null);
        if (run && run.state === 'installing') setInstalls((m) => ({ ...m, [row.key]: run }));
      }
    } catch {
      setRows([]);
      setNote('Could not read the plugin list.');
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => subscribePluginClients(() => setClient(pluginClientErrors())), []);

  // While a dependency install runs, follow it; when it ends, the plugin's row,
  // registry and UI come back as they now are.
  useEffect(() => {
    const running = Object.keys(installs).filter((key) => installs[key]?.state === 'installing');
    if (!running.length) return undefined;
    const timer = setTimeout(async () => {
      const next: Record<string, EnvInstall> = { ...installs };
      let finished = false;
      for (const key of running) {
        const run = await envOf(key).catch(() => null);
        if (!run) continue;
        next[key] = run;
        if (run.state !== 'installing') finished = true;
      }
      setInstalls(next);
      if (finished) {
        try {
          await reloadRegistry();
          await loadPluginUi(scopeNow());
        } finally {
          await refresh();
        }
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [installs]);

  useEffect(() => {
    const bump = () => setPanelTick((n) => n + 1);
    window.addEventListener('cfd:panels', bump);
    return () => window.removeEventListener('cfd:panels', bump);
  }, []);

  // Only the Reload button stops running plugin cases (and drops queued ones); the reload
  // that turning a plugin on or off, or an install, runs stops nothing.
  async function reloadRegistry(opts: { stopCases?: boolean } = {}) {
    try {
      await workerRpc('registry.reload', opts.stopCases ? { stop_plugin_cases: true } : {});
      await useProjectStore.getState().loadRegistry(true);
    } finally {
      // The plugins changed: the tree's STUDIES, the Workspaces menu and an open workspace read again.
      window.dispatchEvent(new CustomEvent('cfd:tree-sync', { detail: { plugins: true } }));
    }
  }

  async function reload() {
    setBusy('reload');
    setNote('');
    try {
      await reloadRegistry({ stopCases: true });
      await loadPluginUi(scopeNow());
      await refresh();
      setNote('Plugins reloaded.');
    } catch (e) {
      setNote(`Reload failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
    }
  }

  async function setEnabled(key: string, enabled: boolean) {
    // Turning off the plugin whose workspace is open asks first when it has unsaved work; Cancel sends nothing.
    const closesWorkspace = !enabled && openWorkspaceRoute()?.plugin === key;
    // Its workspace is updating the project on the way out (API 1.6): that ends first.
    if (closesWorkspace && leaveInProgress()) {
      setNote('Wait until the workspace has finished updating the project, then turn it off.');
      return;
    }
    if (closesWorkspace && !(await confirmLeaveWorkspace('plugin-off'))) return;
    setBusy(key);
    setNote('');
    let done = false;
    try {
      const response = await fetch(`/api/plugins/${encodeURIComponent(key)}/${enabled ? 'enable' : 'disable'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error(`server answered ${response.status}`);
      done = true;
      await reloadRegistry();
      // Load (or remove) its UI now, not after a manual Reload.
      await loadPluginUi(scopeNow());
      await refresh();
    } catch (e) {
      // Still on: the workspace stays open, and its unsaved work is guarded again.
      if (closesWorkspace && !done) withdrawLeaveApproval();
      setNote(`Could not ${enabled ? 'enable' : 'disable'} ${key}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
    }
  }

  async function install(key: string) {
    setBusy(`install:${key}`);
    setNote('');
    try {
      const response = await fetch(`/api/plugins/${encodeURIComponent(key)}/env/install`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body = (await response.json().catch(() => ({}))) as { install?: EnvInstall; error?: string };
      if (!response.ok || !body.install) throw new Error(body.error || `server answered ${response.status}`);
      setInstalls((m) => ({ ...m, [key]: body.install as EnvInstall }));
    } catch (e) {
      setNote(`Could not install the dependencies of ${key}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
    }
  }

  /** A plugin's folder is about to move: refused while its workspace is open (it runs from there). */
  function workspaceOpenFor(key: string, name: string): boolean {
    if (openWorkspaceRoute()?.plugin !== key) return false;
    setNote(`Close the ${name} workspace first: it runs from the plugin's folder.`);
    return true;
  }

  /** After a package install or a removal: the app's registry, tree and plugin screens as they now are. */
  async function afterCopiesChanged(key: string) {
    // The page keeps a plugin's screens it has loaded (a browser keeps a module once
    // imported): a changed plugin with screens in this page needs the page reloaded.
    const hadScreens = registeredPluginKeys().includes(key);
    try {
      await useProjectStore.getState().loadRegistry(true);
    } finally {
      window.dispatchEvent(new CustomEvent('cfd:tree-sync', { detail: { plugins: true } }));
    }
    if (hadScreens) setStale((list) => (list.includes(key) ? list : [...list, key]));
    else await loadPluginUi(scopeNow());
    await refresh();
  }

  async function onZipChosen(file: File | null | undefined) {
    if (!file) return;
    setBusy('package');
    setNote('');
    setPending(null);
    setRemoving(null);
    try {
      const response = await fetch('/api/plugins/package/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      });
      const body = (await response.json().catch(() => ({}))) as {
        package?: Omit<PackageInfo, 'upload' | 'file' | 'work'>;
        upload?: string;
        work?: PluginWork;
        error?: string;
      };
      if (!response.ok || !body.package || !body.upload) throw new Error(body.error || `server answered ${response.status}`);
      setPending({ ...body.package, upload: body.upload, file: file.name, work: body.work });
    } catch (e) {
      setNote(`${file.name} cannot be installed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy('');
      if (zipInput.current) zipInput.current.value = '';
    }
  }

  async function confirmPackage() {
    const info = pending;
    if (!info || workspaceOpenFor(info.key, info.name)) return;
    setBusy('package');
    setNote('');
    try {
      await postJson('/api/plugins/package/install', { upload: info.upload, key: info.key });
      setPending(null);
      await afterCopiesChanged(info.key);
      setNote(`${info.name} ${info.version} is installed.`);
    } catch (e) {
      setPending(null);
      const why = e instanceof Error ? e.message : String(e);
      // The app's own answer when the new copy did not load already names it and says what is kept.
      setNote(why.startsWith(`${info.name} ${info.version} `) ? why : `${info.name} ${info.version} was not installed: ${why}`);
      await refresh();
    } finally {
      setBusy('');
    }
  }

  async function confirmRemove() {
    const row = removing;
    if (!row || workspaceOpenFor(row.key, row.name || row.key)) return;
    setBusy(`remove:${row.key}`);
    setNote('');
    try {
      const out = (await postJson(`/api/plugins/${encodeURIComponent(row.key)}/remove`, {})) as { removed?: { bundled_version?: string } };
      setRemoving(null);
      await afterCopiesChanged(row.key);
      const back = out.removed?.bundled_version;
      setNote(back ? `Removed. ${row.name || row.key} is back to the version that ships with Magnusim (${back}).` : `${row.name || row.key} was removed.`);
    } catch (e) {
      setRemoving(null);
      setNote(`Could not remove ${row.name || row.key}: ${e instanceof Error ? e.message : String(e)}`);
      await refresh();
    } finally {
      setBusy('');
    }
  }

  const merged: PluginRow[] = rows.map((row) => {
    const extra = client.find((item) => item.key === row.key);
    return extra ? { ...row, ...extra, status: 'error' } : row;
  });
  for (const extra of client) {
    if (!merged.some((row) => row.key === extra.key)) merged.push(extra);
  }
  const panels = panelsFor('prefs');
  // Panels with no plugin row of their own; wait for the list so a disabled plugin's panel never flashes.
  const loose = loaded ? panels.filter((panel) => !merged.some((row) => row.key === panel.key)) : [];

  return (
    <div className="wiz-plugins">
      {loaded && merged.length === 0 ? <p className="wiz-copy">No plugins are installed.</p> : null}
      <ul className="wiz-plugin-list" data-plugin-list>
        {merged.map((row) => {
          const status = statusOf(row);
          const panel = status === 'enabled' ? panels.find((item) => item.key === row.key) : undefined;
          const env = row.python_env || null;
          const run = installs[row.key];
          const installing = !!run && run.state === 'installing';
          const needsInstall = !!env && (env.state !== 'ready' || (run && run.state === 'failed'));
          const shipsOff = row.tier === 'bundled' && row.default_enabled === false;
          const unused = row.unused_copies || [];
          // A copy in the plugins folder the person can take away: an update, a user
          // plugin, or copies that are not used.
          const removeLabel =
            row.client ? '' : row.copy === 'update' ? 'Remove update' : row.copy === 'user' ? 'Remove' : unused.length ? 'Remove unused copies' : '';
          return (
            <li
              key={row.key}
              className="wiz-pref-row wiz-plugin-row"
              data-plugin-key={row.key}
              data-plugin-status={status}
              data-plugin-source={row.source || ''}
              data-plugin-required={row.required ? '1' : undefined}
              data-plugin-default-off={shipsOff ? '1' : undefined}
              data-plugin-copy={row.copy || undefined}
            >
              <span className="wiz-pref-copy">
                <strong>
                  {row.name || row.key}
                  <span className="wiz-plugin-meta">
                    {' '}
                    v{row.version || '0.0.0'} · {row.copy === 'update' ? 'update' : row.source || 'local'}
                  </span>
                </strong>
                {row.description ? <span>{row.description}</span> : null}
                {row.copy === 'update' ? (
                  <span className="wiz-plugin-meta" data-plugin-update-note="1">
                    An update from the plugins folder, used in place of the version that ships with Magnusim ({row.bundled_version}).
                  </span>
                ) : null}
                {unused.map((u) => (
                  <span key={u.dir} className="wiz-plugin-meta" data-plugin-unused={u.dir}>
                    plugins/{u.dir} (v{u.version}): {u.reason}
                  </span>
                ))}
                {stale.includes(row.key) ? (
                  <span className="wiz-plugin-env" data-plugin-stale="1" role="status">
                    This page still shows its previous version: reload the page to use the one installed now.
                  </span>
                ) : null}
                {shipsOff && status === 'disabled' ? (
                  <span className="wiz-plugin-meta" data-plugin-optional-hint="1">
                    Ships with Magnusim and stays off until you turn it on.
                  </span>
                ) : null}
                {row.error ? (
                  <span className="wiz-plugin-error" role="alert">
                    {row.error}
                  </span>
                ) : null}
                {env ? <EnvLine env={env} run={run} /> : null}
                {row.notes && row.notes.length ? <span className="wiz-plugin-meta">{row.notes.join(' · ')}</span> : null}
                {panel ? (
                  <span className="wiz-plugin-panel" data-plugin-panel-host={panel.key}>
                    <PanelBoundary>
                      <panel.Component />
                    </PanelBoundary>
                  </span>
                ) : null}
              </span>
              <span className="wiz-plugin-side">
                <span className="wiz-plugin-status" data-state={status}>
                  {row.required && status === 'enabled' ? 'Required' : statusLabel(status)}
                </span>
                {needsInstall || installing ? (
                  <button
                    type="button"
                    className="home-btn"
                    data-plugin-install={row.key}
                    disabled={!!busy || installing}
                    title="Build this plugin's own Python environment from its pinned requirements"
                    onClick={() => void install(row.key)}
                  >
                    {installing || busy === `install:${row.key}` ? 'Installing…' : 'Install dependencies'}
                  </button>
                ) : null}
                {row.client || row.required ? null : (
                  <button
                    type="button"
                    className="home-btn"
                    data-plugin-toggle={row.key}
                    disabled={!!busy || installing}
                    onClick={() => void setEnabled(row.key, status === 'disabled')}
                  >
                    {busy === row.key ? 'Saving…' : status === 'disabled' ? 'Enable' : 'Disable'}
                  </button>
                )}
                {removeLabel ? (
                  <button
                    type="button"
                    className="home-btn"
                    data-plugin-remove={row.key}
                    disabled={!!busy || installing}
                    title="Delete this plugin's copies from the plugins folder"
                    onClick={() => {
                      setPending(null);
                      setRemovingWork(null);
                      setRemoving(row);
                      void fetch(`/api/plugins/${encodeURIComponent(row.key)}/work`, { cache: 'no-store' })
                        .then((r) => r.json())
                        .then((b: { work?: PluginWork }) => setRemovingWork(b.work || null))
                        .catch(() => setRemovingWork(null));
                    }}
                  >
                    {busy === `remove:${row.key}` ? 'Removing…' : removeLabel}
                  </button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      {loose.length ? (
        <div data-plugin-panels>
          {loose.map((panel) => (
            <PanelBoundary key={panel.key}>
              <panel.Component />
            </PanelBoundary>
          ))}
        </div>
      ) : null}
      {pending ? (
        <div className="wiz-plugin-confirm" data-plugin-package={pending.key} role="dialog" aria-label={`Install ${pending.name}`}>
          <strong>{packageSummary(pending)}</strong>
          <span className="wiz-plugin-meta">
            {pending.file} · {pending.key}
            {pending.authors && pending.authors.length ? ` · by ${pending.authors.join(', ')}` : ''}
            {pending.license ? ` · ${pending.license}` : ''}
          </span>
          {pending.description ? <span>{pending.description}</span> : null}
          <span className="wiz-plugin-warn">
            A plugin runs its own code on this PC. Install it only if you trust where it came from.
          </span>
          <WorkLine work={pending.work} doing="Installing it" />
          <span className="wiz-plugin-confirm-actions">
            <button type="button" className="home-btn" data-plugin-package-cancel disabled={busy === 'package'} onClick={() => setPending(null)}>
              Cancel
            </button>
            <button type="button" className="home-btn home-btn-primary" data-plugin-package-confirm disabled={!!busy} onClick={() => void confirmPackage()}>
              {busy === 'package' ? 'Installing…' : 'Install'}
            </button>
          </span>
        </div>
      ) : null}
      {removing ? (
        <div className="wiz-plugin-confirm" data-plugin-remove-confirm={removing.key} role="dialog" aria-label={`Remove ${removing.name || removing.key}`}>
          <strong>
            {removing.copy === 'user'
              ? `Remove ${removing.name || removing.key}?`
              : removing.copy === 'update'
                ? `Remove the ${removing.name || removing.key} ${removing.version} update?`
                : `Remove the unused copies of ${removing.name || removing.key}?`}
          </strong>
          <span>
            {removing.copy === 'user'
              ? 'Its folder is deleted from the plugins folder. Its studies and files in your projects stay, but they do not open until it is installed again.'
              : `Its folder is deleted from the plugins folder${
                  removing.copy === 'update' ? ` and Magnusim goes back to the version it ships with (${removing.bundled_version})` : ''
                }.`}
          </span>
          <WorkLine work={removingWork} doing="Removing it" />
          <span className="wiz-plugin-confirm-actions">
            <button type="button" className="home-btn" data-plugin-remove-cancel disabled={!!busy} onClick={() => setRemoving(null)}>
              Cancel
            </button>
            <button type="button" className="home-btn home-btn-danger" data-plugin-remove-ok disabled={!!busy} onClick={() => void confirmRemove()}>
              {busy === `remove:${removing.key}` ? 'Removing…' : 'Remove'}
            </button>
          </span>
        </div>
      ) : null}
      <div className="wiz-plugin-actions">
        <button
          type="button"
          className="home-btn"
          data-plugins-reload
          disabled={!!busy}
          title="Re-read the plugins folder and load plugin panels again"
          onClick={() => void reload()}
        >
          {busy === 'reload' ? 'Reloading…' : 'Reload plugins'}
        </button>
        <button
          type="button"
          className="home-btn"
          data-plugin-install-zip
          disabled={!!busy}
          title="Install a plugin, or a newer version of one, from a .zip made with npm run plugin:pack"
          onClick={() => zipInput.current?.click()}
        >
          {busy === 'package' && !pending ? 'Checking…' : 'Install plugin from zip…'}
        </button>
        <input
          ref={zipInput}
          type="file"
          accept=".zip,application/zip"
          hidden
          data-plugin-zip-input
          onChange={(e) => void onZipChosen(e.target.files?.[0])}
        />
        {stale.length ? (
          <button type="button" className="home-btn" data-plugin-page-reload onClick={() => window.location.reload()}>
            Reload page
          </button>
        ) : null}
        {note ? (
          <span className="wiz-plugin-note" role="status">
            {note}
          </span>
        ) : null}
      </div>
    </div>
  );
}
