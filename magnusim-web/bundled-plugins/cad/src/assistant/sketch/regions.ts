// A built sketch's regions as the Assistant names them (CAD tools spec §6.6): ids r1, r2, ... by
// area, largest first; regions of one area (to 1e-9 of it: the kernel's areas of equal holes differ
// in their last bits) by where they sit, their box's centre (u, then v), then their inside point;
// and each region's depth: the number of holes it lies in. A region lies in a hole of another when
// its outer loop shares a piece with that hole, or with a region that lies in it there: so the
// pieces of a hole that crossing curves split (two overlapping holes, a keyhole, a line across a
// hole) all lie in it, not only a piece that is the whole hole (spec: the outer loop equals the
// hole). Even depths are material when a tool takes "all": a plate with holes extrudes as the
// plate (its holes open, overlapping or split ones too), a ring as a ring, an island in a hole as
// material again; shapes that overlap with nothing around them are their union.
// The triangles are left out.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec2 } from '../../types/doc';
import type { SketchOutput } from '../../types/sketch';
import { len, sig6 } from '../numbers';

export interface RegionRow {
  /** "r1", "r2", ...: per output, by area (largest first), then by where it sits. */
  id: string;
  /** The region's key (survives dimension and parameter changes). */
  key: string;
  area_mm2: number;
  /** A point inside it (mm, sketch u, v). */
  at: Vec2;
  /** Its hole loops. */
  holes: number;
  /** 0 for an outer region; one more for each hole it lies in. */
  depth: number;
  bbox_uv: [Vec2, Vec2];
  /** The sketch entities on its boundary (stored ids). */
  entities: string[];
}

type Region = SketchOutput['regions'][number];

/** A loop's token without its sign (a hole's piece is a piece of the outer loop of a region inside it). */
const piece = (t: string) => t.replace(/^[+-]/, '');

/** Areas this close (relative) are one area. */
const SAME_AREA = 1e-9;
/** Box centres this close (mm) are one place. */
const SAME_AT = 1e-6;

const centre = (r: Region): Vec2 => [(r.bbox[0] + r.bbox[2]) / 2, (r.bbox[1] + r.bbox[3]) / 2];

/** Largest first; one area by box centre (u, then v), then inside point. */
function ordered(list: readonly Region[]): Region[] {
  const byArea = [...list].sort((a, b) => b.area - a.area);
  const byPlace = (a: Region, b: Region) => {
    const [ca, cb] = [centre(a), centre(b)];
    for (const k of [0, 1] as const) if (Math.abs(ca[k] - cb[k]) > SAME_AT) return ca[k] - cb[k];
    return a.sample[0] - b.sample[0] || a.sample[1] - b.sample[1];
  };
  const out: Region[] = [];
  for (let i = 0; i < byArea.length; ) {
    let j = i + 1;
    while (j < byArea.length && byArea[i].area - byArea[j].area <= SAME_AREA * Math.abs(byArea[i].area)) j++;
    out.push(...byArea.slice(i, j).sort(byPlace));
    i = j;
  }
  return out;
}

export function regionRows(out: Pick<SketchOutput, 'regions'>): RegionRow[] {
  const regions = ordered(out.regions ?? []);
  // The regions each piece bounds from outside them (by their outer loops).
  const outerOf = new Map<string, number[]>();
  regions.forEach((r, i) => {
    for (const t of r.loops[0] ?? []) {
      const k = piece(t);
      const list = outerOf.get(k);
      if (list) list.push(i);
      else outerOf.set(k, [i]);
    }
  });
  // Each region's parent: the region whose hole it lies in. From each hole, the regions across its
  // pieces, then those sharing a piece of their outer loops with them (the hole's other pieces):
  // two regions that share a piece of both outer loops lie side by side, in the same holes.
  const parent = regions.map(() => -1);
  regions.forEach((q, qi) => {
    for (const hole of q.loops.slice(1)) {
      const queue: number[] = [];
      const reach = (tokens: readonly string[]) => {
        for (const t of tokens) {
          for (const j of outerOf.get(piece(t)) ?? []) {
            if (j === qi || parent[j] !== -1) continue;
            parent[j] = qi;
            queue.push(j);
          }
        }
      };
      reach(hole);
      while (queue.length) reach(regions[queue.pop()!].loops[0] ?? []);
    }
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
