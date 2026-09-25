/**
 * Workbench handlers take the request project id.
 * A missing id is a 400. MAGNUSIM_STRICT_SCOPE=0 restores the last-opened
 * project for a local debugger. Home still reads active.json on its own.
 */
let warned = false;

export function scopeIsStrict() {
  return process.env.MAGNUSIM_STRICT_SCOPE !== '0';
}

export function projectIdOrActive(explicit, readActive) {
  const id = String(explicit === undefined || explicit === null ? '' : explicit).trim();
  if (id) return id;
  if (scopeIsStrict()) {
    throw Object.assign(new Error('project_id required'), { status: 400 });
  }
  if (!warned) {
    warned = true;
    console.warn('[scope] request has no project_id; using the last-opened project');
  }
  return typeof readActive === 'function' ? readActive() : null;
}
