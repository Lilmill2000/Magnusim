/** Setup writes for run settings, refinements, and result controls. */

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

export async function postRefinements(body) {
  return postJson('/api/mesh/refinements', body);
}

export async function postRunUpdate(body) {
  return postJson('/api/run/update', body);
}

export async function postRunStart(body) {
  return postJson('/api/run/start', body);
}

export async function postRunRename(body) {
  return postJson('/api/run/rename', body);
}
