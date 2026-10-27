import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../wizard/controller', () => ({ initSetupWizard: () => {} }));

import { loadStartActions, resetStartActionsForTests } from '../workspace/startActions';
import { prepareCreateModal, submitProjectModal } from './controller';

// New Project in Magnusim CAD (src/app/edition.ts): "Start from" offers CAD's starts with the
// first one chosen and no Import geometry (it has no project geometries); a project is Other.
// Magnusim's dialog is startChoice.test.ts, run with no edition meta.

const part = {
  study_kind: 'part',
  kind_title: 'Part',
  workspace: 'part',
  workspace_title: 'Part',
  label: 'Design a part',
  home_label: 'New design',
  header_label: 'CAD',
  hint: '',
  icon: '',
  places: ['empty_project', 'header', 'new_project', 'home'],
};
const PLUGINS = [{ key: 'cad', name: 'Magnusim CAD', status: 'enabled', start_actions: [part] }];

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
      <div id="np-samples-list" hidden></div>
      <p id="np-samples-error" hidden></p>
      <button id="np-samples-toggle" aria-expanded="false" hidden>Open a sample…</button>
      <button id="np-create">Create</button>
    </div>`;
}

const radios = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>('#np-start-list input[type="radio"]')).map((r) => [
    r.value,
    r.closest('label')?.querySelector('.np-start-label')?.textContent,
    r.checked,
  ]);
const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

beforeEach(async () => {
  document.head.innerHTML = '<meta name="magnusim-edition" content="cad">';
  resetStartActionsForTests();
  modal();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u === '/api/plugins') return new Response(JSON.stringify({ ok: true, plugins: PLUGINS }), { status: 200 });
      if (u === '/api/projects') return new Response(JSON.stringify({ projects: [], folders: ['My Projects'] }), { status: 200 });
      return new Response('{}', { status: 200 });
    }),
  );
  await loadStartActions();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetStartActionsForTests();
  document.head.innerHTML = '';
  document.body.replaceChildren();
});

describe('New Project in Magnusim CAD', () => {
  it('starts from a Part (chosen), with no Import geometry; its only choice is not asked (Start from hidden)', async () => {
    await prepareCreateModal(null, { folder: 'My Projects' });
    expect(radios()).toEqual([['cad:part', 'Design a part', true]]);
    expect((document.getElementById('np-start') as HTMLElement).hidden).toBe(true);
    (document.getElementById('np-title') as HTMLInputElement).value = 'Brackets';
    expect(await submitProjectModal()).toMatchObject({
      ok: true,
      mode: 'create',
      start: { plugin: 'cad', kind: 'part' },
      fields: { title: 'Brackets', category: 'Other' },
    });
  });

  it('is a CAD project: category Other, and a part\'s words in the empty fields', async () => {
    await prepareCreateModal(null, { folder: 'My Projects' });
    expect(val('np-category')).toBe('Other');
    expect((document.getElementById('np-title') as HTMLInputElement).placeholder).toBe('Mounting bracket');
    expect((document.getElementById('np-description') as HTMLTextAreaElement).placeholder).toBe('What these parts are for');
  });
});

describe('Start from with two of its own choices in Magnusim CAD', () => {
  it('is asked (a second start action, still no Import geometry)', async () => {
    resetStartActionsForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        const u = String(url);
        const second = { ...part, study_kind: 'sheet', kind_title: 'Sheet', label: 'Design a sheet part' };
        if (u === '/api/plugins') return new Response(JSON.stringify({ ok: true, plugins: [{ ...PLUGINS[0], start_actions: [part, second] }] }), { status: 200 });
        if (u === '/api/projects') return new Response(JSON.stringify({ projects: [], folders: ['My Projects'] }), { status: 200 });
        return new Response('{}', { status: 200 });
      }),
    );
    await loadStartActions();
    await prepareCreateModal(null, { folder: 'My Projects' });
    expect((document.getElementById('np-start') as HTMLElement).hidden).toBe(false);
    expect(radios().map((r) => r[0])).toEqual(['cad:part', 'cad:sheet']);
  });
});

describe('Edit project in Magnusim CAD', () => {
  it('has no Start from', async () => {
    await prepareCreateModal({ id: 'p1', title: 'Brackets', folder: 'My Projects', units: 'Metric', category: 'Other' }, {});
    expect((document.getElementById('np-start') as HTMLElement).hidden).toBe(true);
  });
});
