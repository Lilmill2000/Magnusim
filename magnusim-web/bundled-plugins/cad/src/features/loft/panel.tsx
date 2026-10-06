// The Loft panel (the feature panel conventions of the Extrude panel):
//   Profiles   one shaded region per sketch, in the order the loft goes through them
//              (a click on a region of a new sketch adds it at the end; on the picked
//              one takes it out; on another region of the same sketch swaps it; the
//              arrows move one earlier or later; a profile inside the loft's own body
//              is picked through it)
//   Ruled      flat sides between neighbouring profiles
//   Operation  New body / Join / Cut / Intersect (once a body exists before it)
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../../lib/services';
import type { Feature, LoftFeature } from '../../types/doc';
import type { FeaturePanelProps } from '../../types/modules';
import { Hint } from '../../ui/kit';
import { P2FeaturePanel, useFeaturePanel } from '../p2/panel';
import { useRegionField } from '../solids/fields';
import { CheckRow, OperationRow } from '../solids/panel';
import { useSolidsView } from '../solids/view';

export function LoftPanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<LoftFeature>(props);
  const f = kit.draft;
  const regions = useRegionField(services, {
    feature: props.feature,
    profiles: f.sections,
    active: true,
    mode: 'each',
    onChange: (sections) => kit.set({ sections }),
  });
  useSolidsView(services, { feature: props.feature, used: regions.used, sketches: regions.sketches, lines: [], items: [] });
  return (
    <P2FeaturePanel props={props} kit={kit}>
      {regions.element(f.sections.length ? `Profiles (${f.sections.length})` : 'Profiles', 'profiles', () => {}, 'Click one shaded region in each sketch, in the order the loft goes through them')}
      <CheckRow feature={props.feature} field="ruled" label="Ruled (flat sides)" checked={!!f.ruled} onChange={(v) => kit.set({ ruled: v })} />
      <Hint>Profiles go in the order picked; the arrows beside a profile move it earlier or later.</Hint>
      <OperationRow feature={props.feature} op={f.op} storedOp={kit.stored?.op ?? null} onChange={(op) => kit.set({ op } as Partial<Feature> as Partial<LoftFeature>)} />
    </P2FeaturePanel>
  );
}
