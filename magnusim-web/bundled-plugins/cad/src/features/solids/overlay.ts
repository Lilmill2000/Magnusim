// What an open P4a panel picked that the viewport does not highlight by itself:
// sketch curves (a Sweep's path, a Revolve's axis line) and an axis in space,
// drawn as fat lines in the pick green (the one under the pointer in the hover
// blue) over the part, in one overlay layer (solids.picks, order 45).
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { Vec3 } from '../../types/doc';
import type { OverlayLayer, ViewportHandle } from '../../types/viewport';
import { HOVER_COLOR, PICK_COLOR } from '../../viewport/colors';

export const PICKS_LAYER = 'solids.picks';

export interface PickLine {
  /** A polyline (model mm). */
  points: Vec3[];
  state: 'picked' | 'hover';
  /** Dashed (an axis drawn past its ends). */
  dashed?: boolean;
}

export class PicksOverlay {
  private readonly layer: OverlayLayer;
  private readonly mats: Record<'picked' | 'hover' | 'axis', LineMaterial>;
  private segs: LineSegments2[] = [];
  private readonly offFrame: () => void;
  private dashed = false;

  constructor(private readonly handle: ViewportHandle) {
    this.layer = handle.addLayer(PICKS_LAYER, { order: 45 });
    const mat = (color: number, width: number, dashed = false) => {
      const m = new LineMaterial({ color, linewidth: width, worldUnits: false, depthTest: false, transparent: true });
      m.dashed = dashed;
      return m;
    };
    this.mats = { picked: mat(PICK_COLOR, 3.2), hover: mat(HOVER_COLOR, 3.2), axis: mat(PICK_COLOR, 1.6, true) };
    this.offFrame = handle.onFrame(() => this.place());
  }

  set(lines: PickLine[]): void {
    for (const s of this.segs) {
      this.layer.group.remove(s);
      s.geometry.dispose();
    }
    this.segs = [];
    this.dashed = false;
    for (const l of lines) {
      if (l.points.length < 2) continue;
      const pos: number[] = [];
      for (let i = 1; i < l.points.length; i++) pos.push(...l.points[i - 1], ...l.points[i]);
      const g = new LineSegmentsGeometry();
      g.setPositions(pos);
      const seg = new LineSegments2(g, l.dashed ? this.mats.axis : this.mats[l.state]);
      if (l.dashed) {
        seg.computeLineDistances();
        this.dashed = true;
      }
      seg.renderOrder = 12;
      seg.frustumCulled = false;
      seg.name = `solids-pick:${l.state}`;
      this.segs.push(seg);
      this.layer.group.add(seg);
    }
    this.place();
    this.layer.changed();
  }

  /** Dashes of a constant screen size on an axis. */
  private place(): void {
    if (!this.dashed) return;
    const first = this.segs.find((s) => s.material === this.mats.axis);
    const at = first?.geometry.boundingSphere?.center;
    const px = at ? this.handle.pixelSize([at.x, at.y, at.z]) : 0;
    const m = this.mats.axis;
    if (px > 0 && Math.abs(m.dashSize - 10 * px) > 1e-3 * px) {
      m.dashSize = 10 * px;
      m.gapSize = 5 * px;
      this.layer.changed();
    }
  }

  dispose(): void {
    this.set([]);
    this.offFrame();
    for (const m of Object.values(this.mats)) m.dispose();
    this.layer.dispose();
  }
}

/** An axis drawn as a line through `origin` along `dir`, `half` mm each way. */
export function axisLine(origin: Vec3, dir: Vec3, half: number): Vec3[] {
  return [
    [origin[0] - dir[0] * half, origin[1] - dir[1] * half, origin[2] - dir[2] * half],
    [origin[0] + dir[0] * half, origin[1] + dir[1] * half, origin[2] + dir[2] * half],
  ];
}
