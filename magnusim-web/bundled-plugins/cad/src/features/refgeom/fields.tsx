// The pick fields of the CONSTRUCT panels: a selection list (P2's PickList, the
// core's .mat-assign-list) of stored geometry references. While a field is
// active, a click in the view goes to it: a drawn reference Plane / Axis /
// Point under the pointer, else what the viewport picks with the field's
// filter (flat faces for a plane, edges for an axis, vertices for a point ...);
// a tree row (an origin plane, a CONSTRUCT feature) goes to it too. A field
// that takes planes draws the origin planes while it is active; one that takes
// an axis or a point offers the origin's (X, Y, Z axis; the Origin) as buttons.
// What the fields hold is shown by mirroring it into the shared selection.
// Owner: REFERENCE (P4a).
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { setSelectionFilter } from '../../lib/selection';
import { useStateStore } from '../../lib/store';
import type { AppServices } from '../../types/app';
import type { FeatureId, OriginAxisRef, SketchFeature } from '../../types/doc';
import type { GeomRef } from '../../types/references';
import type { SelectionItem, SelectKind } from '../../types/selection';
import type { ViewportHandle } from '../../types/viewport';
import { Button } from '../../ui/kit';
import { PickList, type PickRow } from '../p2/PickList';
import { shownFaces } from '../p2/refs';
import type { ConstructKind } from './api';
import { resolveIndexOn } from './brep';
import { constructOverlayOf } from './overlay';
import { curveUnder, sketchPointUnder } from '../solids/geom';
import { constructUnder } from './pick';
import { isOriginAxis, wantOriginAxes } from './scene';
import { acceptKinds, refFromItem, type Accept } from './refs';
import { refWords } from './resolve';

export const FIELD_TOOL_ID = 'construct.field';

/** A stable key for a reference (rows, toggles). */
export function refKey(r: GeomRef): string {
  switch (r.kind) {
    case 'origin':
      return `origin:${'plane' in r ? r.plane : 'axis' in r ? r.axis : r.point}`;
    case 'feature':
      return `feature:${r.feature}`;
    case 'sketch-line':
      return `sketch-line:${r.sketch}:${r.entity}`;
    case 'sketch-point':
      return `sketch-point:${r.sketch}:${r.point}`;
    case 'sketch-curve':
      return `sketch-curve:${r.sketch}:${r.entity}`;
    case 'normal':
      return `normal:${refKey(r.plane)}`;
    default:
      return `${r.kind}:${r.body}:${r.ref.name}`;
  }
}

const CONSTRUCT_OF: Partial<Record<Accept, ConstructKind>> = { plane: 'plane', axis: 'axis', point: 'point' };

/** What a field takes, for a click that met nothing ("Nothing to pick there: click …"; P4a review: it said nothing). */
export const NOTHING_THERE: Record<Accept, string> = {
  plane: 'Nothing to pick there: click a plane or a flat face',
  axis: 'Nothing to pick there: click an axis, a straight or round edge, a round face or a sketch line',
  point: 'Nothing to pick there: click a vertex, a point or a point of a sketch',
  edge: 'Nothing to pick there: click an edge',
  curve: 'Nothing to pick there: click an edge or a curve of a sketch',
  round: 'Nothing to pick there: click a round face',
  center: 'Nothing to pick there: click a round edge or a round face',
};

export interface RefFieldOptions {
  /** The feature being edited (it cannot pick itself or what comes after it). */
  feature: FeatureId;
  accept: Accept;
  refs: GeomRef[];
  /** How many it holds (1: a pick replaces it). */
  max: number;
  active: boolean;
  onChange(refs: GeomRef[]): void;
}

export interface RefField {
  element: (label: string, field: string, onActivate: () => void, hint: string) => ReactElement;
  highlight: SelectionItem[];
  /** Items clicked in the tree while the field is active; true when it took them. */
  take(items: SelectionItem[]): boolean;
}

/**
 * The drawn CONSTRUCT items a click in feature `self`'s field may land on: not `self` (a plane
 * being edited is drawn where it is, over the faces a click wants: P4a review, "That is made by
 * this feature itself") and not a feature after it in the history; the origin's axes always.
 */
export function pickableConstructs<T extends { feature: string }>(services: AppServices, self: FeatureId, drawn: readonly T[]): T[] {
  const fs = services.doc.state.get().doc.features;
  const at = fs.findIndex((g) => g.id === self);
  return drawn.filter((c) => {
    if (isOriginAxis(c.feature)) return true;
    if (c.feature === self) return false;
    const i = fs.findIndex((g) => g.id === c.feature);
    return at < 0 || i < 0 || i < at;
  });
}

/** Push the field's pick tool on the viewport while active (the newest wins), with its filter. */
function useFieldPicker(services: AppServices, self: FeatureId, accept: Accept, active: boolean, onPick: (item: SelectionItem) => void, onMiss: (why: string) => void) {
  const latest = useRef(onPick);
  latest.current = onPick;
  const miss = useRef(onMiss);
  miss.current = onMiss;
  useEffect(() => {
    if (!active) return;
    let pop: (() => void) | null = null;
    let handle: ViewportHandle | null = null;
    const wantsPlanes = accept === 'plane';
    // A field that takes an axis draws the origin's axes, so they can be clicked in the view.
    if (accept === 'axis') wantOriginAxes(services, `${FIELD_TOOL_ID}:${self}`, true);
    const attach = (h: ViewportHandle | null) => {
      if (h === handle) return;
      pop?.();
      pop = null;
      if (handle && wantsPlanes) handle.setPlanesWanted(FIELD_TOOL_ID, false);
      handle = h;
      if (!h) return;
      if (wantsPlanes) h.setPlanesWanted(FIELD_TOOL_ID, true);
      pop = h.pushTool({
        id: FIELD_TOOL_ID,
        cursor: 'pointer',
        onPointer(e) {
          if (e.type === 'dblclick') return true;
          if (e.type !== 'click' || e.button !== 0) return false;
          const kind = CONSTRUCT_OF[accept];
          const drawn = pickableConstructs(services, self, constructOverlayOf(services)?.items() ?? []);
          const hit = kind ? constructUnder(h, drawn, e, [kind]) : null;
          if (hit) {
            latest.current(isOriginAxis(hit.feature) ? { kind: 'origin', ref: hit.feature } : { kind: 'feature', feature: hit.feature });
            return true;
          }
          // A point of a sketch drawn in the view (a line's end, a centre, a point).
          if (accept === 'point') {
            const sp = sketchPointUnder(services, e);
            if (sp) {
              latest.current({ kind: 'sketch', feature: sp.feature, id: sp.point, what: 'point' });
              return true;
            }
          }
          // A curve of a sketch drawn in the view (a Sweep path, a centerline as an axis).
          if (accept === 'curve' || accept === 'axis') {
            const c = curveUnder(services, e, { lines: accept === 'axis', construction: accept === 'axis' });
            if (c) {
              latest.current({ kind: 'sketch', feature: c.feature, id: c.entity, what: 'entity' });
              return true;
            }
          }
          const p = h.pick(e.clientX, e.clientY);
          if (p) latest.current(p.item);
          else miss.current(NOTHING_THERE[accept]);
          return true;
        },
      });
    };
    attach(services.viewport.get().handle);
    const off = services.viewport.subscribe((s) => attach(s.handle));
    const before = services.selection.get().filter;
    const mine = acceptKinds(accept).filter((k) => k !== 'feature') as SelectKind[];
    setSelectionFilter(services.selection, mine);
    return () => {
      off();
      pop?.();
      if (accept === 'axis') wantOriginAxes(services, `${FIELD_TOOL_ID}:${self}`, false);
      if (handle && wantsPlanes) handle.setPlanesWanted(FIELD_TOOL_ID, false);
      const now = services.selection.get().filter;
      if (now.join(',') === mine.join(',')) setSelectionFilter(services.selection, before);
    };
  }, [services, self, accept, active]);
}

/** Edge and vertex references resolved to their index on the body shown (for the highlight). */
function useShownIndices(services: AppServices, refs: readonly GeomRef[]): Map<string, SelectionItem> {
  const seq = useStateStore(services.doc.state, (s) => s.rebuild.seq);
  const [map, setMap] = useState(() => new Map<string, SelectionItem>());
  const key = refs.map(refKey).join('\n');
  useEffect(() => {
    let alive = true;
    const bodies = services.doc.state.get().rebuild.bodies;
    void (async () => {
      const next = new Map<string, SelectionItem>();
      for (const r of refs) {
        if (r.kind !== 'edge' && r.kind !== 'vertex') continue;
        const b = bodies.find((x) => x.id === r.body);
        if (!b?.names) continue;
        try {
          const i = await resolveIndexOn(services.kernel, r.kind, b.shape, b.names, r.ref);
          if (i != null) next.set(refKey(r), { kind: r.kind, body: b.id, index: i });
        } catch {
          /* not found: no highlight; the feature's error says so */
        }
      }
      if (alive) setMap(next);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, key, seq]);
  return map;
}

const ORIGIN_AXIS_BUTTONS: { axis: OriginAxisRef; label: string }[] = [
  { axis: 'origin:x', label: 'X axis' },
  { axis: 'origin:y', label: 'Y axis' },
  { axis: 'origin:z', label: 'Z axis' },
];

export function useRefField(services: AppServices, o: RefFieldOptions): RefField {
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  const features = useStateStore(services.doc.state, (s) => s.doc.features);
  const status = useStateStore(services.doc.state, (s) => s.rebuild.features[o.feature]);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(o);
  latest.current = o;
  const add = (ref: GeomRef) => {
    const cur = latest.current;
    setError(null);
    const k = refKey(ref);
    if (cur.max <= 1) {
      cur.onChange([ref]);
      return;
    }
    if (cur.refs.some((r) => refKey(r) === k)) cur.onChange(cur.refs.filter((r) => refKey(r) !== k));
    else if (cur.refs.length >= cur.max) setError(`It takes ${cur.max}: remove one first`);
    else cur.onChange([...cur.refs, ref]);
  };
  const pick = (item: SelectionItem) => {
    void refFromItem(services, item, latest.current.accept, latest.current.feature).then((r) => {
      if (!r.ok) setError(r.reason);
      else add(r.ref);
    });
  };
  useFieldPicker(services, o.feature, o.accept, o.active, pick, setError);
  const indices = useShownIndices(services, o.refs);
  const featureName = (id: FeatureId) => features.find((f) => f.id === id)?.name ?? null;
  const bodyName = (id: string) => bodies.find((b) => b.id === id)?.name ?? null;
  const highlight: SelectionItem[] = [];
  for (const r of o.refs) {
    if (r.kind === 'origin') {
      if ('plane' in r) highlight.push({ kind: 'origin', ref: r.plane });
      else if ('axis' in r) highlight.push({ kind: 'origin', ref: r.axis });
    } else if (r.kind === 'feature') highlight.push({ kind: 'feature', feature: r.feature });
    else if (r.kind === 'sketch-point') highlight.push({ kind: 'sketch', feature: r.sketch, id: r.point, what: 'point' });
    else if (r.kind === 'face' || r.kind === 'face-axis') {
      const b = bodies.find((x) => x.id === r.body);
      if (b) for (const index of shownFaces(b, [r.ref])) highlight.push({ kind: 'face', body: b.id, index });
    } else {
      const it = indices.get(refKey(r));
      if (it) highlight.push(it);
    }
  }
  const message = status?.state === 'error' ? (status.message ?? '') : '';
  const rows: PickRow[] = o.refs.map((r) => {
    const label = refWords(r, featureName, bodyName, (id) => features.find((f) => f.id === id) as SketchFeature | undefined, (id) => bodies.find((b) => b.id === id)?.names?.faces ?? null);
    const onBody = 'body' in r ? bodyName(r.body) ?? null : null;
    const lost = !!message && (message.includes(`${label} not found`) || message.includes(`${label} did not build`) || message.includes(`${label} is suppressed`) || (!!onBody && message.includes(`${onBody} is not there`)) || ('body' in r && !onBody && / is not there at this point/.test(message)));
    if (lost) return { key: refKey(r), label, title: `${message}. Remove it and pick again, or undo the change that removed it.`, sub: 'not found', missing: true };
    const sub = r.kind === 'face' ? (r.ref.signature.type === 'plane' ? 'flat' : r.ref.signature.type) : r.kind === 'face-axis' ? 'axis' : r.kind === 'edge' ? r.ref.signature.type : null;
    return { key: refKey(r), label, sub };
  });
  const originButtons = o.accept === 'axis' ? ORIGIN_AXIS_BUTTONS.map((b) => ({ key: b.axis, label: b.label, ref: { kind: 'origin', axis: b.axis } as GeomRef })) : o.accept === 'point' ? [{ key: 'origin:point', label: 'Origin', ref: { kind: 'origin', point: 'origin:point' } as GeomRef }] : [];
  return {
    highlight,
    take(items) {
      if (!latest.current.active) return false;
      const usable = items.filter((it) => it.kind === 'origin' || it.kind === 'feature' || it.kind === 'face' || it.kind === 'edge' || it.kind === 'vertex' || it.kind === 'sketch');
      if (usable.length !== 1) return false;
      pick(usable[0]);
      return true;
    },
    element: (label, field, onActivate, hint) => (
      <div className="cad-construct-field" data-construct-field={field}>
        <PickList
          field={field}
          label={label}
          rows={rows}
          active={o.active}
          single={o.max <= 1}
          onActivate={onActivate}
          error={error}
          hint={hint}
          onRemove={(key) => {
            setError(null);
            o.onChange(o.refs.filter((r) => refKey(r) !== key));
          }}
        />
        {originButtons.length ? (
          <div className="cad-construct-origin" data-construct-origin={field}>
            <span className="cad-construct-origin-label">Or the origin's:</span>
            {originButtons.map((b) => (
              <Button
                key={b.key}
                variant="link"
                data-origin-pick={b.key}
                onClick={() => {
                  onActivate();
                  add(b.ref);
                }}
              >
                {b.label}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    ),
  };
}
