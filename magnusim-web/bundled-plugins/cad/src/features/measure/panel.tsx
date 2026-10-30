// Measure (proposal §2.11): pick one or two things (faces, edges, points,
// origin planes and axes) in the viewport or in the tree (a plane row: the
// planes are not drawn once the part has bodies), a body (its row in the tree), or a point typed
// as x, y, z; the panel shows one thing's length, area or radius (a body: its volume, area,
// solids, shells, sealed voids, faces, edges and whether it is valid), or two things' minimum
// distance with its X/Y/Z parts, the angle between them and the distance between centres (two
// bodies: also their overlap volume and the solids and voids of the two joined), in the
// document's units: what the Assistant's measure reads. A third pick starts over. Not a feature:
// nothing is undoable or saved.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { AppServices } from '../../types/app';
import type { BodyInfo, KernelCallError } from '../../types/kernel';
import type { MeasureResult, MeasureTarget } from '../../types/kernel-protocol';
import type { ToolPanelProps } from '../../types/modules';
import { selectionKey, type SelectionItem } from '../../types/selection';
import type { EvalResult } from '../../types/units';
import { Button, DisabledReason, Hint, PanelChrome } from '../../ui/kit';
import { formatQuantity, formatReadout, formatVolume, MM_PER } from '../../ui/kit/format';
import { PickList } from '../p2/PickList';
import { usePicker, useSelectionMirror } from '../p2/pick';
import { createMeasureMarks, type MeasureMarks } from './overlay';
import { formatArea, itemLabel, measureRows, targetOf, type Row } from './words';
import { showForPanel } from '../../lib/selection';
import { kernelLookup, refOfEdge, refOfFace, refOfVertex, resolveEdge, resolveFace, resolveVertex, signatureDistance } from '../../naming';
import type { PersistentRef, Vec3 } from '../../types/doc';
import { bodyFacts, overlapFacts, planeOfFace, sectionFacts } from '../../assistant/measure';
import { resolveSectionPlane } from '../../assistant/measure-targets';
import { personCall } from '../../assistant/person-call';
import { Select } from '../../ui/kit';

/** A point typed as x, y, z (model mm), measured as the Assistant's "(x, y, z)" target. */
export interface PointPick {
  kind: 'point';
  at: Vec3;
}
/** What Measure measures: a pick of the view or the tree, or a typed point. */
export type MeasurePick = SelectionItem | PointPick;

const isPoint = (p: MeasurePick): p is PointPick => p.kind === 'point';
const keyOf = (p: MeasurePick) => (isPoint(p) ? `point:${p.at.join(',')}` : selectionKey(p));
const viewPicks = (list: readonly MeasurePick[]) => list.filter((p): p is SelectionItem => !isPoint(p));
const MEASURABLE = new Set(['face', 'edge', 'vertex', 'origin', 'body']);

function pickTarget(p: MeasurePick, bodies: readonly BodyInfo[]): MeasureTarget | null {
  return isPoint(p) ? { point: [...p.at] } : targetOf(p, bodies);
}

/** "12, -3.5, 0" or "(w/2, 0, t)", in the document's length unit, as model mm; or why not. */
export function parsePoint(text: string, evaluate: (expr: string) => EvalResult): Vec3 | string {
  const inner = text.trim().replace(/^\(/, '').replace(/\)$/, '');
  const parts = inner.split(',').map((t) => t.trim());
  if (parts.length !== 3 || parts.some((t) => !t)) return 'Enter x, y, z (for example 10, 0, 5)';
  const out: number[] = [];
  for (const [i, t] of parts.entries()) {
    const r = evaluate(t);
    if (!r.ok) return `${'xyz'[i]}: ${r.error}`;
    out.push(r.value);
  }
  return [out[0], out[1], out[2]];
}

/** What Measure adds for bodies, as the Assistant's measure reads them: one body's facts, or two bodies' overlap and union. */
export async function bodyRows(services: AppServices, picks: readonly MeasurePick[], bodies: readonly BodyInfo[]): Promise<Row[]> {
  const units = services.doc.units.units();
  const list: BodyInfo[] = [];
  for (const p of picks) {
    const b = !isPoint(p) && p.kind === 'body' ? bodies.find((x) => x.id === p.body) : undefined;
    if (!b) return [];
    list.push(b);
  }
  if (list.length === 1) {
    const f = await bodyFacts(services, list[0]);
    return [
      { key: 'volume', label: 'Volume', value: f.volume === null ? 'None (surface body)' : formatVolume(f.volume, units) },
      { key: 'area', label: 'Surface area', value: formatArea(f.area, units) },
      { key: 'solids', label: 'Solids', value: String(f.solids) },
      { key: 'shells', label: 'Shells', value: String(f.shells) },
      { key: 'voids', label: 'Sealed voids', value: f.voids === null ? 'None (surface body)' : String(f.voids) },
      { key: 'faces', label: 'Faces, edges', value: `${f.faces.toLocaleString('en-US')}, ${f.edges.toLocaleString('en-US')}` },
      { key: 'valid', label: 'Valid', value: f.valid ? 'Yes' : 'No (Check lists what is wrong)' },
    ];
  }
  if (list.length !== 2) return [];
  const [a, b] = list;
  const fa = await bodyFacts(services, a);
  const fb = await bodyFacts(services, b);
  const o = await overlapFacts(services, a, b, { a: fa.solids, b: fb.solids });
  if (o.overlap === null) return [{ key: 'overlap', label: 'Overlap', value: o.note ?? 'None (a surface body)' }];
  const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  return [
    { key: 'overlap', label: 'Overlap (interference)', value: formatVolume(o.overlap, units) },
    { key: 'union', label: 'Joined', value: `${plural(o.unionSolids ?? 0, 'solid')}, ${plural(o.unionVoids ?? 0, 'sealed void')}` },
  ];
}

/** One body cut by a plane ("Top offset 4 mm", a construction plane), as the Assistant's measure section reads it. */
export async function sectionRows(services: AppServices, body: BodyInfo, plane: string): Promise<Row[]> {
  const ctx = personCall(services, 'measure', { targets: [body.name], section: plane });
  const p = await resolveSectionPlane(ctx, services.doc.state.get(), plane, (f) => planeOfFace(services, f));
  const f = await sectionFacts(services, body, p.frame);
  const units = services.doc.units.units();
  if (!f.loops && !f.open) return [{ key: 'section', label: `Cut at ${p.words}`, value: `misses ${body.name}` }];
  const rows: Row[] = [
    { key: 'section-area', label: `Cut at ${p.words}`, value: formatArea(f.area, units) },
    { key: 'section-pieces', label: 'Pieces, holes', value: `${f.regions.length}, ${f.holes}` },
  ];
  if (f.open) rows.push({ key: 'section-open', label: 'Open loops', value: `${f.open} (not counted in the area)` });
  return rows;
}

export function MeasurePanel({ close }: ToolPanelProps) {
  const services = useServices();
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  const seq = useStateStore(services.doc.state, (s) => s.rebuild.seq);
  const handle = useStateStore(services.viewport, (s) => s.handle);
  const [picks, setPicks] = useState<MeasurePick[]>(() =>
    services.selection
      .get()
      .items.filter((it) => MEASURABLE.has(it.kind))
      .slice(0, 2),
  );
  const [result, setResult] = useState<MeasureResult | null>(null);
  const [extra, setExtra] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pointText, setPointText] = useState('');
  const [pointError, setPointError] = useState<string | null>(null);
  // One body picked: its cross-section at a plane (the Assistant's measure section).
  const [cutPlane, setCutPlane] = useState('');
  const [cutOffset, setCutOffset] = useState('');
  const [cut, setCut] = useState<{ rows: Row[]; error: string | null }>({ rows: [], error: null });
  const planes = useStateStore(services.doc.state, (s) => s.doc.features.filter((f) => f.type === 'ref_plane').map((f) => f.name).join('|'));
  const marks = useRef<MeasureMarks | null>(null);
  const firstSeq = useRef(seq);

  const pick = (item: MeasurePick) => {
    setNote(null);
    setPicks((cur) => {
      const k = keyOf(item);
      if (cur.some((x) => keyOf(x) === k)) return cur.filter((x) => keyOf(x) !== k);
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
  // A row clicked in the tree (an origin plane or axis, a body) is a pick too; anything else picked
  // there does not change what is measured, and the viewport goes back to showing the picks. (Review
  // P2/P3 round 1: the plane lit up green while the panel still measured the face alone.)
  const picksNow = useRef(picks);
  picksNow.current = picks;
  useSelectionMirror(services, viewPicks(picks), (added) => {
    const usable = added.filter((it) => MEASURABLE.has(it.kind));
    if (usable.length) for (const it of usable.slice(-2)) pick(it);
    else showForPanel(services.selection, viewPicks(picksNow.current));
  });
  // A point typed as x, y, z (the Assistant's "(x, y, z)" target).
  const addPoint = () => {
    const r = parsePoint(pointText, (e) => services.doc.units.evaluate(e, 'length'));
    if (typeof r === 'string') {
      setPointError(r);
      return;
    }
    setPointError(null);
    setPointText('');
    pick({ kind: 'point', at: r });
  };

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
  const pickKeys = picks.map(keyOf).join('\n');
  useEffect(() => {
    const keys = new Set(picks.map(keyOf));
    for (const k of [...pins.current.keys()]) if (!keys.has(k)) pins.current.delete(k);
    for (const p of picks) {
      if (p.kind !== 'face' && p.kind !== 'edge' && p.kind !== 'vertex') continue;
      const k = selectionKey(p);
      if (pins.current.has(k)) continue;
      const b = services.doc.state.get().rebuild.bodies.find((x) => x.id === p.body);
      if (!b) continue;
      const lookup = kernelLookup(services.kernel);
      const made = p.kind === 'face' ? refOfFace(lookup, b, p.index) : p.kind === 'edge' ? refOfEdge(lookup, b, p.index) : refOfVertex(lookup, b, p.index);
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
      const kept: MeasurePick[] = [];
      let lost = false;
      for (const p of cur) {
        if (p.kind === 'origin' || p.kind === 'point') {
          kept.push(p);
          continue;
        }
        if (p.kind === 'body') {
          if (now.some((x) => x.id === p.body)) kept.push(p);
          else lost = true;
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
          const input = { ref, shape: b.shape, names: b.names, lookup, placement: b.placement };
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
        if (lost || kept.some((k, i) => keyOf(k) !== keyOf(cur[i]))) setPicks(kept);
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

  const key = picks.map(keyOf).join('\n');
  useEffect(() => {
    let live = true;
    // P4b (PATTERN): while a rebuild's picks are being checked, nothing is measured on old indices.
    if (checked !== seq) return;
    setResult(null);
    setExtra([]);
    setError(null);
    marks.current?.clear();
    if (!picks.length) return;
    const a = pickTarget(picks[0], bodies);
    const b = picks[1] ? pickTarget(picks[1], bodies) : undefined;
    if (!a || (picks[1] && !b)) {
      setError('That is not on a body any more: pick again');
      return;
    }
    setBusy(true);
    services.kernel
      .call('measure', b ? { a, b } : { a })
      .then(async (r) => {
        if (!live) return;
        setResult(r.result);
        if (r.result.p1 && r.result.p2 && r.result.distance != null) marks.current?.show(r.result.p1, r.result.p2, formatQuantity(r.result.distance, 'length', services.doc.units.units()));
        // Bodies: what the Assistant's measure adds (a body's solids and voids; two bodies' overlap and union).
        const more = await bodyRows(services, picks, bodies);
        if (live) setExtra(more);
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

  const onlyBody = picks.length === 1 && picks[0].kind === 'body' ? (bodies.find((b) => b.id === (picks[0] as { body: string }).body) ?? null) : null;
  const cutText = cutPlane ? `${cutPlane}${cutOffset.trim() ? ` offset ${cutOffset.trim()}` : ''}` : '';
  useEffect(() => {
    setCut({ rows: [], error: null });
    if (!onlyBody || !cutText || checked !== seq) return;
    let live = true;
    sectionRows(services, onlyBody, cutText).then(
      (rows) => live && setCut({ rows, error: null }),
      (err: unknown) => live && setCut({ rows: [], error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlyBody?.id, onlyBody?.shape, cutText, checked]);

  const units = services.doc.units.units();
  const pointLabel = (p: PointPick) => `Point (${p.at.map((x) => formatReadout(x / MM_PER[units.length])).join(', ')}) ${units.length}`;
  const rows = result ? [...measureRows(result, services.doc.units), ...extra, ...cut.rows] : [];
  const foot = [];
  if (error) foot.push(<DisabledReason key="error">{error}</DisabledReason>);
  return (
    <PanelChrome panel="tool" title="Measure" onDone={close} foot={foot.length ? foot : null}>
      <div data-tool-panel="inspect.measure">
        <PickList
          field="measure"
          label={picks.length ? `Picked (${picks.length})` : 'Picked'}
          rows={picks.map((p) => ({ key: keyOf(p), label: isPoint(p) ? pointLabel(p) : itemLabel(p, bodies) }))}
          active
          onActivate={() => {}}
          onRemove={(k) => setPicks((cur) => cur.filter((x) => keyOf(x) !== k))}
          hint="Click one or two faces, edges or points, or a plane or a body in the tree"
        />
        <div className="cad-measure-point">
          <input
            type="text"
            className="mgk-input"
            aria-label="A point to measure: x, y, z"
            placeholder="Add a point: x, y, z"
            spellCheck={false}
            autoComplete="off"
            data-measure-point-input="1"
            value={pointText}
            onChange={(e) => {
              setPointText(e.target.value);
              setPointError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addPoint();
              }
            }}
          />
          <Button variant="secondary" onClick={addPoint} data-measure-point-add="1">
            Add point
          </Button>
        </div>
        {pointError ? <DisabledReason>{pointError}</DisabledReason> : null}
        {onlyBody ? (
          <div className="cad-measure-point" data-measure-section="1">
            <Select
              label="Cross-section plane"
              value={cutPlane}
              attrs={{ 'data-measure-section-plane': '1' }}
              onChange={(v) => setCutPlane(v)}
              options={[{ value: '', label: 'No cross-section' }, ...['Top', 'Front', 'Right', ...(planes ? planes.split('|') : [])].map((n) => ({ value: n, label: `Cut at ${n}` }))]}
            />
            <input
              type="text"
              className="mgk-input"
              aria-label="Cross-section offset"
              placeholder="Offset (0 mm)"
              spellCheck={false}
              autoComplete="off"
              data-measure-section-offset="1"
              disabled={!cutPlane}
              defaultValue={cutOffset}
              onBlur={(e) => setCutOffset(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setCutOffset((e.target as HTMLInputElement).value);
              }}
            />
          </div>
        ) : null}
        {cut.error ? <DisabledReason>{cut.error}</DisabledReason> : null}
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
