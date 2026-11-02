// Delete faces panel: the faces to remove (one body), picked in the viewport;
// every change applies live (the body is healed at once). Done closes.
// Kernel API 8: on a red result whose picked faces are only part of the fillets or holes they
// belong to, "Add the rest (+N)" adds the rest its red text names (the build's DeleteFacesOutput:
// the faces get_model lists as `rest`), as clicks on them would. On the Assistant's read-only
// panel it is inert with the other fields.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { DeleteFacesFeature } from '../../types/doc';
import type { FeaturePanelProps } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { Button, Field, Hint } from '../../ui/kit';
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
  const rest = useRest(props.feature, kit.status?.state === 'error', f.faces);
  return (
    <P2FeaturePanel props={props} kit={kit}>
      {faces.element(`Faces to delete${f.faces.length ? ` (${f.faces.length})` : ''}`, 'faces', () => {}, 'Click faces in the viewport to add or remove them')}
      {rest.length ? (
        <div className="cad-p2-sub" data-delete-rest-row="1">
          <Button variant="secondary" data-delete-rest={rest.length} disabledReason={uiFor(services).editBlock()} tip="Add the faces the red text names to the faces to delete" onClick={() => kit.set({ faces: [...f.faces, ...rest] })}>
            {`Add the rest (+${rest.length})`}
          </Button>
        </div>
      ) : null}
      {bodyName ? (
        <Field label="Body" field="body">
          <span data-delete-body="1">{bodyName}</span>
        </Field>
      ) : null}
      <Hint>The faces around each deleted face grow to close the gap (holes, fillets, bosses).</Hint>
    </P2FeaturePanel>
  );
}

/** The rest a red build of the feature published (DeleteFacesOutput), less the faces picked now. */
function useRest(feature: string, red: boolean, picked: DeleteFacesFeature['faces']): DeleteFacesFeature['faces'] {
  const services = useServices();
  const output = useStateStore(services.doc.state, (s) => s.rebuild.outputs[feature] ?? null);
  if (!red || output?.type !== 'delete-faces') return [];
  return output.restRefs.filter((r) => !picked.some((x) => x.name === r.name));
}
