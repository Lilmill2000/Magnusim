// Measure (proposal §2.11): pick one or two things (faces, edges, points,
// origin planes and axes) in the viewport or in the tree (a plane row: the
// planes are not drawn once the part has bodies); the panel shows one thing's length,
// area or radius, or two things' minimum distance with its X/Y/Z parts, the
// angle between them and the distance between centres, in the document's
// units. A third pick starts over. Not a feature: nothing is undoable or saved.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { KernelCallError } from '../../types/kernel';
import type { MeasureResult } from '../../types/kernel-protocol';
import type { ToolPanelProps } from '../../types/modules';
import { selectionKey, type SelectionItem } from '../../types/selection';
import { DisabledReason, Hint, PanelChrome } from '../../ui/kit';
import { formatQuantity } from '../../ui/kit/format';
import { PickList } from '../p2/PickList';
import { usePicker, useSelectionMirror } from '../p2/pick';
import { createMeasureMarks, type MeasureMarks } from './overlay';
import { itemLabel, measureRows, targetOf } from './words';
import { showForPanel } from '../../lib/selection';
import { kernelLookup, refOfEdge, refOfFace, refOfVertex, resolveEdge, resolveFace, resolveVertex, signatureDistance } from '../../naming';
import type { PersistentRef } from '../../types/doc';

export function MeasurePanel({ close }: ToolPanelProps) {
  const services = useServices();
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  const seq = useStateStore(services.doc.state, (s) => s.rebuild.seq);
  const handle = useStateStore(services.viewport, (s) => s.handle);
  const [picks, setPicks] = useState<SelectionItem[]>(() =>
    services.selection
      .get()
      .items.filter((it) => it.kind === 'face' || it.kind === 'edge' || it.kind === 'vertex' || it.kind === 'origin')
      .slice(0, 2),
  );
  const [result, setResult] = useState<MeasureResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const marks = useRef<MeasureMarks | null>(null);
  const firstSeq = useRef(seq);

  const pick = (item: SelectionItem) => {
    setNote(null);
    setPicks((cur) => {
      const k = selectionKey(item);
      if (cur.some((x) => selectionKey(x) === k)) return cur.filter((x) => selectionKey(x) !== k);
      return cur.length >= 2 ? [item] : [...cur, item];
    });
  };
  usePicker(services, {
    id: 'p2-measure',
    active: true,
    kinds: ['face', 'edge', 'vertex', 'origin'],
    onPick(p) {
      pick(p.item);
    },
  });
  // A row clicked in the tree (an origin plane or axis) is a pick too; anything else picked there
  // does not change what is measured, and the viewport goes back to showing the picks. (Review P2/P3
  // round 1: the plane lit up green while the panel still measured the face alone.)
  const picksNow = useRef(picks);
  picksNow.current = picks;
  useSelectionMirror(services, picks, (added) => {
    const usable = added.filter((it) => it.kind === 'face' || it.kind === 'edge' || it.kind === 'vertex' || it.kind === 'origin');
    if (usable.length) for (const it of usable.slice(-2)) pick(it);
    else showForPanel(services.selection, picksNow.current);
  });

  // ---- P4b (PATTERN, carry-over): a rebuild keeps the picks whose faces, edges and points are
  // still there as they were. Each pick is pinned with its body's geometry key and its persistent
  // reference (made at pick time); after a rebuild a body with the same key keeps its picks as they
  // are, and on a rebuilt body a pick whose name resolves to the same geometry (same place, size and
  // direction) moves to its new index. "The part changed: pick again" only when a pick's geometry
  // really changed or it is gone (split.md: a rebuild that changed nothing, such as the sketch solver
  // arriving, cleared them).
  const picksRef = useRef(picks);
  picksRef.current = picks;
  const pins = useRef(new Map<string, { tessKey: string; ref: Promise<PersistentRef | null> }>());
  const [checked, setChecked] = useState(seq);
  const pickKeys = picks.map(selectionKey).join('\n');
  useEffect(() => {
    const keys = new Set(picks.map(selectionKey));
    for (const k of [...pins.current.keys()]) if (!keys.has(k)) pins.current.delete(k);
    for (const p of picks) {
      if (p.kind !== 'face' && p.kind !== 'edge' && p.kind !== 'vertex') continue;
      const k = selectionKey(p);
      if (pins.current.has(k)) continue;
      const b = services.doc.state.get().rebuild.bodies.find((x) => x.id === p.body);
      if (!b) continue;
      const lookup = kernelLookup(services.kernel);
      const made = p.kind === 'face' ? refOfFace(lookup, b.shape, b.names ?? null, p.index) : p.kind === 'edge' ? refOfEdge(lookup, b.shape, b.names ?? null, p.index) : refOfVertex(lookup, b.shape, b.names ?? null, p.index);
      pins.current.set(k, { tessKey: b.tessKey, ref: made.catch(() => null) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickKeys]);
  useEffect(() => {
    if (seq === firstSeq.current) return;
    firstSeq.current = seq;
    const cur = picksRef.current;
    if (!cur.length) {
      setChecked(seq);
      return;
    }
    let live = true;
    void (async () => {
      const now = services.doc.state.get().rebuild.bodies;
      const lookup = kernelLookup(services.kernel);
      const kept: SelectionItem[] = [];
      let lost = false;
      for (const p of cur) {
        if (p.kind === 'origin') {
          kept.push(p);
          continue;
        }
        if (p.kind !== 'face' && p.kind !== 'edge' && p.kind !== 'vertex') {
          lost = true;
          continue;
        }
        const b = now.find((x) => x.id === p.body);
        const pin = pins.current.get(selectionKey(p));
        if (!b || !pin) {
          lost = true;
          continue;
        }
        if (b.tessKey === pin.tessKey) {
          kept.push(p);
          continue;
        }
        const ref = await pin.ref;
        if (!ref || !b.names) {
          lost = true;
          continue;
        }
        try {
          const input = { ref, shape: b.shape, names: b.names, lookup };
          const r = p.kind === 'face' ? await resolveFace(input) : p.kind === 'edge' ? await resolveEdge(input) : await resolveVertex(input);
          // Still there and still the same (a dimension that moved the face changes what is measured).
          const bb = b.bbox;
          const scale = Math.max(1, Math.hypot(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]));
          if (r.ok && r.how === 'name' && signatureDistance(ref.signature, r.signature, scale) <= 1e-7) {
            const item: SelectionItem = { kind: p.kind, body: p.body, index: r.index };
            pins.current.set(selectionKey(item), { tessKey: b.tessKey, ref: pin.ref });
            kept.push(item);
          } else lost = true;
        } catch {
          lost = true;
        }
      }
      if (!live) return;
      // A pick made meanwhile wins over this check.
      if (picksRef.current === cur) {
        if (lost || kept.some((k, i) => selectionKey(k) !== selectionKey(cur[i]))) setPicks(kept);
        if (lost) setNote('The part changed: pick again');
      }
      setChecked(seq);
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq]);
  // ---- end P4b (PATTERN)

  useEffect(() => {
    if (!handle) return;
    marks.current = createMeasureMarks(handle);
    return () => {
      marks.current?.dispose();
      marks.current = null;
    };
  }, [handle]);

  const key = picks.map(selectionKey).join('\n');
  useEffect(() => {
    let live = true;
    // P4b (PATTERN): while a rebuild's picks are being checked, nothing is measured on old indices.
    if (checked !== seq) return;
    setResult(null);
    setError(null);
    marks.current?.clear();
    if (!picks.length) return;
    const a = targetOf(picks[0], bodies);
    const b = picks[1] ? targetOf(picks[1], bodies) : undefined;
    if (!a || (picks[1] && !b)) {
      setError('That is not on a body any more: pick again');
      return;
    }
    setBusy(true);
    services.kernel
      .call('measure', b ? { a, b } : { a })
      .then((r) => {
        if (!live) return;
        setResult(r.result);
        if (r.result.p1 && r.result.p2 && r.result.distance != null) marks.current?.show(r.result.p1, r.result.p2, formatQuantity(r.result.distance, 'length', services.doc.units.units()));
      })
      .catch((err: unknown) => {
        if (!live) return;
        const e = err as KernelCallError;
        setError(`Measure failed: ${e instanceof Error ? e.message : String(err)}`);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, bodies, checked]);

  const rows = result ? measureRows(result, services.doc.units) : [];
  const foot = [];
  if (error) foot.push(<DisabledReason key="error">{error}</DisabledReason>);
  return (
    <PanelChrome panel="tool" title="Measure" onDone={close} foot={foot.length ? foot : null}>
      <div data-tool-panel="inspect.measure">
        <PickList
          field="measure"
          label={picks.length ? `Picked (${picks.length})` : 'Picked'}
          rows={picks.map((p) => ({ key: selectionKey(p), label: itemLabel(p, bodies) }))}
          active
          onActivate={() => {}}
          onRemove={(k) => setPicks((cur) => cur.filter((x) => selectionKey(x) !== k))}
          hint="Click one or two faces, edges or points, or a plane in the tree"
        />
        {note ? <Hint>{note}</Hint> : null}
        {busy ? <Hint>Measuring…</Hint> : null}
        {rows.length ? (
          <table className="cad-p2-table" data-measure-result="1">
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} data-measure-row={r.key}>
                  <td>{r.label}</td>
                  <td className="num" data-measure-value={r.key}>
                    {r.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
    </PanelChrome>
  );
}
