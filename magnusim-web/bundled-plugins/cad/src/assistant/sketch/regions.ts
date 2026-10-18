// A built sketch's regions as the Assistant names them (CAD tools spec §6.6): ids r1, r2, ... by
// area, largest first, then by their inside point (u, then v); and each region's depth: a region
// whose outer loop is a hole of another region lies inside it (depth + 1). Even depths are
// material when a tool takes "all" (a plate with holes extrudes as the plate, a ring as a ring).
// The triangles are left out.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec2 } from '../../types/doc';
import type { SketchOutput } from '../../types/sketch';
import { len, sig6 } from '../numbers';

export interface RegionRow {
  /** "r1", "r2", ...: per output, by area (largest first), then by `at`. */
  id: string;
  /** The region's key (survives dimension and parameter changes). */
  key: string;
  area_mm2: number;
  /** A point inside it (mm, sketch u, v). */
  at: Vec2;
  /** Its hole loops. */
  holes: number;
  /** 0 for an outer region; one more for each region it lies in a hole of. */
  depth: number;
  bbox_uv: [Vec2, Vec2];
  /** The sketch entities on its boundary (stored ids). */
  entities: string[];
}

/** A loop as a set of its tokens without their signs (a hole of one region is the outer loop of another). */
const loopKey = (loop: readonly string[]) => [...loop].map((t) => t.replace(/^[+-]/, '')).sort().join(' ');

export function regionRows(out: Pick<SketchOutput, 'regions'>): RegionRow[] {
  const regions = [...(out.regions ?? [])].sort((a, b) => b.area - a.area || a.sample[0] - b.sample[0] || a.sample[1] - b.sample[1]);
  // Which region's hole each region's outer loop is.
  const holeOwner = new Map<string, number>();
  regions.forEach((r, i) => {
    for (const hole of r.loops.slice(1)) holeOwner.set(loopKey(hole), i);
  });
  const parent = regions.map((r, i) => {
    const owner = r.loops[0] ? holeOwner.get(loopKey(r.loops[0])) : undefined;
    return owner === undefined || owner === i ? -1 : owner;
  });
  const depth = (i: number): number => {
    let d = 0;
    for (let p = parent[i], guard = 0; p >= 0 && guard < regions.length; p = parent[p], guard++) d++;
    return d;
  };
  return regions.map((r, i) => ({
    id: `r${i + 1}`,
    key: r.key,
    area_mm2: sig6(r.area),
    at: [len(r.sample[0]), len(r.sample[1])],
    holes: Math.max(0, r.loops.length - 1),
    depth: depth(i),
    bbox_uv: [
      [len(r.bbox[0]), len(r.bbox[1])],
      [len(r.bbox[2]), len(r.bbox[3])],
    ],
    entities: [...r.entities],
  }));
}
