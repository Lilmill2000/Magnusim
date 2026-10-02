import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginStudyKind } from '../chrome/treeModel';
import {
  entriesFromCatalog,
  entriesFromKinds,
  headerKinds,
  headerLabel,
  homeLabel,
  loadStartActions,
  resetStartActionsForTests,
  shownStartActions,
  startActionsNow,
  startKey,
  startStudy,
  subscribeStartActions,
  type StartAction,
} from './startActions';

// gate:l1-menus: the places' caps and order, the overflow rule, the Home store, and a
// start action's study (no prompt, a name free across every plugin).

function action(kind: string, places: string[], extra: Partial<StartAction> = {}): StartAction {
  return {
    study_kind: kind,
    kind_title: kind[0].toUpperCase() + kind.slice(1),
    workspace: kind,
    workspace_title: `${kind} bench`,
    label: `Start ${kind}`,
    home_label: '',
    header_label: '',
    hint: '',
    icon: '',
    places,
    ...extra,
  };
}

const ALL = ['empty_project', 'header', 'new_project', 'home'];

// Five actions over three plugins, in plugin load order (bundled first), then manifest order.
function kinds(): PluginStudyKind[] {
  const k = (plugin: string, key: string, start: StartAction | null): PluginStudyKind => ({
    plugin,
    plugin_name: plugin.toUpperCase(),
    key,
    title: key,
    icon: '',
    workspace: key,
    links_geometry: false,
    start_action: start,
  });
  return [
    k('bundled-a', 'part', action('part', ALL, { header_label: 'Parts' })),
    k('bundled-a', 'note', null),
    k('user-b', 'wing', action('wing', ALL)),
    k('user-b', 'fin', action('fin', ['header', 'new_project'])),
    k('user-c', 'hull', action('hull', ALL)),
    k('user-c', 'keel', action('keel', ['home', 'empty_project'])),
  ];
}

describe('shownStartActions', () => {
  it('caps the header, the empty project and Home at 3 in load order, and lists every New Project action', () => {
    const shown = shownStartActions(entriesFromKinds(kinds()));
    const keys = (place: keyof typeof shown) => shown[place].map(startKey);
    expect(keys('header')).toEqual(['bundled-a:part', 'user-b:wing', 'user-b:fin']);
    expect(keys('empty_project')).toEqual(['bundled-a:part', 'user-b:wing', 'user-c:hull']);
    expect(keys('home')).toEqual(['bundled-a:part', 'user-b:wing', 'user-c:hull']);
    expect(keys('new_project')).toEqual(['bundled-a:part', 'user-b:wing', 'user-b:fin', 'user-c:hull']);
  });

  it('"has a header action" means "is a header button after the cap": the overflow stays in the menu and STUDIES', () => {
    const inHeader = headerKinds(kinds());
    expect([...inHeader]).toEqual(['bundled-a:part', 'user-b:wing', 'user-b:fin']);
    // user-c's hull declares a header action but was cut: it is not "in the header".
    expect(inHeader.has('user-c:hull')).toBe(false);
  });

  it('skips kinds without a start action or a workspace', () => {
    const rows = kinds();
    rows[0] = { ...rows[0], workspace: '' };
    expect(entriesFromKinds(rows).map(startKey)).toEqual(['user-b:wing', 'user-b:fin', 'user-c:hull', 'user-c:keel']);
    expect(entriesFromKinds(null)).toEqual([]);
  });

  it('labels: the header label, else the workspace title; the Home label, else the label', () => {
    const [part, wing] = entriesFromKinds(kinds());
    expect(headerLabel(part)).toBe('Parts');
    expect(headerLabel(wing)).toBe('wing bench');
    expect(homeLabel(part)).toBe('Start part');
    expect(homeLabel({ ...part, action: { ...part.action, home_label: 'New part' } })).toBe('New part');
  });

  it('reads catalog rows of plugins that are on only', () => {
    const rows = [
      { key: 'a', name: 'A', status: 'enabled', start_actions: [action('part', ALL)] },
      { key: 'b', name: 'B', status: 'disabled', start_actions: [action('wing', ALL)] },
      { key: 'c', name: 'C', status: 'needs setup', start_actions: [action('hull', ALL)] },
      { key: 'd', name: 'D', status: 'enabled' },
    ];
    expect(entriesFromCatalog(rows).map((e) => [e.plugin, e.plugin_name, e.action.study_kind])).toEqual([['a', 'A', 'part']]);
  });
});

describe('the Home store', () => {
  let answers: Array<{ plugins: unknown[] }>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetStartActionsForTests();
    answers = [];
    fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe('/api/plugins');
      const body = answers.shift() || { plugins: [] };
      return new Response(JSON.stringify({ ok: true, ...body }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetStartActionsForTests();
  });

  it('reads /api/plugins once, sharing a read that is out, and keeps plugins that are on', async () => {
    answers.push({
      plugins: [
        { key: 'a', name: 'A', status: 'enabled', start_actions: [action('part', ALL)] },
        { key: 'b', name: 'B', status: 'disabled', start_actions: [] },
      ],
    });
    const [one, two] = await Promise.all([loadStartActions(), loadStartActions()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(one.map(startKey)).toEqual(['a:part']);
    expect(two).toBe(one);
    expect(await loadStartActions()).toBe(one);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(startActionsNow()).toBe(one);
  });

  it('reads again when a plugin is turned on or off (cfd:tree-sync {plugins: true}), not on other syncs', async () => {
    answers.push({ plugins: [] });
    await loadStartActions();
    expect(startActionsNow()).toEqual([]);
    window.dispatchEvent(new CustomEvent('cfd:tree-sync'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    answers.push({ plugins: [{ key: 'a', name: 'A', status: 'enabled', start_actions: [action('part', ALL)] }] });
    window.dispatchEvent(new CustomEvent('cfd:tree-sync', { detail: { plugins: true } }));
    await vi.waitFor(() => expect(startActionsNow()?.map(startKey)).toEqual(['a:part']));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('tries a failed read again on its own while something shows the store (1 s, then longer)', async () => {
    vi.useFakeTimers();
    try {
      let down = 2;
      fetchMock.mockImplementation(async () => {
        if (down > 0) {
          down -= 1;
          return new Response(JSON.stringify({ ok: false, error: 'worker busy' }), { status: 503 });
        }
        return new Response(
          JSON.stringify({ ok: true, plugins: [{ key: 'a', name: 'A', status: 'enabled', start_actions: [action('part', ALL)] }] }),
          { status: 200 },
        );
      });
      const seen: string[][] = [];
      subscribeStartActions((list) => seen.push(list.map(startKey)));
      await expect(loadStartActions()).rejects.toThrow();
      expect(startActionsNow()).toBe(null);
      // The first retry after 1 s fails too; the next one waits 2 s.
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(startActionsNow()?.map(startKey)).toEqual(['a:part']);
      expect(seen).toEqual([['a:part']]);
      // Answered: no more reads.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not try again when nothing shows the store', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(async () => new Response('{}', { status: 503 }));
      await expect(loadStartActions()).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a start action makes its study without asking', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    location.hash = '';
  });

  it('takes the first free "<Kind> N" against every title sent, creates it in the project and opens it', async () => {
    const posted: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        posted.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true, study: { id: 'st-2', workspace: 'demo' } }), { status: 200 });
      }),
    );
    const notice = vi.fn(async () => undefined);
    const [entry] = entriesFromKinds([
      { plugin: 'start-demo', plugin_name: 'Start demo', key: 'demo', title: 'Demo', icon: '', workspace: 'demo', start_action: { ...action('demo', ALL), kind_title: 'Demo' } },
    ]);
    // "Demo 1" is another plugin's study: the new one is "Demo 2".
    await startStudy(entry, { projectId: 'proj', titles: ['Demo 1'], notice, sync: () => undefined });
    expect(posted).toEqual([{ project_id: 'proj', plugin: 'start-demo', kind: 'demo', title: 'Demo 2' }]);
    expect(notice).not.toHaveBeenCalled();
    expect(location.hash).toBe('#/p/proj/ws/start-demo/demo/st-2');
  });

  it('shows "Could not create the study" when the server refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'start-demo has no study kind (is the plugin on?)' }), { status: 400 })));
    const notice = vi.fn(async () => undefined);
    const [entry] = entriesFromKinds([
      { plugin: 'start-demo', plugin_name: 'Start demo', key: 'demo', title: 'Demo', icon: '', workspace: 'demo', start_action: action('demo', ALL) },
    ]);
    await startStudy(entry, { projectId: 'proj', titles: [], notice, sync: () => undefined });
    expect(notice).toHaveBeenCalledWith('Could not create the study', 'start-demo has no study kind (is the plugin on?)');
    expect(location.hash).not.toContain('/ws/');
  });

  it('does not open the new study when the user went elsewhere in the project while it was made', async () => {
    location.hash = '#/p/proj';
    let answer: (r: Response) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => (answer = r))));
    const [entry] = entriesFromKinds([
      { plugin: 'start-demo', plugin_name: 'Start demo', key: 'demo', title: 'Demo', icon: '', workspace: 'demo', start_action: action('demo', ALL) },
    ]);
    const made = startStudy(entry, { projectId: 'proj', titles: [], notice: vi.fn(async () => undefined), sync: () => undefined });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    // The user opened another study of the same project meanwhile.
    location.hash = '#/p/proj/ws/other/bench/st-9';
    answer(new Response(JSON.stringify({ ok: true, study: { id: 'st-2', workspace: 'demo' } }), { status: 200 }));
    await made;
    expect(location.hash).toBe('#/p/proj/ws/other/bench/st-9');
  });
});
