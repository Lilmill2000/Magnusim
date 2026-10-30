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
// The triangles are left out. A reply lists them short by default (shortRegions): at most 8 rows
// of {id, area_mm2, at, holes}; past 8 regions, a run of one size is one row.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Vec2 } from '../../types/doc';
import type { SketchOutput } from '../../types/sketch';
import { jsonBytes, len, sig6 } from '../numbers';

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

/** Rows a short region list holds at most. */
export const SHORT_REGIONS = 8;
/**
 * Areas this close (relative) are one size in a short list. Replies give areas to 6 significant
 * digits, so these read the same anyway; equal pattern copies differ by about 1e-12 (a 96-tooth
 * wheel's teeth: the kernel's last bits), sizes drawn apart by far more than 1e-6.
 */
export const SAME_SIZE = 1e-6;

/** A region in short, or a run of one size: ids "r7..r102" (each still names its region), its first's at. */
export type ShortRegion = { id: string; area_mm2: number; at: Vec2; holes: number } | { ids: string; count: number; area_mm2: number; at: Vec2; holes: number };

const regionsIn = (r: Record<string, unknown>) => (typeof r.count === 'number' ? r.count : 1);

/**
 * The regions in short, largest first (r1 always leads): each {id, area_mm2, at, holes} while
 * there are at most `max`; past that, a run of one size (SAME_SIZE) is one row, and at most `max`
 * rows go, `more` counting the regions left out.
 */
export function shortRegions(rows: readonly RegionRow[], max = SHORT_REGIONS): { regions: ShortRegion[]; more: number } {
  const one = (r: RegionRow): ShortRegion => ({ id: r.id, area_mm2: r.area_mm2, at: r.at, holes: r.holes });
  if (rows.length <= max) return { regions: rows.map(one), more: 0 };
  const out: ShortRegion[] = [];
  let shown = 0;
  for (let i = 0; i < rows.length && out.length < max; ) {
    let j = i + 1;
    while (j < rows.length && Math.abs(rows[i].area_mm2 - rows[j].area_mm2) <= SAME_SIZE * Math.abs(rows[i].area_mm2)) j++;
    const r = rows[i];
    out.push(j - i === 1 ? one(r) : { ids: `${r.id}..${rows[j - 1].id}`, count: j - i, area_mm2: r.area_mm2, at: r.at, holes: r.holes });
    shown += j - i;
    i = j;
  }
  return { regions: out, more: rows.length - shown };
}

/**
 * A reply's region rows within `budget` bytes: their bounds go first (bounded_by), then the
 * later half of the rows at a time, counted in regions_more; the first row (r1) stays.
 */
export function fitRegions(reply: Record<string, unknown>, budget: number): void {
  const rows = () => (Array.isArray(reply.regions) ? (reply.regions as Record<string, unknown>[]) : null);
  if (jsonBytes(reply) > budget && rows()?.some((r) => 'bounded_by' in r)) reply.regions = rows()!.map(({ bounded_by: _b, ...r }) => r);
  for (let r = rows(); r && r.length > 1 && jsonBytes(reply) > budget; r = rows()) {
    const keep = Math.floor(r.length / 2);
    reply.regions_more = (Number(reply.regions_more) || 0) + r.slice(keep).reduce((n, x) => n + regionsIn(x), 0);
    reply.regions = r.slice(0, keep);
  }
}
