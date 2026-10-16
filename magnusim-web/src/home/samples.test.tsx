// Home's Open sample (manifest [[samples]], API 1.8): the samples of the plugins that are
// on, a menu of them, a pick that copies one as a new project and opens it, and the
// server's reason when it cannot.
import { act } from 'react';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Home } from './Home';
import { samplesFromCatalog } from './samples';

const opened: string[] = [];
let folderNow = '';
let openFails = '';
vi.mock('./controller', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./controller')>()),
  initHome: vi.fn(),
  homeFolderNow: vi.fn(() => folderNow),
  refreshHome: vi.fn(async () => undefined),
  openProject: vi.fn(async (id: string) => {
    if (openFails) throw new Error(openFails);
    opened.push(id);
    return { ok: true };
  }),
}));

const ROWS = [
  { key: 'heat_transfer', name: 'Heat Transfer', status: 'enabled', samples: [{ key: 'heat-sink', title: 'Heat sink', hint: 'A 10 W sink' }] },
  { key: 'off', name: 'Off', status: 'disabled', samples: [{ key: 'x', title: 'Hidden' }] },
  { key: 'plain', name: 'Plain', status: 'enabled' },
];

describe('samplesFromCatalog', () => {
  it('lists the samples of the plugins that are on, in order, each with its plugin', () => {
    expect(samplesFromCatalog(ROWS)).toEqual([
      { plugin: 'heat_transfer', plugin_name: 'Heat Transfer', key: 'heat-sink', title: 'Heat sink', hint: 'A 10 W sink' },
    ]);
    expect(samplesFromCatalog(null)).toEqual([]);
  });
});

let root: Root | null = null;
let posted: unknown[] = [];
let answer: { status: number; body: unknown } = { status: 201, body: { ok: true, id: 'heat-sink-1' } };

function mount(rows: unknown[]) {
  document.body.innerHTML = '<span id="home-sample-host"></span><span id="home-start-host"></span>';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('/api/project/sample')) {
        posted.push(JSON.parse(String(init?.body || '{}')));
        return new Response(JSON.stringify(answer.body), { status: answer.status });
      }
      return new Response(JSON.stringify({ ok: true, plugins: rows }), { status: 200 });
    }),
  );
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root!.render(createElement(Home)));
}

const settle = async (ok: () => boolean) => {
  for (let i = 0; i < 50 && !ok(); i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
};
const button = () => document.querySelector<HTMLButtonElement>('#home-sample-host [data-home-samples="1"]');
const item = () => document.querySelector<HTMLButtonElement>('[data-home-sample="heat_transfer:heat-sink"]');

beforeEach(() => {
  folderNow = '';
  openFails = '';
  posted = [];
  opened.length = 0;
  answer = { status: 201, body: { ok: true, id: 'heat-sink-1' } };
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Home: Open sample', () => {
  it('shows no button when no plugin that is on has a sample', async () => {
    mount([ROWS[1], ROWS[2]]);
    await settle(() => false);
    expect(button()).toBeNull();
  });

  it('lists each sample with its hint and plugin; a pick copies it and opens the new project', async () => {
    mount(ROWS);
    await settle(() => !!button());
    expect(button()!.textContent).toBe('Open sample');
    expect(document.querySelector('[data-home-samples-menu="1"]')).toBeNull();
    act(() => button()!.click());
    expect(item()!.querySelector('.home-samples-title')!.textContent).toBe('Heat sink');
    expect(item()!.querySelector('.home-samples-hint')!.textContent).toBe('A 10 W sink (Heat Transfer)');
    expect(document.querySelectorAll('[data-home-sample]').length).toBe(1);
    await act(async () => item()!.click());
    await settle(() => opened.length > 0);
    expect(posted).toEqual([{ plugin: 'heat_transfer', sample: 'heat-sink' }]);
    expect(opened).toEqual(['heat-sink-1']);
    expect(document.querySelector('[data-home-samples-menu="1"]')).toBeNull();
  });

  it('files the copy under the folder Home shows', async () => {
    folderNow = 'Samples';
    mount(ROWS);
    await settle(() => !!button());
    act(() => button()!.click());
    await act(async () => item()!.click());
    await settle(() => opened.length > 0);
    expect(posted).toEqual([{ plugin: 'heat_transfer', sample: 'heat-sink', folder: 'Samples' }]);
  });

  it("shows the server's reason when the sample cannot be copied, and opens nothing", async () => {
    answer = { status: 404, body: { error: "Heat Transfer has no sample 'heat-sink'" } };
    mount(ROWS);
    await settle(() => !!button());
    act(() => button()!.click());
    await act(async () => item()!.click());
    await settle(() => !!document.querySelector('[data-home-samples-error="1"]'));
    expect(document.querySelector('[data-home-samples-error="1"]')!.textContent).toBe("Heat Transfer has no sample 'heat-sink'");
    expect(opened).toEqual([]);
  });

  it('says in a toast when the copy is made but cannot be opened (the menu is closed by then)', async () => {
    openFails = 'project not found';
    const toasts: unknown[] = [];
    const onToast = (e: Event) => toasts.push((e as CustomEvent).detail);
    window.addEventListener('cfd:toast', onToast);
    try {
      mount(ROWS);
      await settle(() => !!button());
      act(() => button()!.click());
      await act(async () => item()!.click());
      await settle(() => toasts.length > 0);
      expect(toasts).toEqual([
        { message: 'Heat sink was copied as a new project, but it could not be opened: project not found', kind: 'error' },
      ]);
      expect(document.querySelector('[data-home-samples-menu="1"]')).toBeNull();
      expect(button()!.disabled).toBe(false);
    } finally {
      window.removeEventListener('cfd:toast', onToast);
    }
  });

  it('closes on Escape', async () => {
    mount(ROWS);
    await settle(() => !!button());
    act(() => button()!.click());
    expect(document.querySelector('[data-home-samples-menu="1"]')).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(document.querySelector('[data-home-samples-menu="1"]')).toBeNull();
  });
});
