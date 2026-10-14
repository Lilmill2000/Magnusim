// A plugin UI entry with a FILTERS section and a Settings → Plugins panel, each a component
// defined once at module scope (the usual React style), for loader.reload.test.tsx. It counts
// how often each one mounts and unmounts; each holds a draft the person typed (an
// uncontrolled input, lost when its component is mounted again).
import { createElement, useEffect } from 'react';
import type { PluginHost } from '../plugins/loader';

export const KEY = 'reload-probe';
export const counts = { filtersMounts: 0, filtersUnmounts: 0, prefsMounts: 0, prefsUnmounts: 0 };

function ProbeFilters() {
  useEffect(() => {
    counts.filtersMounts += 1;
    return () => {
      counts.filtersUnmounts += 1;
    };
  }, []);
  return createElement('input', { 'aria-label': 'Probe filter draft', defaultValue: '' });
}

function ProbePrefs() {
  useEffect(() => {
    counts.prefsMounts += 1;
    return () => {
      counts.prefsUnmounts += 1;
    };
  }, []);
  return createElement('input', { 'aria-label': 'Probe settings draft', defaultValue: '' });
}

export function register(host: PluginHost): void {
  host.pluginUi.registerPanel({ key: `${KEY}-filters`, title: 'Probe filters', place: 'filters', Component: ProbeFilters });
  host.pluginUi.registerPanel({ key: KEY, title: 'Probe settings', place: 'prefs', Component: ProbePrefs });
}
