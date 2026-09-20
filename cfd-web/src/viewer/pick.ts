export interface PickHit {
  x: number;
  y: number;
  z: number;
  cellId?: number;
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
