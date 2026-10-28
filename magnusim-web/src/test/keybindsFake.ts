/**
 * A fake app server for the keybinds tests: /api/plugins rows with workspace commands files, the
 * files themselves under /plugins/<key>/, the plugin prefs (/api/plugin-prefs/get|set|remove) and
 * the app's keys (GET and POST /api/prefs `keybinds`) in memory. `calls` records every prefs write,
 * in order (the app's as ['app', '', value]).
 */
import { vi } from 'vitest';

/** A commands file with two contexts, a command everywhere and one with two default keys. */
export const DEMO_COMMANDS = {
  version: 1,
  contexts: [
    { id: 'sketch', label: 'Sketch' },
    { id: 'model', label: 'Model' },
  ],
  commands: [
    { id: 'sketch.rectangle', label: 'Rectangle', group: 'Draw', context: 'sketch', keys: ['KeyR'] },
    { id: 'sketch.line', label: 'Line', group: 'Draw', context: 'sketch', keys: ['KeyL'] },
    { id: 'model.extrude', label: 'Extrude', group: 'Features', context: 'model', keys: ['KeyE'] },
    { id: 'view.fit', label: 'Fit', group: 'View', context: 'any', keys: ['KeyF'] },
    { id: 'edit.delete', label: 'Delete', group: 'Edit', context: 'any', keys: ['Delete', 'Backspace'] },
  ],
};

export interface FakeKeysServer {
  /** The plugin prefs, by plugin then key. */
  prefs: Record<string, Record<string, unknown>>;
  /** Every prefs write: [action, plugin, value]. */
  calls: [string, string, unknown][];
  /** Make the next prefs reads fail (the person's keys unreadable) while true. */
  failReads: boolean;
  /** The app's keys the person chose (/api/prefs `keybinds`). */
  app: Record<string, string[]>;
  /** Make the app prefs reads fail while true. */
  failAppReads: boolean;
  fetch: ReturnType<typeof vi.fn>;
}

export function fakeKeysServer(opts: {
  rows?: Record<string, unknown>[];
  files?: Record<string, unknown>;
  prefs?: Record<string, Record<string, unknown>>;
  app?: Record<string, string[]>;
} = {}): FakeKeysServer {
  const rows = opts.rows ?? [
    {
      key: 'demo',
      name: 'Demo',
      status: 'enabled',
      workspaces: [{ key: 'part', title: 'Part', entry: 'workspace/index.html', commands: 'workspace/commands.json', commands_error: '' }],
    },
  ];
  const files: Record<string, unknown> = opts.files ?? { '/plugins/demo/workspace/commands.json': DEMO_COMMANDS };
  const server: FakeKeysServer = { prefs: opts.prefs ?? {}, calls: [], failReads: false, app: opts.app ?? {}, failAppReads: false, fetch: vi.fn() };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  server.fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/plugins') return json(200, { ok: true, plugins: rows });
    if (url === '/api/prefs') {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}')) as { keybinds?: Record<string, string[]> | null };
        if (body.keybinds !== undefined) {
          server.app = JSON.parse(JSON.stringify(body.keybinds ?? {}));
          server.calls.push(['app', '', server.app]);
        }
        return json(200, { ok: true, prefs: { ok: true, keybinds: server.app } });
      }
      if (server.failAppReads) return json(503, { ok: false, error: 'the settings are not available right now' });
      return json(200, { ok: true, units: 'Metric', keybinds: server.app });
    }
    const pref = /^\/api\/plugin-prefs\/(get|set|remove)$/.exec(url);
    if (pref) {
      const body = JSON.parse(String(init?.body || '{}')) as { plugin: string; key: string; value?: unknown };
      if (pref[1] === 'get') {
        if (server.failReads) return json(503, { ok: false, code: 'unavailable', error: 'the plugin list is not available right now' });
        return json(200, { ok: true, value: server.prefs[body.plugin]?.[body.key] ?? null });
      }
      const mine = (server.prefs[body.plugin] ??= {});
      if (pref[1] === 'set') mine[body.key] = JSON.parse(JSON.stringify(body.value));
      else delete mine[body.key];
      server.calls.push([pref[1], body.plugin, pref[1] === 'set' ? mine[body.key] : null]);
      return json(200, { ok: true });
    }
    if (url in files) {
      const doc = files[url];
      return typeof doc === 'string' ? new Response(doc, { status: 200 }) : json(200, doc);
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', server.fetch);
  return server;
}
