import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPanel } from '../../plugin-api';
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
        plugins = plugins.map((p) => (p.key === toggle[1] ? row(toggle[1], toggle[2] === 'enable') : p));
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

  it('disables a plugin, reloads the registry and shows the new state', async () => {
    render(<PluginsStep />);
    await screen.findByText('example-laminar does a thing');
    fireEvent.click(screen.getAllByRole('button', { name: 'Disable' })[0]);
    await waitFor(() =>
      expect(document.querySelector('[data-plugin-key="example-laminar"]')).toHaveAttribute('data-plugin-status', 'disabled'),
    );
    expect(workerRpc).toHaveBeenCalledWith('registry.reload');
    expect(screen.getByRole('button', { name: 'Enable' })).toBeInTheDocument();
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
});
