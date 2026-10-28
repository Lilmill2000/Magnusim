import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The page's surroundings: the open project, the address, the app's dialogs (the name the
// person types, and every notice they would see).
const page = vi.hoisted(() => ({ name: 'Lid' as string | null, notices: [] as { title?: string; copy?: string }[] }));
vi.mock('./shell', () => ({ openProjectNow: () => ({ id: 'p1', title: 'Bracket set' }) }));
vi.mock('../app/routes', () => ({ useHashRoute: () => ({ view: 'workbench' }) }));
vi.mock('../workspace/startActions', () => ({ loadStartActions: async () => [], startStudy: async () => {} }));
vi.mock('../workbench/dialogs', () => ({
  promptName: async () => page.name,
  confirmAction: async (o: { title?: string; copy?: string }) => {
    page.notices.push({ title: o.title, copy: o.copy });
    return true;
  },
}));

import { ProjectPage } from './ProjectPage';

type Rec = { id: string; title: string; rev: number };

/** The server: the study records, what each list read answers, and every rename it was sent. */
let records: Rec[];
let renames: { rev: unknown; title: unknown }[];
let holdList: ((answer: () => void) => void) | null;
/** Runs once right after a record read answers (another write landing between the read and the rename). */
let afterGet: (() => void) | null;

const row = (r: Rec) => ({ ...r, plugin: 'cad', plugin_name: 'Magnusim CAD', kind_title: 'Part', workspace: 'part', available: true, reason: '' });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  page.name = 'Lid';
  page.notices = [];
  records = [{ id: 'st-2', title: 'Part 2', rev: 1 }];
  renames = [];
  holdList = null;
  afterGet = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://app');
      if (url.pathname === '/api/plugin-studies') {
        // The answer is what the records were when the read reached the server.
        const answer = json(200, { studies: records.map(row) });
        if (!holdList) return answer;
        return new Promise<Response>((resolve) => holdList!(() => resolve(answer)));
      }
      if (url.pathname === '/api/plugin-studies/get') {
        const rec = records.find((r) => r.id === url.searchParams.get('study_id'));
        const answer = rec ? json(200, { ok: true, study: { ...rec } }) : json(404, { ok: false });
        const then = afterGet;
        afterGet = null;
        then?.();
        return answer;
      }
      if (url.pathname === '/api/plugin-studies/rename') {
        const body = JSON.parse(String(init?.body));
        renames.push({ rev: body.rev, title: body.title });
        const rec = records.find((r) => r.id === body.study_id)!;
        if (body.rev !== rec.rev) return json(409, { ok: false, code: -32009, error: 'This study changed in another tab. Reload to continue.' });
        Object.assign(rec, { title: body.title, rev: rec.rev + 1 });
        return json(200, { ok: true, study: rec });
      }
      return json(404, {});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(<ProjectPage host={host} />);
}

const titles = () => [...document.querySelectorAll('.cad-part-title')].map((t) => t.textContent);

describe("Magnusim CAD's project page", () => {
  it("a row older than the record (the Part saved while open) renames with the record's rev, refused never", async () => {
    mount();
    await waitFor(() => expect(titles()).toEqual(['Part 2']));
    // The Part writes its own field while open: the row still says rev 1.
    records[0].rev = 2;
    fireEvent.click(screen.getByRole('button', { name: 'Rename Part 2' }));
    await waitFor(() => expect(titles()).toEqual(['Lid']));
    expect(renames).toEqual([{ rev: 2, title: 'Lid' }]);
    expect(page.notices).toEqual([]);
  });

  it('a write between the read and the rename is read again once, and the rename goes', async () => {
    mount();
    await waitFor(() => expect(titles()).toEqual(['Part 2']));
    afterGet = () => (records[0].rev = 2);
    fireEvent.click(screen.getByRole('button', { name: 'Rename Part 2' }));
    await waitFor(() => expect(titles()).toEqual(['Lid']));
    expect(renames).toEqual([
      { rev: 1, title: 'Lid' },
      { rev: 2, title: 'Lid' },
    ]);
    expect(page.notices).toEqual([]);
  });

  it('a Part renamed elsewhere meanwhile is not renamed over: the person is told', async () => {
    mount();
    await waitFor(() => expect(titles()).toEqual(['Part 2']));
    Object.assign(records[0], { title: 'Bracket', rev: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Rename Part 2' }));
    await waitFor(() => expect(page.notices).toEqual([{ title: 'Could not rename the part', copy: 'This study changed in another tab. Reload to continue.' }]));
    expect(renames).toEqual([{ rev: 1, title: 'Lid' }]);
    await waitFor(() => expect(titles()).toEqual(['Bracket']));
  });

  it('only the newest list read is shown: an older answer landing last does not put back old rows', async () => {
    const held: (() => void)[] = [];
    holdList = (answer) => held.push(answer);
    // Opening the page reads the list (twice: its start and its back-from-a-Part effect).
    mount();
    await waitFor(() => expect(held).toHaveLength(2));
    // The Part is renamed; another read starts (Back's), and answers before the first ones.
    records[0].title = 'Lid';
    act(() => {
      window.dispatchEvent(new Event('cfd:tree-sync'));
    });
    await waitFor(() => expect(held).toHaveLength(3));
    await act(async () => held[2]());
    await waitFor(() => expect(titles()).toEqual(['Lid']));
    await act(async () => {
      held[0]();
      held[1]();
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(titles()).toEqual(['Lid']);
  });

  it('Cancel on the name asks nothing of the server', async () => {
    mount();
    await waitFor(() => expect(titles()).toEqual(['Part 2']));
    page.name = null;
    fireEvent.click(screen.getByRole('button', { name: 'Rename Part 2' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(renames).toEqual([]);
  });
});
