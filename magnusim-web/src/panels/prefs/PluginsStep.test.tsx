import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPanel } from '../../plugin-api';
import {
  confirmLeaveWorkspace,
  installWorkspaceLeaveGuard,
  registerOpenWorkspace,
  setWorkspaceDirty,
  workspaceDirty,
} from '../../workspace/leaveGuard';
import { PluginsStep } from './PluginsStep';

const workerRpc = vi.fn(async () => ({}));
vi.mock('../../api/workerRpc', () => ({ workerRpc: (method: string) => workerRpc(method) }));

let plugins: Array<Record<string, unknown>> = [];

function row(key: string, enabled: boolean) {
  return {
    key,
    name: key,
    version: '0.1.0',
    description: `${key} does a thing`,
    source: 'local',
    status: enabled ? 'enabled' : 'disabled',
    enabled,
  };
}

beforeEach(() => {
  workerRpc.mockClear();
  plugins = [row('example-laminar', true), row('example-hook-monitor', true)];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const toggle = url.match(/\/api\/plugins\/([^/]+)\/(enable|disable)$/);
      if (toggle && init?.method === 'POST') {
        plugins = plugins.map((p) => (p.key === toggle[1] ? { ...p, ...row(toggle[1], toggle[2] === 'enable') } : p));
        return new Response('{"ok":true}', { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, plugins }), { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PluginsStep', () => {
  it('lists plugins with version, source, description and on/off state', async () => {
    render(<PluginsStep />);
    const laminar = await screen.findByText('example-laminar does a thing');
    const li = laminar.closest('li') as HTMLElement;
    expect(li).toHaveAttribute('data-plugin-status', 'enabled');
    expect(within(li).getByText(/v0\.1\.0 · local/)).toBeInTheDocument();
    expect(within(li).getByText('On')).toBeInTheDocument();
    expect(within(li).getByRole('button', { name: 'Disable' })).toBeInTheDocument();
  });

  it('an optional bundled plugin that ships off says so and can be turned on', async () => {
    plugins = [
      { ...row('opt-demo', false), tier: 'bundled', source: 'bundled', required: false, default_enabled: false },
      { ...row('incompressible_flow', true), tier: 'bundled', source: 'bundled', required: true, default_enabled: true },
    ];
    render(<PluginsStep />);
    const li = await waitFor(() => {
      const el = document.querySelector('[data-plugin-key="opt-demo"]') as HTMLElement | null;
      if (!el) throw new Error('no row yet');
      return el;
    });
    expect(li).toHaveAttribute('data-plugin-default-off', '1');
    expect(li).toHaveAttribute('data-plugin-status', 'disabled');
    expect(within(li).getByText('Ships with Magnusim and stays off until you turn it on.')).toBeInTheDocument();
    expect(within(li).getByText('Off')).toBeInTheDocument();
    const required = document.querySelector('[data-plugin-key="incompressible_flow"]') as HTMLElement;
    expect(required).not.toHaveAttribute('data-plugin-default-off');
    expect(within(required).getByText('Required')).toBeInTheDocument();
    fireEvent.click(within(li).getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(document.querySelector('[data-plugin-key="opt-demo"]')).toHaveAttribute('data-plugin-status', 'enabled'));
    // Once on, the hint goes.
    expect(screen.queryByText('Ships with Magnusim and stays off until you turn it on.')).toBeNull();
  });

  it('disables a plugin, reloads the registry and shows the new state', async () => {
    let syncs = 0;
    const onSync = () => void (syncs += 1);
    window.addEventListener('cfd:tree-sync', onSync);
    render(<PluginsStep />);
    await screen.findByText('example-laminar does a thing');
    fireEvent.click(screen.getAllByRole('button', { name: 'Disable' })[0]);
    await waitFor(() =>
      expect(document.querySelector('[data-plugin-key="example-laminar"]')).toHaveAttribute('data-plugin-status', 'disabled'),
    );
    expect(workerRpc).toHaveBeenCalledWith('registry.reload');
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
    // The tree (its STUDIES) and the Workspaces menu read the plugins' state again.
    expect(syncs).toBeGreaterThan(0);
    window.removeEventListener('cfd:tree-sync', onSync);
  });

  it('shows a plugin panel inside its own row, only while the plugin is on', async () => {
    registerPanel({
      key: 'example-hook-monitor',
      title: 'Test panel',
      place: 'prefs',
      Component: () => <button type="button" data-plugin-hook="1">What does this hook do?</button>,
    });
    render(<PluginsStep />);
    const hook = await screen.findByRole('button', { name: 'What does this hook do?' });
    expect(hook.closest('li')).toHaveAttribute('data-plugin-key', 'example-hook-monitor');
    const li = hook.closest('li') as HTMLElement;
    fireEvent.click(within(li).getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'What does this hook do?' })).toBeNull());
  });

  it('sets up a plugin with its own environment: needs setup, installing, ready', async () => {
    let installed = false;
    let polls = 0;
    const envRow = () => ({
      ...row('env-demo', true),
      status: installed ? 'enabled' : 'needs setup',
      enabled: installed,
      python_env: { state: installed ? 'ready' : 'needs_setup', service: true },
    });
    plugins = [envRow()];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/plugins/env-demo/env/install') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true, install: { state: 'installing', label: 'Creating the environment' } }), { status: 202 });
      }
      if (url.endsWith('/api/plugins/env-demo/env')) {
        polls += 1;
        installed = polls >= 1;
        plugins = [envRow()];
        return new Response(JSON.stringify({ ok: true, install: { state: 'ready', label: 'Ready' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, plugins }), { status: 200 });
    });
    render(<PluginsStep />);
    const li = (await screen.findByText('env-demo does a thing')).closest('li') as HTMLElement;
    expect(li).toHaveAttribute('data-plugin-status', 'needs setup');
    expect(within(li).getByText('Needs setup')).toBeInTheDocument();
    expect(within(li).getByText('Needs setup: its dependencies are not installed yet.')).toBeInTheDocument();
    // It is on (not disabled): its toggle turns it off.
    expect(within(li).getByRole('button', { name: 'Disable' })).toBeInTheDocument();
    fireEvent.click(within(li).getByRole('button', { name: 'Install dependencies' }));
    expect(await within(li).findByText(/Installing dependencies… Creating the environment/)).toBeInTheDocument();
    expect(within(li).getByRole('button', { name: 'Installing…' })).toBeDisabled();
    await waitFor(() => expect(li).toHaveAttribute('data-plugin-status', 'enabled'), { timeout: 4000 });
    expect(within(li).getByText('On')).toBeInTheDocument();
    expect(within(li).queryByRole('button', { name: 'Install dependencies' })).toBeNull();
    expect(workerRpc).toHaveBeenCalledWith('registry.reload');
  });

  it("shows why a setup failed, with pip's last lines", async () => {
    plugins = [
      {
        ...row('env-demo', true),
        status: 'needs setup',
        enabled: false,
        python_env: { state: 'failed', error: 'Installing dependencies failed', tail: ['ERROR: THESE PACKAGES DO NOT MATCH THE HASHES'] },
      },
    ];
    render(<PluginsStep />);
    const li = (await screen.findByText('env-demo does a thing')).closest('li') as HTMLElement;
    expect(within(li).getByRole('alert')).toHaveTextContent('Setup failed: Installing dependencies failed');
    expect(within(li).getByText('ERROR: THESE PACKAGES DO NOT MATCH THE HASHES')).toBeInTheDocument();
    expect(within(li).getByRole('button', { name: 'Install dependencies' })).toBeEnabled();
  });

  it('says so when a toggle fails instead of failing silently', async () => {
    render(<PluginsStep />);
    await screen.findByText('example-laminar does a thing');
    vi.mocked(fetch).mockImplementationOnce(async () => new Response('{}', { status: 500 }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Disable' })[0]);
    expect(await screen.findByRole('status')).toHaveTextContent('Could not disable example-laminar: server answered 500');
  });

  it('Reload tells an open workspace that the plugins changed', async () => {
    const seen: unknown[] = [];
    const onSync = (e: Event) => void seen.push((e as CustomEvent).detail);
    window.addEventListener('cfd:tree-sync', onSync);
    render(<PluginsStep />);
    await screen.findByText('example-laminar does a thing');
    fireEvent.click(screen.getByRole('button', { name: 'Reload plugins' }));
    await screen.findByText('Plugins reloaded.');
    expect(seen).toContainEqual({ plugins: true });
    window.removeEventListener('cfd:tree-sync', onSync);
  });
});

describe('turning off a plugin whose workspace is open', () => {
  const OFF = {
    title: 'Turn off Workspace demo?',
    copy: 'Its workspace is open with changes that are not saved (Chord not saved). Turning it off closes the workspace and discards them.',
    yes: 'Turn off',
    // Enter answers Cancel: only a click turns it off.
    no: 'Cancel',
    safe: true,
  };
  let unregister: () => void = () => undefined;
  let answer = false;
  let confirm: ReturnType<typeof vi.fn>;
  // What happened, in order: the toggle's requests and the syncs it sent.
  let log: string[] = [];
  const onSync = (e: Event) => void log.push(`sync ${JSON.stringify((e as CustomEvent).detail ?? null)}`);

  beforeEach(() => {
    installWorkspaceLeaveGuard();
    plugins = [{ ...row('ws-demo', true), name: 'Workspace demo' }, row('example-laminar', true)];
    unregister = registerOpenWorkspace({
      route: { projectId: 'proj', plugin: 'ws-demo', workspace: 'bench', studyId: 'st-1' },
      pluginName: () => 'Workspace demo',
      studyTitle: () => 'Wing section',
      frame: () => null,
    });
    answer = false;
    confirm = vi.fn(async () => answer);
    window.__CFD_CONFIRM__ = confirm as unknown as typeof window.__CFD_CONFIRM__;
    log = [];
    const inner = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') log.push(`POST ${String(input)}`);
      return (inner as NonNullable<typeof inner>)(input, init);
    });
    window.addEventListener('cfd:tree-sync', onSync);
  });

  afterEach(() => {
    unregister();
    delete window.__CFD_CONFIRM__;
    window.removeEventListener('cfd:tree-sync', onSync);
  });

  const toggleOf = (key: string) =>
    within(document.querySelector(`[data-plugin-key="${key}"]`) as HTMLElement).getByRole('button', { name: /Disable|Enable/ });

  /** Closing the tab now: whether the browser would ask first (a beforeunload listener cancelled it). */
  function unloadAsks(): boolean {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  }

  it('asks first when it has unsaved work; Cancel sends nothing and keeps it on', async () => {
    setWorkspaceDirty(true, 'Chord not saved');
    render(<PluginsStep />);
    await screen.findByText('ws-demo does a thing');
    fireEvent.click(toggleOf('ws-demo'));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith({ ...OFF, signal: expect.any(AbortSignal) }));
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toEqual([]);
    expect(document.querySelector('[data-plugin-key="ws-demo"]')).toHaveAttribute('data-plugin-status', 'enabled');
    expect(toggleOf('ws-demo')).toHaveTextContent('Disable');
  });

  it('Turn off sends the request, then tells the workspace the plugins changed', async () => {
    setWorkspaceDirty(true, 'Chord not saved');
    answer = true;
    render(<PluginsStep />);
    await screen.findByText('ws-demo does a thing');
    fireEvent.click(toggleOf('ws-demo'));
    await waitFor(() =>
      expect(document.querySelector('[data-plugin-key="ws-demo"]')).toHaveAttribute('data-plugin-status', 'disabled'),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['POST /api/plugins/ws-demo/disable', 'sync {"plugins":true}']);
  });

  it('a Turn off the app refused guards the unsaved work again: every way out asks, closing the tab too', async () => {
    setWorkspaceDirty(true, 'Chord not saved');
    answer = true;
    render(<PluginsStep />);
    await screen.findByText('ws-demo does a thing');
    const inner = vi.mocked(fetch).getMockImplementation();
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST' && String(input).endsWith('/ws-demo/disable')
        ? new Response('{}', { status: 500 })
        : (inner as NonNullable<typeof inner>)(input, init),
    );
    fireEvent.click(toggleOf('ws-demo'));
    expect(await screen.findByRole('status')).toHaveTextContent('Could not disable ws-demo: server answered 500');
    expect(document.querySelector('[data-plugin-key="ws-demo"]')).toHaveAttribute('data-plugin-status', 'enabled');
    expect(workspaceDirty()).toBe(true);
    expect(unloadAsks()).toBe(true);
    // The next way out asks again.
    answer = false;
    expect(await confirmLeaveWorkspace('back')).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('a Turn off the app made keeps the user\'s choice even when reading the plugins again fails', async () => {
    setWorkspaceDirty(true, 'Chord not saved');
    answer = true;
    workerRpc.mockImplementationOnce(async () => {
      throw new Error('worker busy');
    });
    render(<PluginsStep />);
    await screen.findByText('ws-demo does a thing');
    fireEvent.click(toggleOf('ws-demo'));
    expect(await screen.findByRole('status')).toHaveTextContent('Could not disable ws-demo: worker busy');
    expect(log).toEqual(['POST /api/plugins/ws-demo/disable', 'sync {"plugins":true}']);
    // It is off: the workspace closes into its card, and nothing the user chose to discard asks again.
    expect(workspaceDirty()).toBe(false);
    expect(unloadAsks()).toBe(false);
  });

  it('never asks for another plugin, or when the workspace has nothing unsaved', async () => {
    setWorkspaceDirty(true, 'Chord not saved');
    render(<PluginsStep />);
    await screen.findByText('ws-demo does a thing');
    fireEvent.click(toggleOf('example-laminar'));
    await waitFor(() =>
      expect(document.querySelector('[data-plugin-key="example-laminar"]')).toHaveAttribute('data-plugin-status', 'disabled'),
    );
    await waitFor(() => expect(toggleOf('ws-demo')).toBeEnabled());
    setWorkspaceDirty(false);
    fireEvent.click(toggleOf('ws-demo'));
    await waitFor(() =>
      expect(document.querySelector('[data-plugin-key="ws-demo"]')).toHaveAttribute('data-plugin-status', 'disabled'),
    );
    expect(confirm).not.toHaveBeenCalled();
  });
});
