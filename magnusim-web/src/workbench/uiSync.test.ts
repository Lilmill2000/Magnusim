/**
 * The page's ui_sync handler (phase 5, C2 §6.4): it follows the open project's `ui` channel;
 * each kind reloads through the runtime's own function; frames are coalesced for 150 ms; a
 * study switch meanwhile drops the reload; another project's frame is ignored; a frame for a
 * study not shown refreshes the tree only; `active` follows as the person's own switch; a hidden
 * tab that comes back reloads its setup once; and who wrote a record is remembered for 60 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (ev: MessageEvent) => void;
const channels: Array<{ url: string; listeners: Map<string, Listener>; closed: boolean }> = [];
vi.mock('../api/eventHub', () => ({
  openChannel: (url: string) => {
    const ch = { url, listeners: new Map<string, Listener>(), closed: false };
    channels.push(ch);
    return {
      url,
      addEventListener: (type: string, fn: Listener) => ch.listeners.set(type, fn),
      removeEventListener: () => undefined,
      close: () => {
        ch.closed = true;
      },
    };
  },
}));

import { bindUiSyncHost, COALESCE_MS, followProject, heardWrite, HEARD_MS, merge, receive, resetUiSyncForTests, uiSyncSettled, uiSyncState, type UiSyncFrame, type UiSyncHost } from './uiSync';

let gen = 0;
let project = 'p1';
let study = 's1';
let geometry = 'g1';
let calls: string[] = [];
let clock = 1_000_000;

function host(over: Partial<UiSyncHost> = {}): void {
  const rec = (name: string) =>
    vi.fn(async (...args: unknown[]) => {
      calls.push(args.length > 1 ? `${name}:${JSON.stringify(args.slice(1))}` : name);
    });
  bindUiSyncHost({
    currentProjectId: () => project,
    currentStudyId: () => study,
    currentGeometryId: () => geometry,
    switchGen: () => gen,
    reloadProjectShell: rec('project'),
    reloadGeometries: rec('geometry'),
    reloadStudies: rec('study'),
    reloadMaterials: rec('materials'),
    reloadBcs: rec('bcs'),
    reloadMesh: rec('mesh'),
    reloadRefinements: rec('refinements'),
    reloadRuns: rec('runs'),
    activateGeometry: vi.fn(async (id: string) => {
      calls.push(`activate-geometry:${id}`);
    }),
    activateStudy: vi.fn(async (id: string) => {
      calls.push(`activate-study:${id}`);
    }),
    activateMesh: vi.fn(async (id: string) => {
      calls.push(`activate-mesh:${id}`);
    }),
    activateRun: vi.fn(async (id: string) => {
      calls.push(`activate-run:${id}`);
    }),
    reloadAll: vi.fn(async () => {
      calls.push('all');
    }),
    syncTree: () => {
      calls.push('tree');
    },
    ...over,
  });
}

const frame = (o: Partial<UiSyncFrame> = {}): UiSyncFrame => ({
  seq: 1,
  project_id: 'p1',
  simulation_id: 's1',
  kinds: ['bcs'],
  ids: { bc: ['bc-7'] },
  revs: { 'bc-7': 5 },
  by: 'assistant',
  turn: 't-1',
  tool: 'setup_edit.bc.update',
  ...o,
});

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(COALESCE_MS + 5);
  await uiSyncSettled();
}

beforeEach(() => {
  vi.useFakeTimers();
  channels.length = 0;
  calls = [];
  gen = 0;
  project = 'p1';
  study = 's1';
  geometry = 'g1';
  clock = 1_000_000;
  resetUiSyncForTests(() => clock);
  host();
  followProject('p1');
});

afterEach(() => {
  resetUiSyncForTests();
  vi.useRealTimers();
});

describe('the channel', () => {
  it("opens the project's ui channel, closes it when the project goes, and opens the next one's", () => {
    expect(channels.map((c) => c.url)).toEqual(['/api/ui/events?project_id=p1']);
    followProject('p1');
    expect(channels).toHaveLength(1);
    followProject('');
    expect(channels[0].closed).toBe(true);
    expect(uiSyncState().following).toBe(false);
    followProject('p2');
    expect(channels[1].url).toBe('/api/ui/events?project_id=p2');
  });

  it("reads a channel's sync frames", async () => {
    channels[0].listeners.get('sync')?.(new MessageEvent('sync', { data: JSON.stringify(frame()) }));
    await flush();
    expect(calls).toEqual(['bcs', 'tree']);
  });
});

describe('each kind reloads through its function', () => {
  const cases: Array<[UiSyncFrame['kinds'], Record<string, string[]>, string[]]> = [
    [['project'], {}, ['project', 'tree']],
    [['geometry'], { geometry: ['g2'] }, ['geometry', 'tree']],
    [['study'], { study: ['s1'] }, ['study', 'tree']],
    [['materials'], { material: ['m1'] }, ['materials', 'tree']],
    [['bcs'], { bc: ['bc-7'] }, ['bcs', 'tree']],
    [['bc_defaults'], {}, ['bcs', 'tree']],
    [['mesh'], { mesh: ['m-1'] }, ['mesh:[["m-1"]]', 'tree']],
    [['refinements'], { refinement: ['r1'] }, ['refinements', 'tree']],
    [['runs'], { run: ['run-1'] }, ['runs:[["run-1"]]', 'tree']],
    [['plugin_studies'], {}, ['tree']],
    [['tree'], {}, ['tree']],
  ];
  for (const [kinds, ids, want] of cases) {
    it(kinds.join(','), async () => {
      receive(frame({ kinds, ids }));
      await flush();
      expect(calls).toEqual(want);
    });
  }
});

describe('the rules', () => {
  it('coalesces frames heard within 150 ms into one reload of each kind', async () => {
    receive(frame({ kinds: ['bcs'] }));
    await vi.advanceTimersByTimeAsync(100);
    receive(frame({ seq: 2, kinds: ['bcs', 'mesh'], ids: { mesh: ['m-1'] } }));
    receive(frame({ seq: 3, kinds: ['mesh'], ids: { mesh: ['m-2'] } }));
    expect(calls).toEqual([]);
    await flush();
    expect(calls).toEqual(['bcs', 'mesh:[["m-1","m-2"]]', 'tree']);
  });

  it('drops the rest of a reload when the person switched study meanwhile', async () => {
    host({
      reloadBcs: vi.fn(async () => {
        calls.push('bcs');
        gen += 1;
      }),
    });
    receive(frame({ kinds: ['bcs', 'mesh', 'runs'] }));
    await flush();
    expect(calls).toEqual(['bcs']);
  });

  it("ignores another project's frame", async () => {
    receive(frame({ project_id: 'p2' }));
    await flush();
    expect(calls).toEqual([]);
    expect(heardWrite('bc', 'bc-7')).toBeNull();
  });

  it('a frame for a study not shown refreshes the tree only', async () => {
    receive(frame({ simulation_id: 's2', kinds: ['bcs', 'mesh'] }));
    await flush();
    expect(calls).toEqual(['tree']);
  });

  it('active: a study made active is switched to (it loads its setup itself); a mesh and a run follow after the reloads', async () => {
    receive(frame({ simulation_id: 's2', kinds: ['study', 'active'], active: { study: 's2' } }));
    await flush();
    expect(calls).toEqual(['activate-study:s2']);
    calls = [];
    receive(frame({ kinds: ['mesh', 'active'], ids: { mesh: ['m-3'] }, active: { mesh: 'm-3' } }));
    await flush();
    expect(calls).toEqual(['mesh:[["m-3"]]', 'activate-mesh:m-3', 'tree']);
    calls = [];
    receive(frame({ kinds: ['geometry', 'active'], active: { geometry: 'g2' } }));
    await flush();
    expect(calls).toEqual(['geometry', 'activate-geometry:g2']);
    calls = [];
    // Already shown: nothing to switch.
    receive(frame({ kinds: ['runs', 'active'], ids: { run: ['r1'] }, active: { study: 's1', run: 'r1' } }));
    await flush();
    expect(calls).toEqual(['runs:[["r1"]]', 'activate-run:r1', 'tree']);
  });

  it('says cfd:ui-sync on the window with the merged frames before reloading', async () => {
    const heard: unknown[] = [];
    const on = (e: Event) => heard.push((e as CustomEvent).detail);
    window.addEventListener('cfd:ui-sync', on);
    try {
      receive(frame({ kinds: ['mesh'], ids: { mesh: ['m-1'] } }));
      await flush();
      expect(heard).toEqual([merge([frame({ kinds: ['mesh'], ids: { mesh: ['m-1'] } })])]);
    } finally {
      window.removeEventListener('cfd:ui-sync', on);
    }
  });

  it('a hidden tab that comes back reloads its setup once', async () => {
    window.dispatchEvent(new CustomEvent('cfd:events-resumed'));
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(['all']);
  });
});

describe('who wrote it', () => {
  it('remembers the Assistant (or another app) for 60 s, per record', () => {
    receive(frame());
    receive(frame({ seq: 2, kinds: ['mesh'], ids: { mesh: ['m-1'] }, by: 'app' }));
    receive(frame({ seq: 3, kinds: ['bc_defaults'], ids: {} }));
    expect(heardWrite('bc', 'bc-7')).toBe('assistant');
    expect(heardWrite('bc', 'bc-8')).toBeNull();
    expect(heardWrite('mesh', 'm-1')).toBe('app');
    expect(heardWrite('bc_defaults', 's1')).toBe('assistant');
    clock += HEARD_MS + 1;
    expect(heardWrite('bc', 'bc-7')).toBeNull();
  });

  it('a frame naming no ids covers every record of its kind', () => {
    receive(frame({ kinds: ['runs'], ids: {} }));
    expect(heardWrite('run', 'anything')).toBe('assistant');
  });
});
