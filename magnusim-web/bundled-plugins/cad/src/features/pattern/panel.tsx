// The panel of Linear pattern, Circular pattern and Mirror (the feature panel conventions:
// live apply, Done in the foot, Delete only when removable, no header tick):
//   Pattern of   Features | Bodies | Faces
//   Features     body-making features: their tree rows, or a click on a face they made
//   Bodies       bodies: a click in the view or their rows
//   Faces        faces of one body (the boss, pocket or hole they bound is copied onto it)
//   Linear       Direction 1 (an axis, an edge, a sketch line or a plane's normal), Flip,
//                Count, Spacing or Extent, Symmetric; "Add direction 2"
//   Circular     Axis, Flip, Count, Full 360° or Angle (first to last), Symmetric (Angle)
//   Mirror       Mirror plane (an origin or CONSTRUCT plane, a flat face)
//   Instances    how many copies are made, which are skipped (a click on a copy's number in
//                the view skips it or brings it back)
//   Operation    As each feature (features), New body / Join / Cut / Intersect
// Owner: P4b PATTERN.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef, useState, type ReactElement } from 'react';
import { showForPanel } from '../../lib/selection';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { AppServices } from '../../types/app';
import type { BodyOp, CircularPatternFeature, Feature, FeatureId, LinearPatternFeature, MirrorFeature, PatternCommon, PatternDirection, PatternOf, PatternOp } from '../../types/doc';
import type { AxisRef, PlaneRef } from '../../types/references';
import type { OriginAxisRef, OriginPlaneRef } from '../../types/doc';
import { constructOf } from '../refgeom/api';
import type { PatternOutput } from '../../types/doc-service';
import type { FeaturePanelProps } from '../../types/modules';
import type { SelectionItem } from '../../types/selection';
import { Button, Field, FieldGroup, Hint, NumberUnitInput, Select } from '../../ui/kit';
import { wholeTurn } from './transforms';
import { useBodyField, useFaceField } from '../p2/fields';
import { P2FeaturePanel, useFeaturePanel, type FeaturePanelKit } from '../p2/panel';
import { usePicker, useSelectionMirror } from '../p2/pick';
import { PickList, type PickRow } from '../p2/PickList';
import { featureOfName } from '../p2/refs';
import { useRefField } from '../refgeom/fields';
import { useAxisField } from '../solids/fields';
import { usePicksLines } from '../solids/view';
import { effectiveOp, REPEATABLE_TYPES } from './build';
import { usePatternMarkers } from './markers';
import './pattern.css';

const OF: { value: PatternOf; label: string }[] = [
  { value: 'features', label: 'Features' },
  { value: 'bodies', label: 'Bodies' },
  { value: 'faces', label: 'Faces' },
];
const OP_WORDS: Record<BodyOp, string> = { new: 'New body', join: 'Join', cut: 'Cut', intersect: 'Intersect' };

type AnyPattern = (LinearPatternFeature | CircularPatternFeature | MirrorFeature) & PatternCommon;

/** The default Operation for a kind of source (features: each feature's own). */
export function defaultOp(of: PatternOf): PatternOp {
  return of === 'features' ? 'source' : of === 'bodies' ? 'new' : 'join';
}

// ------------------------------------------------------------ features field

/** Why feature `id` cannot be repeated by pattern `self`, or null. */
export function featureRefusal(services: Pick<AppServices, 'doc'>, self: FeatureId, id: FeatureId): string | null {
  const fs = services.doc.state.get().doc.features;
  const g = fs.find((x) => x.id === id);
  if (!g) return 'That feature is not in the part';
  if (id === self) return 'A pattern cannot repeat itself';
  const at = fs.findIndex((x) => x.id === self);
  const i = fs.findIndex((x) => x.id === id);
  if (at >= 0 && i > at) return `${g.name} comes after this feature in the history: pick a feature above it`;
  if (!REPEATABLE_TYPES.includes(g.type)) return `${g.name} makes no body of its own to repeat: pick an Extrude, Revolve, Sweep, Loft, pattern or mirror, or pattern its body or faces`;
  if ('of' in g && g.of === 'faces') return `${g.name} copies faces of a body, so it has no tool body to repeat`;
  return null;
}

function useFeatureField(services: AppServices, o: { feature: FeatureId; ids: FeatureId[]; active: boolean; onChange(ids: FeatureId[]): void }) {
  const features = useStateStore(services.doc.state, (s) => s.doc.features);
  const status = useStateStore(services.doc.state, (s) => s.rebuild.features);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(o);
  latest.current = o;
  const toggle = (id: FeatureId) => {
    const cur = latest.current;
    const why = featureRefusal(services, cur.feature, id);
    if (why && !cur.ids.includes(id)) {
      setError(why);
      return;
    }
    setError(null);
    cur.onChange(cur.ids.includes(id) ? cur.ids.filter((x) => x !== id) : [...cur.ids, id]);
  };
  // A click on a face in the view picks the feature that made it.
  usePicker(services, {
    id: `pattern-features-${o.feature}`,
    active: o.active,
    kinds: ['face'],
    onPick(p) {
      if (p.item.kind !== 'face') return;
      const item = p.item;
      const body = services.doc.state.get().rebuild.bodies.find((b) => b.id === item.body);
      const name = body?.names?.faces[item.index];
      const maker = name ? featureOfName(name) : null;
      if (!maker) {
        setError('That face has no feature of its own to repeat: pick the body, or the faces, instead');
        return;
      }
      toggle(maker);
    },
  });
  const rows: PickRow[] = o.ids.map((id) => {
    const g = features.find((x) => x.id === id);
    const bad = !g || status[id]?.state === 'error' || g.suppressed;
    return { key: id, label: g?.name ?? 'A deleted feature', sub: g ? (bad ? (g.suppressed ? 'suppressed' : 'failed') : OP_WORDS[effectiveOp({ features }, g)]) : 'not found', missing: !g };
  });
  return {
    take(items: SelectionItem[]): boolean {
      if (!latest.current.active) return false;
      const picked = items.filter((it): it is Extract<SelectionItem, { kind: 'feature' }> => it.kind === 'feature');
      if (picked.length !== 1) return false;
      toggle(picked[0].feature);
      return true;
    },
    highlight: o.ids.map((feature): SelectionItem => ({ kind: 'feature', feature })),
    element: (label: string, field: string, onActivate: () => void, hint: string): ReactElement => (
      <PickList field={field} label={label} rows={rows} active={o.active} onActivate={onActivate} error={error} hint={hint} onRemove={(key) => o.onChange(o.ids.filter((x) => x !== key))} />
    ),
  };
}

// ------------------------------------------------------------ parts

function OperationRow({ feature, f, onChange }: { feature: FeatureId; f: AnyPattern; onChange(op: PatternOp): void }) {
  const services = useServices();
  const features = useStateStore(services.doc.state, (s) => s.doc.features);
  if (f.of === 'faces') {
    const body = services.doc.state.get().rebuild.bodies.find((b) => b.id === f.faceBody);
    return <Hint>{`The copies go onto ${body?.name ?? 'the body'}: a boss is added, a pocket or hole is cut.`}</Hint>;
  }
  const id = `cad-f-${feature}-op`;
  const own = f.features
    .map((x) => features.find((g) => g.id === x))
    .filter((g): g is Feature => !!g)
    .map((g) => OP_WORDS[effectiveOp({ features }, g)]);
  const ownWords = [...new Set(own)].join(', ');
  const options: { value: PatternOp; label: string }[] = [
    ...(f.of === 'features' ? [{ value: 'source' as PatternOp, label: 'As each feature' }] : []),
    { value: 'new', label: 'New body' },
    { value: 'join', label: 'Join' },
    { value: 'cut', label: 'Cut' },
    { value: 'intersect', label: 'Intersect' },
  ];
  return (
    <>
      <Field label="Operation" htmlFor={id} field="op">
        <Select id={id} label="Operation" field="op" value={f.op === 'source' && f.of !== 'features' ? 'new' : f.op} onChange={(v) => onChange(v as PatternOp)} options={options} />
      </Field>
      {f.of === 'features' && f.op === 'source' && ownWords ? (
        <div data-op-words="1">
          <Hint>{`Each feature's own: ${ownWords}`}</Hint>
        </div>
      ) : null}
    </>
  );
}

function Check({ feature, field, label, checked, onChange }: { feature: FeatureId; field: string; label: string; checked: boolean; onChange(v: boolean): void }) {
  const id = `cad-f-${feature}-${field}`;
  return (
    <Field label={label} htmlFor={id} field={field}>
      <input id={id} type="checkbox" className="cad-check" data-field={field} checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </Field>
  );
}

function Instances({ feature, out, skip, onRestore }: { feature: FeatureId; out: PatternOutput | null; skip: string[]; onRestore(key: string): void }) {
  if (!out) return null;
  const total = out.copies.length + 1;
  const skipped = out.copies.filter((c) => c.skipped);
  const words = out.copies.some((c) => c.key === 'm')
    ? skipped.length
      ? 'The mirror copy is skipped: nothing is made'
      : 'The original and its mirror copy'
    : `${total} instances: the original and ${out.copies.length} ${out.copies.length === 1 ? 'copy' : 'copies'}${skipped.length ? `, ${skipped.length} skipped` : ''}`;
  return (
    <div className="cad-pattern-instances" data-pattern-instances={feature} data-instances={total} data-made={out.made} data-skipped={skip.length}>
      <div className="cad-pattern-count" data-instance-words="1">
        {words}
      </div>
      {skipped.length ? (
        <ul className="cad-pattern-skipped">
          {skipped.map((c) => (
            <li key={c.key} data-skipped-instance={c.key}>
              <span>{c.label} · skipped</span>
              <Button variant="link" data-restore-instance={c.key} onClick={() => onRestore(c.key)}>
                Make it again
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Hint>Click a copy's number in the view to skip it or make it again.</Hint>
    </div>
  );
}

function DirectionFields({ feature, prefix, d, units, onChange }: { feature: FeatureId; prefix: string; d: PatternDirection; units: AppServices['doc']['units']; onChange(next: PatternDirection): void }) {
  const id = (k: string) => `cad-pat-${feature}-${prefix}-${k}`;
  const what = d.mode === 'extent' ? 'Extent' : 'Spacing';
  return (
    <>
      <Check feature={feature} field={`${prefix}-flip`} label="Flip direction" checked={d.flip} onChange={(flip) => onChange({ ...d, flip })} />
      <Field label={d.symmetric ? 'Count per side' : 'Count'} htmlFor={id('count')} field={`${prefix}-count`}>
        <NumberUnitInput
          id={id('count')}
          field={`${prefix}-count`}
          label="Count"
          expr={d.count}
          quantity="scalar"
          units={units}
          validate={(v) => (Math.abs(v - Math.round(v)) > 1e-9 ? 'Count must be a whole number' : v < 2 ? 'Count must be at least 2 (the original counts as 1)' : null)}
          onCommit={(count) => onChange({ ...d, count })}
        />
      </Field>
      <Field label="Distance" htmlFor={id('mode')} field={`${prefix}-mode`}>
        <Select
          id={id('mode')}
          label="Distance"
          field={`${prefix}-mode`}
          value={d.mode}
          onChange={(v) => onChange({ ...d, mode: v as PatternDirection['mode'] })}
          options={[
            { value: 'spacing', label: 'Spacing' },
            { value: 'extent', label: 'Extent' },
          ]}
        />
      </Field>
      <Field label={what} htmlFor={id('distance')} field={`${prefix}-distance`}>
        <NumberUnitInput id={id('distance')} field={`${prefix}-distance`} label={what} expr={d.distance} quantity="length" units={units} validate={(v) => (v > 0 ? null : `${what} must be more than 0`)} onCommit={(distance) => onChange({ ...d, distance })} />
      </Field>
      <Hint>{d.mode === 'extent' ? 'From the original to the last copy' : 'Between neighbouring copies'}</Hint>
      <Check feature={feature} field={`${prefix}-symmetric`} label="Symmetric" checked={d.symmetric} onChange={(symmetric) => onChange({ ...d, symmetric })} />
    </>
  );
}

// ------------------------------------------------------------ the panel

type Slot = 'sources' | 'dir1' | 'dir2' | 'axis' | 'plane';

export function PatternPanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<AnyPattern>(props);
  const f = kit.draft;
  const units = services.doc.units;
  const out = useStateStore(services.doc.state, (s) => (s.rebuild.outputs[props.feature]?.type === 'pattern' ? (s.rebuild.outputs[props.feature] as PatternOutput) : null));
  const sourcesEmpty = f.of === 'features' ? !f.features.length : f.of === 'bodies' ? !f.bodies.length : !f.faces.length;
  const lin = f.type === 'pattern_linear' ? (f as LinearPatternFeature) : null;
  const circ = f.type === 'pattern_circular' ? (f as CircularPatternFeature) : null;
  const mir = f.type === 'mirror' ? (f as MirrorFeature) : null;
  const order: [Slot, boolean][] = [['sources', sourcesEmpty]];
  if (lin) order.push(['dir1', !lin.dir1.axis], ...(lin.dir2 ? [['dir2', !lin.dir2.axis] as [Slot, boolean]] : []));
  if (circ) order.push(['axis', !circ.axis]);
  if (mir) order.push(['plane', !mir.plane]);
  const [chosen, choose] = useState<Slot | null>(null);
  const active: Slot | null = chosen ?? order.find(([, empty]) => empty)?.[0] ?? null;
  const setAnd = (patch: Partial<AnyPattern>, next: Slot | null = null) => {
    kit.set(patch);
    choose(next);
  };

  const feats = useFeatureField(services, { feature: props.feature, ids: f.features, active: active === 'sources' && f.of === 'features', onChange: (features) => setAnd({ features } as Partial<AnyPattern>, 'sources') });
  const bodies = useBodyField(services, {
    feature: props.feature,
    ids: f.bodies,
    active: active === 'sources' && f.of === 'bodies',
    refuse: (id) => (services.doc.state.get().rebuild.bodies.find((b) => b.id === id)?.feature === props.feature ? 'That body is a copy this pattern makes' : null),
    onChange: (ids) => setAnd({ bodies: ids } as Partial<AnyPattern>, 'sources'),
  });
  const faces = useFaceField(services, { feature: props.feature, body: f.faceBody, refs: f.faces, active: active === 'sources' && f.of === 'faces', oneBody: 'Pick faces of one body (the copies go onto it)', describe: true, onChange: (faceBody, refs) => setAnd({ faceBody, faces: refs } as Partial<AnyPattern>, 'sources') });
  const dir1 = useAxisField(services, { feature: props.feature, value: lin?.dir1.axis ?? null, active: !!lin && active === 'dir1', planes: true, onChange: (axis) => lin && setAnd({ dir1: { ...lin.dir1, axis } } as Partial<AnyPattern>) });
  const dir2 = useAxisField(services, { feature: props.feature, value: lin?.dir2?.axis ?? null, active: !!lin?.dir2 && active === 'dir2', planes: true, onChange: (axis) => lin?.dir2 && setAnd({ dir2: { ...lin.dir2, axis } } as Partial<AnyPattern>) });
  const axis = useAxisField(services, { feature: props.feature, value: circ?.axis ?? null, active: !!circ && active === 'axis', onChange: (a) => circ && setAnd({ axis: a } as Partial<AnyPattern>) });
  const plane = useRefField(services, { feature: props.feature, accept: 'plane', refs: mir?.plane ? [mir.plane] : [], max: 1, active: !!mir && active === 'plane', onChange: (r) => mir && setAnd({ plane: (r[0] as PlaneRef) ?? null } as Partial<AnyPattern>) });

  const highlight: SelectionItem[] = f.of === 'features' ? feats.highlight : f.of === 'bodies' ? bodies.highlight : faces.highlight;
  const shownRef = useRef<SelectionItem[]>([]);
  shownRef.current = [...highlight, ...(mir ? plane.highlight : [])];
  useSelectionMirror(services, [...highlight, ...(mir ? plane.highlight : [])], (picked) => {
    // An axis or a plane row (Origin's, a CONSTRUCT one) can only be the direction, axis or mirror
    // plane: it goes there whichever field is active (the sources take bodies, faces and features).
    // Whatever the click was, the selection goes back to what the panel shows once the fields have
    // read it: an axis row picked for a direction does not stay selected into the next command
    // (fix round 1, P2).
    queueMicrotask(() => showForPanel(services.selection, shownRef.current));
    if (picked.length === 1 && routeGeometry(picked[0])) return;
    if (active === 'sources') {
      if (f.of === 'features') feats.take(picked);
      else if (f.of === 'bodies') bodies.take(picked);
    } else if (active === 'plane') plane.take(picked);
  });
  /** A tree row of an axis or a plane, when the field that takes it is not the active one (it handles its own). */
  function routeGeometry(item: SelectionItem): boolean {
    const isAxis = item.kind === 'origin' && (item.ref === 'origin:x' || item.ref === 'origin:y' || item.ref === 'origin:z');
    const isPlane = item.kind === 'origin' && (item.ref === 'origin:top' || item.ref === 'origin:front' || item.ref === 'origin:right');
    const c = item.kind === 'feature' ? constructOf(services, item) : null;
    if (!isAxis && !isPlane && (!c || c.kind === 'point')) return false;
    if (c && featureRefusal(services, props.feature, c.feature)?.includes('comes after')) return false;
    if (lin) {
      if (active === 'dir1' || active === 'dir2') return false;
      const ref: AxisRef = isAxis ? { kind: 'origin', axis: (item as { ref: OriginAxisRef }).ref } : isPlane ? { kind: 'normal', plane: { kind: 'origin', plane: (item as { ref: OriginPlaneRef }).ref } } : c!.kind === 'axis' ? { kind: 'feature', feature: c!.feature } : { kind: 'normal', plane: { kind: 'feature', feature: c!.feature } };
      if (lin.dir2 && lin.dir1.axis && !lin.dir2.axis) setAnd({ dir2: { ...lin.dir2, axis: ref } } as Partial<AnyPattern>);
      else setAnd({ dir1: { ...lin.dir1, axis: ref } } as Partial<AnyPattern>);
      return true;
    }
    if (circ) {
      if (active === 'axis' || isPlane || c?.kind === 'plane') return false;
      setAnd({ axis: isAxis ? { kind: 'origin', axis: (item as { ref: OriginAxisRef }).ref } : { kind: 'feature', feature: c!.feature } } as Partial<AnyPattern>);
      return true;
    }
    if (mir) {
      if (active === 'plane' || isAxis || c?.kind === 'axis') return false;
      setAnd({ plane: isPlane ? { kind: 'origin', plane: (item as { ref: OriginPlaneRef }).ref } : { kind: 'feature', feature: c!.feature } } as Partial<AnyPattern>);
      return true;
    }
    return false;
  }
  usePicksLines(services, [...(lin ? [...dir1.lines, ...(lin.dir2 ? dir2.lines : [])] : []), ...(circ ? axis.lines : [])]);
  const toggleSkip = (key: string) => {
    const skip = f.skip.includes(key) ? f.skip.filter((k) => k !== key) : [...f.skip, key];
    kit.set({ skip } as Partial<AnyPattern>);
  };
  usePatternMarkers(services, out, f.name, toggleSkip);

  const setOf = (of: PatternOf) => {
    if (of === f.of) return;
    kit.set({ of, op: defaultOp(of), scope: [] } as Partial<AnyPattern>);
    // The first empty field takes the clicks: the new kind's list until it holds something, then the next.
    choose(null);
  };
  const sourceElement =
    f.of === 'features'
      ? feats.element(f.features.length ? `Features (${f.features.length})` : 'Features', 'features', () => choose('sources'), 'Click features in the tree, or a face a feature made in the view; then the next box (or an axis or plane row)')
      : f.of === 'bodies'
        ? bodies.element(f.bodies.length ? `Bodies (${f.bodies.length})` : 'Bodies', 'bodies', () => choose('sources'), 'Click bodies in the view or their rows; then the next box (or an axis or plane row)')
        : faces.element(f.faces.length ? `Faces (${f.faces.length})` : 'Faces', 'faces', () => choose('sources'), 'Click the faces of a boss, pocket or hole (they are copied onto the same body); then the next box (or an axis or plane row)');
  const id = (k: string) => `cad-pat-${props.feature}-${k}`;
  return (
    <P2FeaturePanel props={props} kit={kit as FeaturePanelKit<AnyPattern>}>
      <Field label={mir ? 'Mirror of' : 'Pattern of'} htmlFor={id('of')} field="of">
        <Select id={id('of')} label={mir ? 'Mirror of' : 'Pattern of'} field="of" value={f.of} onChange={(v) => setOf(v as PatternOf)} options={OF} />
      </Field>
      {sourceElement}
      {lin ? (
        <>
          <FieldGroup title="Direction 1">
            {dir1.element('Along', 'dir1', () => choose('dir1'), 'Click an edge, an axis, a sketch line, or a plane or flat face (its normal)')}
            <DirectionFields feature={props.feature} prefix="dir1" d={lin.dir1} units={units} onChange={(dir) => kit.set({ dir1: dir } as Partial<AnyPattern>)} />
          </FieldGroup>
          {lin.dir2 ? (
            <FieldGroup title="Direction 2">
              {dir2.element('Along', 'dir2', () => choose('dir2'), 'Click an edge, an axis, a sketch line, or a plane or flat face (its normal)')}
              <DirectionFields feature={props.feature} prefix="dir2" d={lin.dir2} units={units} onChange={(dir) => kit.set({ dir2: dir } as Partial<AnyPattern>)} />
              <Button variant="link" data-remove-direction="2" onClick={() => setAnd({ dir2: null, skip: f.skip.filter((k) => !k.includes('.')) } as Partial<AnyPattern>)}>
                Remove direction 2
              </Button>
            </FieldGroup>
          ) : (
            <Button variant="link" data-add-direction="2" onClick={() => setAnd({ dir2: { axis: null, flip: false, count: '2', mode: 'spacing', distance: lin.dir1.distance, symmetric: false } } as Partial<AnyPattern>, 'dir2')}>
              Add direction 2
            </Button>
          )}
        </>
      ) : null}
      {circ ? (
        <>
          {axis.element('Axis', 'axis', () => choose('axis'), 'Click an axis (X, Y or Z under Origin, or a CONSTRUCT axis), a straight or round edge, a round face or a sketch line')}
          <Check feature={props.feature} field="flip" label="Flip direction" checked={circ.flip} onChange={(flip) => kit.set({ flip } as Partial<AnyPattern>)} />
          <Field label={circ.mode === 'angle' && circ.symmetric ? 'Count per side' : 'Count'} htmlFor={id('count')} field="count">
            <NumberUnitInput id={id('count')} field="count" label="Count" expr={circ.count} quantity="scalar" units={units} validate={(v) => (Math.abs(v - Math.round(v)) > 1e-9 ? 'Count must be a whole number' : v < 2 ? 'Count must be at least 2 (the original counts as 1)' : null)} onCommit={(count) => kit.update({ count } as Partial<AnyPattern>)} />
          </Field>
          <Field label="Spread" htmlFor={id('mode')} field="mode">
            <Select
              id={id('mode')}
              label="Spread"
              field="mode"
              value={circ.mode}
              onChange={(v) => kit.set({ mode: v } as Partial<AnyPattern>)}
              options={[
                { value: 'full', label: 'Full 360°' },
                { value: 'angle', label: 'Angle' },
              ]}
            />
          </Field>
          {circ.mode === 'angle' ? (
            <>
              <Field label="Angle" htmlFor={id('angle')} field="angle">
                <NumberUnitInput id={id('angle')} field="angle" label="Angle" expr={circ.angle} quantity="angle" units={units} validate={(v) => (v > 0 && v <= 360 ? null : 'Angle must be more than 0 and at most 360°')} onCommit={(angle) => kit.update({ angle } as Partial<AnyPattern>)} />
              </Field>
              <div data-angle-words="1">
                <Hint>{wholeTurnExpr(circ, units) && !circ.symmetric ? '360°: the copies are spread evenly all round, as Full 360° spreads them' : 'From the original to the last copy'}</Hint>
              </div>
              <Check feature={props.feature} field="symmetric" label="Symmetric" checked={circ.symmetric} onChange={(symmetric) => kit.set({ symmetric } as Partial<AnyPattern>)} />
            </>
          ) : null}
        </>
      ) : null}
      {mir ? plane.element('Mirror plane', 'plane', () => choose('plane'), 'Click an origin plane or a CONSTRUCT plane (in the view or the tree), or a flat face') : null}
      <Instances feature={props.feature} out={out} skip={f.skip} onRestore={toggleSkip} />
      <OperationRow feature={props.feature} f={f} onChange={(op) => kit.set({ op } as Partial<AnyPattern>)} />
    </P2FeaturePanel>
  );
}

/** The circular pattern's Angle is a whole turn (360°: spread evenly, as Full 360°). */
function wholeTurnExpr(c: { mode: 'full' | 'angle'; angle: string; symmetric: boolean }, units: AppServices['doc']['units']): boolean {
  const r = units.evaluate(c.angle, 'angle');
  return r.ok && wholeTurn({ mode: c.mode, angle: r.value, symmetric: c.symmetric });
}
