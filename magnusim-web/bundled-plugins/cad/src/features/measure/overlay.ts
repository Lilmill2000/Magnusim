// Measure markers in the viewport (layer order 60, docs/p2p3-plan.md §3.3):
// the shortest-distance segment between the two picks, its end points, and the
// distance as a label at its middle (html, re-placed every frame).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { BufferGeometry, Float32BufferAttribute, Line, LineBasicMaterial, Points, PointsMaterial } from 'three';
import type { Vec3 } from '../../types/doc';
import type { OverlayLayer, ViewportHandle } from '../../types/viewport';

/** The measure colour (--cad-p2-measure in p2.css). */
const MEASURE_COLOR = 0x1a4fbf;

export interface MeasureMarks {
  show(p1: Vec3, p2: Vec3, label: string): void;
  clear(): void;
  dispose(): void;
}

export function createMeasureMarks(handle: ViewportHandle): MeasureMarks {
  const layer: OverlayLayer = handle.addLayer('p2-measure', { order: 60 });
  const lineMat = new LineBasicMaterial({ color: MEASURE_COLOR, depthTest: false, transparent: true });
  const pointMat = new PointsMaterial({ color: MEASURE_COLOR, size: 7, sizeAttenuation: false, depthTest: false, transparent: true });
  let line: Line | null = null;
  let points: Points | null = null;
  const label = document.createElement('div');
  label.className = 'cad-measure-label';
  label.setAttribute('data-measure-label', '1');
  label.hidden = true;
  layer.html.appendChild(label);
  let at: Vec3 | null = null;
  const place = () => {
    if (!at) return;
    const s = handle.project(at);
    if (!s) {
      label.hidden = true;
      return;
    }
    const r = layer.html.getBoundingClientRect();
    label.hidden = false;
    label.style.left = `${s[0] - r.left}px`;
    label.style.top = `${s[1] - r.top}px`;
  };
  const offFrame = handle.onFrame(place);
  const clear = () => {
    for (const o of [line, points]) {
      if (!o) continue;
      layer.group.remove(o);
      o.geometry.dispose();
    }
    line = null;
    points = null;
    at = null;
    label.hidden = true;
    layer.changed();
  };
  return {
    show(p1, p2, text) {
      clear();
      const g = new BufferGeometry();
      g.setAttribute('position', new Float32BufferAttribute([...p1, ...p2], 3));
      line = new Line(g, lineMat);
      line.renderOrder = 60;
      line.frustumCulled = false;
      const pg = new BufferGeometry();
      pg.setAttribute('position', new Float32BufferAttribute([...p1, ...p2], 3));
      points = new Points(pg, pointMat);
      points.renderOrder = 61;
      points.frustumCulled = false;
      layer.group.add(line, points);
      at = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2, (p1[2] + p2[2]) / 2];
      label.textContent = text;
      layer.changed();
      place();
    },
    clear,
    dispose() {
      clear();
      offFrame();
      lineMat.dispose();
      pointMat.dispose();
      layer.dispose();
    },
  };
}
