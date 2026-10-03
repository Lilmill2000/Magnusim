// Delete faces panel: the faces to remove (one body), picked in the viewport;
// every change applies live (the body is healed at once). Done closes.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { DeleteFacesFeature } from '../../types/doc';
import type { FeaturePanelProps } from '../../types/modules';
import { Field, Hint } from '../../ui/kit';
import { useFaceField } from '../p2/fields';
import { P2FeaturePanel, useFeaturePanel } from '../p2/panel';
import { useSelectionMirror } from '../p2/pick';

export function DeleteFacesPanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<DeleteFacesFeature>(props);
  const f = kit.draft;
  const bodyName = useStateStore(services.doc.state, (s) => (f.body ? (s.rebuild.bodies.find((b) => b.id === f.body)?.name ?? s.doc.bodies[f.body]?.name ?? null) : null));
  const faces = useFaceField(services, {
    feature: props.feature,
    body: f.body,
    refs: f.faces,
    active: true,
    oneBody: 'Delete faces works on one body: pick faces of the same body, or remove these first',
    onChange: (body, refs) => kit.set({ body, faces: refs }),
  });
  useSelectionMirror(services, faces.highlight);
  return (
    <P2FeaturePanel props={props} kit={kit}>
      {faces.element(`Faces to delete${f.faces.length ? ` (${f.faces.length})` : ''}`, 'faces', () => {}, 'Click faces in the viewport to add or remove them')}
      {bodyName ? (
        <Field label="Body" field="body">
          <span data-delete-body="1">{bodyName}</span>
        </Field>
      ) : null}
      <Hint>The faces around each deleted face grow to close the gap (holes, fillets, bosses).</Hint>
    </P2FeaturePanel>
  );
}
