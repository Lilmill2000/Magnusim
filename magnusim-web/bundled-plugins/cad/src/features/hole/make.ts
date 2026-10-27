// The person's Hole: the hole tool's plan (assistant/tools/hole.ts planHole: every check, the
// sketch of circles compiled and solved headless) and the same two features it stores, made on the
// person's own paths: the sketch "<name> sketch" through sketch mode (startSketch, one apply of the
// solution, Finish), then the cut extrude "<name>" through its panel (openNew with the hole tool's
// fields, Done). The two undo steps are joined into one ("<name>"), as the Assistant's request is
// one, and the features are noted as made by hole (get_model's made_by). A failure after the
// sketch takes it back: nothing changes.
// Owner: ASSISTANT (the person's side of hole).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../../types/app';
import type { Feature, FeatureId, SketchFeature } from '../../types/doc';
import { uiFor } from '../../ui/controller';
import { modeFor } from '../../sketch/mode';
import { setMadeWith } from '../../assistant/made-with';
import { personCall } from '../../assistant/person-call';
import { regionsOf } from '../../assistant/region-tools';
import { withScene } from '../../assistant/selectors/resolve';
import { whole } from '../../assistant/sketch/write';
import { holeCutFields, planHole, type HolePlan } from '../../assistant/tools/hole';
import type { SelectionItem } from '../../types/selection';

/** What the hole tool's input holds (schemas.ts hole), the face as "selection" (the panel's pick). */
export interface HoleInput {
  name: string;
  centers: { x: string; y: string; z: string }[];
  diameter: string;
  depth: 'through' | 'blind';
  distance: string;
}

/** The words of a refusal without the tool's reason prefix ("bad_input: ..."). */
export function holeError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^[a-z_]+: /, '');
}

/** The hole tool's plan for the panel's choice: throws its refusal (nothing changes). */
export function planFor(services: AppServices, face: SelectionItem, input: HoleInput): Promise<HolePlan> {
  const ctx = personCall(services, 'hole', { ...input, face: 'selection' }, [face]);
  return planHole(ctx);
}

const featureOf = (services: AppServices, id: FeatureId) => services.doc.state.get().doc.features.find((f) => f.id === id) ?? null;

/** Make the holes the plan holds: the sketch and the cut, one undo step. Resolves with their ids; rejects with why (nothing kept). */
export async function makeHoles(services: AppServices, plan: HolePlan): Promise<{ sketch: FeatureId; cut: FeatureId }> {
  const { doc } = services;
  const ui = uiFor(services);
  const mode = modeFor(services);
  if (!mode) throw new Error('Sketch mode is not running in this Part');
  // 1. The sketch on the face, as a person draws one: its panel, one apply of the solution, Finish.
  const started = await mode.startSketch(plan.support);
  if (started !== true) throw new Error(`The holes' sketch could not start on the face: ${started}`);
  const session = mode.session;
  if (!session || !session.open) throw new Error("The holes' sketch did not open");
  if (session.draft.name !== plan.sketchName) session.update({ name: plan.sketchName } as Partial<Feature>);
  const sketch = session.feature;
  const applied = await mode.apply('Sketch', () => whole(plan.solved.geometry));
  await mode.idle();
  if (!applied.ok) {
    ui.cancelPanel();
    throw new Error(`The holes' sketch could not be written: ${applied.reason}`);
  }
  await doc.settled();
  const why = await mode.finish();
  if (why || !featureOf(services, sketch)) {
    if (session.open) session.discard();
    throw new Error(why ?? "The holes' sketch was not kept");
  }
  let steps = 1;
  const takeBack = () => {
    for (let i = 0; i < steps; i++) doc.undo();
  };
  try {
    // 2. The cut: every circle, into the face's body only, through its panel.
    await doc.settled();
    const f = featureOf(services, sketch) as SketchFeature | null;
    if (!f) throw new Error(`${plan.sketchName} is not in the part`);
    const regions = await withScene(personCall(services, 'hole', {}), { sketch }, (sc) => regionsOf(sc, f, ['all'], 'hole'));
    ui.openNew('extrude', holeCutFields(plan, regions.refs));
    const p = ui.state.get().panel;
    if (p?.kind !== 'feature' || p.type !== 'extrude' || !p.isNew) throw new Error('The cut could not be opened');
    const cut = p.feature;
    await doc.settled();
    const st = doc.state.get().rebuild.features[cut];
    if (st?.state === 'error') {
      p.session.discard();
      throw new Error(`${plan.name} fails: ${st.message ?? 'it did not build'}`);
    }
    ui.closePanel();
    if (!featureOf(services, cut)) throw new Error(`${plan.name} was not kept`);
    steps = 2;
    // 3. One undo step, as the Assistant's hole is one.
    const joined = doc.joinSteps(2, plan.name);
    if (!joined.ok) console.warn('[cad] the hole stays two undo steps:', joined.reason);
    setMadeWith(services, [sketch, cut], 'hole');
    return { sketch, cut };
  } catch (e) {
    takeBack();
    throw e;
  }
}
