import { useEffect, useState } from 'react';
import { workerRpc } from '../../api/workerRpc';
import { PanelBoundary } from '../../islands';
import { panelsFor } from '../../plugin-api';
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

type PluginRow = ListedPlugin & { description?: string; python_env?: PluginEnv | null; notes?: string[] };

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
          return (
            <li
              key={row.key}
              className="wiz-pref-row wiz-plugin-row"
              data-plugin-key={row.key}
              data-plugin-status={status}
              data-plugin-source={row.source || ''}
              data-plugin-required={row.required ? '1' : undefined}
              data-plugin-default-off={shipsOff ? '1' : undefined}
            >
              <span className="wiz-pref-copy">
                <strong>
                  {row.name || row.key}
                  <span className="wiz-plugin-meta">
                    {' '}
                    v{row.version || '0.0.0'} · {row.source || 'local'}
                  </span>
                </strong>
                {row.description ? <span>{row.description}</span> : null}
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
        {note ? (
          <span className="wiz-plugin-note" role="status">
            {note}
          </span>
        ) : null}
      </div>
    </div>
  );
}
