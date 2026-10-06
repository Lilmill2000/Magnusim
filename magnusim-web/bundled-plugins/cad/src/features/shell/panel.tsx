// The Shell panel (the feature panel conventions of the Extrude panel):
//   Faces to remove  the openings, faces of one body (a click in the view adds or
//                    removes one)
//   Thickness        the wall
//   Direction        Inside (the outer size stays) / Outside (the body is the cavity)
// Every valid change applies live; Done closes.
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../../lib/services';
import type { PersistentRef, ShellFeature } from '../../types/doc';
import type { FeaturePanelProps } from '../../types/modules';
import { Field, NumberUnitInput, Select } from '../../ui/kit';
import { useFaceField } from '../p2/fields';
import { P2FeaturePanel, useFeaturePanel } from '../p2/panel';
import { useSolidsView } from '../solids/view';

const DIRECTIONS: { value: ShellFeature['direction']; label: string }[] = [
  { value: 'inside', label: 'Inside' },
  { value: 'outside', label: 'Outside' },
];

export function ShellPanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<ShellFeature>(props);
  const f = kit.draft;
  /**
   * A face clicked on the live result of an Outside shell is the input face turned inside out (the
   * cavity's wall): its stored signature takes the input face's outward normal, so the next build
   * finds it as it is, not "Reference repaired" after every edit (P4a review).
   */
  const asOnInput = (r: PersistentRef, body: string): PersistentRef => {
    const shown = services.doc.state.get().rebuild.bodies.find((b) => b.id === body);
    const fromHere = shown?.feature === props.feature && f.direction === 'outside';
    const d = r.signature.dir;
    if (!fromHere || !d || r.signature.type !== 'plane') return r;
    return { ...r, signature: { ...r.signature, dir: [-d[0], -d[1], -d[2]] } };
  };
  const units = services.doc.units;
  const faces = useFaceField(services, {
    feature: props.feature,
    body: f.body,
    refs: f.faces,
    active: true,
    oneBody: 'Shell works on one body: pick faces of the same body, or remove these first',
    describe: true,
    onChange: (body, refs) => kit.set({ body, faces: refs.map((r) => (f.faces.some((x) => x.name === r.name) ? r : asOnInput(r, body))) }),
  });
  useSolidsView(services, { feature: props.feature, used: [], sketches: [], lines: [], items: faces.highlight });
  const id = `cad-sh-${props.feature}-thickness`;
  const did = `cad-sh-${props.feature}-direction`;
  return (
    <P2FeaturePanel props={props} kit={kit}>
      {faces.element(f.faces.length ? `Faces to remove (${f.faces.length})` : 'Faces to remove', 'faces', () => {}, 'Click the faces to open in the view; click again to keep one')}
      <Field label="Thickness" htmlFor={id} field="thickness">
        <NumberUnitInput id={id} field="thickness" label="Thickness" expr={f.thickness} quantity="length" units={units} validate={(v) => (!(v > 0) ? 'Thickness must be more than 0' : null)} onCommit={(e) => kit.update({ thickness: e })} />
      </Field>
      <Field label="Direction" htmlFor={did} field="direction">
        <Select id={did} label="Direction" field="direction" value={f.direction} onChange={(v) => kit.set({ direction: v as ShellFeature['direction'] })} options={DIRECTIONS} />
      </Field>
    </P2FeaturePanel>
  );
}
