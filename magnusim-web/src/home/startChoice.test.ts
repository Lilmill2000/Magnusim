import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../wizard/controller', () => ({ initSetupWizard: () => {} }));

import { loadStartActions, resetStartActionsForTests } from '../workspace/startActions';
import { firstFreeUntitledTitle, prepareCreateModal, submitProjectModal } from './controller';

// gate:l1-menus: the New Project dialog's "Start from" (API 1.4) and Home's start
// button, which opens it with its action chosen and a title filled in (D2).

const ALL = ['empty_project', 'header', 'new_project', 'home'];
const act = (kind: string, title: string, places: string[]) => ({
  study_kind: kind,
  kind_title: title,
  workspace: kind,
  workspace_title: `${title} bench`,
  label: `Start a ${title.toLowerCase()}`,
  home_label: '',
  header_label: '',
  hint: `${title} hint`,
  icon: '',
  places,
});

const PLUGINS = [
  { key: 'start-demo', name: 'Start demo', status: 'enabled', start_actions: [act('demo', 'Demo', ALL)] },
  // Home only: offered under "Start from" only when Home's button opened the dialog.
  { key: 'start-demo-2', name: 'Start demo two', status: 'enabled', start_actions: [act('gamma', 'Gamma', ['home'])] },
  { key: 'off-demo', name: 'Off', status: 'disabled', start_actions: [act('off', 'Off', ALL)] },
];

const PROJECTS = [
  { id: 'p1', title: 'Untitled Demo 1', folder: 'My Projects' },
  { id: 'p2', title: 'untitled demo 3 ', folder: 'My Projects' },
  { id: 'p3', title: 'Untitled Demo 2', folder: 'Wings' },
];

function modal() {
  document.body.innerHTML = `
    <div id="modal-new-project" hidden>
      <h2 id="np-heading">Create new project</h2>
      <input id="np-title" />
      <textarea id="np-description"></textarea>
      <select id="np-category"><option value="Other">Other</option><option value="Fluid dynamics">Fluid dynamics</option></select>
      <select id="np-units"><option value="Metric">Metric</option><option value="Imperial">Imperial</option></select>
      <select id="np-folder"></select>
      <div id="np-folder-new-wrap" hidden><input id="np-folder-new" /></div>
      <fieldset id="np-start" hidden><legend>Start from</legend><div id="np-start-list"></div></fieldset>
      <button id="np-create">Create</button>
    </div>`;
}

const radios = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>('#np-start-list input[type="radio"]')).map((r) => [
    r.value,
    r.closest('label')?.querySelector('.np-start-label')?.textContent,
    r.checked,
  ]);

function stubFetch(plugins: () => Promise<Response> | Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u === '/api/plugins') return plugins();
      if (u === '/api/projects') return new Response(JSON.stringify({ projects: PROJECTS, folders: ['My Projects', 'Wings'] }), { status: 200 });
      return new Response('{}', { status: 200 });
    }),
  );
}

const pluginsAnswer = (plugins: unknown[]) => new Response(JSON.stringify({ ok: true, plugins }), { status: 200 });

beforeEach(async () => {
  resetStartActionsForTests();
  modal();
  stubFetch(() => pluginsAnswer(PLUGINS));
  // Home's read at app start (the store is filled before the dialog opens).
  await loadStartActions();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetStartActionsForTests();
  document.body.replaceChildren();
});

describe('New Project: Start from', () => {
  it('offers Import geometry (checked) and each new_project action of a plugin that is on', async () => {
    await prepareCreateModal(null, { folder: 'My Projects' });
    expect((document.getElementById('np-start') as HTMLElement).hidden).toBe(false);
    expect(radios()).toEqual([
      ['', 'Import geometry', true],
      ['start-demo:demo', 'Start a demo', false],
    ]);
    expect(document.getElementById('np-start-list')).toHaveTextContent('Demo hint');
    expect((document.getElementById('np-title') as HTMLInputElement).value).toBe('');
    const got = await submitProjectModal();
    expect(got).toMatchObject({ ok: false });
    (document.getElementById('np-title') as HTMLInputElement).value = 'Mine';
    expect(await submitProjectModal()).toMatchObject({ ok: true, mode: 'create', start: null, fields: { title: 'Mine' } });
    (document.querySelector('#np-start-list input[value="start-demo:demo"]') as HTMLInputElement).checked = true;
    expect(await submitProjectModal()).toMatchObject({ ok: true, mode: 'create', start: { plugin: 'start-demo', kind: 'demo' } });
  });

  it("Home's button: its radio checked, \"Untitled <kind> N\" free in that folder, filled in and selected", async () => {
    await prepareCreateModal(null, { folder: 'My Projects', start: { plugin: 'start-demo', kind: 'demo' } });
    expect(radios()).toEqual([
      ['', 'Import geometry', false],
      ['start-demo:demo', 'Start a demo', true],
    ]);
    const title = document.getElementById('np-title') as HTMLInputElement;
    // "Untitled Demo 1" (and "untitled demo 3 ") are taken in My Projects.
    expect(title.value).toBe('Untitled Demo 2');
    expect([title.selectionStart, title.selectionEnd]).toEqual([0, title.value.length]);
    expect(await submitProjectModal()).toMatchObject({
      ok: true,
      fields: { title: 'Untitled Demo 2', folder: 'My Projects' },
      start: { plugin: 'start-demo', kind: 'demo' },
    });
    // In another folder the count starts again.
    await prepareCreateModal(null, { folder: 'Wings', start: { plugin: 'start-demo', kind: 'demo' } });
    expect(title.value).toBe('Untitled Demo 1');
  });

  it("adds the opener's action for this opening when it has no new_project place", async () => {
    await prepareCreateModal(null, { folder: 'My Projects', start: { plugin: 'start-demo-2', kind: 'gamma' } });
    expect(radios()).toEqual([
      ['', 'Import geometry', false],
      ['start-demo:demo', 'Start a demo', false],
      ['start-demo-2:gamma', 'Start a gamma', true],
    ]);
    expect((document.getElementById('np-title') as HTMLInputElement).value).toBe('Untitled Gamma 1');
    // The next plain opening does not keep it.
    await prepareCreateModal(null, { folder: 'My Projects' });
    expect(radios().map((r) => r[0])).toEqual(['', 'start-demo:demo']);
  });

  it('is hidden in edit mode, and when no plugin has an action', async () => {
    await prepareCreateModal({ id: 'p1', title: 'Untitled Demo 1', folder: 'My Projects' });
    expect((document.getElementById('np-start') as HTMLElement).hidden).toBe(true);
    expect(document.getElementById('np-heading')).toHaveTextContent('Edit project');
    resetStartActionsForTests();
    stubFetch(() => pluginsAnswer([PLUGINS[2]]));
    await loadStartActions();
    await prepareCreateModal(null, { folder: 'My Projects' });
    expect((document.getElementById('np-start') as HTMLElement).hidden).toBe(true);
  });

  it('does not wait on /api/plugins: it opens without Start from, which fills in when the read lands', async () => {
    resetStartActionsForTests();
    let answer: (r: Response) => void = () => undefined;
    stubFetch(() => new Promise<Response>((r) => (answer = r)));
    await prepareCreateModal(null, { folder: 'My Projects' });
    expect((document.getElementById('np-start') as HTMLElement).hidden).toBe(true);
    expect((document.getElementById('np-heading') as HTMLElement).textContent).toBe('Create new project');
    answer(pluginsAnswer(PLUGINS));
    await vi.waitFor(() => expect((document.getElementById('np-start') as HTMLElement).hidden).toBe(false));
    expect(radios()).toEqual([
      ['', 'Import geometry', true],
      ['start-demo:demo', 'Start a demo', false],
    ]);
  });

  it("keeps the user's choice when a later read fills Start from again, and never fills in an edit", async () => {
    await prepareCreateModal(null, { folder: 'My Projects' });
    (document.querySelector('#np-start-list input[value="start-demo:demo"]') as HTMLInputElement).checked = true;
    // A plugin was turned on meanwhile: the read in flight adds its action.
    let answer: (r: Response) => void = () => undefined;
    stubFetch(() => new Promise<Response>((r) => (answer = r)));
    const reread = loadStartActions({ force: true });
    await prepareCreateModal(null, { folder: 'My Projects' });
    (document.querySelector('#np-start-list input[value="start-demo:demo"]') as HTMLInputElement).checked = true;
    const more = [...PLUGINS, { key: 'late', name: 'Late', status: 'enabled', start_actions: [{ ...PLUGINS[0].start_actions[0], study_kind: 'wing', label: 'Start a wing' }] }];
    answer(pluginsAnswer(more));
    await reread;
    await vi.waitFor(() => expect(radios().map((r) => r[0])).toEqual(['', 'start-demo:demo', 'late:wing']));
    expect(radios()).toEqual([
      ['', 'Import geometry', false],
      ['start-demo:demo', 'Start a demo', true],
      ['late:wing', 'Start a wing', false],
    ]);
    // Edit mode is never filled in later.
    resetStartActionsForTests();
    stubFetch(() => new Promise<Response>((r) => (answer = r)));
    await prepareCreateModal(null, { folder: 'My Projects' });
    await prepareCreateModal({ id: 'p1', title: 'Untitled Demo 1', folder: 'My Projects' });
    answer(pluginsAnswer(PLUGINS));
    await new Promise((r) => setTimeout(r, 20));
    expect((document.getElementById('np-start') as HTMLElement).hidden).toBe(true);
  });

  it('shows a label and a hint as text, never as markup', async () => {
    resetStartActionsForTests();
    const odd = { ...PLUGINS[0].start_actions[0], label: 'Pipes <b>&</b> bends', hint: 'A <i>hint</i> & more' };
    stubFetch(() => pluginsAnswer([{ ...PLUGINS[0], start_actions: [odd] }]));
    await loadStartActions();
    await prepareCreateModal(null, { folder: 'My Projects' });
    const label = document.querySelectorAll('#np-start-list .np-start-label')[1] as HTMLElement;
    expect(label.textContent).toBe('Pipes <b>&</b> bends');
    expect(label.querySelector('b')).toBe(null);
    const hint = document.querySelector('#np-start-list .np-start-hint') as HTMLElement;
    expect(hint.textContent).toBe('A <i>hint</i> & more');
    expect(hint.querySelector('i')).toBe(null);
  });

  it('firstFreeUntitledTitle counts only that folder, trimmed and ignoring case', () => {
    expect(firstFreeUntitledTitle('Demo', PROJECTS, 'My Projects')).toBe('Untitled Demo 2');
    expect(firstFreeUntitledTitle('Demo', PROJECTS, 'Wings')).toBe('Untitled Demo 1');
    expect(firstFreeUntitledTitle('Demo', [], undefined)).toBe('Untitled Demo 1');
    // A title that differs only in case and spaces is taken.
    expect(firstFreeUntitledTitle('Demo', [{ title: ' untitled DEMO 1 ', folder: 'My Projects' }], 'My Projects')).toBe('Untitled Demo 2');
  });
});
