// The host's question when a linked geometry gets a new shape (host API 1.5, LINK proposal
// 5.0): its words, which copy box starts checked (D36), what a refused choice looks like
// (plugin_needed, a geometry still updating), the three answers and the row's "Waiting for
// your choice" with "Choose…" (5.18). gate:l2-choice (client part).
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { linkStatusText, PluginStudiesView } from '../chrome/LeftTree';
import { linkedGeometryByStudy, type GeomLink, type ProjectTreeDoc } from '../chrome/treeModel';
import { initiallyChecked, linkChoiceText, listNames, savedAsNewText, sendLinkChoice, showLinkChoice, type LinkQuestion } from './linkChoice';

const Q: LinkQuestion = {
  geometry: { id: 'g1', name: 'Demo 1' },
  study: { id: 'st-1', title: 'Demo 1' },
  new_name: 'Demo 1 v2',
  studies: [
    { id: 's1', title: 'Study 1', copy: 'ok', checked: true },
    { id: 's2', title: 'Study 2', copy: 'ok', checked: false },
    { id: 's3', title: 'Study 3', copy: 'Demo 1 is still updating', checked: false },
  ],
  overwrite: 'ok',
  fenced: false,
};

const MARKUP = `
  <div id="modal-link-choice" hidden>
    <div id="lc-backdrop"></div>
    <h2 id="lc-heading"></h2><p id="lc-copy"></p>
    <button id="lc-new"></button><p id="lc-new-line"></p><div id="lc-copies"></div>
    <button id="lc-overwrite"></button><p id="lc-overwrite-line"></p>
    <button id="lc-cancel"></button>
  </div>`;

beforeEach(() => {
  document.body.innerHTML = MARKUP;
});
afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('the words', () => {
  it('names the study, the geometry, every study in use and the new geometry', () => {
    const t = linkChoiceText(Q);
    expect(t.title).toBe('Demo 1 has a new shape');
    expect(t.copy).toBe('Demo 1 is used by Study 1, Study 2 and Study 3. How should the simulation get the new shape?');
    expect(t.newLine).toBe('Adds Demo 1 v2. Demo 1 and its studies, meshes and results stay as they are.');
    expect(t.copyLabel('Study 1')).toBe('Copy the setup of Study 1 onto it');
    expect(t.overwriteLabel).toBe('Overwrite Demo 1');
    expect(t.overwriteLine).toBe('Updates Demo 1 in place. Faces are matched by name; its meshes must be generated again before a run.');
    expect(t.overwriteBlocked).toBeNull();
    expect(listNames(['A'])).toBe('A');
    expect(listNames(['A', 'B'])).toBe('A and B');
  });

  it('D36: only the study the geometry showed last starts checked, and never one that cannot be copied', () => {
    expect(initiallyChecked(Q)).toEqual(['s1']);
    expect(initiallyChecked({ ...Q, studies: [{ id: 's3', title: 'Study 3', copy: 'no', checked: true }] })).toEqual([]);
  });

  it('after Save as new: the new geometry, the old one kept, and each copy (or why it failed)', () => {
    const t = savedAsNewText('Demo 1 v2', 'Demo 1', [
      { studyId: 's1', title: 'Study 1', ok: true, newTitle: 'Steady-state 2', lost: [{ item: 'Top', label: 'Boss end', name: 'F:boss:end' }], claimedTwice: [] },
      { studyId: 's2', title: 'Study 2', ok: false, error: 'its faces could not be matched' },
    ]);
    expect(t.title).toBe('Demo 1 v2 added');
    expect(t.copy.split('\n')).toEqual([
      'Demo 1 v2 added. Demo 1 and its studies are kept as they were.',
      'Copied the setup of Study 1 onto it, as Steady-state 2.',
      'These faces are not on the new shape. Each one stays listed on its record:',
      "Top: 'Boss end'",
      "Couldn't copy the setup of Study 2: its faces could not be matched",
    ]);
  });

  it('a copy that kept its study\'s title does not repeat the name', () => {
    const t = savedAsNewText('Part 1 v2', 'Part 1', [
      { studyId: 's1', title: 'Incompressible Steady-state', ok: true, newTitle: 'Incompressible Steady-state', lost: [], claimedTwice: [] },
    ]);
    expect(t.copy.split('\n')).toEqual([
      'Part 1 v2 added. Part 1 and its studies are kept as they were.',
      'Copied the setup of Incompressible Steady-state onto it.',
    ]);
  });
});

describe('the dialog', () => {
  it('shows each study with its copy box, the one shown last checked, a refused copy disabled with why; Save as new answers the boxes checked', async () => {
    const p = showLinkChoice(Q);
    await vi.waitFor(() => expect(document.getElementById('modal-link-choice')!.hidden).toBe(false));
    expect(document.getElementById('lc-heading')!.textContent).toBe('Demo 1 has a new shape');
    const boxes = [...document.querySelectorAll<HTMLInputElement>('#lc-copies input')];
    expect(boxes.map((b) => [b.value, b.checked, b.disabled])).toEqual([
      ['s1', true, false],
      ['s2', false, false],
      ['s3', false, true],
    ]);
    expect(document.getElementById('lc-copies')!.textContent).toContain('Demo 1 is still updating');
    expect(document.activeElement).toBe(document.getElementById('lc-new'));
    boxes[1].checked = true;
    (document.getElementById('lc-new') as HTMLButtonElement).click();
    await expect(p).resolves.toEqual({ choice: 'new', copy: ['s1', 's2'] });
    expect(document.getElementById('modal-link-choice')!.hidden).toBe(true);
  });

  it('plugin_needed: Overwrite is disabled and says why; Save as new still answers', async () => {
    const blocked = { code: 'plugin_needed', message: 'Turn BC demo on, then update Demo 1 from Demo 1 again. Demo 1 keeps its last update.' };
    const p = showLinkChoice({ ...Q, overwrite: blocked });
    await vi.waitFor(() => expect(document.getElementById('modal-link-choice')!.hidden).toBe(false));
    const over = document.getElementById('lc-overwrite') as HTMLButtonElement;
    expect(over.disabled).toBe(true);
    expect(document.getElementById('lc-overwrite-line')!.textContent).toBe(blocked.message);
    over.click();
    expect(document.getElementById('modal-link-choice')!.hidden).toBe(false);
    (document.getElementById('lc-new') as HTMLButtonElement).click();
    await expect(p).resolves.toEqual({ choice: 'new', copy: ['s1'] });
  });

  it('Overwrite and Keep editing (the button and Escape) answer; an asker that goes away drops it unanswered', async () => {
    let p = showLinkChoice(Q);
    await vi.waitFor(() => expect(document.getElementById('modal-link-choice')!.hidden).toBe(false));
    (document.getElementById('lc-overwrite') as HTMLButtonElement).click();
    await expect(p).resolves.toEqual({ choice: 'overwrite' });
    p = showLinkChoice(Q);
    await vi.waitFor(() => expect(document.getElementById('modal-link-choice')!.hidden).toBe(false));
    fireEvent.keyDown(document, { key: 'Escape' });
    await expect(p).resolves.toEqual({ choice: 'cancel' });
    const ac = new AbortController();
    p = showLinkChoice(Q, { signal: ac.signal });
    await vi.waitFor(() => expect(document.getElementById('modal-link-choice')!.hidden).toBe(false));
    ac.abort();
    await expect(p).resolves.toBeNull();
  });

  it('sends the answer to the choose route and refuses with its code', async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, body: JSON.parse(String(init.body)) });
        return seen.length === 1
          ? new Response(JSON.stringify({ ok: true, job_id: 'gl-x', geometry_id: 'g2', created: true }), { status: 202 })
          : new Response(JSON.stringify({ ok: false, code: 'not_choosing', error: 'This question was already answered.' }), { status: 409 });
      }),
    );
    const scope = { projectId: 'p1', plugin: 'link-demo', studyId: 'st-1', jobId: 'gl-x' };
    await expect(sendLinkChoice(scope, { choice: 'new', copy: ['s1'] })).resolves.toMatchObject({ geometry_id: 'g2', created: true });
    expect(seen[0]).toEqual({
      url: '/api/plugin-geometry/choose?project_id=p1',
      body: { project_id: 'p1', plugin: 'link-demo', study_id: 'st-1', job_id: 'gl-x', choice: 'new', copy: ['s1'] },
    });
    await expect(sendLinkChoice(scope, { choice: 'overwrite' })).rejects.toMatchObject({ code: 'not_choosing' });
  });
});

describe('the rows', () => {
  const LINK: GeomLink = {
    plugin: 'link-demo',
    studyId: 'st-1',
    studyTitle: 'Demo 3',
    workspace: 'demo',
    studyScopeKey: 'k',
    sourceState: 'ok',
    behind: false,
    updating: false,
    lostFaces: 0,
    rev: 1,
  };

  it('the geometry row says "Waiting for your choice: <Study> changed" while a question waits, and "Adding <Geometry> v2…" while Save as new runs', () => {
    expect(linkStatusText('Demo 3', LINK, { status: 'choosing', stage: null, label: null })).toBe('Waiting for your choice: Demo 3 changed');
    expect(linkStatusText('Demo 3', LINK, { status: 'running', stage: 'meshing', label: null, adding: 'Demo 3 v2' })).toBe('Adding Demo 3 v2…');
  });

  it('the plugin study row says "→ <geometry>" for the geometry it links now (not an earlier version), else "Not in the simulation yet"', () => {
    const doc: ProjectTreeDoc = {
      project_id: 'p1',
      geometries: [
        { id: 'g2', name: 'Demo 1 v2', source: { plugin: 'link-demo', study_id: 'st-1' }, unlinked: false, studies: [] },
        { id: 'g1', name: 'Demo 1', source: { plugin: 'link-demo', study_id: 'st-1' }, unlinked: true, studies: [] },
      ],
    };
    const linked = linkedGeometryByStudy(doc);
    expect(linked).toEqual({ 'link-demo|st-1': { id: 'g2', name: 'Demo 1 v2' } });
    const row = (id: string, title: string) => ({
      id,
      plugin: 'link-demo',
      plugin_name: 'Link demo',
      kind: 'demo',
      kind_title: 'Demo',
      icon: '',
      workspace: 'demo',
      title,
      rev: 1,
      available: true,
      read_only: false,
      reason: '',
      scope_key: `p:p1/plugin:link-demo/study:${id}`,
    });
    render(
      <PluginStudiesView
        projectId="p1"
        studies={[row('st-1', 'Demo 1'), row('st-2', 'Demo 2')]}
        kinds={[{ plugin: 'link-demo', plugin_name: 'Link demo', key: 'demo', title: 'Demo', icon: '', workspace: 'demo', links_geometry: true }]}
        linked={linked}
      />,
    );
    expect(screen.getByText('→ Demo 1 v2').getAttribute('data-plugin-study-geometry')).toBe('g2');
    expect(screen.getByText('Not in the simulation yet')).toBeTruthy();
  });
});
