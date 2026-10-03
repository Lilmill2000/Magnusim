// The Enclosure panel (flyout, PanelChrome; decision 2026-10-01, CFD prep):
//   Shape     Box | Cylinder (Axis X / Y / Z for a cylinder)
//   Bodies    the bodies it wraps: none picked = every solid body before it
//             (the field itself says which); click the list, then bodies, to pick
//   Padding   Zero (tight to the part, the default) | Percent of part size |
//             Fixed distance, with its value
//   Sides     +X -X +Y -Y +Z -Z (box) or Radius, Top, Bottom (cylinder): each
//             shows its padding; typing one (or dragging its arrow in the
//             view) sets that side on its own, and "Use padding" puts it back;
//             a side past the part's far side is refused (the reason under it,
//             also when the part shrank under a side already set), the sides
//             into the part get one amber note naming them (Combine Cut leaves
//             the cut-off part out of the fluid); changing Padding keeps the
//             sides set
//   Size      what was made, and a word on the air volume (a separate Combine)
// No Operation row: it only ever makes a new body. Every valid change applies
// live; Done closes; Delete removes it (a new one: discards it).
// Owner: SD pass (src/features/enclosure/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { Fragment, useEffect, useRef, useState } from 'react';
import { bodyMaker } from '../../doc/features/hooks';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { EnclosureFeature, EnclosureSide, OriginAxisRef } from '../../types/doc';
import type { EnclosureOutput } from '../../types/doc-service';
import type { FeaturePanelProps } from '../../types/modules';
import type { SelectionItem } from '../../types/selection';
import { buttonClass, Field, FieldGroup, Hint, NumberUnitInput, Select } from '../../ui/kit';
import { formatQuantity, formatVolume, unitText } from '../../ui/kit/format';
import { useBodyField } from '../p2/fields';
import { P2FeaturePanel, useFeaturePanel } from '../p2/panel';
import { useSelectionMirror } from '../p2/pick';
import { overlayColors } from '../sketch/colors';
import { isEnclosureBody } from './def';
import { AXIS_LABELS, enclosureShape, paddingFromMode, resolveEnclosure, shapeVolume, sideCuts, SIDE_KEYS, sideLabel, sidesOf } from './geometry';
import { shapeOfOutput, startEnclosureHandles } from './handles';

/** "A", "A and B", "A, B and C". */
function listWords(items: string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const SHAPES: { value: EnclosureFeature['shape']; label: string }[] = [
  { value: 'box', label: 'Box' },
  { value: 'cylinder', label: 'Cylinder' },
];
const AXES: OriginAxisRef[] = ['origin:x', 'origin:y', 'origin:z'];
const PADDINGS: { value: EnclosureFeature['padding']; label: string; hint: string }[] = [
  { value: 'zero', label: 'Zero (tight to the part)', hint: 'Every side touches the bounding box of the bodies' },
  { value: 'percent', label: 'Percent of part size', hint: "Each side moves out by this share of the part's size in its direction" },
  { value: 'fixed', label: 'Fixed distance', hint: 'Each side moves out by the same distance' },
];

/**
 * While the bodies field takes picks, the viewport shows what it holds and a body row clicked in
 * the tree goes to it. Otherwise the panel leaves the selection to the shell (the feature it edits
 * stays selected, as for every feature panel).
 */
function BodiesMirror({ items, take }: { items: SelectionItem[]; take(items: SelectionItem[]): boolean }) {
  const services = useServices();
  useSelectionMirror(services, items, (picked) => void take(picked));
  return null;
}

export function EnclosurePanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<EnclosureFeature>(props);
  const f = kit.draft;
  const units = services.doc.units;
  const docUnits = useStateStore(services.doc.state, (s) => s.doc.units);
  const output = useStateStore(services.doc.state, (s) => {
    const o = s.rebuild.outputs?.[props.feature];
    return o && o.type === 'enclosure' ? o : null;
  }) as EnclosureOutput | null;
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  const handle = useStateStore(services.viewport, (s) => s.handle);
  const [picking, setPicking] = useState(false);

  // With none picked, the field itself says what it encloses: every solid body before it.
  const enclosed = output?.bodies ?? [];
  const nameOf = (bid: string) => bodies.find((b) => b.id === bid)?.name ?? bid;
  const allText = enclosed.length ? `All solid bodies (${enclosed.length}): ${enclosed.map(nameOf).join(', ')}` : 'All solid bodies';
  // The bodies it wraps. A body made after it in the history, or its own, cannot be taken.
  const refuse = (id: string): string | null => {
    const st = services.doc.state.get();
    if (id === f.creates) return `${f.name} cannot enclose its own body`;
    if (isEnclosureBody(st.doc.features, id)) return 'That is the body of another enclosure: pick the part';
    const maker = bodyMaker(services.doc.features, st.doc, id);
    const at = (fid: string) => st.doc.features.findIndex((g) => g.id === fid);
    if (maker && at(props.feature) >= 0 && at(maker.id) > at(props.feature)) return `${maker.name} comes after ${f.name} in the history: pick a body made before it`;
    return null;
  };
  const field = useBodyField(services, {
    feature: props.feature,
    ids: f.bodies ?? [],
    active: picking,
    refuse,
    onChange: (ids) => kit.set({ bodies: ids }),
    empty: allText,
  });

  // The arrows in the view for as long as the panel is open.
  const tool = useRef<ReturnType<typeof startEnclosureHandles> | null>(null);
  const outRef = useRef(output);
  outRef.current = output;
  useEffect(() => {
    if (!handle || typeof handle.pushTool !== 'function') return;
    const t = startEnclosureHandles(services, handle, { session: props.session, color: overlayColors().under, output: () => outRef.current });
    tool.current = t;
    return () => {
      t.stop();
      tool.current = null;
    };
  }, [handle, props.session]);
  useEffect(() => {
    tool.current?.refresh();
  });

  const values = resolveEnclosure(f, units);
  const sides = sidesOf(f.shape);
  // Each side's padding as the panel shows it: the user's own, else the padding mode's (percent needs the part's size).
  const derived = (side: EnclosureSide): string => {
    const zero = `0 ${docUnits.length}`;
    if (f.padding === 'fixed') return f.distance;
    if (f.padding === 'zero' || !values.ok) return zero;
    if (!output) return '';
    return `${paddingFromMode(side, values.values, output.bbox)} mm`;
  };
  const lengthWords = (mm: number) => formatQuantity(mm, 'length', docUnits);
  // A side's typed value is checked against the part: never past its far side, never no size.
  const sideProblem = (side: EnclosureSide, mm: number): string | null => {
    if (!values.ok || !output) return null;
    const s = enclosureShape({ ...values.values, sides: { ...values.values.sides, [side]: mm } }, output.bbox, lengthWords);
    return s.ok ? null : s.message;
  };
  // A side that goes into the part: allowed (a symmetry plane), but the fluid then leaves that part out.
  const cutWords = (() => {
    const names = (output?.bodies ?? []).map((b) => bodies.find((x) => x.id === b)?.name ?? b);
    return names.length === 1 ? names[0] : names.length ? 'the enclosed bodies' : 'the part';
  })();
  // The stored sides as the part is now: the reason the Enclosure cannot be made goes under the
  // sides it is about (SD review round 2: after the part shrank under −X it showed only at the foot).
  const built = values.ok && output ? enclosureShape(values.values, output.bbox, lengthWords) : null;
  const faultOf = (side: EnclosureSide): string | null => (built && !built.ok && built.sides.includes(side) ? built.message : null);
  // One note for every side that goes into the part (SD review round 2: one per side, six identical
  // lines, pushed Done out of view).
  const cutting = values.ok && output ? sides.filter((s) => !faultOf(s) && sideCuts(s, values.values, output.bbox)) : [];
  const cutNote = cutting.length
    ? `${listWords(cutting.map((s) => sideLabel(s, f.axis)))} ${cutting.length === 1 ? 'cuts' : 'cut'} through ${cutWords}: Combine Cut will leave the cut-off ${cutting.length === 1 ? 'part' : 'parts'} of ${cutWords} out of the fluid`
    : null;

  const shapeNow = shapeOfOutput(output);
  const sizeText = (() => {
    if (!shapeNow) return null;
    if (shapeNow.kind === 'box') {
      const d = [0, 1, 2].map((k) => formatQuantity(shapeNow.max[k] - shapeNow.min[k], 'length', docUnits));
      return `${d.join(' × ')} · ${formatVolume(shapeVolume(shapeNow), docUnits)}`;
    }
    return `Ø${formatQuantity(2 * shapeNow.r, 'length', docUnits)} × ${formatQuantity(shapeNow.h, 'length', docUnits)} · ${formatVolume(shapeVolume(shapeNow), docUnits)}`;
  })();

  const id = (k: string) => `cad-enclosure-${props.feature}-${k}`;
  const padding = PADDINGS.find((p) => p.value === f.padding) ?? PADDINGS[0];

  return (
    <P2FeaturePanel props={props} kit={kit}>
      <Field label="Shape" htmlFor={id('shape')} field="shape">
        <Select id={id('shape')} label="Shape" field="shape" value={f.shape} onChange={(v) => kit.set({ shape: v as EnclosureFeature['shape'] })} options={SHAPES.map((o) => ({ value: o.value, label: o.label }))} />
      </Field>
      {f.shape === 'cylinder' ? (
        <Field label="Axis" htmlFor={id('axis')} field="axis">
          <Select id={id('axis')} label="Axis" field="axis" value={f.axis} onChange={(v) => kit.set({ axis: v as OriginAxisRef })} options={AXES.map((a) => ({ value: a, label: AXIS_LABELS[a] }))} />
        </Field>
      ) : null}
      {picking ? <BodiesMirror items={field.highlight} take={field.take} /> : null}
      {field.element(`Bodies to enclose${f.bodies?.length ? ` (${f.bodies.length})` : ''}`, 'bodies', () => setPicking(true), 'Click bodies in the viewport or the tree; remove them all to enclose every solid body')}
      <Field label="Padding" htmlFor={id('padding')} field="padding">
        <Select
          id={id('padding')}
          label="Padding"
          field="padding"
          value={f.padding}
          // The sides that follow the padding take the new one; a side set on its own keeps its value
          // ("Use padding" beside it). SD review round 1: changing Padding silently wiped them.
          onChange={(v) => kit.set({ padding: v as EnclosureFeature['padding'] })}
          options={PADDINGS.map((p) => ({ value: p.value, label: p.label }))}
        />
      </Field>
      <div className="cad-p2-sub" data-enclosure-padding-hint="1">
        {padding.hint}
      </div>
      {f.padding === 'percent' ? (
        <Field label="Percent" htmlFor={id('percent')} field="percent">
          <NumberUnitInput
            id={id('percent')}
            field="percent"
            className="cad-enclosure-pct"
            label="Percent of part size"
            expr={f.percent}
            quantity="scalar"
            units={units}
            showUnit={false}
            // "%" where a length's "mm" is, as wide as it: this field lines up with the sides' fields
            // and its "%" stays on the input's line under an error (SD review round 1).
            unit={
              <span className="cad-enclosure-pct-unit">
                <span>%</span>
                <span className="cad-enclosure-pct-width" aria-hidden="true">
                  {unitText('length', docUnits)}
                </span>
              </span>
            }
            validate={(v) => (v < 0 ? 'Percent must not be negative' : null)}
            onCommit={(e) => kit.update({ percent: e })}
          />
        </Field>
      ) : null}
      {f.padding === 'fixed' ? (
        <Field label="Distance" htmlFor={id('distance')} field="distance">
          <NumberUnitInput
            id={id('distance')}
            field="distance"
            label="Padding distance"
            expr={f.distance}
            quantity="length"
            units={units}
            validate={(v) => (v < 0 ? 'Distance must not be negative' : null)}
            onCommit={(e) => kit.update({ distance: e })}
          />
        </Field>
      ) : null}
      <FieldGroup title="Sides">
        {sides.map((side) => {
          const own = f.sides?.[side];
          const set = typeof own === 'string' && own !== '';
          const expr = set ? (own as string) : derived(side);
          const key = SIDE_KEYS[side];
          const label = sideLabel(side, f.axis);
          return (
            <Fragment key={side}>
              <Field label={label} htmlFor={id(`side-${key}`)} field={`side-${key}`}>
                {/* "Use padding" goes before the field, so the field stays where it is when the
                    link comes (SD review round 1: it moved the number 75 px left) and every
                    value field of the panel sits in one column. */}
                <span className="cad-enclosure-side" data-side={side} data-side-source={set ? 'set' : 'padding'}>
                  {set ? (
                    <button
                      type="button"
                      className={`${buttonClass('fix')} cad-enclosure-reset`}
                      data-side-reset={key}
                      title={`${label} follows the padding again`}
                      onClick={() => {
                        const next = { ...(f.sides ?? {}) };
                        delete next[side];
                        kit.set({ sides: next });
                      }}
                    >
                      Use padding
                    </button>
                  ) : null}
                  <NumberUnitInput
                    id={id(`side-${key}`)}
                    field={`side-${key}`}
                    label={`${label} padding`}
                    expr={expr}
                    quantity="length"
                    units={units}
                    validate={(v) => sideProblem(side, v)}
                    problem={faultOf(side)}
                    onCommit={(e) => kit.update({ sides: { ...(f.sides ?? {}), [side]: e } })}
                  />
                </span>
              </Field>
            </Fragment>
          );
        })}
        {cutNote ? (
          <div className="cad-enclosure-note" data-side-note={cutting.map((s) => SIDE_KEYS[s]).join(' ')}>
            <Hint tone="warning">{cutNote}</Hint>
          </div>
        ) : null}
        <Hint>Drag the arrows in the view to move a side.</Hint>
      </FieldGroup>
      {sizeText ? (
        <div className="cad-p2-sub" data-enclosure-size="1">
          Size: {sizeText}
        </div>
      ) : null}
      <Hint>Makes a new body only. The air volume is a separate Combine: Cut, with Keep the tool bodies on.</Hint>
    </P2FeaturePanel>
  );
}
