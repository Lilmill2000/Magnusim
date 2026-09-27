import { workerRpc } from '../api/workerRpc';
import { bcCatalog, meshCatalog } from './catalogs.js';

const host = {
  viewingBcId: () => '',
  readBcEditorDraft: () => null,
  applyBcRecords: () => {},
  currentStudyId: () => '',
  viewingMeshId: () => '',
  settingsOwnedByMesh: (_meshId) => ({}),
  meshDisplayName: () => '',
  currentMeshProjectId: () => '',
  currentMeshStudyIds: () => ({}),
  findMeshRecord: () => null,
  cloneMeshSettings: (settings) => settings,
  updateMeshListEntry: () => {},
  rememberMeshDraft: () => {},
  applyMeshRecord: () => {},
  publishMesh: () => null,
};

/** The viewed mesh's record plus draft, named as the panel shows it. */
function viewedMeshSettings(meshId) {
  const owned = host.settingsOwnedByMesh(meshId) || {};
  return { ...owned, name: host.meshDisplayName() || owned.name };
}

export function bindSetupHost(api) {
  Object.assign(host, api || {});
}

export async function saveBoundary(expectedId) {
  if (bcCatalog._createWait) {
    try {
      await bcCatalog._createWait;
    } catch (_) {}
  }
  const viewId = expectedId || host.viewingBcId();
  const draft = host.readBcEditorDraft();
  if (!draft) return null;
  if (viewId && draft.id && String(draft.id) !== String(viewId)) return null;
  const same = (rec) => {
    if (!rec || !draft) return false;
    if (draft.id && rec.id) return String(rec.id) === String(draft.id);
    return !!(draft.name && rec.name && String(rec.name) === String(draft.name));
  };
  const live = (bcCatalog.bcs || []).find(same);
  if (live) {
    live.faces = (draft.faces || []).slice();
    live.face = live.faces[0] || null;
  }
  const gen = (bcCatalog._persistGen = (bcCatalog._persistGen || 0) + 1);
  const ownerId = draft.id;
  const simId = String(draft.simulation_id || host.currentStudyId() || '');
  const list = (bcCatalog.bcs || []).map((b) => (same(b) ? { ...b, ...draft } : b));
  const doc = await workerRpc('bcs.set', {
    project_id: draft.project_id,
    sim_id: simId,
    // BC records only: the wall default is saved by the Defaults panel alone.
    body: {
      boundary_conditions: list,
      simulation_id: simId,
    },
  });
  if (gen !== bcCatalog._persistGen) return doc;
  if (host.viewingBcId() && ownerId && String(host.viewingBcId()) !== String(ownerId)) return doc;
  host.applyBcRecords({ ...doc, ok: true, project_id: draft.project_id }, draft.project_id);
  return doc;
}

export async function saveMeshSettings(partial) {
  if (meshCatalog._createWait) {
    try {
      await meshCatalog._createWait;
    } catch (_) {}
  }
  const fromForm = !(partial && (partial.use_bank_defaults || partial.reset_defaults || partial.nameOnly));
  const meshId =
    (partial && partial.mesh_id) ||
    host.viewingMeshId() ||
    (meshCatalog && meshCatalog.active_id) ||
    (meshCatalog && meshCatalog.mesh && meshCatalog.mesh.id) ||
    undefined;
  const body = {
    use_bank_defaults: !!(partial && partial.use_bank_defaults),
    force_bank: !!(partial && (partial.force_bank || partial.use_bank_defaults)),
    project_id: host.currentMeshProjectId(),
    mesh_id: meshId,
    ...(fromForm && String(host.viewingMeshId() || '') === String(meshId || '') ? viewedMeshSettings(meshId) : {}),
    ...(partial || {}),
  };
  if (body.mesh_id && body.fineness != null) {
    const rec = host.findMeshRecord(body.mesh_id);
    const owned = host.cloneMeshSettings(
      {
        ...((rec && rec.settings) || {}),
        ...body,
        advanced: body.advanced || ((rec && rec.settings && rec.settings.advanced) || {}),
      },
      body.name || (rec && rec.name),
    );
    host.updateMeshListEntry(body.mesh_id, { settings: owned, name: owned.name });
    host.rememberMeshDraft(body.mesh_id, owned);
  }
  delete body.generate;
  delete body.remesh;
  delete body.kick;
  delete body.allowDuringGenerate;
  const r = await fetch('/api/mesh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...host.currentMeshStudyIds(), ...body }),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) {
    meshCatalog.note = (j && j.error) || 'Mesh save failed';
    host.publishMesh({ ready: false, note: meshCatalog.note });
    throw new Error(meshCatalog.note);
  }
  host.applyMeshRecord(j, j.project_id);
  meshCatalog.bank_exact = !!j.bank_exact;
  return host.publishMesh({ saved: true });
}
