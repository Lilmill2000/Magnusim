/** The host API this plugin's UI registered with (set once by register()). */
import type { PluginHost } from '../../../src/plugins/loader';

let current: PluginHost | null = null;

export function setHost(host: PluginHost): void {
  current = host;
}

export function host(): PluginHost {
  if (!current) throw new Error('Heat Transfer UI used before register()');
  return current;
}
