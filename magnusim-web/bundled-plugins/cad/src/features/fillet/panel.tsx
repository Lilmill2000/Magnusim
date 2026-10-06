// The Fillet panel (the feature panel conventions of the Extrude panel):
//   Edges    edges of one body ("End · Side 2 of Extrude 1"), and faces (all their
//            edges); a click in the view adds or removes one; a click on a fillet
//            face this feature made takes its edge out again
//   Radius   the constant radius
//   and how many edges it rounds with their tangent chains.
// Every valid change applies live (the body is the preview); Done closes.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { FilletFeature } from '../../types/doc';
import type { FeaturePanelProps } from '../../types/modules';
import { Field, Hint, NumberUnitInput } from '../../ui/kit';
import { P2FeaturePanel, useFeaturePanel } from '../p2/panel';
import { useEdgeSetField } from '../solids/fields';
import { useSolidsView } from '../solids/view';

/** "Rounds 8 edges: 2 picked, 6 more along their tangent chains", or null. */
export function chainWords(verb: string, picked: number, done: number): string | null {
  if (!(done > picked)) return null;
  return `${verb} ${done} edges: ${picked} picked, ${done - picked} more along their tangent chain${done - picked === 1 ? '' : 's'}`;
}

export function FilletPanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<FilletFeature>(props);
  const f = kit.draft;
  const units = services.doc.units;
  const out = useStateStore(services.doc.state, (s) => s.rebuild.outputs?.[props.feature] ?? null);
  const field = useEdgeSetField(services, {
    feature: props.feature,
    role: 'fillet',
    body: f.body,
    edges: f.edges,
    faces: f.faces,
    active: true,
    onChange: (body, edges, faces) => kit.set({ body, edges, faces }),
  });
  useSolidsView(services, { feature: props.feature, used: [], sketches: [], lines: [], items: field.highlight });
  // Only what this build made: no edge left, or a build that failed or did not run, has no chain to tell (P4a review: "Rounds 5 edges" stayed).
  const built = useStateStore(services.doc.state, (s) => s.rebuild.features[props.feature]?.state === 'ok');
  const chain = built && f.edges.length + f.faces.length > 0 && out && out.type === 'edge-chain' ? chainWords('Rounds', out.picked, out.done) : null;
  const id = `cad-fl-${props.feature}-radius`;
  const count = f.edges.length + f.faces.length;
  return (
    <P2FeaturePanel props={props} kit={kit}>
      {field.element(count ? `Edges (${count})` : 'Edges', 'edges', () => {}, 'Click edges in the view (or a face: all its edges); click again to take one out')}
      <Field label="Radius" htmlFor={id} field="radius">
        <NumberUnitInput id={id} field="radius" label="Radius" expr={f.radius} quantity="length" units={units} validate={(v) => (!(v > 0) ? 'Radius must be more than 0' : null)} onCommit={(e) => kit.update({ radius: e })} />
      </Field>
      {chain ? (
        <div data-chain="1">
          <Hint>{chain}</Hint>
        </div>
      ) : null}
    </P2FeaturePanel>
  );
}
