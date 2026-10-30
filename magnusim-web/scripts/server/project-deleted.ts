/**
 * Who hears that a project was deleted (w16-project-geometry.js deleteProject: the person's
 * delete, a folder's, the Assistant's delete tool). The Assistant drops its saved chats of it
 * (assistant-routes.ts, assistant/history.ts). The listeners are on globalThis, so a Vite
 * re-import of either side shares them; nothing runs when the module loads.
 */
type Listener = (projectId: string) => void;

const KEY = Symbol.for('magnusim.projectDeleted');

function listeners(): Set<Listener> {
  const g = globalThis as unknown as Record<symbol, Set<Listener> | undefined>;
  let set = g[KEY];
  if (!set) {
    set = new Set();
    g[KEY] = set;
  }
  return set;
}

/** Hears each project deleted, by id; returns the call that stops it. */
export function onProjectDeleted(fn: Listener): () => void {
  listeners().add(fn);
  return () => {
    listeners().delete(fn);
  };
}

/** A project was deleted: every listener hears it (one that throws stops nothing). */
export function projectDeleted(projectId: string): void {
  for (const fn of [...listeners()]) {
    try {
      fn(projectId);
    } catch {
      /* a listener never stops a delete */
    }
  }
}
