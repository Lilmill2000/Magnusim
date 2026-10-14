// Refinement round the tunnel's bodies, kept up as they move: each body (or set of bodies
// close enough that their patches would overlap) gets a chain of nested patches round its
// box as it lies, sizes rounded up so a small turn does not resize them. A patch stays where it is while
// its bodies' margins stay inside it and moves by whole parent cells when they leave
// (its cells shifted with it, the newly covered ones filled from the parent); a patch that
// must change size, or bodies that join or part, are rebuilt with what the old patches held
// copied over. Everything happens at a frame's start, when every level is at the same time.
// SPDX-License-Identifier: GPL-3.0-or-later
import { bboxRings, transformRings, type Pose, type Rings } from '../geometry/polygon';
import { Refinement, type PatchRect } from './refine';
import type { FrameResult, Physics, Solver } from './solver';

export interface ManagedBody {
  id: string;
  /** The shape's key (outline, cell size, band): a change rebakes its fields. */
  key: string;
  /** Outline in coarse cells, body frame. */
  local: Rings;
  band?: number;
  /** Coarse poses at the frame's start and end. */
  from: Pose;
  to: Pose;
  /** Radius about the pivot (coarse cells). */
  r: number;
}

/** Margins round a body's box, in body lengths, per level: ahead, to the sides, behind (the near wake). */
const MARGINS = [
  { ahead: 0.25, side: 0.25, behind: 0.6 },
  { ahead: 0.06, side: 0.08, behind: 0.15 },
];
/** A patch is made this much bigger than it needs, so a body can move a little before it does. */
const SLACK = 1.15;
/** Patch sizes are rounded up to this many parent cells. */
const SIZE_STEP = 8;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Group {
  /** Member ids sorted (the group's identity) and in the order their bodies were given. */
  ids: string[];
  order: string[];
  ref: Refinement;
}

const overlap = (a: Box, b: Box) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
const union = (a: Box, b: Box): Box => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const inside = (a: Box, r: PatchRect) => a.x0 >= r.ox && a.y0 >= r.oy && a.x1 <= r.ox + r.wc && a.y1 <= r.oy + r.hc;

export class RefineManager {
  private device: GPUDevice;
  private coarse: Solver;
  private groups: Group[] = [];
  private levels = 0;
  private physics: Physics | null = null;

  constructor(device: GPUDevice, coarse: Solver) {
    this.device = device;
    this.coarse = coarse;
  }

  get depth(): number {
    return this.levels;
  }

  /** The bodies refined now. */
  get refinedIds(): Set<string> {
    return new Set(this.groups.flatMap((g) => g.ids));
  }

  /** The finest grid's cells per coarse cell. */
  get scale(): number {
    return 2 ** this.levels;
  }

  /** Drop every patch (a new grid, a reset flow, refinement off). */
  clear() {
    for (const g of this.groups) g.ref.destroy();
    this.groups = [];
    this.coarse.setPatches([]);
  }

  setPhysics(p: Physics) {
    this.physics = p;
    for (const g of this.groups) g.ref.setPhysics(p);
  }

  /** A body's margined box at a level, in that level's parent cells (`k` of them per coarse cell, origin `o`). */
  private box(b: ManagedBody, level: number, k = 1, o = { x: 0, y: 0 }): Box {
    const bb = bboxRings(transformRings(b.local, b.to));
    const L = Math.max(bb.x1 - bb.x0, bb.y1 - bb.y0) * k;
    const m = MARGINS[level];
    const X = (x: number) => k * (x - o.x);
    const Y = (y: number) => k * (y - o.y);
    return { x0: X(bb.x0) - m.ahead * L, y0: Y(bb.y0) - m.side * L, x1: X(bb.x1) + m.behind * L, y1: Y(bb.y1) + m.side * L };
  }

  /** A rectangle with slack round a box, clamped to `bounds` (null if it cannot fit). */
  private rectFor(b: Box, bounds: Box): PatchRect | null {
    const w = Math.ceil(((b.x1 - b.x0) * SLACK) / SIZE_STEP) * SIZE_STEP;
    const h = Math.ceil(((b.y1 - b.y0) * SLACK) / SIZE_STEP) * SIZE_STEP;
    let ox = Math.floor((b.x0 + b.x1) / 2 - w / 2);
    let oy = Math.floor((b.y0 + b.y1) / 2 - h / 2);
    if (w > bounds.x1 - bounds.x0 || h > bounds.y1 - bounds.y0) return null;
    ox = Math.max(bounds.x0, Math.min(bounds.x1 - w, ox));
    oy = Math.max(bounds.y0, Math.min(bounds.y1 - h, oy));
    return { ox, oy, wc: w, hc: h };
  }

  /**
   * Bring the patches up to date for a frame whose bodies end at `to` (encodes fills and
   * moves into `enc` before the frame's steps). `bounds` is where level 1 may lie (coarse
   * cells: clear of the absorbing layers).
   */
  update(enc: GPUCommandEncoder, bodies: ManagedBody[], levels: number, bounds: Box) {
    if (!this.physics) return;
    if (levels !== this.levels) {
      this.clear();
      this.levels = levels;
    }
    if (levels === 0 || !bodies.length) {
      if (this.groups.length) this.clear();
      return;
    }
    // Which bodies go together: their level-1 boxes overlap.
    const boxes = bodies.map((b) => this.box(b, 0));
    const sets: number[][] = bodies.map((_, i) => [i]);
    for (let merged = true; merged; ) {
      merged = false;
      outer: for (let a = 0; a < sets.length; a++)
        for (let b = a + 1; b < sets.length; b++) {
          const ba = sets[a].map((i) => boxes[i]).reduce(union);
          const bb = sets[b].map((i) => boxes[i]).reduce(union);
          if (overlap(ba, bb)) {
            sets[a].push(...sets[b]);
            sets.splice(b, 1);
            merged = true;
            break outer;
          }
        }
    }
    const next: Group[] = [];
    const used = new Set<Group>();
    const fineBounds = (r: PatchRect): Box => ({ x0: 4, y0: 4, x1: 2 * r.wc - 4, y1: 2 * r.hc - 4 });
    for (const set of sets) {
      const members = set.map((i) => bodies[i]);
      const ids = members.map((b) => b.id).sort();
      const want1 = set.map((i) => boxes[i]).reduce(union);
      const old = this.groups.find((g) => !used.has(g) && g.ids.join('|') === ids.join('|'));
      let group: Group | null = null;
      if (old) {
        used.add(old);
        group = this.keep(enc, old, members, want1, bounds, fineBounds);
      }
      if (!group) {
        const r1 = this.rectFor(want1, bounds);
        if (!r1) continue; // too near the tunnel's ends or walls to refine: the coarse grid carries it
        const rects = [r1];
        if (levels > 1) {
          const p = members.map((b) => this.box(b, 1, 2, { x: r1.ox, y: r1.oy })).reduce(union);
          const r2 = this.rectFor(p, fineBounds(r1));
          if (r2) rects.push(r2);
        }
        const ref = new Refinement(this.device, this.coarse, rects, this.physics, false);
        // Copy what an old group of any of these bodies had (they joined or parted, or it grew).
        const prev = this.groups.find((g) => !used.has(g) && g.ids.some((id) => ids.includes(id)));
        ref.encodeFill(enc, prev?.ref ?? null);
        group = { ids, order: [], ref };
      }
      group.order = members.map((b) => b.id);
      group.ref.setBodies(members.map((b) => ({ key: b.key, local: b.local, band: b.band, from: b.from, to: b.to })));
      next.push(group);
    }
    for (const g of this.groups) if (!next.includes(g)) g.ref.destroy();
    this.groups = next;
    this.coarse.setPatches(next.map((g) => g.ref.levels[0]));
  }

  /** Keep a group's chain: move its patches if their bodies left them; null if it must be rebuilt. */
  private keep(enc: GPUCommandEncoder, g: Group, members: ManagedBody[], want1: Box, bounds: Box, fineBounds: (r: PatchRect) => Box): Group | null {
    const l1 = g.ref.levels[0];
    const big = (want: Box, r: PatchRect) => (want.x1 - want.x0) * (want.y1 - want.y0) * SLACK * SLACK < 0.5 * r.wc * r.hc;
    if (big(want1, l1.rect)) return null;
    if (!inside(want1, l1.rect)) {
      const r = this.rectFor(want1, bounds);
      if (!r || r.wc !== l1.rect.wc || r.hc !== l1.rect.hc) return null;
      const dx = r.ox - l1.rect.ox;
      const dy = r.oy - l1.rect.oy;
      l1.encodeMoveTo(enc, r.ox, r.oy);
      // The level below sits on level 1's cells, which just moved: same place, new numbers.
      g.ref.levels[1]?.shiftOrigin(-2 * dx, -2 * dy);
    }
    const l2 = g.ref.levels[1];
    if (l2) {
      const r1 = l1.rect;
      const want2 = members.map((b) => this.box(b, 1, 2, { x: r1.ox, y: r1.oy })).reduce(union);
      if (!inside(want2, l2.rect) || l2.rect.ox < 2 || l2.rect.oy < 2 || l2.rect.ox + l2.rect.wc > 2 * r1.wc - 2 || l2.rect.oy + l2.rect.hc > 2 * r1.hc - 2) {
        const r = this.rectFor(want2, fineBounds(r1));
        if (!r || r.wc !== l2.rect.wc || r.hc !== l2.rect.hc) return null;
        l2.encodeMoveTo(enc, r.ox, r.oy);
      }
    }
    return g;
  }

  /** The bodies' forces from the finest level round them, for a frame of `count` coarse steps (by body id). */
  prepareRead(enc: GPUCommandEncoder, count: number): () => Promise<{ byId: Map<string, FrameResult['forces'][number]>; bad: number; limited: number } | null> {
    const reads = this.groups.map((g) => ({ g, read: g.ref.prepareRead(enc, count) }));
    return async () => {
      const byId = new Map<string, FrameResult['forces'][number]>();
      let bad = 0;
      let limited = 0;
      for (const { g, read } of reads) {
        const r = await read();
        if (!r) return null;
        bad += r.bad;
        limited += r.limited;
        g.order.forEach((id, i) => byId.set(id, r.forces[i]));
      }
      return { byId, bad, limited };
    };
  }

  /**
   * The patch drawn from its own cells (the first group's finest level), its displayed field
   * computed for `field` (the coarse field's settings, lengths in coarse cells). Null without one.
   */
  encodeDisplay(enc: GPUCommandEncoder, field: { mode: number; uRef: number; lRef: number; rhoRef?: number }) {
    const g = this.groups[0];
    if (!g) return null;
    const box = g.ref.finestBox;
    const fine = g.ref.finest;
    fine.encodeField(enc, { ...field, lRef: field.lRef * box.scale });
    return { scalar: fine.buffers.scalar, scale: box.scale, nx: fine.nx, ny: fine.ny, x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 };
  }

  /**
   * The finest grid holding a point (coarse cells), at least `inset` coarse cells inside its
   * edge, and the map from coarse cells to its own; null outside every patch.
   */
  finestAt(x: number, y: number, inset = 2): { solver: Solver; scale: number; map: (x: number, y: number) => { x: number; y: number } } | null {
    for (const g of this.groups) {
      const b = g.ref.finestBox;
      if (x >= b.x0 + inset && x <= b.x1 - inset && y >= b.y0 + inset && y <= b.y1 - inset) {
        return { solver: g.ref.finest, scale: b.scale, map: (px, py) => g.ref.toFinest(px, py) };
      }
    }
    return null;
  }

  /** The patches now (for tests): per group, its bodies and each level's rectangle and grid. */
  info() {
    return this.groups.map((g) => ({ ids: g.order, levels: g.ref.levels.map((l) => ({ ...l.rect, nx: l.fine.nx, ny: l.fine.ny })) }));
  }

  destroy() {
    this.clear();
  }
}
