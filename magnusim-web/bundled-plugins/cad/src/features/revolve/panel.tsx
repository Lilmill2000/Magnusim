// The Revolve panel (flyout, the feature panel conventions of the Extrude panel):
//   Profiles   shaded regions of one sketch (a click in the view adds or removes one)
//   Axis       a centerline or line of a sketch, a straight or round edge, a round
//              face (its axis), an origin axis or a CONSTRUCT axis (a click picks it;
//              a sketch with one centerline gives it by itself)
//   Angle      One side / Symmetric / Two sides, the angle(s), Flip direction
//   Operation  New body / Join / Cut / Intersect (once a body exists before it)
// Every valid change applies live (the body is the preview); Done closes.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../../lib/services';
import type { Feature, RevolveExtentDef, RevolveFeature } from '../../types/doc';
import type { FeaturePanelProps } from '../../types/modules';
import { Field, FieldGroup, NumberUnitInput, Select } from '../../ui/kit';
import { P2FeaturePanel, useFeaturePanel } from '../p2/panel';
import { soleCenterline } from '../solids/centerline';
import { useAxisField, useRegionField } from '../solids/fields';
import { CheckRow, OperationRow, useActiveField } from '../solids/panel';
import { useSolidsView } from '../solids/view';

const EXTENTS: { value: RevolveExtentDef['kind']; label: string }[] = [
  { value: 'one', label: 'One side' },
  { value: 'symmetric', label: 'Symmetric' },
  { value: 'two', label: 'Two sides' },
];

export function RevolvePanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<RevolveFeature>(props);
  const f = kit.draft;
  const units = services.doc.units;
  const [active, choose] = useActiveField<'profiles' | 'axis'>([
    ['profiles', !f.profiles.length],
    ['axis', !f.axis],
  ]);
  const regions = useRegionField(services, {
    feature: props.feature,
    profiles: f.profiles,
    active: true,
    selected: active === 'profiles',
    mode: 'one',
    onChange: (profiles) => {
      const auto = !f.axis && profiles[0] ? soleCenterline(services.doc.state.get().doc, profiles[0].sketch) : null;
      kit.set({ profiles, ...(auto ? { axis: auto } : {}) });
      choose(null);
    },
  });
  const axis = useAxisField(services, {
    feature: props.feature,
    value: f.axis,
    active: active === 'axis',
    onChange: (a) => {
      kit.set({ axis: a });
      choose(null);
    },
  });
  useSolidsView(services, { feature: props.feature, used: regions.used, sketches: [...regions.sketches, ...(f.axis?.kind === 'sketch-line' ? [f.axis.sketch] : [])], lines: axis.lines, items: [] });

  const e = f.extent;
  const angleField = (key: 'angle' | 'angle2', label: string, expr: string) => {
    const id = `cad-rv-${props.feature}-${key}`;
    return (
      <Field key={key} label={label} htmlFor={id} field={key}>
        <NumberUnitInput
          id={id}
          field={key}
          label={label}
          expr={expr}
          quantity="angle"
          units={units}
          validate={(v) => (v < 0 ? 'Angle must not be negative' : key === 'angle' && e.kind !== 'two' && !(v > 0) ? 'Angle must be more than 0' : v > 360 ? 'Angle must be at most 360°' : null)}
          onCommit={(x) => kit.update({ extent: { ...e, [key]: x } as RevolveExtentDef })}
        />
      </Field>
    );
  };
  const setKind = (kind: RevolveExtentDef['kind']) => {
    if (kind === e.kind) return;
    const next: RevolveExtentDef = kind === 'two' ? { kind, angle: e.angle, angle2: e.kind === 'two' ? e.angle2 : '0 deg' } : { kind, angle: e.angle };
    kit.set({ extent: next } as Partial<RevolveFeature>);
  };
  return (
    <P2FeaturePanel props={props} kit={kit}>
      {regions.element(f.profiles.length ? `Profiles (${f.profiles.length})` : 'Profiles', 'profiles', () => choose('profiles'), 'Click shaded regions of a sketch in the view to add or remove them')}
      {axis.element('Axis', 'axis', () => choose('axis'), 'Click a centerline or line of a sketch, a straight or round edge, a round face, or an axis')}
      <FieldGroup title="Angle">
        <Field label="Extent" htmlFor={`cad-rv-${props.feature}-extent`} field="extent">
          <Select id={`cad-rv-${props.feature}-extent`} label="Extent" field="extent" value={e.kind} onChange={(v) => setKind(v as RevolveExtentDef['kind'])} options={EXTENTS} />
        </Field>
        {e.kind === 'one' ? angleField('angle', 'Angle', e.angle) : e.kind === 'symmetric' ? angleField('angle', 'Total angle', e.angle) : [angleField('angle', 'Angle 1', e.angle), angleField('angle2', 'Angle 2', e.angle2)]}
        {e.kind !== 'symmetric' ? <CheckRow feature={props.feature} field="flip" label="Flip direction" checked={!!f.flip} onChange={(v) => kit.set({ flip: v })} /> : null}
      </FieldGroup>
      <OperationRow feature={props.feature} op={f.op} storedOp={kit.stored?.op ?? null} onChange={(op) => kit.set({ op } as Partial<Feature> as Partial<RevolveFeature>)} />
    </P2FeaturePanel>
  );
}
