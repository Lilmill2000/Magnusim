// Delete body panel (Edit on a Delete body row): the bodies it deletes, picked in the viewport or
// the tree, or taken out with their ×. A body it deletes is not drawn after it, so it is taken out
// here, never clicked. Every change applies live. Done closes.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../../lib/services';
import type { DeleteBodyFeature } from '../../types/doc';
import type { FeaturePanelProps } from '../../types/modules';
import { Hint } from '../../ui/kit';
import { useBodyField } from '../p2/fields';
import { P2FeaturePanel, useFeaturePanel } from '../p2/panel';
import { useSelectionMirror } from '../p2/pick';

export function DeleteBodyPanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<DeleteBodyFeature>(props);
  const f = kit.draft;
  const bodies = useBodyField(services, {
    feature: props.feature,
    ids: f.bodies,
    active: true,
    onChange: (ids) => kit.set({ bodies: ids }),
  });
  useSelectionMirror(services, bodies.highlight, (items) => void bodies.take(items));
  return (
    <P2FeaturePanel props={props} kit={kit}>
      {bodies.element(`Bodies to delete${f.bodies.length ? ` (${f.bodies.length})` : ''}`, 'bodies', () => {}, 'Click bodies in the viewport or the tree to add them; × takes one back')}
      <Hint>The bodies leave the model from here on. Delete or suppress this feature to bring them back.</Hint>
    </P2FeaturePanel>
  );
}
