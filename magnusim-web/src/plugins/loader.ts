import React from 'react';
import ReactDOM from 'react-dom/client';
import { pluginUi } from '../plugin-api';

export type ListedPlugin = {
  key: string;
  name?: string;
  version?: string;
  ui?: string | null;
  ui_entry?: string;
  status?: string;
  enabled?: boolean;
  source?: string;
  error?: string;
  url?: string;
  client?: boolean;
};

export type PluginHost = {
  React: typeof React;
  ReactDOM: typeof ReactDOM;
  pluginUi: typeof pluginUi;
  scope: string;
};

const listeners = new Set<() => void>();
let clientErrors: ListedPlugin[] = [];

export function pluginClientErrors(): ListedPlugin[] {
  return clientErrors;
}

export function subscribePluginClients(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(rows: ListedPlugin[]): void {
  clientErrors = rows;
  for (const listener of listeners) listener();
}

function recordClientError(plugin: ListedPlugin, message: string): void {
  const row: ListedPlugin = {
    key: plugin.key,
    name: plugin.name || plugin.key,
    version: plugin.version || '0.0.0',
    source: plugin.source || 'local',
    status: 'error',
    enabled: false,
    error: message,
    client: true,
  };
  publish([...clientErrors.filter((item) => item.key !== plugin.key), row]);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('cfd:plugin-toast', { detail: `${row.name}: ${message}` }));
  }
}

export function pluginHost(scope: string): PluginHost {
  return { React, ReactDOM, pluginUi, scope };
}

/** Load one UI entry. A thrown register is recorded and rethrown. */
export async function loadOnePlugin(plugin: ListedPlugin, scope: string): Promise<void> {
  if (!plugin.ui && !plugin.url) return;
  if (plugin.enabled === false) return;
  if (plugin.status && plugin.status !== 'enabled') return;
  const url = plugin.url || `/plugins/${plugin.key}/ui/${plugin.ui_entry || 'index.js'}`;
  try {
    const mod = (await import(/* @vite-ignore */ url)) as {
      register?: (host: PluginHost) => void;
      default?: (host: PluginHost) => void;
    };
    const register = mod.register || mod.default;
    if (typeof register !== 'function') return;
    register(pluginHost(scope));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordClientError(plugin, message);
    throw error;
  }
}

/** Boot helper. A failed plugin UI becomes a toast and a Plugins-tab row. */
export async function loadPluginUi(scope: string): Promise<void> {
  let plugins: ListedPlugin[] = [];
  try {
    const response = await fetch('/api/plugins');
    const body = (await response.json()) as { plugins?: ListedPlugin[] };
    plugins = body.plugins || [];
  } catch {
    return;
  }
  for (const plugin of plugins) {
    try {
      await loadOnePlugin(plugin, scope);
    } catch {
      /* recorded; boot continues */
    }
  }
}
