// The person's Hole: the hole tool's plan (assistant/tools/hole.ts planHole: every check, the
// sketches of circles compiled and solved headless) and the same features it stores, made on the
// person's own paths: each sketch ("<name> sketch", and a drill tip's "<name> tip sketch" on the
// hole's bottom) through sketch mode (startSketch, one apply of the solution, Finish), each cut
// (a counterbore or countersink, "<name>", a drill tip) through the Extrude panel (openNew with the
// hole tool's fields, Done), then a modelled thread's feature "<name> thread" through its panel. The
// undo steps are joined into one ("<name>"), as the Assistant's
// request is one, and the features are noted as made by hole (get_model's made_by). A failure
// part way takes back what was made: nothing changes.
// Owner: ASSISTANT (the person's side of hole).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { AppServices } from '../../types/app';
import type { Feature, FeatureId, SketchFeature, SketchSupport } from '../../types/doc';
import { uiFor } from '../../ui/controller';
import { modeFor } from '../../sketch/mode';
import { setMadeWith } from '../../assistant/made-with';
import { personCall } from '../../assistant/person-call';
import { regionsOf } from '../../assistant/region-tools';
import { withScene } from '../../assistant/selectors/resolve';
import { whole } from '../../assistant/sketch/write';
import { boreWarning, bottomOf, cutFields, hasBottom, planHole, threadFields, throughWords, type HolePlan } from '../../assistant/tools/hole';
import type { Solved } from '../../assistant/sketch/solve';
import type { SelectionItem } from '../../types/selection';

/** What the hole tool's input holds (schemas.ts hole), the face as "selection" (the panel's pick). */
export interface HoleInput {
  name: string;
  centers: { x: string; y: string; z: string }[];
  /** "" or a sketch whose points are the centres (centers [] then). */
  points: string;
  diameter: string;
  depth: 'through' | 'blind';
  distance: string;
  /** "" or a fastener size ("M6", "1/4-20") with fit, which gives the diameter. */
  size: string;
  fit: '' | 'close' | 'normal' | 'loose' | 'tapped';
  type: 'simple' | 'counterbore' | 'countersink';
  cb_diameter: string;
  cb_depth: string;
  cs_diameter: string;
  cs_angle: string;
  tip: 'flat' | 'drill';
  tip_angle: string;
  /** A tapped hole's thread: drawn only (cosmetic) or also cut into the wall (modelled). */
  thread: 'cosmetic' | 'modelled';
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

/** One sketch on the person's path: its panel, one apply of the solution, Finish. Resolves with its id. */
async function drawSketch(services: AppServices, support: SketchSupport, name: string, solved: Solved): Promise<FeatureId> {
  const { doc } = services;
  const ui = uiFor(services);
  const mode = modeFor(services);
  if (!mode) throw new Error('Sketch mode is not running in this Part');
  const started = await mode.startSketch(support);
  if (started !== true) throw new Error(`${name} could not start on the face: ${started}`);
  const session = mode.session;
  if (!session || !session.open) throw new Error(`${name} did not open`);
  if (session.draft.name !== name) session.update({ name } as Partial<Feature>);
  const sketch = session.feature;
  const applied = await mode.apply('Sketch', () => whole(solved.geometry));
  await mode.idle();
  if (!applied.ok) {
    ui.cancelPanel();
    throw new Error(`${name} could not be written: ${applied.reason}`);
  }
  await doc.settled();
  const why = await mode.finish();
  if (why || !featureOf(services, sketch)) {
    if (session.open) session.discard();
    throw new Error(why ?? `${name} was not kept`);
  }
  return sketch;
}

/** Make the holes the plan holds: the sketches and the cuts, one undo step. Resolves with the hole's sketch and its own cut; rejects with why (nothing kept). */
export async function makeHoles(services: AppServices, plan: HolePlan): Promise<{ sketch: FeatureId; cut: FeatureId; warnings: string[] }> {
  const { doc } = services;
  const ui = uiFor(services);
  const made: FeatureId[] = [];
  const warnings: string[] = [];
  // 1. The sketch on the face, as a person draws one.
  const sketch = await drawSketch(services, plan.support, plan.sketchName, plan.solved);
  made.push(sketch);
  let steps = 1;
  const takeBack = () => {
    for (let i = 0; i < steps; i++) doc.undo();
  };
  try {
    let on = sketch;
    let onName = plan.sketchName;
    for (const cut of plan.cuts) {
      if (cut.role === 'tip') {
        // The drill tip on the hole's bottom; a hole that went through has none.
        if (!hasBottom(services, plan)) {
          warnings.push(`${throughWords(plan)}; the drill tip was left out`);
          break;
        }
        const support = await bottomOf(personCall(services, 'hole', {}), plan);
        on = await drawSketch(services, support, plan.tip!.sketchName, plan.tip!.solved);
        onName = plan.tip!.sketchName;
        made.push(on);
        steps++;
      }
      // 2. Each cut: its regions, into the face's body only, through the Extrude panel.
      await doc.settled();
      const f = featureOf(services, on) as SketchFeature | null;
      if (!f) throw new Error(`${onName} is not in the part`);
      const regions = await withScene(personCall(services, 'hole', {}), { sketch: on }, (sc) => regionsOf(sc, f, cut.regions, 'hole'));
      ui.openNew('extrude', cutFields(plan, cut, regions.refs));
      const p = ui.state.get().panel;
      if (p?.kind !== 'feature' || p.type !== 'extrude' || !p.isNew) throw new Error(`${cut.name} could not be opened`);
      const id = p.feature;
      await doc.settled();
      const st = doc.state.get().rebuild.features[id];
      if (st?.state === 'error') {
        p.session.discard();
        throw new Error(`${cut.name} fails: ${st.message ?? 'it did not build'}`);
      }
      ui.closePanel();
      if (!featureOf(services, id)) throw new Error(`${cut.name} was not kept`);
      steps++;
      made.push(id);
      if (cut.role === 'bore') {
        plan.bore = id;
        const through = boreWarning(services, plan);
        if (through) warnings.push(through);
      }
    }
    // 3. A modelled thread: its feature through its panel (it cuts the thread into the wall).
    if (plan.modelled && plan.bore) {
      await doc.settled();
      ui.openNew('thread', threadFields(plan));
      const p = ui.state.get().panel;
      if (p?.kind !== 'feature' || p.type !== 'thread' || !p.isNew) throw new Error(`${plan.modelled} could not be opened`);
      const id = p.feature;
      await doc.settled();
      const st = doc.state.get().rebuild.features[id];
      if (st?.state === 'error') {
        p.session.discard();
        throw new Error(`${plan.modelled} fails: ${st.message ?? 'it did not build'}`);
      }
      ui.closePanel();
      if (!featureOf(services, id)) throw new Error(`${plan.modelled} was not kept`);
      steps++;
      made.push(id);
    }
    // 4. One undo step, as the Assistant's hole is one.
    const joined = doc.joinSteps(steps, plan.name);
    if (!joined.ok) console.warn('[cad] the hole stays several undo steps:', joined.reason);
    setMadeWith(services, made, 'hole');
    return { sketch, cut: plan.bore!, warnings };
  } catch (e) {
    takeBack();
    throw e;
  }
}
