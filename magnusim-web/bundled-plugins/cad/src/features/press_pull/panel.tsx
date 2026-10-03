// Press-pull panel: flat faces of one body and a distance; every valid change
// applies live, so the viewport shows the result as it is typed (the preview).
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../../lib/services';
import type { PressPullFeature } from '../../types/doc';
import type { FeaturePanelProps } from '../../types/modules';
import { displayOf, Field, Hint, NumberUnitInput } from '../../ui/kit';
import { useFaceField } from '../p2/fields';
import { P2FeaturePanel, useFeaturePanel } from '../p2/panel';
import { useSelectionMirror } from '../p2/pick';

export function PressPullPanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<PressPullFeature>(props);
  const f = kit.draft;
  const units = services.doc.units;
  const faces = useFaceField(services, {
    feature: props.feature,
    body: f.body,
    refs: f.faces,
    active: true,
    planar: 'Press-pull works on flat faces: that face is curved',
    oneBody: 'Press-pull works on one body: pick faces of the same body, or remove these first',
    onChange: (body, refs) => kit.set({ body, faces: refs }),
  });
  useSelectionMirror(services, faces.highlight);
  const shown = displayOf(f.distance, 'length', units);
  const sense = shown.value == null || shown.value === 0 ? null : shown.value > 0 ? 'Adds material: the faces move out of the body' : 'Removes material: the faces move into the body';
  const id = `cad-pp-${props.feature}-distance`;
  return (
    <P2FeaturePanel props={props} kit={kit}>
      {faces.element(`Faces${f.faces.length ? ` (${f.faces.length})` : ''}`, 'faces', () => {}, 'Click flat faces in the viewport to add or remove them')}
      <Field label="Distance" htmlFor={id} field="distance">
        <NumberUnitInput
          id={id}
          field="distance"
          label="Distance"
          expr={f.distance}
          quantity="length"
          units={units}
          validate={(v) => (v === 0 ? 'Distance must not be 0' : null)}
          onCommit={(e) => kit.update({ distance: e })}
        />
      </Field>
      {sense ? (
        <div className="cad-p2-sub" data-press-sense={shown.value! > 0 ? 'adds' : 'removes'}>
          {sense}
        </div>
      ) : null}
      <Hint>Faces whose neighbours are square to them grow or shrink exactly; a slanted neighbour is not extended (a step forms).</Hint>
    </P2FeaturePanel>
  );
}
