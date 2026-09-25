export interface PickHit {
  x: number;
  y: number;
  z: number;
  cellId?: number;
}

export function faceIdsFromEvent(detail: { ids?: unknown } | null | undefined): string[] {
  const ids = detail && detail.ids;
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => String(id || '').trim()).filter(Boolean);
}

export function toggleFaceId(ids: string[], id: string): string[] {
  const name = String(id || '').trim();
  if (!name) return ids.slice();
  return ids.includes(name) ? ids.filter((item) => item !== name) : [...ids, name];
}

export function removeFaceId(ids: string[], id: string): string[] {
  const name = String(id || '').trim();
  return ids.filter((item) => item !== name);
}

export function publishFaceSelection(ids: string[]): void {
  document.dispatchEvent(new CustomEvent('cfd:faces', { detail: { ids: ids.slice() } }));
}

/** Viewport and tree picks publish `cfd:faces` with the selected face ids. */
export function subscribeFacePicks(onIds: (ids: string[]) => void): () => void {
  const fn = (ev: Event) => {
    const detail = (ev as CustomEvent<{ ids?: unknown }>).detail;
    onIds(faceIdsFromEvent(detail));
  };
  document.addEventListener('cfd:faces', fn);
  return () => document.removeEventListener('cfd:faces', fn);
}

export interface BodyPick {
  name: string;
  idx: number;
}

export function bodiesFromEvent(detail: { bodies?: unknown } | null | undefined): BodyPick[] {
  const bodies = detail && detail.bodies;
  if (!Array.isArray(bodies)) return [];
  return bodies
    .map((item) => {
      const row = (item || {}) as { name?: unknown; idx?: unknown };
      return { name: String(row.name || '').trim(), idx: Number(row.idx ?? -1) };
    })
    .filter((row) => !!row.name);
}

export function publishBodySelection(bodies: BodyPick[]): void {
  document.dispatchEvent(new CustomEvent('cfd:bodies', { detail: { bodies: bodies.slice() } }));
}

/** Viewport and tree body picks publish `cfd:bodies` with the clicked bodies. */
export function subscribeBodyPicks(onBodies: (bodies: BodyPick[]) => void): () => void {
  const fn = (ev: Event) => {
    const detail = (ev as CustomEvent<{ bodies?: unknown }>).detail;
    onBodies(bodiesFromEvent(detail));
  };
  document.addEventListener('cfd:bodies', fn);
  return () => document.removeEventListener('cfd:bodies', fn);
}

export function pickAtDisplay(
  picker: { pick?: (x: number, y: number, z: number, ren: unknown) => void; getActors?: () => unknown[] },
  x: number,
  y: number,
  renderer: unknown,
): boolean {
  try {
    picker.pick?.(x, y, 0, renderer);
    const actors = picker.getActors?.() || [];
    return Array.isArray(actors) && actors.length > 0;
  } catch {
    return false;
  }
}
