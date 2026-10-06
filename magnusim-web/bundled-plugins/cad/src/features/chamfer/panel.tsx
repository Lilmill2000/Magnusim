// The Chamfer panel (the feature panel conventions of the Extrude panel):
//   Edges     edges (and faces: all their edges) of one body, as Fillet's
//   Type      Equal distance / Two distances
//   Distance  (Distance 1 and Distance 2; Flip swaps their sides)
// Every valid change applies live; Done closes.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { ChamferFeature } from '../../types/doc';
import type { FeaturePanelProps } from '../../types/modules';
import { Field, Hint, NumberUnitInput, Select } from '../../ui/kit';
import { chainWords } from '../fillet/panel';
import { P2FeaturePanel, useFeaturePanel } from '../p2/panel';
import { useEdgeSetField } from '../solids/fields';
import { CheckRow } from '../solids/panel';
import { useSolidsView } from '../solids/view';

const MODES: { value: ChamferFeature['mode']; label: string }[] = [
  { value: 'distance', label: 'Equal distance' },
  { value: 'two', label: 'Two distances' },
];

export function ChamferPanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<ChamferFeature>(props);
  const f = kit.draft;
  const units = services.doc.units;
  const out = useStateStore(services.doc.state, (s) => s.rebuild.outputs?.[props.feature] ?? null);
  const field = useEdgeSetField(services, {
    feature: props.feature,
    role: 'chamfer',
    body: f.body,
    edges: f.edges,
    faces: f.faces,
    active: true,
    onChange: (body, edges, faces) => kit.set({ body, edges, faces }),
  });
  useSolidsView(services, { feature: props.feature, used: [], sketches: [], lines: [], items: field.highlight });
  // Only what this build made: no edge left, or a build that failed or did not run, has no chain to tell (P4a review: "Rounds 5 edges" stayed).
  const built = useStateStore(services.doc.state, (s) => s.rebuild.features[props.feature]?.state === 'ok');
  const chain = built && f.edges.length + f.faces.length > 0 && out && out.type === 'edge-chain' ? chainWords('Chamfers', out.picked, out.done) : null;
  const dist = (key: 'distance' | 'distance2', label: string) => {
    const id = `cad-ch-${props.feature}-${key}`;
    return (
      <Field key={key} label={label} htmlFor={id} field={key}>
        <NumberUnitInput id={id} field={key} label={label} expr={f[key]} quantity="length" units={units} validate={(v) => (!(v > 0) ? `${label} must be more than 0` : null)} onCommit={(e) => kit.update({ [key]: e } as Partial<ChamferFeature>)} />
      </Field>
    );
  };
  const count = f.edges.length + f.faces.length;
  const mid = `cad-ch-${props.feature}-mode`;
  return (
    <P2FeaturePanel props={props} kit={kit}>
      {field.element(count ? `Edges (${count})` : 'Edges', 'edges', () => {}, 'Click edges in the view (or a face: all its edges); click again to take one out')}
      <Field label="Type" htmlFor={mid} field="mode">
        <Select id={mid} label="Type" field="mode" value={f.mode} onChange={(v) => kit.set({ mode: v as ChamferFeature['mode'] })} options={MODES} />
      </Field>
      {f.mode === 'two' ? [dist('distance', 'Distance 1'), dist('distance2', 'Distance 2')] : dist('distance', 'Distance')}
      {f.mode === 'two' ? <CheckRow feature={props.feature} field="flip" label="Flip sides" checked={!!f.flip} onChange={(v) => kit.set({ flip: v })} /> : null}
      {f.mode === 'two' && built && out && out.type === 'edge-chain' && out.distance1On ? (
        <div data-distance1-on="1">
          <Hint>{`Distance 1 is on ${out.distance1On}; Flip sides puts it on the other face.`}</Hint>
        </div>
      ) : null}
      {chain ? (
        <div data-chain="1">
          <Hint>{chain}</Hint>
        </div>
      ) : null}
    </P2FeaturePanel>
  );
}
