// Press-pull panel: faces of one body (flat or curved, of mixed kinds) and a distance;
// every valid change applies live, so the viewport shows the result as it is typed (the
// preview). Below the distance it says what the sign does for the picked faces: "Adds
// material: the faces move out of the body", and for curved ones their radius before and
// after ("Bore radius 10 mm → 8 mm"), the tangent faces that moved with them, and, when
// OCCT's offset could not be used and the result differs visibly from one, why.
// Owner: P2-FEATURES (curved faces: 2026-10-06).
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { PressPullFeature } from '../../types/doc';
import type { PressPullOutput } from '../../types/doc-service';
import type { OffsetFaceAbout } from '../../types/kernel-protocol';
import type { FeaturePanelProps } from '../../types/modules';
import type { UnitsService } from '../../types/units';
import { displayOf, Field, Hint, NumberUnitInput } from '../../ui/kit';
import { useFaceField } from '../p2/fields';
import { P2FeaturePanel, useFeaturePanel } from '../p2/panel';
import { useSelectionMirror } from '../p2/pick';

const RADIUS_NAME: Partial<Record<OffsetFaceAbout['role'], string>> = {
  bore: 'Bore radius',
  cylinder: 'Cylinder radius',
  fillet: 'Fillet radius',
  cone: 'Cone radius at its wide end',
  torus: 'Torus tube radius',
};

/** One line per picked face: "Bore radius 10 mm → 8 mm", "Flat face moves 2 mm out of the body". */
export function faceLine(a: OffsetFaceAbout, d: number, units: Pick<UnitsService, 'format'>): string {
  const mm = (x: number) => units.format(x, 'length');
  if (a.radius != null && a.new_radius != null) {
    const name = a.role === 'sphere' ? (a.convex ? 'Sphere radius' : 'Spherical hollow radius') : (RADIUS_NAME[a.role] ?? 'Radius');
    return `${name} ${mm(a.radius)} → ${mm(a.new_radius)}`;
  }
  // A cone has no single radius that moves by d (fix round 1, B3: its wide end stays where a
  // neighbour is extended to meet it): what happens to the face, in words that hold.
  if (a.role === 'cone') return `Cone face moves ${mm(Math.abs(d))} ${d > 0 ? 'out of' : 'into'} the body, square to the face`;
  const what = a.role === 'flat' ? 'Flat face' : 'Curved face';
  return `${what} moves ${mm(Math.abs(d))} ${d > 0 ? 'out of' : 'into'} the body`;
}

/** The lines for every picked face, the same line said once with its count. */
export function faceLines(out: PressPullOutput, d: number, units: Pick<UnitsService, 'format'>): string[] {
  const counts = new Map<string, number>();
  for (const a of out.faces) {
    const line = faceLine(a, d, units);
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return [...counts].map(([line, n]) => (n > 1 ? `${line} (${n} faces)` : line));
}

/** "Keeps the 2 fillets beside it at their size", "Keeps the fillet and the chamfer beside them at their size". */
export function carriedLine(c: { fillets: number; chamfers: number }, picks: number): string {
  const part = (n: number, one: string, many: string) => (n === 0 ? null : n === 1 ? `the ${one}` : `the ${n} ${many}`);
  const what = [part(c.fillets, 'fillet', 'fillets'), part(c.chamfers, 'chamfer', 'chamfers')].filter(Boolean).join(' and ');
  const one = c.fillets + c.chamfers === 1;
  return `Keeps ${what} beside ${picks === 1 ? 'it' : 'them'} at ${one ? 'its' : 'their'} size`;
}

export function PressPullPanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<PressPullFeature>(props);
  const f = kit.draft;
  const units = services.doc.units;
  const out = useStateStore(services.doc.state, (s) => s.rebuild.outputs?.[props.feature] ?? null);
  // A build that worked, also with a warning (review P4: "Body 1 is now 2 separate solids" hid the radius line).
  const state = useStateStore(services.doc.state, (s) => s.rebuild.features[props.feature]?.state ?? null);
  const built = state === 'ok' || state === 'warning';
  const faces = useFaceField(services, {
    feature: props.feature,
    body: f.body,
    refs: f.faces,
    active: true,
    // A Press-pull saved before version 2 keeps the flat-face prism path (so its document rebuilds as made).
    planar: f.version === 2 ? null : 'This Press-pull was made before curved faces: it moves flat faces only. A new Press-pull moves curved ones',
    oneBody: 'Press-pull works on one body: pick faces of the same body, or remove these first',
    onChange: (body, refs) => kit.set({ body, faces: refs }),
  });
  useSelectionMirror(services, faces.highlight);
  const shown = displayOf(f.distance, 'length', units);
  const d = shown.value == null ? null : shown.value;
  const sense = d == null || d === 0 ? null : d > 0 ? 'Adds material: the faces move out of the body' : 'Removes material: the faces move into the body';
  // Only what this build made (a failed or stale build says nothing about radii).
  const pp = built && f.faces.length && out && out.type === 'press-pull' ? out : null;
  const failed = state === 'error' && out && out.type === 'press-pull' ? out : null;
  const legacy = f.version !== 2;
  const lines = pp && d != null && d !== 0 ? faceLines(pp, d, units) : [];
  const id = `cad-pp-${props.feature}-distance`;
  return (
    <P2FeaturePanel props={props} kit={kit}>
      {faces.element(`Faces${f.faces.length ? ` (${f.faces.length})` : ''}`, 'faces', () => {}, 'Click faces in the viewport to add or remove them: flat or curved')}
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
        <div className="cad-p2-sub" data-press-sense={d! > 0 ? 'adds' : 'removes'}>
          {sense}
        </div>
      ) : null}
      {lines.length ? (
        <div data-press-radius="1">
          {lines.map((l) => (
            <div key={l} className="cad-p2-sub" data-press-line={l}>
              {l}
            </div>
          ))}
        </div>
      ) : null}
      {pp && pp.tangent > 0 ? (
        <div className="cad-p2-sub" data-press-tangent={pp.tangent}>
          {`Also moves ${pp.tangent} tangent face${pp.tangent === 1 ? '' : 's'} with ${f.faces.length === 1 ? 'it' : 'them'}`}
        </div>
      ) : null}
      {pp && pp.carried && pp.carried.fillets + pp.carried.chamfers > 0 ? (
        <div className="cad-p2-sub" data-press-carried={pp.carried.fillets + pp.carried.chamfers}>
          {carriedLine(pp.carried, f.faces.length)}
        </div>
      ) : null}
      {pp && pp.note ? (
        <div data-press-note={pp.method}>
          <Hint>{pp.note}</Hint>
        </div>
      ) : null}
      {failed && failed.detail ? (
        <details className="cad-p2-sub" data-press-detail="1">
          <summary>Details</summary>
          {failed.detail}
        </details>
      ) : null}
      {legacy ? (
        <div data-press-legacy="1">
          <Hint>Made before press-pull took curved faces: its flat faces move by a prism, as when it was made, and a neighbour that is not square to them is not extended. A new Press-pull extends it.</Hint>
        </div>
      ) : (
        <Hint>A curved face changes its radius; fillets and chamfers beside a moved face keep their size. Neighbours are extended or trimmed to meet the moved faces.</Hint>
      )}
    </P2FeaturePanel>
  );
}
