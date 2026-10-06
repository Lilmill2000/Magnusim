// The Sweep panel (the feature panel conventions of the Extrude panel):
//   Profiles     shaded regions of one sketch (a click in the view adds or removes one)
//   Path         curves of another sketch, end to end (a click on a curve adds or
//                removes it; the path is drawn in the pick green)
//   Orientation  Follow path (the profile turns with it) / Keep orientation
//   Operation    New body / Join / Cut / Intersect (once a body exists before it)
// Every valid change applies live; Done closes.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { Feature, SweepFeature } from '../../types/doc';
import type { FeaturePanelProps } from '../../types/modules';
import { Field, Hint, Select } from '../../ui/kit';
import { P2FeaturePanel, useFeaturePanel } from '../p2/panel';
import { usePathField, useRegionField } from '../solids/fields';
import { OperationRow, useActiveField } from '../solids/panel';
import { useSolidsView } from '../solids/view';

const ORIENTATIONS: { value: SweepFeature['orientation']; label: string }[] = [
  { value: 'follow', label: 'Follow path' },
  { value: 'fixed', label: 'Keep orientation' },
];

export function SweepPanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<SweepFeature>(props);
  const f = kit.draft;
  const [active, choose] = useActiveField<'profiles' | 'path'>([
    ['profiles', !f.profiles.length],
    ['path', !f.path],
  ]);
  const regions = useRegionField(services, {
    feature: props.feature,
    profiles: f.profiles,
    active: active !== 'path',
    selected: active === 'profiles',
    mode: 'one',
    refuse: (sk) => (f.path?.sketch === sk ? 'That sketch is the path: draw the profile in another sketch' : null),
    onChange: (profiles) => {
      kit.set({ profiles });
      choose(null);
    },
  });
  const path = usePathField(services, {
    feature: props.feature,
    path: f.path,
    active: active === 'path',
    refuse: (sk) => (f.profiles[0]?.sketch === sk ? 'That sketch holds the profile: the path must be another sketch' : null),
    onChange: (p) => {
      kit.set({ path: p });
      // A path takes several curves: the field stays on until another field is clicked.
      choose('path');
    },
  });
  useSolidsView(services, { feature: props.feature, used: regions.used, sketches: [...regions.sketches, ...(f.path ? [f.path.sketch] : [])], lines: path.lines, items: [] });
  const oid = `cad-sw-${props.feature}-orientation`;
  // Curves still being picked out of order: not joined yet is not a failure while the path field is
  // on (P4a review: red "gap" mid-pick). The field says what is missing; the foot does not repeat it.
  const failure = useStateStore(services.doc.state, (s) => (s.rebuild.features[props.feature]?.state === 'error' ? (s.rebuild.features[props.feature]?.message ?? '') : ''));
  const joining = active === 'path' && /the path has a gap/.test(failure);
  return (
    <P2FeaturePanel props={props} kit={kit} fieldsSay={joining ? 'the path has a gap' : null}>
      {regions.element(f.profiles.length ? `Profiles (${f.profiles.length})` : 'Profiles', 'profiles', () => choose('profiles'), 'Click shaded regions of a sketch in the view to add or remove them')}
      {path.element(
        f.path?.entities.length ? `Path (${f.path.entities.length})` : 'Path',
        'path',
        () => choose('path'),
        joining ? 'Not joined yet: click the curves between these, so the path runs end to end' : 'Click the curves of the path in the view (another sketch: lines and arcs end to end)',
      )}
      <Field label="Orientation" htmlFor={oid} field="orientation">
        <Select id={oid} label="Orientation" field="orientation" value={f.orientation} onChange={(v) => kit.set({ orientation: v as SweepFeature['orientation'] })} options={ORIENTATIONS} />
      </Field>
      <Hint>Draw the profile on a plane through the start of the path, square to it (Plane, Normal to a curve).</Hint>
      <OperationRow feature={props.feature} op={f.op} storedOp={kit.stored?.op ?? null} onChange={(op) => kit.set({ op } as Partial<Feature> as Partial<SweepFeature>)} />
    </P2FeaturePanel>
  );
}
