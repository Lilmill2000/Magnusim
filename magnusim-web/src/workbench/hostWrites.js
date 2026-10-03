/** Setup writes for run settings, refinements, and result controls. */
import { fetchLinkedSave, withGeometryRev } from './geometryRev';

export async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  let json = {};
  try {
    json = await response.json();
  } catch (_) {
    json = {};
  }
  return { response, json };
}

/** A save of face-carrying records: stamped with the rev its labels were drawn at (API 1.5). */
async function postLinkedSave(path, body, rec) {
  const response = await fetchLinkedSave(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(withGeometryRev(body ?? {}, rec)),
  });
  let json = {};
  try {
    json = await response.json();
  } catch (_) {
    json = {};
  }
  return { response, json };
}

export async function postRefinements(body) {
  return postLinkedSave('/api/mesh/refinements', body, body);
}

export async function postRunUpdate(body) {
  return postLinkedSave('/api/run/update', body, body);
}

export async function postRunStart(body) {
  return postJson('/api/run/start', body);
}

export async function postRunRename(body) {
  return postJson('/api/run/rename', body);
}
