import React from 'react';
import ReactDOM from 'react-dom/client';
import { pluginUiFor, registeredPluginKeys, unregisterPlugin } from '../plugin-api';

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
  /** "bundled" ships with the app; a required one cannot be turned off. */
  tier?: string;
  required?: boolean;
  /** False: an optional bundled plugin that ships off until someone turns it on. */
  default_enabled?: boolean;
};

export type PluginHost = {
  React: typeof React;
  ReactDOM: typeof ReactDOM;
  pluginUi: ReturnType<typeof pluginUiFor>;
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

/** The host object one plugin's register() receives; what it registers is recorded under its key. */
export function pluginHost(scope: string, pluginKey = ''): PluginHost {
  return { React, ReactDOM, pluginUi: pluginUiFor(pluginKey), scope };
}

function clearClientError(key: string): void {
  if (clientErrors.some((item) => item.key === key)) publish(clientErrors.filter((item) => item.key !== key));
}

/**
 * Load one UI entry. What the plugin registered before is removed first, so a
 * reload or a scope change never doubles its panels or tree rows. A disabled
 * plugin's UI is removed. A thrown register is recorded and rethrown.
 */
export async function loadOnePlugin(plugin: ListedPlugin, scope: string): Promise<void> {
  unregisterPlugin(plugin.key);
  if (plugin.enabled === false || (plugin.status && plugin.status !== 'enabled')) return;
  if (!plugin.ui && !plugin.url) return;
  const url = plugin.url || `/plugins/${plugin.key}/ui/${plugin.ui_entry || 'index.js'}`;
  (globalThis as { __MAGNUSIM_HOST_REACT__?: typeof React }).__MAGNUSIM_HOST_REACT__ = React;
  try {
    const mod = (await import(/* @vite-ignore */ url)) as {
      register?: (host: PluginHost) => void;
      default?: (host: PluginHost) => void;
    };
    const register = mod.register || mod.default;
    if (typeof register !== 'function') return;
    register(pluginHost(scope, plugin.key));
    clearClientError(plugin.key);
  } catch (error) {
    // Half a registration is worse than none: drop what it managed to add.
    unregisterPlugin(plugin.key);
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
  // A plugin that is no longer listed (removed, or its load now fails server-side) loses its UI.
  const listed = new Set(plugins.map((plugin) => plugin.key));
  for (const key of registeredPluginKeys()) {
    if (!listed.has(key)) unregisterPlugin(key);
  }
  for (const plugin of plugins) {
    try {
      await loadOnePlugin(plugin, scope);
    } catch {
      /* recorded; boot continues */
    }
  }
}
