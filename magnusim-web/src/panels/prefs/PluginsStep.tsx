import { useEffect, useState } from 'react';
import { workerRpc } from '../../api/workerRpc';
import { PanelBoundary } from '../../islands';
import { panelsFor } from '../../plugin-api';
import { loadPluginUi, pluginClientErrors, subscribePluginClients, type ListedPlugin } from '../../plugins/loader';
import { useProjectStore } from '../../store/project';

type PluginRow = ListedPlugin & { description?: string };

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
  return status;
}

/** Settings → Plugins step. Rows come from /api/plugins plus plugin UI load failures. */
export function PluginsStep() {
  const [rows, setRows] = useState<PluginRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [client, setClient] = useState<ListedPlugin[]>(pluginClientErrors());
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const [, setPanelTick] = useState(0);

  async function refresh() {
    try {
      const response = await fetch('/api/plugins', { cache: 'no-store' });
      const body = (await response.json()) as { plugins?: PluginRow[] };
      setRows(Array.isArray(body.plugins) ? body.plugins : []);
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

  useEffect(() => {
    const bump = () => setPanelTick((n) => n + 1);
    window.addEventListener('cfd:panels', bump);
    return () => window.removeEventListener('cfd:panels', bump);
  }, []);

  async function reloadRegistry() {
    await workerRpc('registry.reload', {});
    await useProjectStore.getState().loadRegistry(true);
  }

  async function reload() {
    setBusy('reload');
    setNote('');
    try {
      await reloadRegistry();
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
    setBusy(key);
    setNote('');
    try {
      const response = await fetch(`/api/plugins/${encodeURIComponent(key)}/${enabled ? 'enable' : 'disable'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw new Error(`server answered ${response.status}`);
      await reloadRegistry();
      await refresh();
    } catch (e) {
      setNote(`Could not ${enabled ? 'enable' : 'disable'} ${key}: ${e instanceof Error ? e.message : String(e)}`);
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
          return (
            <li
              key={row.key}
              className="wiz-pref-row wiz-plugin-row"
              data-plugin-key={row.key}
              data-plugin-status={status}
              data-plugin-source={row.source || ''}
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
                {row.error ? (
                  <span className="wiz-plugin-error" role="alert">
                    {row.error}
                  </span>
                ) : null}
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
                  {statusLabel(status)}
                </span>
                {row.client ? null : (
                  <button
                    type="button"
                    className="home-btn"
                    data-plugin-toggle={row.key}
                    disabled={!!busy}
                    onClick={() => void setEnabled(row.key, status !== 'enabled')}
                  >
                    {busy === row.key ? 'Saving…' : status === 'enabled' ? 'Disable' : 'Enable'}
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
