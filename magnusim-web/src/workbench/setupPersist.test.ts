/**
 * The BC editor's and the mesh form's saves (phase 5, C2 §6.3): saveBoundary sends only the open
 * record (`only_id`) with the rev it was loaded with (`base_rev`), and stores the new rev from
 * the answer, so the person's next quick save sends that one; a refusal as stale reads the BCs
 * again, tells the person, answers null, and drops the saves queued behind it. saveMeshSettings
 * sends a form save's base_rev (not a rename's or a Restore defaults'), and a refusal reloads
 * the mesh and tells the person.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('./geometryRev', () => ({
  linkedWorkerRpc: (method: string, params: unknown) => rpc(method, params),
  stampRecords: (list: unknown[]) => list,
}));
const notice = vi.fn(async (_kind: string, _id: string, _name: string) => undefined);
const released = vi.fn();
vi.mock('./staleNotice', () => ({ showStaleNotice: (kind: string, id: string, name: string) => notice(kind, id, name), releaseFocus: () => released() }));

import { bcCatalog, meshCatalog } from './catalogs.js';
import { bindSetupHost, saveBoundary, saveMeshSettings } from './setupPersist.js';

type Rec = Record<string, unknown>;
const stale = () => Object.assign(new Error('This was changed elsewhere.'), { code: 'stale_record', kind: 'bc', id: 'bc-1', rev: 5 });

let draft: Rec;
const applied: Rec[] = [];
const reread = vi.fn(async () => undefined);
const reloadMesh = vi.fn(async (_id: string) => undefined);

beforeEach(() => {
  rpc.mockReset();
  notice.mockClear();
  reread.mockClear();
  reloadMesh.mockClear();
  applied.length = 0;
  bcCatalog.bcs = [
    { id: 'bc-1', name: 'Inlet', bc_type: 'Velocity inlet', velocity: 4, rev: 4 },
    { id: 'bc-2', name: 'Outlet', bc_type: 'Pressure outlet', rev: 2 },
  ];
  bcCatalog._persistGen = 0;
  draft = { id: 'bc-1', name: 'Inlet', bc_type: 'Velocity inlet', velocity: 12, faces: [], project_id: 'p1', simulation_id: 's1', rev: 4 };
  bindSetupHost({
    viewingBcId: () => 'bc-1',
    readBcEditorDraft: (id?: string) => (id && draft.id && id !== draft.id ? { ...(bcCatalog.bcs as Rec[]).find((b) => b.id === id), project_id: 'p1', simulation_id: 's1', faces: [] } : { ...draft }),
    applyBcRecords: (doc: Rec) => {
      applied.push(doc);
      bcCatalog.bcs = (doc.boundary_conditions as Rec[]).map((r) => ({ ...r }));
    },
    rereadBcRecords: reread,
    currentStudyId: () => 's1',
    reloadMeshRecord: reloadMesh,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const answer = (rev: number, velocity: unknown = 12): Rec => ({
  boundary_conditions: [
    { id: 'bc-1', name: 'Inlet', bc_type: 'Velocity inlet', velocity, rev },
    { id: 'bc-2', name: 'Outlet', bc_type: 'Pressure outlet', rev: 2 },
  ],
});

describe('saveBoundary', () => {
  it('sends only the open record with only_id and base_rev, and stores the new rev', async () => {
    rpc.mockResolvedValueOnce(answer(5));
    await saveBoundary('bc-1');
    expect(rpc).toHaveBeenCalledTimes(1);
    const [method, params] = rpc.mock.calls[0] as [string, { body: { boundary_conditions: Rec[]; only_id: string } }];
    expect(method).toBe('bcs.set');
    expect(params.body.only_id).toBe('bc-1');
    expect(params.body.boundary_conditions).toHaveLength(1);
    expect(params.body.boundary_conditions[0]).toMatchObject({ id: 'bc-1', velocity: 12, base_rev: 4 });
    expect('rev' in params.body.boundary_conditions[0]).toBe(false);
    expect((bcCatalog.bcs as Rec[])[0].rev).toBe(5);
  });

  it("a BC that is not open is saved from its own record, and the open editor is not shown it (seen: a hot wall's temperature dropped)", async () => {
    (bcCatalog.bcs as Rec[])[1].value = 101325;
    rpc.mockResolvedValueOnce(answer(5));
    await saveBoundary('bc-2');
    expect(rpc).toHaveBeenCalledTimes(1);
    const params = (rpc.mock.calls[0] as [string, { body: { boundary_conditions: Rec[]; only_id: string } }])[1];
    expect(params.body.only_id).toBe('bc-2');
    expect(params.body.boundary_conditions).toEqual([expect.objectContaining({ id: 'bc-2', value: 101325, base_rev: 2 })]);
    expect(applied).toHaveLength(0);
  });

  it("two quick saves of one BC: the second sends the rev the first one's answer stored", async () => {
    let release: (v: Rec) => void = () => undefined;
    rpc.mockImplementationOnce(() => new Promise((r) => (release = r)));
    rpc.mockResolvedValueOnce(answer(6, 13));
    const one = saveBoundary('bc-1');
    draft = { ...draft, velocity: 13 };
    const two = saveBoundary('bc-1');
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    release(answer(5));
    await one;
    await two;
    expect(rpc).toHaveBeenCalledTimes(2);
    const second = (rpc.mock.calls[1] as [string, { body: { boundary_conditions: Rec[] } }])[1];
    expect(second.body.boundary_conditions[0]).toMatchObject({ velocity: 13, base_rev: 5 });
  });

  it("two quick saves of one BC: the first one's answer, older than the second edit, is not shown over it", async () => {
    let release: (v: Rec) => void = () => undefined;
    rpc.mockImplementationOnce(() => new Promise((r) => (release = r)));
    rpc.mockResolvedValueOnce(answer(6, 13));
    const one = saveBoundary('bc-1');
    draft = { ...draft, velocity: 13 };
    const two = saveBoundary('bc-1');
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    release(answer(5));
    await one;
    // The editor still shows 13: the first answer (velocity 12) was not applied.
    expect(applied).toHaveLength(0);
    await two;
    expect(applied.map((d) => (d.boundary_conditions as Rec[])[0].velocity)).toEqual([13]);
  });

  it('keeps the new rev even when a newer save makes the answer old', async () => {
    rpc.mockResolvedValueOnce(answer(5));
    bcCatalog._persistGen = 0;
    const p = saveBoundary('bc-1');
    // Another BC's save started meanwhile (the gen moved): this answer is not applied whole.
    bcCatalog._persistGen = 40;
    await p;
    expect((bcCatalog.bcs as Rec[]).find((r) => r.id === 'bc-1')?.rev).toBe(5);
  });

  it('a refusal as stale reads the BCs again, tells the person, answers null, and drops the saves queued behind it', async () => {
    let refuse: (e: unknown) => void = () => undefined;
    rpc.mockImplementationOnce(() => new Promise((_r, j) => (refuse = j)));
    const one = saveBoundary('bc-1');
    const queued = saveBoundary('bc-1');
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    refuse(stale());
    await expect(one).resolves.toBeNull();
    await expect(queued).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(reread).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith('bc', 'bc-1', 'Inlet');
    expect(applied).toHaveLength(0);
    // A save made after the refusal (the panel shows the saved values) goes out.
    rpc.mockResolvedValueOnce(answer(6, 7));
    await saveBoundary('bc-1');
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('another error is thrown as before', async () => {
    rpc.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '' }));
    await expect(saveBoundary('bc-1')).rejects.toThrow('boom');
    expect(notice).not.toHaveBeenCalled();
  });

  it('a record with no id yet is saved with the whole list, as before', async () => {
    draft = { name: 'New', bc_type: 'Wall', faces: [], project_id: 'p1' };
    bcCatalog.bcs = [...(bcCatalog.bcs as Rec[]), { name: 'New', bc_type: 'Wall' }];
    rpc.mockResolvedValueOnce(answer(1));
    await saveBoundary('');
    const params = (rpc.mock.calls[0] as [string, { body: Rec }])[1];
    expect('only_id' in params.body).toBe(false);
    expect((params.body.boundary_conditions as Rec[]).length).toBe(3);
  });
});

describe('saveMeshSettings', () => {
  const posts: Rec[] = [];
  function meshHost(rev: number | null) {
    bindSetupHost({
      viewingMeshId: () => 'm1',
      settingsOwnedByMesh: () => ({ fineness: 3 }),
      meshDisplayName: () => 'Mesh 1',
      currentMeshProjectId: () => 'p1',
      currentMeshStudyIds: () => ({ simulation_id: 's1' }),
      findMeshRecord: () => (rev === null ? { id: 'm1', name: 'Mesh 1' } : { id: 'm1', name: 'Mesh 1', rev }),
      cloneMeshSettings: (s: Rec) => s,
      updateMeshListEntry: () => undefined,
      rememberMeshDraft: () => undefined,
      applyMeshRecord: () => undefined,
      publishMesh: (o: Rec) => o,
      reloadMeshRecord: reloadMesh,
    });
  }
  function fetchAnswers(...answers: Array<[number, Rec]>) {
    posts.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        posts.push(JSON.parse(init.body));
        const [status, body] = answers.shift() ?? [200, { ok: true }];
        return new Response(JSON.stringify(body), { status });
      }),
    );
  }

  it("a form save sends the mesh's base_rev; a rename and Restore defaults send none", async () => {
    meshHost(3);
    meshCatalog.active_id = 'm1';
    fetchAnswers([200, { ok: true }], [200, { ok: true }], [200, { ok: true }]);
    await saveMeshSettings({ mesh_id: 'm1', fineness: 4 });
    await saveMeshSettings({ mesh_id: 'm1', name: 'Fine', nameOnly: true });
    await saveMeshSettings({ mesh_id: 'm1', use_bank_defaults: true });
    expect(posts.map((p) => p.base_rev)).toEqual([3, undefined, undefined]);
  });

  it('a refusal as stale reloads the mesh, tells the person, and throws stale_record', async () => {
    meshHost(3);
    fetchAnswers([409, { ok: false, code: 'stale_record', kind: 'mesh', id: 'm1', rev: 4, error: 'This was changed elsewhere.' }]);
    await expect(saveMeshSettings({ mesh_id: 'm1', fineness: 4 })).rejects.toMatchObject({ code: 'stale_record' });
    expect(reloadMesh).toHaveBeenCalledWith('m1');
    expect(notice).toHaveBeenCalledWith('mesh', 'm1', 'Mesh 1');
  });

  it('a mesh with no rev yet sends none', async () => {
    meshHost(null);
    fetchAnswers([200, { ok: true }]);
    await saveMeshSettings({ mesh_id: 'm1', fineness: 4 });
    expect('base_rev' in posts[0]).toBe(false);
  });
});
