// The pick fields of the P4a solids' panels, in the P2 selection-list look
// (PickList): a field is active (green border) while viewport clicks go to it;
// clicking its box activates it.
//   useRegionField   profile regions: of one sketch (Revolve, Sweep) or one per
//                    sketch in order (Loft); a click on a shaded region toggles it
//   useAxisField     an axis: a sketch line or centerline, a straight or round model
//                    edge, a round face (its axis), an origin axis, a CONSTRUCT axis
//   usePathField     a sweep path: curves of one sketch (a click toggles a curve)
//   useTargetField   Up to: one flat face or vertex of a body
//   useEdgeSetField  fillet / chamfer: edges and faces (all their edges) of one body
// Picks are made on the bodies as shown, which is the panel's own live result: a
// face, edge or vertex this feature made itself is refused with the reason (as the
// P2 face fields do); every other one keeps its name through the feature.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { setSelectionFilter } from '../../lib/selection';
import { useServices } from '../../lib/services';
import { useSelectionMirror } from '../p2/pick';
import { useStateStore } from '../../lib/store';
import { describeFace, kernelLookup } from '../../naming';
import { edgeWords, refOfEdge, refOfVertex, splitEdgeName, splitVertexName, vertexWords } from '../../naming/edges';
import { splitMerged } from '../../naming/names';
import type { AppServices } from '../../types/app';
import type { BodyId, BodyRef, FeatureId, PersistentRef, RegionRef, SketchEntityId, SketchFeature, Vec3 } from '../../types/doc';
import type { BuiltBody } from '../../types/doc-service';
import type { BodyInfo } from '../../types/kernel';
import type { AxisRef } from '../../types/references';
import type { SelectionItem, SelectKind } from '../../types/selection';
import type { ViewportHandle, ViewportPointer } from '../../types/viewport';
import { formatArea } from '../extrude/ExtrudePanel';
import { entityParents, refOfRegion, resolveRegionRef } from '../extrude/profiles';
import { PickList, type PickRow } from '../p2/PickList';
import { featureOfName, pickFace, shownFaces } from '../p2/refs';
import { drawnConstructs, isOriginAxis, wantOriginAxes } from '../refgeom/scene';
import { constructOverlayOf } from '../refgeom/overlay';
import { constructOf } from '../refgeom/api';
import { constructUnder } from '../refgeom/pick';
import { refWords, resolveAxis } from '../refgeom/resolve';
import { regionUnder } from '../sketch/pick';
import { profilesView, sketchOutput, type RegionKey } from '../sketch/view';
import { curvePolyline, curveUnder, curveWords, geometryOf } from './geom';
import { axisLine, type PickLine } from './overlay';

// ------------------------------------------------------------ plumbing

/** Shows `items` as the shared selection while it is mounted (a panel mounts it only when it has something to show). */
export function SelectionMirror({ items }: { items: SelectionItem[] }) {
  const services = useServices();
  useSelectionMirror(services, items);
  return null;
}

/** Push a pointer tool on the viewport while `active` (the newest tool sees events first). */
export function useViewportTool(services: AppServices, o: { id: string; active: boolean; kinds?: SelectKind[] | null; onPointer(e: ViewportPointer, h: ViewportHandle): boolean }): void {
  const ref = useRef(o);
  ref.current = o;
  const kindsKey = (o.kinds ?? []).join(',');
  // Attached before the browser paints: a click right after the field shows active is the field's.
  useLayoutEffect(() => {
    if (!o.active) return;
    let pop: (() => void) | null = null;
    let handle: ViewportHandle | null = null;
    const attach = (h: ViewportHandle | null) => {
      if (h === handle) return;
      pop?.();
      pop = null;
      handle = h;
      if (!h) return;
      pop = h.pushTool({ id: ref.current.id, cursor: 'pointer', onPointer: (e) => (e.type === 'dblclick' ? true : ref.current.onPointer(e, h)) });
    };
    attach(services.viewport.get().handle);
    const off = services.viewport.subscribe((s) => attach(s.handle));
    // The selection filter follows the field, and goes back afterwards unless the user changed it meanwhile.
    const before = services.selection.get().filter;
    const mine = kindsKey ? (kindsKey.split(',') as SelectKind[]) : null;
    if (mine) setSelectionFilter(services.selection, mine);
    return () => {
      off();
      pop?.();
      if (mine && services.selection.get().filter.join(',') === mine.join(',')) setSelectionFilter(services.selection, before);
    };
  }, [services, o.active, kindsKey]);
}

/** A feature name for words ("Sketch 2"), or null when it is gone. */
export function featureNameOf(services: AppServices): (id: FeatureId) => string | null {
  const features = services.doc.state.get().doc.features;
  return (id) => features.find((f) => f.id === id)?.name ?? null;
}

/** The bodies as the rebuild shows them, as a build context holds them (for resolving references in a panel). */
export function liveBodies(services: AppServices): Map<BodyId, BuiltBody> {
  const m = new Map<BodyId, BuiltBody>();
  for (const b of services.doc.state.get().rebuild.bodies) m.set(b.id, { id: b.id, shape: b.shape, valid: b.valid, feature: b.feature, names: b.names ?? null });
  return m;
}

/** Half the size of the shown part (to draw an axis across it), 50 mm with no body. */
export function partHalfSize(services: AppServices): number {
  const bodies = services.doc.state.get().rebuild.bodies;
  let d = 0;
  for (const b of bodies) if (b.bbox) d = Math.max(d, Math.hypot(b.bbox[3] - b.bbox[0], b.bbox[4] - b.bbox[1], b.bbox[5] - b.bbox[2]));
  return d > 0 ? 0.75 * d : 50;
}

/** Does a face name come (all of it) from feature `self`? */
const madeBy = (name: string, self: FeatureId) => splitMerged(name).every((n) => featureOfName(n) === self);

/** Is the feature `later` after `self` in the history (it cannot be used by it)? */
function after(services: AppServices, self: FeatureId, later: FeatureId): string | null {
  const fs = services.doc.state.get().doc.features;
  const at = (id: string) => fs.findIndex((g) => g.id === id);
  if (at(self) >= 0 && at(later) > at(self)) return `${fs[at(later)]?.name ?? 'That sketch'} comes after ${fs[at(self)]?.name ?? 'this feature'} in the history: pick from a feature above it`;
  return null;
}

export interface FieldView {
  element(label: string, field: string, onActivate: () => void, hint: string): ReactElement;
  error: string | null;
}

// ------------------------------------------------------------ profile regions

export interface RegionRow {
  i: number;
  ref: RegionRef;
  ok: boolean;
  key: string | null;
  repaired: boolean;
  area: number | null;
  sketchName: string;
}

/** Each profile as a panel lists it: found (exact or repaired) with its area, or lost. */
export function regionRows(services: AppServices, profiles: readonly RegionRef[]): RegionRow[] {
  const s = services.doc.state.get();
  return profiles.map((p, i) => {
    const out = sketchOutput(s, p.sketch);
    const sk = s.doc.features.find((g) => g.id === p.sketch);
    const parents = entityParents(sk && sk.type === 'sketch' ? sk.entities : []);
    const r = out ? resolveRegionRef(p, out.regions, parents) : ({ ok: false } as const);
    return { i, ref: p, ok: r.ok, key: r.ok ? r.key : null, repaired: r.ok && r.how === 'repaired', area: r.ok ? r.region.area : null, sketchName: sk?.name ?? 'a deleted sketch' };
  });
}

export interface RegionFieldOptions {
  feature: FeatureId;
  profiles: RegionRef[];
  /** Region clicks go to this field (it takes only clicks on shaded regions, so it may stay on under another field). */
  active: boolean;
  /** Drawn as the active field (default: `active`). */
  selected?: boolean;
  /** 'one': profiles of one sketch (Revolve, Sweep); 'each': one profile per sketch, in the order picked (Loft). */
  mode: 'one' | 'each';
  /** A sketch whose regions this field refuses, with the reason (a sweep's path sketch), or null. */
  refuse?(sketch: FeatureId): string | null;
  onChange(next: RegionRef[]): void;
}

export function useRegionField(services: AppServices, o: RegionFieldOptions): FieldView & { used: RegionKey[]; sketches: FeatureId[]; rows: RegionRow[] } {
  useStateStore(services.doc.state, (s) => s.rebuild.seq);
  const units = useStateStore(services.doc.state, (s) => s.doc.units);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(o);
  latest.current = o;
  const view = profilesView(services);
  useViewportTool(services, {
    id: `solids-regions-${o.feature}`,
    active: o.active,
    onPointer(e) {
      if (services.mode.get().mode !== 'model') return false;
      // The feature's own preview (its body as the panel builds it) does not hide its profiles.
      const through = services.doc.state.get().rebuild.bodies.filter((b) => b.feature === latest.current.feature).map((b) => b.id);
      if (e.type === 'move' && !e.buttons) {
        const hit = regionUnder(services, e, { through });
        const h = hit ? { feature: hit.feature, key: hit.key } : null;
        const was = view.get().hover;
        if (was?.feature !== h?.feature || was?.key !== h?.key) view.set({ hover: h });
        return !!hit;
      }
      if (e.type === 'leave') {
        if (view.get().hover) view.set({ hover: null });
        return false;
      }
      if (e.type !== 'click' || e.button !== 0) return false;
      const hit = regionUnder(services, e, { through });
      if (!hit) return false;
      const cur = latest.current;
      const why = after(services, cur.feature, hit.feature) ?? cur.refuse?.(hit.feature) ?? null;
      if (why) {
        setError(why);
        return true;
      }
      const s = services.doc.state.get();
      const out = sketchOutput(s, hit.feature);
      if (!out) return true;
      const sk = s.doc.features.find((g) => g.id === hit.feature);
      const parents = entityParents(sk && sk.type === 'sketch' ? sk.entities : []);
      const picked = refOfRegion(hit.feature, hit.region);
      let next: RegionRef[];
      if (cur.mode === 'one') {
        const from = cur.profiles[0]?.sketch;
        if (from && from !== hit.feature) {
          const name = (id: string) => s.doc.features.find((g) => g.id === id)?.name ?? 'another sketch';
          setError(`Pick profiles from one sketch: this one uses ${name(from)}, that profile is in ${name(hit.feature)}`);
          return true;
        }
        let removed = false;
        next = [];
        for (const p of cur.profiles) {
          const r = resolveRegionRef(p, out.regions, parents);
          if (r.ok && r.key === hit.key) {
            removed = true;
            continue;
          }
          next.push(r.ok ? refOfRegion(hit.feature, r.region) : p);
        }
        if (!removed) next.push(picked);
      } else {
        const at = cur.profiles.findIndex((p) => p.sketch === hit.feature);
        if (at < 0) next = [...cur.profiles, picked];
        else {
          const r = resolveRegionRef(cur.profiles[at], out.regions, parents);
          next = r.ok && r.key === hit.key ? cur.profiles.filter((_, k) => k !== at) : cur.profiles.map((p, k) => (k === at ? picked : p));
        }
      }
      setError(null);
      cur.onChange(next);
      return true;
    },
  });
  const rows = regionRows(services, o.profiles);
  const used = rows.flatMap((r) => (r.key ? [{ feature: r.ref.sketch, key: r.key }] : []));
  const sketches = [...new Set(o.profiles.map((p) => p.sketch))];
  const pickRows: PickRow[] = rows.map((r) => ({
    key: `${r.i}:${r.ref.sketch}:${r.ref.region}`,
    label: o.mode === 'each' ? `Profile ${r.i + 1} (${r.sketchName})` : `Profile ${r.i + 1}`,
    title: r.ok ? `${r.repaired ? 'Repaired: check it. ' : ''}A region of ${r.sketchName}` : `Not in ${r.sketchName} now: its region is gone. Remove it and pick the region again, or undo the change that removed it.`,
    sub: r.ok ? `${r.repaired ? 'repaired · ' : ''}${formatArea(r.area as number, units)}` : 'lost',
    missing: !r.ok,
    onHover: (on) => view.set({ hover: on && r.key ? { feature: r.ref.sketch, key: r.key } : null }),
  }));
  return {
    rows,
    used,
    sketches,
    error,
    element: (label, field, onActivate, hint) => (
      <PickList
        field={field}
        label={label}
        rows={pickRows}
        active={o.selected ?? o.active}
        onActivate={onActivate}
        error={error}
        hint={hint}
        onRemove={(key) => {
          setError(null);
          const i = pickRows.findIndex((r) => r.key === key);
          if (i >= 0) o.onChange(o.profiles.filter((_, k) => k !== i));
          view.set({ hover: null });
        }}
        {...(o.mode === 'each'
          ? {
              onMove: (key: string, by: -1 | 1) => {
                const i = pickRows.findIndex((r) => r.key === key);
                const j = i + by;
                if (i < 0 || j < 0 || j >= o.profiles.length) return;
                const next = [...o.profiles];
                [next[i], next[j]] = [next[j], next[i]];
                setError(null);
                o.onChange(next);
              },
            }
          : {})}
      />
    ),
  };
}

// ------------------------------------------------------------ axis

/** The live axis of a reference as the bodies are shown (for drawing it), or null. */
async function liveAxis(services: AppServices, ref: AxisRef): Promise<{ origin: Vec3; dir: Vec3 } | null> {
  const s = services.doc.state.get();
  const ctx = {
    bodies: liveBodies(services),
    kernel: services.kernel,
    outputs: new Map(Object.entries(s.rebuild.outputs ?? {})),
    doc: s.doc,
    bodyName: (id: BodyId) => s.rebuild.bodies.find((b) => b.id === id)?.name ?? 'a body',
    featureName: (id: FeatureId) => s.doc.features.find((f) => f.id === id)?.name ?? 'a deleted feature',
  };
  try {
    const r = await resolveAxis(ref, ctx);
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

export interface AxisFieldOptions {
  feature: FeatureId;
  value: AxisRef | null;
  active: boolean;
  /** What an empty field means, shown in it ("Normal to the profile"). */
  empty?: string | null;
  /**
   * Planes give a direction too (their normal): a CONSTRUCT plane or an origin plane, clicked in
   * the view or its tree row, or a flat face (Extrude "Along"; not an axis to revolve about).
   */
  planes?: boolean;
  onChange(next: AxisRef | null): void;
}

/** A tree row picked while an axis field is active: a CONSTRUCT axis, or (planes) a CONSTRUCT or origin plane. */
function treeAxisRef(services: AppServices, item: SelectionItem, planes: boolean): AxisRef | null {
  if (item.kind === 'origin') {
    if (item.ref === 'origin:x' || item.ref === 'origin:y' || item.ref === 'origin:z') return { kind: 'origin', axis: item.ref };
    if (planes && (item.ref === 'origin:top' || item.ref === 'origin:front' || item.ref === 'origin:right')) return { kind: 'normal', plane: { kind: 'origin', plane: item.ref } };
    return null;
  }
  const c = constructOf(services, item);
  if (!c) return null;
  if (c.kind === 'axis') return { kind: 'feature', feature: c.feature };
  if (c.kind === 'plane' && planes) return { kind: 'normal', plane: { kind: 'feature', feature: c.feature } };
  return null;
}

/** The CONSTRUCT feature an axis reference reads (directly, or the plane it is the normal of). */
function constructIn(ref: AxisRef): FeatureId | null {
  if (ref.kind === 'feature') return ref.feature;
  if (ref.kind === 'normal' && ref.plane.kind === 'feature') return ref.plane.feature;
  return null;
}

/** A plane picked where an axis is wanted. */
export const PLANE_NOT_AXIS = 'That is a plane: pick an axis (X, Y or Z axis under Origin, or a CONSTRUCT axis), a line or centerline of a sketch, a straight or round edge, or a round face';

export function useAxisField(services: AppServices, o: AxisFieldOptions): FieldView & { lines: PickLine[] } {
  const seq = useStateStore(services.doc.state, (s) => s.rebuild.seq);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<PickLine | null>(null);
  const [axis, setAxis] = useState<{ origin: Vec3; dir: Vec3 } | null>(null);
  const latest = useRef(o);
  latest.current = o;
  const key = JSON.stringify(o.value);
  useEffect(() => {
    let live = true;
    if (!o.value) setAxis(null);
    else void liveAxis(services, o.value).then((a) => live && setAxis(a));
    return () => {
      live = false;
    };
  }, [key, seq]);
  const set = (v: AxisRef) => {
    setError(null);
    latest.current.onChange(v);
  };
  // A tree row clicked while the field is active: a CONSTRUCT axis (or plane) row, an origin plane.
  useEffect(() => {
    if (!o.active) return;
    return services.selection.subscribe((s, prev) => {
      if (s.items === prev.items || !s.items.length) return;
      const cur = latest.current;
      const item = s.items[s.items.length - 1];
      const ref = treeAxisRef(services, item, !!cur.planes);
      if (!ref) {
        // A plane's row where only an axis will do: say so (P4a review: the click did nothing).
        const plane = (item.kind === 'origin' && (item.ref === 'origin:top' || item.ref === 'origin:front' || item.ref === 'origin:right')) || constructOf(services, item)?.kind === 'plane';
        if (plane) setError(PLANE_NOT_AXIS);
        return;
      }
      const used = constructIn(ref);
      const why = used ? after(services, cur.feature, used) : null;
      if (why) setError(why);
      else set(ref);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, o.active]);
  // The origin's X, Y and Z axes are drawn while the field is active, so they can be clicked (P4a review).
  useEffect(() => {
    if (!o.active) return;
    const owner = `solids-axis-${o.feature}`;
    wantOriginAxes(services, owner, true);
    return () => wantOriginAxes(services, owner, false);
  }, [services, o.active, o.feature]);
  useViewportTool(services, {
    id: `solids-axis-${o.feature}`,
    active: o.active,
    kinds: ['edge', 'face', 'origin'],
    onPointer(e, h) {
      if (services.mode.get().mode !== 'model') return false;
      if (e.type === 'move' && !e.buttons) {
        const c = curveUnder(services, e, { lines: true, construction: true });
        const s = services.doc.state.get();
        const out = c ? sketchOutput(s, c.feature) : null;
        setHover(c && out ? { points: curvePolyline(c.geom, out), state: 'hover' } : null);
        return false;
      }
      if (e.type === 'leave') {
        setHover(null);
        return false;
      }
      if (e.type !== 'click' || e.button !== 0) return false;
      const cur = latest.current;
      const s = services.doc.state.get();
      const construct = constructUnder(h, constructOverlayOf(services)?.items() ?? drawnConstructs(s, services.mode.get().mode), e, cur.planes ? ['axis', 'plane'] : ['axis']);
      if (construct && isOriginAxis(construct.feature)) {
        set({ kind: 'origin', axis: construct.feature });
        return true;
      }
      if (construct) {
        const why = after(services, cur.feature, construct.feature);
        if (why) setError(why);
        else set(construct.kind === 'plane' ? { kind: 'normal', plane: { kind: 'feature', feature: construct.feature } } : { kind: 'feature', feature: construct.feature });
        return true;
      }
      const c = curveUnder(services, e, { lines: true, construction: true });
      if (c) {
        const why = after(services, cur.feature, c.feature);
        if (why) setError(why);
        else set({ kind: 'sketch-line', sketch: c.feature, entity: c.entity });
        return true;
      }
      const p = h.pick(e.clientX, e.clientY);
      if (!p) {
        // A click that met nothing says so (P4a review: silent misses).
        setError('Nothing to pick there: click an axis (Origin X, Y or Z, or a CONSTRUCT axis), a sketch line, a straight or round edge, or a round face');
        return true;
      }
      const item = p.item;
      if (item.kind === 'origin') {
        if (item.ref === 'origin:x' || item.ref === 'origin:y' || item.ref === 'origin:z') set({ kind: 'origin', axis: item.ref });
        else if (cur.planes && (item.ref === 'origin:top' || item.ref === 'origin:front' || item.ref === 'origin:right')) set({ kind: 'normal', plane: { kind: 'origin', plane: item.ref } });
        else setError(PLANE_NOT_AXIS);
        return true;
      }
      const info = item.kind === 'edge' || item.kind === 'face' ? s.rebuild.bodies.find((b) => b.id === item.body) : null;
      if (!info || (item.kind !== 'edge' && item.kind !== 'face')) return false;
      void (async () => {
        try {
          if (item.kind === 'edge') {
            const ref = await refOfEdge(kernelLookup(services.kernel), info.shape, info.names ?? null, item.index);
            if (ref.signature.type !== 'line' && ref.signature.type !== 'circle') {
              setError('That edge is neither straight nor round, so it gives no axis');
              return;
            }
            if (splitEdgeName(ref.name)?.every((n) => madeBy(n, cur.feature))) {
              setError('That edge is made by this feature itself');
              return;
            }
            set({ kind: 'edge', body: info.id, ref });
          } else {
            const r = await pickFace(services, info, item.index, cur.feature);
            if (!r.ok) {
              setError(r.reason);
              return;
            }
            if (cur.planes && r.ref.signature.type === 'plane') {
              // A flat face gives its normal.
              set({ kind: 'normal', plane: { kind: 'face', body: info.id, ref: r.ref } });
              return;
            }
            if (!['cylinder', 'cone', 'sphere', 'torus'].includes(r.ref.signature.type)) {
              setError('That face is flat: pick a round face (its axis), an edge, a sketch line or an axis');
              return;
            }
            set({ kind: 'face-axis', body: info.id, ref: r.ref });
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
      return true;
    },
  });
  const lines: PickLine[] = [];
  if (axis) lines.push({ points: axisLine(axis.origin, axis.dir, partHalfSize(services)), state: 'picked', dashed: true });
  const sl = o.value?.kind === 'sketch-line' ? o.value : null;
  if (sl) {
    const s = services.doc.state.get();
    const out = sketchOutput(s, sl.sketch);
    const sk = s.doc.features.find((f) => f.id === sl.sketch) as SketchFeature | undefined;
    const g = out && sk ? geometryOf(sk, out).find((x) => x.id === sl.entity) : null;
    if (g && out) lines.push({ points: curvePolyline(g, out), state: 'picked' });
  }
  if (hover && o.active) lines.push(hover);
  const fname = featureNameOf(services);
  const bodyOf = (id: BodyId) => services.doc.state.get().rebuild.bodies.find((b) => b.id === id);
  const sketchOf = (id: FeatureId) => services.doc.state.get().doc.features.find((f) => f.id === id) as SketchFeature | undefined;
  const rows: PickRow[] = o.value ? [{ key: 'axis', label: refWords(o.value, fname, (id) => bodyOf(id)?.name ?? null, sketchOf, (id) => bodyOf(id)?.names?.faces ?? null), sub: o.value.kind === 'sketch-line' ? 'sketch line' : o.value.kind === 'origin' ? 'origin' : o.value.kind === 'feature' ? 'axis' : o.value.kind === 'face-axis' ? 'face axis' : o.value.kind === 'normal' ? 'plane normal' : 'edge' }] : [];
  return {
    lines,
    error,
    element: (label, field, onActivate, hint) => (
      <PickList
        field={field}
        label={label}
        rows={rows}
        single
        active={o.active}
        onActivate={onActivate}
        error={error}
        hint={hint}
        empty={o.empty ?? null}
        onRemove={() => {
          setError(null);
          o.onChange(null);
        }}
      />
    ),
  };
}

// ------------------------------------------------------------ sweep path

export interface PathFieldOptions {
  feature: FeatureId;
  path: { sketch: FeatureId; entities: SketchEntityId[] } | null;
  active: boolean;
  refuse?(sketch: FeatureId): string | null;
  onChange(next: { sketch: FeatureId; entities: SketchEntityId[] } | null): void;
}

export function usePathField(services: AppServices, o: PathFieldOptions): FieldView & { lines: PickLine[] } {
  useStateStore(services.doc.state, (s) => s.rebuild.seq);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<PickLine | null>(null);
  const latest = useRef(o);
  latest.current = o;
  useViewportTool(services, {
    id: `solids-path-${o.feature}`,
    active: o.active,
    onPointer(e) {
      if (services.mode.get().mode !== 'model') return false;
      if (e.type === 'move' && !e.buttons) {
        const c = curveUnder(services, e, { construction: false });
        const out = c ? sketchOutput(services.doc.state.get(), c.feature) : null;
        setHover(c && out ? { points: curvePolyline(c.geom, out), state: 'hover' } : null);
        return !!c;
      }
      if (e.type === 'leave') {
        setHover(null);
        return false;
      }
      if (e.type !== 'click' || e.button !== 0) return false;
      const c = curveUnder(services, e, { construction: false });
      if (!c) {
        setError('Nothing to pick there: click a line or an arc of the path sketch');
        return true;
      }
      const cur = latest.current;
      const why = after(services, cur.feature, c.feature) ?? cur.refuse?.(c.feature) ?? null;
      if (why) {
        setError(why);
        return true;
      }
      setError(null);
      if (!cur.path || cur.path.sketch !== c.feature) cur.onChange({ sketch: c.feature, entities: [c.entity] });
      else {
        const has = cur.path.entities.includes(c.entity);
        const entities = has ? cur.path.entities.filter((x) => x !== c.entity) : [...cur.path.entities, c.entity];
        cur.onChange(entities.length ? { sketch: c.feature, entities } : null);
      }
      return true;
    },
  });
  const s = services.doc.state.get();
  const sk = o.path ? (s.doc.features.find((f) => f.id === o.path!.sketch) as SketchFeature | undefined) : undefined;
  const out = o.path ? sketchOutput(s, o.path.sketch) : null;
  const geom = sk && out ? geometryOf(sk, out) : [];
  const lines: PickLine[] = [];
  for (const id of o.path?.entities ?? []) {
    const g = geom.find((x) => x.id === id);
    if (g && out) lines.push({ points: curvePolyline(g, out), state: 'picked' });
  }
  if (hover && o.active) lines.push(hover);
  const rows: PickRow[] = (o.path?.entities ?? []).map((id) => {
    const there = geom.some((g) => g.id === id && !g.construction);
    return {
      key: id,
      label: `${curveWords(sk, id)} (${sk?.name ?? 'a deleted sketch'})`,
      sub: there ? null : 'not found',
      missing: !there,
      title: there ? undefined : `Not in ${sk?.name ?? 'the sketch'} now (deleted, or made construction). Remove it, or undo the change.`,
    };
  });
  return {
    lines,
    error,
    element: (label, field, onActivate, hint) => (
      <PickList
        field={field}
        label={label}
        rows={rows}
        active={o.active}
        onActivate={onActivate}
        error={error}
        hint={hint}
        onRemove={(id) => {
          setError(null);
          if (!o.path) return;
          const entities = o.path.entities.filter((x) => x !== id);
          o.onChange(entities.length ? { ...o.path, entities } : null);
        }}
      />
    ),
  };
}

// ------------------------------------------------------------ Up to target (a face or a vertex)

/** The shown body's indices of edges / vertices named as given (resolved by name on the body as shown). */
async function namedIndices(services: AppServices, info: BodyInfo, kind: 'edge' | 'vertex', names: readonly string[]): Promise<number[]> {
  if (!info.names || !names.length) return [];
  const lookup = kernelLookup(services.kernel);
  const want = new Set(names);
  if (kind === 'edge') {
    const all = await lookup.edges!(info.shape, 'all');
    return all
      .filter((e) => {
        const f = [...new Set(e.faces)];
        if (!f.length) return false;
        const a = info.names!.faces[f[0]];
        const b = info.names!.faces[f.length > 1 ? f[1] : f[0]];
        return !!a && !!b && want.has(a <= b ? `E:${a}&${b}` : `E:${b}&${a}`);
      })
      .map((e) => e.i);
  }
  const all = await lookup.vertices!(info.shape, 'all');
  return all
    .filter((v) => {
      const fs = (v.faces ?? []).map((i) => info.names!.faces[i]);
      if (!fs.length || fs.some((x) => !x)) return false;
      return want.has(`V:${[...new Set(fs)].sort().join('&')}`);
    })
    .map((v) => v.i);
}

export interface TargetFieldOptions {
  feature: FeatureId;
  value: BodyRef | null;
  active: boolean;
  onChange(next: BodyRef | null): void;
}

export function useTargetField(services: AppServices, o: TargetFieldOptions): FieldView & { highlight: SelectionItem[] } {
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  const [error, setError] = useState<string | null>(null);
  const [vertexItems, setVertexItems] = useState<SelectionItem[]>([]);
  const latest = useRef(o);
  latest.current = o;
  useViewportTool(services, {
    id: `solids-target-${o.feature}`,
    active: o.active,
    kinds: ['face', 'vertex'],
    onPointer(e, h) {
      if (e.type !== 'click' || e.button !== 0) return false;
      const p = h.pick(e.clientX, e.clientY);
      if (!p) {
        setError('Nothing to pick there: click a flat face or a vertex of a body');
        return true;
      }
      if (p.item.kind !== 'face' && p.item.kind !== 'vertex') return false;
      const item = p.item;
      const info = services.doc.state.get().rebuild.bodies.find((b) => b.id === item.body);
      if (!info) return true;
      const cur = latest.current;
      void (async () => {
        if (item.kind === 'face') {
          if (!h.planeNormal(item)) {
            setError('Up to takes a flat face or a vertex: that face is curved');
            return;
          }
          const r = await pickFace(services, info, item.index, cur.feature);
          if (!r.ok) setError(r.reason);
          else {
            setError(null);
            cur.onChange({ body: info.id, ref: r.ref });
          }
          return;
        }
        try {
          const ref = await refOfVertex(kernelLookup(services.kernel), info.shape, info.names ?? null, item.index);
          if (splitVertexName(ref.name)?.every((n) => madeBy(n, cur.feature))) {
            setError('That point is made by this feature itself');
            return;
          }
          setError(null);
          cur.onChange({ body: info.id, ref });
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
      return true;
    },
  });
  const v = o.value;
  const info = v ? bodies.find((b) => b.id === v.body) : undefined;
  const key = `${v?.ref.name ?? ''}|${info?.shape ?? ''}`;
  useEffect(() => {
    let live = true;
    if (!v || !info || v.ref.signature.kind !== 'vertex') setVertexItems([]);
    else void namedIndices(services, info, 'vertex', [v.ref.name]).then((ix) => live && setVertexItems(ix.map((index) => ({ kind: 'vertex', body: info.id, index }))));
    return () => {
      live = false;
    };
  }, [key]);
  const highlight: SelectionItem[] = v && info ? (v.ref.signature.kind === 'vertex' ? vertexItems : shownFaces(info, [v.ref]).map((index) => ({ kind: 'face', body: info.id, index }))) : [];
  const fname = featureNameOf(services);
  const rows: PickRow[] = v
    ? [
        {
          key: v.ref.name,
          label: `${v.ref.signature.kind === 'vertex' ? (vertexWords(v.ref.name, fname, info?.names?.faces ?? null) ?? 'A vertex') : describeFace(v.ref.name, fname, info?.names?.faces ?? null)}`,
          sub: v.ref.signature.kind === 'vertex' ? 'vertex' : 'flat face',
        },
      ]
    : [];
  return {
    highlight,
    error,
    element: (label, field, onActivate, hint) => (
      <PickList
        field={field}
        label={label}
        rows={rows}
        single
        active={o.active}
        onActivate={onActivate}
        error={error}
        hint={hint}
        onRemove={() => {
          setError(null);
          o.onChange(null);
        }}
      />
    ),
  };
}

// ------------------------------------------------------------ edges and faces of one body (fillet, chamfer)

export interface EdgeSetFieldOptions {
  feature: FeatureId;
  /** 'fillet' or 'chamfer': the role of the faces this feature makes from an edge (F:<id>:<role>:<edge name>). */
  role: string;
  body: BodyId | '';
  edges: PersistentRef[];
  faces: PersistentRef[];
  active: boolean;
  onChange(body: BodyId | '', edges: PersistentRef[], faces: PersistentRef[]): void;
}

export function useEdgeSetField(services: AppServices, o: EdgeSetFieldOptions): FieldView & { highlight: SelectionItem[] } {
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  const [error, setError] = useState<string | null>(null);
  const [edgeItems, setEdgeItems] = useState<SelectionItem[]>([]);
  const latest = useRef(o);
  latest.current = o;
  useViewportTool(services, {
    id: `solids-edges-${o.feature}`,
    active: o.active,
    kinds: ['edge', 'face'],
    onPointer(e, h) {
      if (e.type !== 'click' || e.button !== 0) return false;
      const p = h.pick(e.clientX, e.clientY);
      if (!p) {
        setError('Nothing to pick there: click an edge, or a face (all its edges)');
        return true;
      }
      if (p.item.kind !== 'edge' && p.item.kind !== 'face') return false;
      const item = p.item;
      const info = services.doc.state.get().rebuild.bodies.find((b) => b.id === item.body);
      if (!info) return true;
      const cur = latest.current;
      if (cur.body && cur.body !== info.id && (cur.edges.length || cur.faces.length)) {
        setError(`One body at a time: these edges are on ${bodies.find((b) => b.id === cur.body)?.name ?? 'another body'}. Remove them first to pick on ${info.name}.`);
        return true;
      }
      void (async () => {
        try {
          if (item.kind === 'edge') {
            const ref = await refOfEdge(kernelLookup(services.kernel), info.shape, info.names ?? null, item.index);
            const pair = splitEdgeName(ref.name) ?? [];
            if (pair.some((n) => madeBy(n, cur.feature))) {
              setError(`That edge is made by this ${cur.role} itself`);
              return;
            }
            setError(null);
            const has = cur.edges.some((x) => x.name === ref.name);
            cur.onChange(info.id, has ? cur.edges.filter((x) => x.name !== ref.name) : [...cur.edges, ref], cur.faces);
            return;
          }
          // A face this feature made from an edge (a fillet face): clicking it takes that edge out again.
          const name = info.names?.faces[item.index] ?? '';
          const m = new RegExp(`^F:${cur.feature}:${cur.role}:(E:.*?)(#\\d+)?$`).exec(name);
          if (m && cur.edges.some((x) => x.name === m[1])) {
            setError(null);
            cur.onChange(info.id, cur.edges.filter((x) => x.name !== m[1]), cur.faces);
            return;
          }
          const r = await pickFace(services, info, item.index, cur.feature);
          if (!r.ok) {
            setError(r.reason);
            return;
          }
          setError(null);
          const has = cur.faces.some((x) => x.name === r.ref.name);
          cur.onChange(info.id, cur.edges, has ? cur.faces.filter((x) => x.name !== r.ref.name) : [...cur.faces, r.ref]);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })();
      return true;
    },
  });
  const info = bodies.find((b) => b.id === o.body);
  const key = `${o.edges.map((e) => e.name).join('\n')}|${info?.shape ?? ''}`;
  useEffect(() => {
    let live = true;
    if (!info || !o.edges.length) setEdgeItems([]);
    else
      void namedIndices(services, info, 'edge', o.edges.map((e) => e.name))
        .then((ix) => live && setEdgeItems(ix.map((index) => ({ kind: 'edge', body: info.id, index }))))
        .catch(() => live && setEdgeItems([]));
    return () => {
      live = false;
    };
  }, [key]);
  // What the feature made from each picked edge (its fillet or chamfer faces) shows picked too.
  const made: SelectionItem[] = [];
  if (info?.names) {
    const want = new Set(o.edges.map((e) => `F:${o.feature}:${o.role}:${e.name}`));
    info.names.faces.forEach((n, index) => {
      const base = n.replace(/#\d+$/, '');
      if (want.has(base)) made.push({ kind: 'face', body: info.id, index });
    });
  }
  const highlight: SelectionItem[] = info ? [...edgeItems, ...made, ...shownFaces(info, o.faces).map((index): SelectionItem => ({ kind: 'face', body: info.id, index }))] : [];
  const fname = featureNameOf(services);
  const faceNames = info?.names?.faces ?? null;
  const rows: PickRow[] = [
    ...o.edges.map((e) => ({ key: e.name, label: edgeWords(e.name, fname, faceNames) ?? 'An edge', title: `Edge between ${(splitEdgeName(e.name) ?? []).map((f) => describeFace(f, fname, faceNames)).join(' and ')}`, sub: 'edge' })),
    ...o.faces.map((f) => ({ key: f.name, label: describeFace(f.name, fname, faceNames), sub: 'all its edges' })),
  ];
  return {
    highlight,
    error,
    element: (label, field, onActivate, hint) => (
      <PickList
        field={field}
        label={label}
        rows={rows}
        active={o.active}
        onActivate={onActivate}
        error={error}
        hint={hint}
        onRemove={(k) => {
          setError(null);
          const edges = o.edges.filter((x) => x.name !== k);
          const faces = o.faces.filter((x) => x.name !== k);
          o.onChange(edges.length || faces.length ? o.body : '', edges, faces);
        }}
      />
    ),
  };
}
