import { bcCatalog, meshCatalog } from './catalogs.js';
import { linkedWorkerRpc, stampRecords } from './geometryRev';
import { isStaleRecord, revOf, serialSave, withBaseRev } from './recordRev';
import { releaseFocus, showStaleNotice } from './staleNotice';

const host = {
  viewingBcId: () => '',
  readBcEditorDraft: () => null,
  applyBcRecords: () => {},
  rereadBcRecords: async () => {},
  reloadMeshRecord: async () => {},
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

/** Saves of a BC refused as stale, by BC: a save queued before a refusal is dropped with it. */
const bcRefusals = new Map();

/**
 * Save the open BC: only that record (`only_id`), with the rev it was loaded with
 * (`base_rev`, C2). Saves of one BC run one at a time and each reads the rev when it is
 * sent, so the person's own quick edits never refuse each other. A record changed since
 * (by the Assistant, or another window) is refused: the BCs are read again and the
 * person is told (staleNotice.ts); the answer is then null.
 */
export async function saveBoundary(expectedId) {
  if (bcCatalog._createWait) {
    try {
      await bcCatalog._createWait;
    } catch (_) {}
  }
  const viewId = expectedId || host.viewingBcId();
  // The named BC's record, open or not. A save writes only its own record (only_id), so a BC
  // changed while another was open used to be dropped here (seen: a heated cavity's hot wall
  // saved with no temperature, set while the cold wall's editor was open).
  const draft = host.readBcEditorDraft(viewId);
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
  const ownerId = draft.id;
  const key = String(ownerId || draft.name || '');
  const epoch = bcRefusals.get(key) || 0;
  // Counted when the person's edit asks for the save, not when its turn in the queue comes: an
  // earlier save's answer, older than an edit made since, is then not shown over that edit.
  const gen = (bcCatalog._persistGen = (bcCatalog._persistGen || 0) + 1);
  return serialSave('bc:' + key, async () => {
    if ((bcRefusals.get(key) || 0) !== epoch) return null;
    const simId = String(draft.simulation_id || host.currentStudyId() || '');
    // The rev as the catalog has it now: an earlier save's answer moved it.
    const stored = (bcCatalog.bcs || []).find(same) || null;
    const body = ownerId
      ? {
          // This record only: the server writes it onto its stored list (C2).
          boundary_conditions: stampRecords([withBaseRev({ ...(stored || {}), ...draft }, stored)]),
          simulation_id: simId,
          only_id: ownerId,
        }
      : {
          // A record with no id yet: the whole list, as before.
          boundary_conditions: stampRecords((bcCatalog.bcs || []).map((b) => (same(b) ? { ...b, ...draft } : b))),
          simulation_id: simId,
        };
    let doc;
    try {
      // Each record carries the rev its faces were drawn at (a linked geometry's stamp).
      // BC records only: the wall default is saved by the Defaults panel alone.
      doc = await linkedWorkerRpc('bcs.set', { project_id: draft.project_id, sim_id: simId, body });
    } catch (e) {
      if (!isStaleRecord(e)) throw e;
      releaseFocus();
      bcRefusals.set(key, epoch + 1);
      await host.rereadBcRecords();
      await showStaleNotice('bc', String(ownerId || ''), String(draft.name || (stored && stored.name) || ''));
      return null;
    }
    // The saved record's new rev, even when a newer save makes this answer's list old.
    const saved = ((doc && doc.boundary_conditions) || []).find((b) => b && ownerId && String(b.id) === String(ownerId));
    const now = (bcCatalog.bcs || []).find(same);
    if (saved && now && revOf(saved) !== null) now.rev = revOf(saved);
    if (gen !== bcCatalog._persistGen) return doc;
    if (host.viewingBcId() && ownerId && String(host.viewingBcId()) !== String(ownerId)) return doc;
    host.applyBcRecords({ ...doc, ok: true, project_id: draft.project_id }, draft.project_id);
    return doc;
  });
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
  // A form's save sends every setting it shows: it carries the rev the mesh was loaded with
  // (C2), read when it is sent. A rename or Restore defaults changes what it names whatever
  // was loaded, and sends none.
  const checked = fromForm && !body.nameOnly && !body.use_bank_defaults && !body.reset_defaults;
  return serialSave('mesh:' + String(meshId || ''), async () => {
    const send = { ...host.currentMeshStudyIds(), ...body };
    delete send.base_rev;
    const rev = checked && meshId ? revOf(host.findMeshRecord(meshId)) : null;
    if (rev !== null) send.base_rev = rev;
    const r = await fetch('/api/mesh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(send),
    });
    const j = await r.json();
    if (r.status === 409 && isStaleRecord(j)) {
      // Changed since the panel loaded it: show what is saved, then say so.
      releaseFocus();
      await host.reloadMeshRecord(meshId);
      const rec = host.findMeshRecord(meshId);
      await showStaleNotice('mesh', String(meshId || ''), String((rec && rec.name) || body.name || ''));
      throw Object.assign(new Error(j.error || 'This was changed elsewhere.'), { code: 'stale_record' });
    }
    if (!r.ok || !j.ok) {
      meshCatalog.note = (j && j.error) || 'Mesh save failed';
      host.publishMesh({ ready: false, note: meshCatalog.note });
      throw new Error(meshCatalog.note);
    }
    host.applyMeshRecord(j, j.project_id);
    meshCatalog.bank_exact = !!j.bank_exact;
    return host.publishMesh({ saved: true });
  });
}
