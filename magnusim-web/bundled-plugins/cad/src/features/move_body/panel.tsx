// Move/copy body panel (the feature panel conventions: live apply, Done in the foot, Delete only
// when removable, no header tick):
//   Bodies        the bodies to move: a click in the view or their rows, × takes one back
//   Move          X, Y, Z (lengths in the Part's units; parameters allowed)
//   Turn          Angle; About X, Y or Z through the pivot (X, Y, Z: the centre of the bodies' box
//                 until one is typed; "Use the bodies' centre" goes back to it), or an axis the
//                 person picks (an axis, a straight or round edge, a round face, a sketch line)
//   Keep a copy   the originals stay, copies are moved (Body-Move 1 becomes Body-Copy 1 while its
//                 name is still the one it was given)
// One line says the order: it turns first, then moves. With features after it, one line says they
// wait until Done (the rebuild stops after it while it is edited: isolateWhileEditing).
// The view shows a drag handle at the pivot for as long as the person's panel is open (handle.ts:
// arrows for Move X, Y, Z, rings for the Angle); the fields show a drag's values as it runs, and
// its release applies them as typed values are. None while the Assistant fills the panel.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { Expr } from '../../types/units';
import type { ExprVec3, MoveAbout, MoveBodyFeature, Vec3 } from '../../types/doc';
import type { MoveBodyOutput } from '../../types/doc-service';
import type { FeaturePanelProps } from '../../types/modules';
import { Button, Field, FieldGroup, Hint, NumberUnitInput, Select } from '../../ui/kit';
import { useBodyField } from '../p2/fields';
import { P2FeaturePanel, useFeaturePanel } from '../p2/panel';
import { useSelectionMirror } from '../p2/pick';
import { liveAxis, useAxisField } from '../solids/fields';
import { usePicksLines } from '../solids/view';
import { uiFor } from '../../ui/controller';
import { bodyRefusal, nameForCopy, XYZ } from './feature';
import { startMoveHandle } from './handle';
import { snapLengthWords, type Line } from './handle-math';

const ABOUT: { value: MoveAbout; label: string }[] = [
  { value: 'x', label: 'X' },
  { value: 'y', label: 'Y' },
  { value: 'z', label: 'Z' },
  { value: 'axis', label: 'An axis, edge or round face' },
];

/** A length in mm as a stored expression ("12.5 mm"), rounded past what a display shows. */
const mmExpr = (v: number) => `${Math.abs(v) < 5e-10 ? 0 : Number(v.toFixed(6))} mm`;

export function MoveBodyPanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<MoveBodyFeature>(props);
  const f = kit.draft;
  // A drag of the view's handle: its fields while the button is held (null: the draft's).
  const [live, setLive] = useState<Partial<MoveBodyFeature> | null>(null);
  const shown = live ? ({ ...f, ...live } as MoveBodyFeature) : f;
  const units = services.doc.units;
  const lengthUnit = useStateStore(services.doc.state, (s) => s.doc.units.length);
  const handle = useStateStore(services.viewport, (s) => s.handle);
  const out = useStateStore(services.doc.state, (s) => (s.rebuild.outputs[props.feature]?.type === 'move_body' ? (s.rebuild.outputs[props.feature] as MoveBodyOutput) : null));
  const boxes = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  // Features after it that wait while it is open (not rolled back by the bar already).
  const later = useStateStore(services.doc.state, (s) => {
    const i = s.doc.features.findIndex((g) => g.id === props.feature);
    const end = s.view.rollback ?? s.doc.features.length;
    return i >= 0 && i + 1 < end;
  });
  const [chosen, choose] = useState<'bodies' | 'axis' | null>(null);
  const empty: ('bodies' | 'axis')[] = [...(!f.bodies.length ? (['bodies'] as const) : []), ...(f.about === 'axis' && !f.axis ? (['axis'] as const) : [])];
  const active = chosen ?? empty[0] ?? null;
  const bodies = useBodyField(services, {
    feature: props.feature,
    ids: f.bodies,
    active: active === 'bodies',
    // A copy this feature makes is not one of its own sources (a body it only moves is).
    refuse: (id) => bodyRefusal(props.feature, f.bodies, id),
    onChange: (ids) => {
      kit.set({ bodies: ids });
      choose('bodies');
    },
  });
  useSelectionMirror(services, bodies.highlight, (items) => void bodies.take(items));
  const axis = useAxisField(services, {
    feature: props.feature,
    value: f.about === 'axis' ? f.axis : null,
    active: f.about === 'axis' && active === 'axis',
    onChange: (a) => {
      kit.set({ axis: a });
      choose(null);
    },
  });
  usePicksLines(services, f.about === 'axis' ? axis.lines : []);

  // The picked axis as found now, for the handle's ring while no build has found it (nothing to move yet).
  const pickedAxis = useRef<Line | null>(null);
  const axisKey = f.about === 'axis' && f.axis && !out?.turnAxis ? JSON.stringify(f.axis) : '';
  useEffect(() => {
    pickedAxis.current = null;
    if (!axisKey || !f.axis) return;
    let on = true;
    void liveAxis(services, f.axis).then((a) => {
      if (!on) return;
      pickedAxis.current = a;
      tool.current?.refresh();
    });
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [services, axisKey]);
  // The handle in the view while the person's panel is open.
  const tool = useRef<ReturnType<typeof startMoveHandle> | null>(null);
  const kitNow = useRef(kit);
  kitNow.current = kit;
  useEffect(() => {
    if (!handle || typeof handle.pushTool !== 'function' || props.session.owner) return;
    const t = startMoveHandle(services, handle, {
      session: props.session,
      liveAxis: () => pickedAxis.current,
      live: setLive,
      commit(patch) {
        const why = kitNow.current.update(patch);
        if (why) uiFor(services).setPanelNote(why);
        return why;
      },
    });
    tool.current = t;
    return () => {
      t.stop();
      tool.current = null;
    };
  }, [services, handle, props.session]);
  useEffect(() => {
    tool.current?.refresh();
  });

  // The centre of the bodies' box just before this feature: as the build found it, or (not built
  // yet: nothing to move typed) the boxes the tree shows now, where the bodies still are.
  const fallback = (() => {
    const bs = boxes.filter((b) => f.bodies.includes(b.id));
    if (!bs.length) return null;
    const lo = [0, 1, 2].map((k) => Math.min(...bs.map((b) => b.bbox[k])));
    const hi = [0, 1, 2].map((k) => Math.max(...bs.map((b) => b.bbox[k + 3])));
    return [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as Vec3;
  })();
  const centre = out?.centre ?? fallback;
  const shownPivot: ExprVec3 = f.pivot ?? (centre ? (centre.map(mmExpr) as ExprVec3) : ['0 mm', '0 mm', '0 mm']);
  const id = (k: string) => `cad-f-${props.feature}-${k}`;
  const setMove = (i: number, e: Expr) => kit.update({ move: f.move.map((x, k) => (k === i ? e : x)) as ExprVec3 });
  const setPivot = (i: number, e: Expr) => kit.update({ pivot: shownPivot.map((x, k) => (k === i ? e : x)) as ExprVec3 });
  const setCopy = (copy: boolean) => {
    const others = services.doc.state.get().doc.features.filter((g) => g.id !== props.feature).map((g) => g.name);
    const name = nameForCopy(f.name, copy, others);
    kit.set(name === f.name ? { copy } : { copy, name });
  };
  const n = f.bodies.length;
  return (
    <P2FeaturePanel props={props} kit={kit}>
      {bodies.element(`Bodies${n ? ` (${n})` : ''}`, 'bodies', () => choose('bodies'), 'Click bodies in the view or the tree to add them; × takes one back')}
      <FieldGroup title="Move">
        {XYZ.map((a, i) => (
          <Field key={a} label={a} htmlFor={id(`move-${a.toLowerCase()}`)} field={`move-${a.toLowerCase()}`}>
            <NumberUnitInput id={id(`move-${a.toLowerCase()}`)} field={`move-${a.toLowerCase()}`} label={`Move ${a}`} expr={shown.move[i]} quantity="length" units={units} onCommit={(e) => setMove(i, e)} />
          </Field>
        ))}
      </FieldGroup>
      <FieldGroup title="Turn">
        <Field label="Angle" htmlFor={id('angle')} field="angle">
          <NumberUnitInput id={id('angle')} field="angle" label="Angle" expr={shown.angle} quantity="angle" units={units} onCommit={(angle) => kit.update({ angle })} />
        </Field>
        <Field label="About" htmlFor={id('about')} field="about">
          <Select
            id={id('about')}
            label="About"
            field="about"
            value={shown.about}
            onChange={(v) => {
              kit.set({ about: v as MoveAbout });
              choose(v === 'axis' ? 'axis' : null);
            }}
            options={ABOUT}
          />
        </Field>
        {f.about === 'axis' ? (
          axis.element('Axis', 'axis', () => choose('axis'), 'Click an axis (X, Y or Z under Origin, or a CONSTRUCT axis), a straight or round edge, a round face or a sketch line')
        ) : (
          <div data-pivot={f.pivot ? 'typed' : 'centre'}>
            {XYZ.map((a, i) => (
              <Field key={a} label={`Pivot ${a}`} htmlFor={id(`pivot-${a.toLowerCase()}`)} field={`pivot-${a.toLowerCase()}`}>
                <NumberUnitInput id={id(`pivot-${a.toLowerCase()}`)} field={`pivot-${a.toLowerCase()}`} label={`Pivot ${a}`} expr={shownPivot[i]} quantity="length" units={units} onCommit={(e) => setPivot(i, e)} />
              </Field>
            ))}
            {f.pivot ? (
              <Button variant="link" data-pivot-centre="1" onClick={() => kit.set({ pivot: null })}>
                Use the bodies' centre
              </Button>
            ) : (
              <Hint>The centre of the bodies' box: type a point to turn about another.</Hint>
            )}
          </div>
        )}
      </FieldGroup>
      <Field label="Keep a copy" htmlFor={id('copy')} field="copy">
        <input id={id('copy')} type="checkbox" className="cad-check" data-field="copy" checked={f.copy} onChange={(e) => setCopy(e.target.checked)} />
      </Field>
      <div data-move-order="1">
        <Hint>{f.copy ? 'The originals stay; the copies turn first, then move.' : 'It turns first, then moves.'}</Hint>
      </div>
      {later ? (
        <div data-move-later="1">
          <Hint>Until Done, the features after it wait: the bodies are drawn as it leaves them.</Hint>
        </div>
      ) : null}
      {handle && !props.session.owner ? (
        <div data-move-drag="1">
          <Hint>{`Or drag the arrows and rings in the view (Ctrl: steps of ${snapLengthWords(lengthUnit)} and 15°).`}</Hint>
        </div>
      ) : null}
    </P2FeaturePanel>
  );
}
