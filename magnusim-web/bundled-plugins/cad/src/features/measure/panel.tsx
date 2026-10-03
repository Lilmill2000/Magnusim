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
    else services.selection.set({ items: picksNow.current });
  });

  // The part changed (a rebuild): the picked indices may name other faces now.
  const picksRef = useRef(picks);
  picksRef.current = picks;
  useEffect(() => {
    if (seq === firstSeq.current) return;
    firstSeq.current = seq;
    if (!picksRef.current.length) return;
    setPicks([]);
    setNote('The part changed: pick again');
  }, [seq]);

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
  }, [key, bodies]);

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
