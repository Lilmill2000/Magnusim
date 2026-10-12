// Editing a project geometry (host API 1.7), the host side: the context's geometry and
// one-shot launch, project.geometrySource / geometryFaces over the bridge, the link's
// originalNames, and the client module of the geometry actions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyRecord } from '../plugin-sdk/workspace';
import { BridgeError, linkBody, WorkspaceCalls, type BridgeHooks, type BridgeScope } from './bridge';
import {
  actionsFor,
  dropLaunch,
  geometryActionsNow,
  geometryOriginalNow,
  launchFor,
  openGeometryAction,
  rememberTreeActions,
  resetGeometryActionsForTests,
  withGeometryRemoveNote,
} from './geometryActions';

const SCOPE: BridgeScope = { plugin: 'cad', pluginName: 'Magnusim CAD', workspace: 'cad', projectId: 'proj-a', projectTitle: 'A', studyId: 'st-1' };
const STUDY = { id: 'st-1', kind: 'part', title: 'box', rev: 1 } as unknown as StudyRecord;
const GEOMETRY = { id: 'g1', name: 'box', format: 'step', fileName: 'box.step', linked: false, rev: 0, bodies: 1, faces: 6 };
const SHA = 'cd'.repeat(32);

function hooks(): BridgeHooks {
  return {
    back: vi.fn(async () => true),
    setDirty: vi.fn(),
    connected: vi.fn(),
    studyChanged: vi.fn(),
    studyGone: vi.fn(),
    toast: vi.fn(),
    confirm: vi.fn(async () => true),
    prompt: vi.fn(async () => null),
    units: vi.fn(() => 'metric' as const),
    log: vi.fn(),
    openResults: vi.fn(async () => true),
  };
}

let urls: string[] = [];
let answer: (url: string, init: RequestInit) => Response | Promise<Response>;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

beforeEach(() => {
  urls = [];
  answer = (url) => {
    if (url.startsWith('/api/plugin-studies/get')) return json({ ok: true, study: STUDY });
    if (url.startsWith('/api/plugin-geometry/target')) return json({ ok: true, geometry: GEOMETRY });
    return json({ ok: true });
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      urls.push(url);
      return answer(url, init);
    }),
  );
  resetGeometryActionsForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the context (1.7)', () => {
  it('carries the geometry the study edits and, once, what was right-clicked', async () => {
    let launch: { face?: string } | null = { face: 'face 6@Body1' };
    const c = new WorkspaceCalls(SCOPE, hooks(), { get: () => launch, drop: () => (launch = null) });
    const first = await c.context();
    expect(first.hostVersion).toBe('1.7');
    expect(first.geometry).toEqual(GEOMETRY);
    expect(first.launch).toEqual({ face: 'face 6@Body1' });
    expect(urls.some((u) => u === '/api/plugin-geometry/target?project_id=proj-a&plugin=cad&study_id=st-1')).toBe(true);
    // A reload of the page (a new hello) gets no launch.
    expect((await c.context()).launch).toBe(null);
  });

  it('a study that edits nothing, or an app that cannot say, has geometry null', async () => {
    answer = (url) => (url.startsWith('/api/plugin-studies/get') ? json({ ok: true, study: STUDY }) : json({ ok: false, error: 'down' }, 503));
    const ctx = await new WorkspaceCalls(SCOPE, hooks()).context();
    expect(ctx.geometry).toBe(null);
    expect(ctx.launch).toBe(null);
  });
});

describe('project.geometrySource and project.geometryFaces (1.7)', () => {
  it('streams the STEP into one Blob with its headers, and tells the page how far', async () => {
    const bytes = new Uint8Array(300_000).fill(7);
    answer = (url) =>
      url.startsWith('/api/plugin-geometry/source')
        ? new Response(bytes, {
            status: 200,
            headers: { 'Content-Length': String(bytes.length), 'X-Sha256': SHA, 'X-File-Name': encodeURIComponent('Vortex CFD Test.step'), 'X-Geometry-Id': 'g1', 'X-Adopted': '0' },
          })
        : json({ ok: true });
    const c = new WorkspaceCalls(SCOPE, hooks());
    const pushed: Array<Record<string, unknown>> = [];
    c.setPush((m) => pushed.push(m));
    const r = (await c.handle('project.geometrySource', { formats: ['step'], token: 'tk1' })) as { blob: Blob; fileName: string; size: number; sha256: string; adopted: boolean; geometryId: string };
    expect(urls.at(-1)).toBe('/api/plugin-geometry/source?project_id=proj-a&plugin=cad&study_id=st-1&format=step');
    expect(r.blob.size).toBe(bytes.length);
    expect(r).toMatchObject({ fileName: 'Vortex CFD Test.step', size: bytes.length, sha256: SHA, adopted: false, geometryId: 'g1', format: 'step' });
    const last = pushed.at(-1) as { event: string; data: { token: string; done: number; total: number } };
    expect(last).toEqual({ event: 'sourceProgress', data: { token: 'tk1', done: bytes.length, total: bytes.length } });
  });

  it('refuses another format, and passes the app refusal with its retryAfter', async () => {
    const c = new WorkspaceCalls(SCOPE, hooks());
    await expect(c.handle('project.geometrySource', { formats: ['iges'] })).rejects.toMatchObject({ code: 'unsupported_format' });
    answer = () => json({ ok: false, code: 'not_ready', error: 'Magnusim is still storing box.', retryAfter: 3 }, 503, { 'Retry-After': '3' });
    const err = (await c.handle('project.geometrySource', { formats: ['step'] }).catch((e) => e)) as BridgeError;
    expect(err).toBeInstanceOf(BridgeError);
    expect(err.retryAfter).toBe(3);
    expect(err.code).toBe('not_ready');
    answer = () => json({ ok: false, code: 'not_allowed', error: 'This study edits no project geometry.' }, 403);
    await expect(c.handle('project.geometrySource', {})).rejects.toMatchObject({ code: 'not_allowed' });
  });

  it('an abort from the page stops the read', async () => {
    answer = (url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        void url;
      });
    const c = new WorkspaceCalls(SCOPE, hooks());
    const p = c.handle('project.geometrySource', { token: 'tk2' });
    await c.handle('project.geometrySourceAbort', { token: 'tk2' });
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
  });

  it('answers the face table without the ok flag', async () => {
    answer = () => json({ ok: true, geometryId: 'g1', rev: 0, lengthUnit: 'mm', sourceSha256: SHA, bodies: [], faces: [] });
    const c = new WorkspaceCalls(SCOPE, hooks());
    expect(await c.handle('project.geometryFaces', {})).toEqual({ geometryId: 'g1', rev: 0, lengthUnit: 'mm', sourceSha256: SHA, bodies: [], faces: [] });
    expect(urls.at(-1)).toBe('/api/plugin-geometry/faces?project_id=proj-a&plugin=cad&study_id=st-1');
  });

  it("linkGeometry's originalNames goes to the route as original_names, checked like a file", () => {
    const body = linkBody({ shape: { rel: 's.bbrep', format: 'brep', sha256: SHA }, originalNames: { rel: 'o.json', sha256: SHA.toUpperCase() }, sourceVersion: 1, basedOnRev: null });
    expect(body.original_names).toEqual({ rel: 'o.json', sha256: SHA });
    expect(() => linkBody({ shape: { rel: 's', format: 'brep', sha256: SHA }, originalNames: { rel: 'o.json' }, sourceVersion: 1 })).toThrow(/originalNames/);
    expect('original_names' in linkBody({ shape: { rel: 's', format: 'brep', sha256: SHA }, sourceVersion: 1 })).toBe(false);
  });
});

describe('the geometry actions (client)', () => {
  const NODE = {
    id: 'g1',
    edit_actions: [
      { plugin: 'cad', plugin_name: 'Magnusim CAD', study_kind: 'part', label: 'Edit in CAD', hint: 'Open it in CAD.', places: ['tree', 'panel'], workspace: 'cad', workspace_title: 'CAD', enabled: true, reason: '' },
      { plugin: 'other', study_kind: 'x', label: 'Edit elsewhere', places: ['viewport'], enabled: false, reason: 'box is updating.' },
    ],
  };

  it('lists the actions of a place, with the reason of one that is off', () => {
    expect(actionsFor(NODE, 'tree').map((a) => a.label)).toEqual(['Edit in CAD']);
    const vp = actionsFor(NODE, 'viewport');
    expect(vp).toEqual([expect.objectContaining({ label: 'Edit elsewhere', enabled: false, reason: 'box is updating.' })]);
    expect(actionsFor(null, 'tree')).toEqual([]);
    rememberTreeActions('proj-a', [NODE, { id: 'g2', original: { file_name: 'box.step', present: true } }]);
    expect(geometryActionsNow('proj-a', 'g1', 'panel')).toHaveLength(1);
    expect(geometryActionsNow('proj-b', 'g1', 'panel')).toEqual([]);
    expect(geometryOriginalNow('proj-a', 'g2')).toEqual({ fileName: 'box.step', present: true });
  });

  it('opens the study the app picks at its address, and keeps the launch for that study once', async () => {
    answer = () => json({ ok: true, plugin: 'cad', study_id: 'st-9', workspace: 'cad', created: true });
    const open = vi.fn();
    const sync = vi.fn();
    const entry = actionsFor(NODE, 'tree')[0];
    const r = await openGeometryAction('proj-a', 'g1', entry, { launch: { face: 'face 3@Body1', body: 'Body1' }, open, sync });
    expect(r).toEqual({ ok: true, studyId: 'st-9', created: true });
    expect(open).toHaveBeenCalledWith('#/p/proj-a/ws/cad/cad/st-9');
    expect(sync).toHaveBeenCalledTimes(1);
    expect(launchFor('proj-a', 'cad', 'st-9')).toEqual({ face: 'face 3@Body1', body: 'Body1' });
    dropLaunch('proj-a', 'cad', 'st-9');
    expect(launchFor('proj-a', 'cad', 'st-9')).toBe(null);
    // A launch that is not a face or body label is not kept.
    await openGeometryAction('proj-a', 'g1', entry, { launch: { face: '<b>' }, open, sync });
    expect(launchFor('proj-a', 'cad', 'st-9')).toBe(null);
  });

  it("says why the app refused, in the action's words", async () => {
    answer = () => json({ ok: false, code: 'not_editable', error: 'box is a mesh (STL).' }, 409);
    const entry = actionsFor(NODE, 'tree')[0];
    const open = vi.fn();
    const r = await openGeometryAction('proj-a', 'g1', entry, { open });
    expect(r).toEqual({ ok: false, title: "Can't edit in CAD", message: 'box is a mesh (STL).' });
    expect(open).not.toHaveBeenCalled();
    answer = () => json({ ok: false, code: 'plugin_off', error: 'off' }, 404);
    expect((await openGeometryAction('proj-a', 'g1', entry, { open })).message).toBe('Magnusim CAD is off. Turn it on in Settings > Plugins.');
  });
});

describe('the words of an adoption (review fixes)', () => {
  const base = {
    geometryId: 'g1',
    name: 'stepped-bore',
    rev: 1,
    fromRev: 0,
    created: false,
    change: 'shape',
    bodies: 1,
    faces: 6,
    named: 6,
    match: { byName: 6, byShape: 0, split: 0, merged: 0, movedFar: 0 },
    lost: [],
    returned: [],
    stillLost: 0,
    claimedTwice: [],
    outOfDate: { meshes: [], runs: 0 },
    seconds: 1,
  };

  it('an adoption always says where the original went, as a toast when nothing needs the user', async () => {
    const { linkQuietText, linkReportText, linkNeedsAction } = await import('./linkReport');
    const adopted = { ...base, adopted: true, unverified: 0 } as never;
    expect(linkQuietText(adopted, null, 1, 'stepped-bore (2)')).toBe(
      'stepped-bore updated from stepped-bore (2). The original file is kept: Geometry panel → Add the original as a new geometry.',
    );
    expect(linkReportText(adopted, null, 1, 'Part').copy.split('\n')[0]).toBe(
      'stepped-bore updated from Part. The original file is kept: Geometry panel → Add the original as a new geometry.',
    );
    // An ordinary update with nothing to say stays quiet.
    expect(linkQuietText(base as never, null)).toBe('');
    // A BC now on an inside face: a dialog that says so.
    const setup = { movedFar: [], split: [], merged: [], stale: [], inside: [{ studyId: 's', studyTitle: 'Study 1', kind: 'bc', item: 'Inlet', faces: ['face 5@Body1'], bodies: 2 }] };
    expect(linkNeedsAction(base as never, setup)).toBe(true);
    expect(linkReportText(base as never, setup).copy).toContain("Inlet is now on an inside face (shared by 2 bodies) and won't be used. Move it in Boundary conditions.");
  });

  it("the question names the geometry when the study edits it; the delete question names both", async () => {
    const { linkChoiceText } = await import('./linkChoice');
    const q = { geometry: { id: 'g', name: 'stepped-bore' }, study: { id: 's', title: 'stepped-bore (2)' }, new_name: 'stepped-bore v2', studies: [{ id: 'x', title: 'Study 1', copy: 'ok' }], overwrite: 'ok' as const };
    expect(linkChoiceText({ ...q, edits: true }).title).toBe('stepped-bore has a new shape');
    expect(linkChoiceText(q).title).toBe('stepped-bore (2) has a new shape');
    const { deleteWords } = await import('../chrome/LeftTree');
    const row = { id: 's', plugin: 'cad', plugin_name: 'Magnusim CAD', kind: 'part', kind_title: 'Part', workspace_title: 'CAD', title: 'Vortex' } as never;
    expect(deleteWords(row, { id: 'g', name: 'Vortex' })).toEqual({
      confirm_title: 'Delete the CAD part?',
      confirm_copy: "Delete the CAD part 'Vortex'? The geometry 'Vortex' stays in the project, with its simulations.",
    });
    expect(deleteWords(row, undefined)).toEqual({});
  });
});

describe('a removed target (1.7 fix)', () => {
  it('the question: "<Geometry> was removed from the project. Add <Part> as a new geometry?", Add as new geometry, Not now, Keep editing', async () => {
    const { linkChoiceText } = await import('./linkChoice');
    const t = linkChoiceText({ kind: 'removed', geometry: { id: 'g', name: 'Vortex' }, study: { id: 's', title: 'Vortex' }, new_name: 'Vortex v2', studies: [], overwrite: 'ok' });
    expect([t.title, t.copy]).toEqual(['Vortex was removed from the project', 'Add Vortex as a new geometry?']);
    expect([t.newLabel, t.newLine, t.overwriteLabel, t.cancelLabel, t.overwriteBlocked]).toEqual([
      'Add as new geometry',
      'Adds Vortex v2 to the project.',
      'Not now',
      'Keep editing',
      null,
    ]);
    expect(t.overwriteLine).toBe('Nothing is added. Vortex stays out of the simulation; you are asked again the next time it goes back with a change.');
  });

  it('every link this host sends says it can ask (ask_removed)', () => {
    expect(linkBody({ shape: { rel: 's', format: 'brep', sha256: SHA }, sourceVersion: 1 }).ask_removed).toBe(true);
  });

  it("the remove question says the part that edits the geometry stays and won't add it back", () => {
    resetGeometryActionsForTests();
    rememberTreeActions('p1', [
      { id: 'g1', name: 'Vortex', editors: [{ title: 'Vortex', kind_title: 'Part', workspace_title: 'CAD' }] },
      { id: 'g2', name: 'plain', editors: [] },
      { id: 'g3', name: 'two', editors: [{ title: 'A', kind_title: 'Part', workspace_title: 'CAD' }, { title: 'B', kind_title: 'Part', workspace_title: 'CAD' }] },
    ]);
    const copy = 'The CAD is removed from this project.';
    expect(withGeometryRemoveNote(copy, 'p1', 'g1')).toBe(
      "The CAD is removed from this project. The CAD part 'Vortex' that edits it stays. It won't add the geometry back unless you choose to.",
    );
    expect(withGeometryRemoveNote(copy, 'p1', 'g2')).toBe(copy);
    expect(withGeometryRemoveNote(copy, 'p1', 'g3')).toBe(`${copy} The studies 'A' and 'B' that edit it stay. They won't add the geometry back unless you choose to.`);
    // Another project's tree: nothing.
    expect(withGeometryRemoveNote(copy, 'p2', 'g1')).toBe(copy);
    resetGeometryActionsForTests();
  });
});
