export interface PlaneSpec {
  origin: [number, number, number];
  normal: [number, number, number];
}

export function planeId(index: number): `cut_plane:${string}` {
  return `cut_plane:${index}`;
}
