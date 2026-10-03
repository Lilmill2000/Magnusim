// Mass properties (proposal §2.11): volume, surface area, centroid and size of
// the selected bodies (or every shown body when none is selected), each body
// and their total (centroid weighted by volume). Exact values from the kernel
// (DocService.measure: BRepGProp, the exact bounding box), in the document's
// units. A tool panel: nothing is saved or undoable.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { BodyId, Vec3 } from '../../types/doc';
import type { BodyProps } from '../../types/doc-service';
import type { ToolPanelProps } from '../../types/modules';
import { DisabledReason, Hint, PanelChrome } from '../../ui/kit';
import { formatQuantity, formatReadout, formatVolume, MM_PER } from '../../ui/kit/format';
import { selectedBodies } from '../../ui/tree/model';
import { formatArea } from '../measure/words';

export interface MassTotal {
  volume: number;
  area: number;
  centroid: Vec3 | null;
  bbox: [number, number, number, number, number, number] | null;
}

/**
 * The total of several bodies: volumes and areas add, the centroid is volume-weighted, the box encloses all.
 * A surface body (no solid) has no volume: it adds its area and box only.
 */
export function massTotal(list: readonly BodyProps[]): MassTotal {
  let volume = 0;
  let area = 0;
  const c: Vec3 = [0, 0, 0];
  let weighted = 0;
  let bbox: MassTotal['bbox'] = null;
  for (const p of list) {
    const solid = p.solids !== 0;
    if (solid) volume += p.volume;
    area += p.area;
    if (solid && p.centroid && p.volume > 0) {
      for (let k = 0; k < 3; k++) c[k] += p.centroid[k] * p.volume;
      weighted += p.volume;
    }
    const b = p.bbox;
    bbox = bbox ? [Math.min(bbox[0], b[0]), Math.min(bbox[1], b[1]), Math.min(bbox[2], b[2]), Math.max(bbox[3], b[3]), Math.max(bbox[4], b[4]), Math.max(bbox[5], b[5])] : [b[0], b[1], b[2], b[3], b[4], b[5]];
  }
  return { volume, area, centroid: weighted > 0 ? [c[0] / weighted, c[1] / weighted, c[2] / weighted] : null, bbox };
}

/** 0 for a value that is only float noise against the part's size (1e-9 of it). */
export function cleanZero(v: number, scale: number): number {
  return Math.abs(v) < 1e-9 * Math.max(1, scale) ? 0 : v;
}

export function MassPanel({ close }: ToolPanelProps) {
  const services = useServices();
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  const seq = useStateStore(services.doc.state, (s) => s.rebuild.seq);
  const units = useStateStore(services.doc.state, (s) => s.doc.units);
  const sel = useStateStore(services.selection);
  const picked = selectedBodies(sel);
  const chosen = bodies.filter((b) => picked.has(b.id));
  const list = chosen.length ? chosen : bodies.filter((b) => b.visible);
  const ids = list.map((b) => b.id).join(',');
  const [props, setProps] = useState<Record<BodyId, BodyProps>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setError(null);
    setBusy(true);
    // Values of another selection or an older rebuild are not shown meanwhile.
    setProps({});
    const want = ids ? ids.split(',') : [];
    void (async () => {
      const out: Record<BodyId, BodyProps> = {};
      try {
        for (const id of want) {
          out[id] = await services.doc.measure(id);
          if (!live) return;
        }
        if (live) setProps(out);
      } catch (err) {
        if (live) setError(`Mass properties failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (live) setBusy(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [services, ids, seq]);

  const ready = list.filter((b) => props[b.id]);
  const total = massTotal(ready.map((b) => props[b.id]));
  const surfaces = ready.filter((b) => props[b.id].solids === 0).length;
  const len = (v: number) => formatQuantity(v, 'length', units);
  // Float noise on a symmetric part's centroid (-1.9e-13 mm on a 100 mm flange) reads as 0, as it is.
  const scale = total.bbox ? Math.max(1, total.bbox[3] - total.bbox[0], total.bbox[4] - total.bbox[1], total.bbox[5] - total.bbox[2]) : 1;
  const point = (p: Vec3) => `${p.map((x) => formatReadout(cleanZero(x, scale) / MM_PER[units.length])).join(', ')} ${units.length}`;
  const which = chosen.length ? (chosen.length === 1 ? chosen[0].name : `${chosen.length} selected bodies`) : list.length === 1 ? list[0].name : `All ${list.length} shown bodies`;
  const foot = error ? [<DisabledReason key="error">{error}</DisabledReason>] : null;
  return (
    <PanelChrome panel="tool" title="Mass properties" onDone={close} foot={foot}>
      <div data-tool-panel="inspect.mass">
        <div className="cad-p2-sub" data-mass-which="1">
          {list.length ? which : 'No body is shown'}
        </div>
        {busy && ready.length < list.length ? <Hint>Measuring…</Hint> : null}
        {ready.length ? (
          <>
            <table className="cad-p2-table" data-mass-total="1">
              <tbody>
                <tr data-mass-row="volume">
                  <td>Volume</td>
                  <td className="num" data-mass-value="volume" data-mm3={String(total.volume)}>
                    {surfaces === ready.length ? 'None (surface body)' : formatVolume(total.volume, units)}
                  </td>
                </tr>
                <tr data-mass-row="area">
                  <td>Surface area</td>
                  <td className="num" data-mass-value="area">
                    {formatArea(total.area, units)}
                  </td>
                </tr>
                {total.centroid ? (
                  <tr data-mass-row="centroid">
                    <td>Centroid</td>
                    <td className="num" data-mass-value="centroid">
                      {point(total.centroid)}
                    </td>
                  </tr>
                ) : null}
                {total.bbox ? (
                  <tr data-mass-row="size">
                    <td>Size (X, Y, Z)</td>
                    <td className="num" data-mass-value="size">
                      {len(total.bbox[3] - total.bbox[0])} × {len(total.bbox[4] - total.bbox[1])} × {len(total.bbox[5] - total.bbox[2])}
                    </td>
                  </tr>
                ) : null}
                {ready.length === 1 ? (
                  <tr data-mass-row="faces">
                    <td>Faces, edges</td>
                    <td className="num" data-mass-value="faces">
                      {props[ready[0].id].faces.toLocaleString('en-US')}, {props[ready[0].id].edges.toLocaleString('en-US')}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            {ready.length > 1 ? (
              <table className="cad-p2-table" data-mass-bodies="1">
                <thead>
                  <tr>
                    <th>Body</th>
                    <th className="num">Volume</th>
                    <th className="num">Faces</th>
                  </tr>
                </thead>
                <tbody>
                  {ready.map((b) => (
                    <tr key={b.id} data-mass-body={b.id}>
                      <td>{b.name}</td>
                      <td className="num">{props[b.id].solids === 0 ? 'Surface' : formatVolume(props[b.id].volume, units)}</td>
                      <td className="num">{props[b.id].faces.toLocaleString('en-US')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </>
        ) : null}
        {surfaces && surfaces < ready.length ? <Hint>{surfaces === 1 ? '1 surface body is' : `${surfaces} surface bodies are`} not counted in the volume.</Hint> : null}
        <Hint>Select bodies (in the tree or the viewport) to see them alone.</Hint>
      </div>
    </PanelChrome>
  );
}
