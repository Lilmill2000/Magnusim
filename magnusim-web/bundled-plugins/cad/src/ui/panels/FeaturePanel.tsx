// Feature panels (flyout, PanelChrome): Box and Cylinder. Every valid field
// change applies live through the panel's EditSession; Done closes; Delete
// discards a new feature or removes an existing one; the whole panel is one
// undo step. Numbers are NumberUnitInputs bound to expressions. Operation
// (New body / Join / Cut / Intersect) shows once a body is made before the
// feature in history. Rebuild errors and warnings show in the foot ("What's wrong"),
// except one a field already shows under itself (said once, where it is).
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import { FEATURE_ACTION_LABELS, type BodyOp, type BoxFeature, type CylinderFeature, type ExprVec3, type Feature, type OriginAxisRef } from '../../types/doc';
import type { Expr } from '../../types/units';
import { errText, uiFor, type PanelState } from '../controller';
import { sizeProblem } from '../../doc/features/primitives';
import { DisabledReason, displayOf, Field, FieldGroup, Hint, NumberUnitInput, PanelChrome, Select } from '../kit';

type FeaturePanelState = Extract<PanelState, { kind: 'feature' }>;

const OPS: { value: BodyOp; label: string }[] = [
  { value: 'new', label: 'New body' },
  { value: 'join', label: 'Join' },
  { value: 'cut', label: 'Cut' },
  { value: 'intersect', label: 'Intersect' },
];

const AXES: { value: OriginAxisRef; label: string }[] = [
  { value: 'origin:x', label: 'X axis' },
  { value: 'origin:y', label: 'Y axis' },
  { value: 'origin:z', label: 'Z axis' },
];

const XYZ = ['x', 'y', 'z'] as const;

/** A size field: more than 0, and not below the smallest size the kernel builds (MIN_SIZE_MM). */
export const positive = (what: string) => (v: number) => sizeProblem(what, v);

function setAt(v: ExprVec3, i: number, e: Expr): ExprVec3 {
  const next: ExprVec3 = [v[0], v[1], v[2]];
  next[i] = e;
  return next;
}

export function FeaturePanel({ panel }: { panel: FeaturePanelState }) {
  const services = useServices();
  const ui = uiFor(services);
  const { doc } = services;
  const stored = useStateStore(doc.state, (s) => s.doc.features.find((f) => f.id === panel.feature) ?? null);
  const status = useStateStore(doc.state, (s) => s.rebuild.features[panel.feature] ?? null);
  // Join / Cut / Intersect need a body made BEFORE this feature in history
  // (review round 3: the first feature's panel offered Join once a later Box
  // made a body). The rebuild says how many bodies exist just before it; until
  // the feature is built (new, or rolled back), count the bodies the features
  // above it made.
  const bodiesBefore = useStateStore(doc.state, (s) => {
    const st = s.rebuild.features[panel.feature];
    if (st && typeof st.bodiesBefore === 'number') return st.bodiesBefore;
    const idx = s.doc.features.findIndex((f) => f.id === panel.feature);
    const above = idx >= 0 ? s.doc.features.slice(0, idx) : s.doc.features.slice(0, s.view.rollback ?? s.doc.features.length);
    return above.filter((f) => f.op === 'new' && !f.suppressed && (s.rebuild.features[f.id]?.state === 'ok' || s.rebuild.features[f.id]?.state === 'warning')).length;
  });
  useStateStore(doc.state, (s) => s.doc.units);
  useStateStore(doc.state, (s) => s.doc.params);
  const note = useStateStore(ui.state, (s) => s.panelNote);
  // A field change that does not validate is kept in the session's draft but
  // not applied, so the document may not change: re-render on every update.
  const [, setTick] = useState(0);

  // The feature as last typed (the document holds its last valid version).
  const draft: Feature = panel.session.open ? panel.session.draft : (stored ?? panel.session.draft);

  const update = (patch: Partial<Feature>): string | null => {
    // The session ignores changes it cannot make: say why instead of showing a value that did not apply.
    const block = ui.editBlock();
    if (block) return block;
    if (!panel.session.open) return 'This panel is no longer editing the feature';
    try {
      panel.session.update(patch);
    } catch (err) {
      return `${panel.isNew ? 'Create' : 'Edit'} failed: ${errText(err)}`;
    }
    setTick((n) => n + 1);
    if (note) ui.setPanelNote(null);
    return null;
  };

  let incomplete: string | null = null;
  try {
    incomplete = panel.session.incomplete();
  } catch (err) {
    incomplete = errText(err);
  }
  const doneDisabled = panel.isNew && incomplete ? incomplete : null;

  const units = doc.units;
  // What the fields already say under themselves ("Unknown parameter "w"" under Length): the foot
  // does not say it again (P1.5 review round 1: the same reason showed three times).
  const fieldErrors: string[] = [];
  const exprField = (key: string, label: string, expr: Expr, validate?: (v: number) => string | null, axis?: 'x' | 'y' | 'z') => {
    const id = `cad-f-${panel.feature}-${key}`;
    const storedError = displayOf(expr, 'length', units).error;
    if (storedError) fieldErrors.push(storedError);
    return (
      <Field key={key} label={label} htmlFor={id} field={key} axis={axis}>
        <NumberUnitInput
          id={id}
          field={key}
          label={label}
          expr={expr}
          quantity="length"
          units={units}
          validate={validate}
          onCommit={(e) => update(buildPatch(draft, key, e))}
        />
      </Field>
    );
  };

  // A stored Join / Cut / Intersect keeps the row, so a feature that has nothing to act on can be set back to New body.
  const opRow =
    bodiesBefore > 0 || draft.op !== 'new' || (stored != null && stored.op !== 'new') ? (
      <Field label="Operation" htmlFor={`cad-f-${panel.feature}-op`} field="op">
        <Select
          id={`cad-f-${panel.feature}-op`}
          aria-label="Operation"
          data-field="op"
          value={draft.op}
          onChange={(e) => {
            const refused = update({ op: e.target.value as BodyOp });
            if (refused) ui.setPanelNote(refused);
          }}
        >
          {OPS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
    ) : null;

  let body;
  if (draft.type === 'box') {
    const f = draft as BoxFeature;
    body = (
      <>
        <FieldGroup title="Size">
          {exprField('size.0', 'Length (X)', f.size[0], positive('Length'))}
          {exprField('size.1', 'Width (Y)', f.size[1], positive('Width'))}
          {exprField('size.2', 'Height (Z)', f.size[2], positive('Height'))}
        </FieldGroup>
        <FieldGroup title="Corner">{XYZ.map((a, i) => exprField(`origin.${i}`, a.toUpperCase(), f.origin[i], undefined, a))}</FieldGroup>
        {opRow}
      </>
    );
  } else {
    const f = draft as CylinderFeature;
    body = (
      <>
        <FieldGroup title="Size">
          {exprField('diameter', 'Diameter', f.diameter, positive('Diameter'))}
          {exprField('height', 'Height', f.height, positive('Height'))}
        </FieldGroup>
        <FieldGroup title="Placement">
          <Field label="Axis" htmlFor={`cad-f-${panel.feature}-axis`} field="axis">
            <Select
              id={`cad-f-${panel.feature}-axis`}
              aria-label="Axis"
              data-field="axis"
              value={f.axis}
              onChange={(e) => {
                const refused = update({ axis: e.target.value as OriginAxisRef } as Partial<Feature>);
                if (refused) ui.setPanelNote(refused);
              }}
            >
              {AXES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </Select>
          </Field>
          {XYZ.map((a, i) => exprField(`origin.${i}`, `Base centre ${a.toUpperCase()}`, f.origin[i], undefined, a))}
        </FieldGroup>
        {opRow}
      </>
    );
  }

  const saidByField = (msg: string | null | undefined) => !!msg && fieldErrors.some((e) => msg === e || msg.endsWith(`: ${e}`));
  // Typed in this panel and not in the document yet (the stored feature is not "not applied").
  const pending = stored != null && JSON.stringify(draft) !== JSON.stringify(stored);

  const foot = [];
  if (note) foot.push(<DisabledReason key="note">{note}</DisabledReason>);
  if (status?.state === 'error' && !(saidByField(status.message) && !status.actions?.length)) {
    const fixes = (status.actions ?? []).map((a) => ({ label: FEATURE_ACTION_LABELS[a], run: () => ui.runFeatureAction(panel.feature, a) }));
    foot.push(
      <DisabledReason key="error" fixes={fixes}>
        {status.message || `${draft.name} failed`}
      </DisabledReason>,
    );
  }
  else if (status?.state === 'warning' && status.message) {
    foot.push(
      <div key="warning" className="mat-assign-hint is-warning" role="status">
        {status.message}
      </div>,
    );
  }
  if (incomplete && panel.isNew) {
    foot.push(<DisabledReason key="incomplete">{incomplete}</DisabledReason>);
  } else if (incomplete && (pending || !saidByField(incomplete))) {
    foot.push(
      <Hint key="incomplete">
        <span className="cad-not-applied">Not applied: {incomplete}</span>
      </Hint>,
    );
  }

  return (
    <PanelChrome
      panel="feature"
      title={draft.name}
      accent="feature"
      onRename={(next) => {
        const why = ui.renameFeature(panel.feature, next);
        if (!why) setTick((n) => n + 1);
        return why;
      }}
      onRenameGiveUp={(why) => ui.setPanelNote(`Rename failed: ${why}`)}
      renameLabel="feature"
      onDone={() => ui.closePanel()}
      doneDisabled={doneDisabled}
      onDelete={() => ui.deletePanelFeature()}
      foot={foot.length ? foot : null}
    >
      <div data-feature-panel={draft.type} data-feature-id={panel.feature} data-new={panel.isNew ? '1' : '0'}>
        {body}
      </div>
    </PanelChrome>
  );
}

/** The patch for one expression field ("size.1", "origin.0", "diameter", "height"). */
export function buildPatch(f: Feature, key: string, e: Expr): Partial<Feature> {
  const [name, idx] = key.split('.');
  if (idx != null) {
    const i = Number(idx);
    if (name === 'size' && f.type === 'box') return { size: setAt(f.size, i, e) } as Partial<Feature>;
    if (name === 'origin') return { origin: setAt(f.origin, i, e) } as Partial<Feature>;
  }
  if (name === 'diameter' || name === 'height') return { [name]: e } as Partial<Feature>;
  throw new Error(`unknown field ${key}`);
}
