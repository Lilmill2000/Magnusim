/**
 * The app's other tabs, and the open workspaces of this one, hear a plugin's pref changes here
 * (same origin, same browser): the bridge announces what its page set, Settings → Keybinds what
 * the person set there, and each open workspace bridge passes it on as a `prefs` event to its
 * page when the plugin is its own and the change came from elsewhere.
 */
export const PREFS_CHANNEL = 'magnusim-plugin-prefs';

/** A pref change as the channel carries it. `from`: who made it (a bridge's id, or 'settings'). */
export interface PrefChange {
  plugin: string;
  key: string;
  value: unknown;
  from: string;
}

/** A pref this tab changed: every other listener (this tab's other bridges included) hears it. */
export function announcePref(plugin: string, key: string, value: unknown, from: string): void {
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const ch = new BroadcastChannel(PREFS_CHANNEL);
    ch.postMessage({ plugin, key, value, from } satisfies PrefChange);
    ch.close();
  } catch {
    /* no other tab hears it; each still reads the file */
  }
}

/** Calls `fn` with each pref change announced elsewhere; returns the stop. */
export function onPrefChange(fn: (change: PrefChange) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const ch = new BroadcastChannel(PREFS_CHANNEL);
  ch.onmessage = (e: MessageEvent) => {
    const m = (e.data || {}) as Partial<PrefChange>;
    if (typeof m.plugin !== 'string' || typeof m.key !== 'string' || typeof m.from !== 'string') return;
    fn({ plugin: m.plugin, key: m.key, value: m.value ?? null, from: m.from });
  };
  return () => ch.close();
}
