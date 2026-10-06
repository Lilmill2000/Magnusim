// The CONSTRUCT panels (flyout, PanelChrome through P2's feature panel kit):
//   Plane  Method (Offset from a plane, At an angle, Through 3 points,
//          Midplane, Normal to a curve) and its picks and values
//   Axis   Method (Through 2 points, Axis of a cylinder or cone, Along an
//          edge, Where 2 planes cross) and its picks; Reverse direction
//   Point  Method (At a vertex, Centre of an arc, circle or sphere, On an edge,
//          Where an edge crosses a plane, Coordinates) and its picks and values
// Every valid change applies live (the plane, axis or point moves in the view
// as it is edited); a pick fills its field and the next empty one takes the
// next click. The foot says what is missing, or why it failed; "Built:" reads
// what it is now. Done closes; Delete removes it (a new one: discards it);
// no header tick.
// Owner: REFERENCE (P4a).
// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { RefAxisFeature, RefPlaneFeature, RefPointFeature, Vec3 } from '../../types/doc';
import type { FeaturePanelProps } from '../../types/modules';
import type { AxisRef, CurveRef, EdgeRef, FaceRef, GeomRef, PlaneRef, PointRef } from '../../types/references';
import type { SelectionItem } from '../../types/selection';
import type { UnitsService } from '../../types/units';
import { Field, Hint, NumberUnitInput, Select } from '../../ui/kit';
import { P2FeaturePanel, Switch, useFeaturePanel, type FeaturePanelKit } from '../p2/panel';
import { useSelectionMirror } from '../p2/pick';
import { constructOutput } from './api';
import { AXIS_METHODS, PLANE_METHODS, POINT_METHODS } from './defs';
import { useRefField, type RefField } from './fields';


/** "0, 0, 20 mm" (a point), "0, 0, 1" (a direction). */
function vecWords(v: Vec3, units: UnitsService, unit: boolean): string {
  const n = (x: number) => (Math.abs(x) < 1e-9 ? 0 : x);
  return unit ? `${v.map((x) => units.format(n(x), 'length', { unit: false })).join(', ')} ${units.unitLabel('length')}` : v.map((x) => String(Math.round(n(x) * 1e6) / 1e6)).join(', ');
}

/** What it is now, from the latest rebuild ("Built: through 0, 0, 20 mm, normal 0, 0, 1"). */
function useReadout(feature: string): string | null {
  const services = useServices();
  const units = services.doc.units;
  useStateStore(services.doc.state, (s) => s.doc.units);
  const out = useStateStore(services.doc.state, (s) => constructOutput(s, feature));
  if (!out) return null;
  if (out.type === 'plane') return `Built: through ${vecWords(out.frame.origin, units, true)}, normal ${vecWords(out.frame.normal, units, false)}`;
  if (out.type === 'axis') return `Built: through ${vecWords(out.origin, units, true)}, direction ${vecWords(out.dir, units, false)}`;
  return `Built: at ${vecWords(out.p, units, true)}`;
}

function Readout({ feature }: { feature: string }) {
  const text = useReadout(feature);
  return text ? (
    <div data-construct-readout={feature}>
      <Hint>{text}</Hint>
    </div>
  ) : null;
}

/** The fields' highlight in the view, and tree rows clicked while a field is active going to it. */
function Mirror({ fields, active }: { fields: Record<string, RefField>; active: string }) {
  const services = useServices();
  const items: SelectionItem[] = Object.values(fields).flatMap((f) => f.highlight);
  useSelectionMirror(services, items, (picked) => void fields[active]?.take(picked));
  return null;
}

function MethodSelect<T extends string>({ id, value, options, onChange }: { id: string; value: T; options: { value: T; label: string }[]; onChange(v: T): void }) {
  return (
    <Field label="Method" htmlFor={id} field="method">
      <Select id={id} label="Method" field="method" value={value} options={options} onChange={(v) => onChange(v as T)} />
    </Field>
  );
}

/** The first slot (in panel order) that is still empty, else the first. */
function firstEmpty(slots: { key: string; full: boolean }[]): string {
  return (slots.find((s) => !s.full) ?? slots[0])?.key ?? '';
}

// ------------------------------------------------------------ Plane

function planeSlots(f: RefPlaneFeature): { key: string; full: boolean }[] {
  switch (f.method) {
    case 'offset':
      return [{ key: 'plane', full: !!f.plane }];
    case 'angle':
      return [
        { key: 'plane', full: !!f.plane },
        { key: 'axis', full: !!f.axis },
      ];
    case 'three_points':
      return [{ key: 'points', full: f.points.length >= 3 }];
    case 'midplane':
      return [{ key: 'planes', full: !!f.plane && !!f.plane2 }];
    case 'normal_to_curve':
      return [
        { key: 'edge', full: !!f.edge },
        { key: 'points', full: f.points.length >= 1 },
      ];
  }
}

export function RefPlanePanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<RefPlaneFeature>(props);
  const f = kit.draft;
  const units = services.doc.units;
  const [active, setActive] = useState(() => firstEmpty(planeSlots(f)));
  const next = (patch: Partial<RefPlaneFeature>) => {
    kit.set(patch);
    setActive(firstEmpty(planeSlots({ ...f, ...patch } as RefPlaneFeature)));
  };
  const id = (k: string) => `cad-plane-${props.feature}-${k}`;
  const fields: Record<string, RefField> = {
    plane: useRefField(services, { feature: props.feature, accept: 'plane', refs: f.plane ? [f.plane] : [], max: 1, active: active === 'plane' && (f.method === 'offset' || f.method === 'angle'), onChange: (r) => next({ plane: (r[0] as PlaneRef) ?? null }) }),
    axis: useRefField(services, { feature: props.feature, accept: 'axis', refs: f.axis ? [f.axis] : [], max: 1, active: active === 'axis' && f.method === 'angle', onChange: (r) => next({ axis: (r[0] as AxisRef) ?? null }) }),
    planes: useRefField(services, {
      feature: props.feature,
      accept: 'plane',
      refs: [f.plane, f.plane2].filter((x): x is PlaneRef => !!x),
      max: 2,
      active: active === 'planes' && f.method === 'midplane',
      onChange: (r) => next({ plane: (r[0] as PlaneRef) ?? null, plane2: (r[1] as PlaneRef) ?? null }),
    }),
    points: useRefField(services, {
      feature: props.feature,
      accept: 'point',
      refs: f.points,
      max: f.method === 'normal_to_curve' ? 1 : 3,
      active: active === 'points' && (f.method === 'three_points' || f.method === 'normal_to_curve'),
      onChange: (r) => next({ points: r as PointRef[] }),
    }),
    edge: useRefField(services, { feature: props.feature, accept: 'curve', refs: f.edge ? [f.edge] : [], max: 1, active: active === 'edge' && f.method === 'normal_to_curve', onChange: (r) => next({ edge: (r[0] as CurveRef) ?? null }) }),
  };
  const shown: Record<string, RefField> = {};
  for (const s of planeSlots(f)) shown[s.key] = fields[s.key];
  return (
    <P2FeaturePanel props={props} kit={kit as FeaturePanelKit<RefPlaneFeature>}>
      <Mirror fields={shown} active={active} />
      <MethodSelect
        id={id('method')}
        value={f.method}
        options={PLANE_METHODS}
        onChange={(method) => {
          kit.set({ method });
          setActive(firstEmpty(planeSlots({ ...f, method })));
        }}
      />
      {f.method === 'offset' || f.method === 'angle' ? fields.plane.element('Plane', 'plane', () => setActive('plane'), 'Click a plane or a flat face (in the view or the tree)') : null}
      {f.method === 'angle' ? fields.axis.element('Axis', 'axis', () => setActive('axis'), 'Click an axis or an edge lying in the plane') : null}
      {f.method === 'three_points' ? fields.points.element(`Points (${f.points.length} of 3)`, 'points', () => setActive('points'), 'Click three points: a CONSTRUCT point, a vertex, or a point of a sketch shown') : null}
      {f.method === 'midplane' ? fields.planes.element(`Planes (${[f.plane, f.plane2].filter(Boolean).length} of 2)`, 'planes', () => setActive('planes'), 'Click two planes or flat faces') : null}
      {f.method === 'normal_to_curve' ? (
        <>
          {fields.edge.element('Curve', 'edge', () => setActive('edge'), 'Click an edge, or a curve of a sketch (a Sweep path)')}
          {fields.points.element('Point on the curve', 'points', () => setActive('points'), 'Click a point or vertex on the curve, or set the position below')}
        </>
      ) : null}
      {f.method === 'offset' ? (
        <Field label="Distance" htmlFor={id('distance')} field="distance">
          <NumberUnitInput id={id('distance')} field="distance" label="Distance" expr={f.distance} quantity="length" units={units} onCommit={(e) => kit.update({ distance: e })} />
        </Field>
      ) : null}
      {f.method === 'angle' ? (
        <Field label="Angle" htmlFor={id('angle')} field="angle">
          <NumberUnitInput id={id('angle')} field="angle" label="Angle" expr={f.angle} quantity="angle" units={units} onCommit={(e) => kit.update({ angle: e })} />
        </Field>
      ) : null}
      {f.method === 'normal_to_curve' && !f.points.length ? (
        <Field label="Position" htmlFor={id('percent')} field="percent">
          <NumberUnitInput id={id('percent')} field="percent" label="Position" expr={f.percent} quantity="scalar" unit="%" units={units} validate={(v) => (v >= 0 && v <= 100 ? null : 'Position must be from 0 to 100')} onCommit={(e) => kit.update({ percent: e })} />
        </Field>
      ) : null}
      <div className="cad-field">
        <Switch field="flip" label={f.method === 'offset' ? 'Reverse direction' : 'Reverse normal'} checked={f.flip} onChange={(flip) => kit.set({ flip })} />
      </div>
      <Readout feature={props.feature} />
    </P2FeaturePanel>
  );
}

// ------------------------------------------------------------ Axis

function axisSlots(f: RefAxisFeature): { key: string; full: boolean }[] {
  switch (f.method) {
    case 'two_points':
      return [{ key: 'points', full: f.points.length >= 2 }];
    case 'cylinder':
      return [{ key: 'face', full: !!f.face }];
    case 'edge':
      return [{ key: 'edge', full: !!f.edge }];
    case 'two_planes':
      return [{ key: 'planes', full: f.planes.length >= 2 }];
  }
}

export function RefAxisPanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<RefAxisFeature>(props);
  const f = kit.draft;
  const [active, setActive] = useState(() => firstEmpty(axisSlots(f)));
  const next = (patch: Partial<RefAxisFeature>) => {
    kit.set(patch);
    setActive(firstEmpty(axisSlots({ ...f, ...patch } as RefAxisFeature)));
  };
  const id = (k: string) => `cad-axis-${props.feature}-${k}`;
  const fields: Record<string, RefField> = {
    points: useRefField(services, { feature: props.feature, accept: 'point', refs: f.points, max: 2, active: active === 'points' && f.method === 'two_points', onChange: (r) => next({ points: r as PointRef[] }) }),
    face: useRefField(services, { feature: props.feature, accept: 'round', refs: f.face ? [f.face] : [], max: 1, active: active === 'face' && f.method === 'cylinder', onChange: (r) => next({ face: (r[0] as FaceRef) ?? null }) }),
    edge: useRefField(services, { feature: props.feature, accept: 'axis', refs: f.edge ? [f.edge] : [], max: 1, active: active === 'edge' && f.method === 'edge', onChange: (r) => next({ edge: (r[0] as GeomRef as EdgeRef) ?? null }) }),
    planes: useRefField(services, { feature: props.feature, accept: 'plane', refs: f.planes, max: 2, active: active === 'planes' && f.method === 'two_planes', onChange: (r) => next({ planes: r as PlaneRef[] }) }),
  };
  const shown: Record<string, RefField> = {};
  for (const s of axisSlots(f)) shown[s.key] = fields[s.key];
  return (
    <P2FeaturePanel props={props} kit={kit}>
      <Mirror fields={shown} active={active} />
      <MethodSelect
        id={id('method')}
        value={f.method}
        options={AXIS_METHODS}
        onChange={(method) => {
          kit.set({ method });
          setActive(firstEmpty(axisSlots({ ...f, method })));
        }}
      />
      {f.method === 'two_points' ? fields.points.element(`Points (${f.points.length} of 2)`, 'points', () => setActive('points'), 'Click two points: a CONSTRUCT point, a vertex, or a point of a sketch shown') : null}
      {f.method === 'cylinder' ? fields.face.element('Face', 'face', () => setActive('face'), 'Click a cylindrical or conical face') : null}
      {f.method === 'edge' ? fields.edge.element('Edge', 'edge', () => setActive('edge'), 'Click a straight or round edge') : null}
      {f.method === 'two_planes' ? fields.planes.element(`Planes (${f.planes.length} of 2)`, 'planes', () => setActive('planes'), 'Click two planes or flat faces that cross') : null}
      <div className="cad-field">
        <Switch field="flip" label="Reverse direction" checked={f.flip} onChange={(flip) => kit.set({ flip })} />
      </div>
      <Readout feature={props.feature} />
    </P2FeaturePanel>
  );
}

// ------------------------------------------------------------ Point

function pointSlots(f: RefPointFeature): { key: string; full: boolean }[] {
  switch (f.method) {
    case 'vertex':
      return [{ key: 'vertex', full: !!f.vertex }];
    case 'center':
      return [{ key: 'center', full: !!(f.edge || f.face) }];
    case 'on_edge':
      return [{ key: 'edge', full: !!f.edge }];
    case 'edge_plane':
      return [
        { key: 'edge', full: !!f.edge },
        { key: 'plane', full: !!f.plane },
      ];
    case 'coordinates':
      return [];
  }
}

const ALONG = [
  { value: 'percent', label: 'Percent of its length' },
  { value: 'distance', label: 'Distance' },
];

export function RefPointPanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<RefPointFeature>(props);
  const f = kit.draft;
  const units = services.doc.units;
  const [active, setActive] = useState(() => firstEmpty(pointSlots(f)));
  const next = (patch: Partial<RefPointFeature>) => {
    kit.set(patch);
    setActive(firstEmpty(pointSlots({ ...f, ...patch } as RefPointFeature)));
  };
  const id = (k: string) => `cad-point-${props.feature}-${k}`;
  const center = f.edge ?? f.face;
  const fields: Record<string, RefField> = {
    vertex: useRefField(services, { feature: props.feature, accept: 'point', refs: f.vertex ? [f.vertex] : [], max: 1, active: active === 'vertex' && f.method === 'vertex', onChange: (r) => next({ vertex: (r[0] as PointRef) ?? null }) }),
    center: useRefField(services, {
      feature: props.feature,
      accept: 'center',
      refs: center ? [center] : [],
      max: 1,
      active: active === 'center' && f.method === 'center',
      onChange: (r) => {
        const x = r[0];
        next({ edge: x?.kind === 'edge' ? (x as EdgeRef) : null, face: x?.kind === 'face' ? (x as FaceRef) : null });
      },
    }),
    edge: useRefField(services, { feature: props.feature, accept: f.method === 'on_edge' ? 'curve' : 'edge', refs: f.edge ? [f.edge] : [], max: 1, active: active === 'edge' && (f.method === 'on_edge' || f.method === 'edge_plane'), onChange: (r) => next({ edge: (r[0] as CurveRef) ?? null }) }),
    plane: useRefField(services, { feature: props.feature, accept: 'plane', refs: f.plane ? [f.plane] : [], max: 1, active: active === 'plane' && f.method === 'edge_plane', onChange: (r) => next({ plane: (r[0] as PlaneRef) ?? null }) }),
  };
  const shown: Record<string, RefField> = {};
  for (const s of pointSlots(f)) shown[s.key] = fields[s.key];
  const xyz = f.xyz ?? ['0 mm', '0 mm', '0 mm'];
  return (
    <P2FeaturePanel props={props} kit={kit}>
      <Mirror fields={shown} active={active} />
      <MethodSelect
        id={id('method')}
        value={f.method}
        options={POINT_METHODS}
        onChange={(method) => {
          // A centre's edge is a round one, an edge to walk along may be any: a switch keeps only what fits.
          kit.set({ method, ...(method === 'center' ? {} : { face: null }) });
          setActive(firstEmpty(pointSlots({ ...f, method })));
        }}
      />
      {f.method === 'vertex' ? fields.vertex.element('Vertex', 'vertex', () => setActive('vertex'), 'Click a vertex (or a CONSTRUCT point, or a point of a sketch shown)') : null}
      {f.method === 'center' ? fields.center.element('Arc, circle or sphere', 'center', () => setActive('center'), 'Click a round edge or a spherical face') : null}
      {f.method === 'on_edge' || f.method === 'edge_plane' ? fields.edge.element('Edge', 'edge', () => setActive('edge'), f.method === 'on_edge' ? 'Click an edge, or a curve of a sketch' : 'Click an edge') : null}
      {f.method === 'edge_plane' ? fields.plane.element('Plane', 'plane', () => setActive('plane'), 'Click a plane or a flat face the edge crosses') : null}
      {f.method === 'on_edge' ? (
        <>
          <Field label="Where" htmlFor={id('along')} field="along">
            <Select id={id('along')} label="Where" field="along" value={f.along} options={ALONG} onChange={(v) => kit.set({ along: v as RefPointFeature['along'] })} />
          </Field>
          {f.along === 'distance' ? (
            <Field label="Distance" htmlFor={id('distance')} field="distance">
              <NumberUnitInput id={id('distance')} field="distance" label="Distance" expr={f.distance} quantity="length" units={units} validate={(v) => (v >= 0 ? null : 'Distance must not be negative')} onCommit={(e) => kit.update({ distance: e })} />
            </Field>
          ) : (
            <Field label="Position" htmlFor={id('percent')} field="percent">
              <NumberUnitInput id={id('percent')} field="percent" label="Position" expr={f.percent} quantity="scalar" unit="%" units={units} validate={(v) => (v >= 0 && v <= 100 ? null : 'Position must be from 0 to 100')} onCommit={(e) => kit.update({ percent: e })} />
            </Field>
          )}
          <div className="cad-field">
            <Switch field="from-end" label="From the other end" checked={f.fromEnd} onChange={(fromEnd) => kit.set({ fromEnd })} />
          </div>
        </>
      ) : null}
      {f.method === 'coordinates'
        ? (['X', 'Y', 'Z'] as const).map((axis, i) => (
            <Field key={axis} label={axis} htmlFor={id(axis)} field={`xyz-${i}`}>
              <NumberUnitInput
                id={id(axis)}
                field={axis.toLowerCase()}
                label={axis}
                expr={xyz[i]}
                quantity="length"
                units={units}
                onCommit={(e) => {
                  const v = [...xyz] as RefPointFeature['xyz'];
                  v[i] = e;
                  return kit.update({ xyz: v });
                }}
              />
            </Field>
          ))
        : null}
      <Readout feature={props.feature} />
    </P2FeaturePanel>
  );
}
