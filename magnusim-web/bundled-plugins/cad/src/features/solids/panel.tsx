// Panel parts the P4a solids share, as the Extrude panel draws them: the
// Operation row (New body / Join / Cut / Intersect, shown once a body is made
// before the feature in history, or when it is not New body so it can go back),
// a checkbox row, and the active pick field (the first one still empty, until the
// user clicks another field's box).
// Owner: P4a SOLIDS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useState } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { BodyOp, Feature, FeatureId } from '../../types/doc';
import { Field, Select } from '../../ui/kit';

export const OPS: { value: BodyOp; label: string }[] = [
  { value: 'new', label: 'New body' },
  { value: 'join', label: 'Join' },
  { value: 'cut', label: 'Cut' },
  { value: 'intersect', label: 'Intersect' },
];

/** How many bodies exist just before the feature (the last rebuild's count, else what the history says). */
export function useBodiesBefore(feature: FeatureId): number {
  const services = useServices();
  return useStateStore(services.doc.state, (s) => {
    const st = s.rebuild.features[feature];
    if (st && typeof st.bodiesBefore === 'number') return st.bodiesBefore;
    const idx = s.doc.features.findIndex((f) => f.id === feature);
    const above = idx >= 0 ? s.doc.features.slice(0, idx) : s.doc.features.slice(0, s.view.rollback ?? s.doc.features.length);
    const makesBody = (f: Feature) => ('op' in f ? f.op === 'new' : f.type === 'import' || f.type === 'split');
    return above.filter((f) => makesBody(f) && !f.suppressed && (s.rebuild.features[f.id]?.state === 'ok' || s.rebuild.features[f.id]?.state === 'warning')).length;
  });
}

export function OperationRow({ feature, op, storedOp, onChange }: { feature: FeatureId; op: BodyOp; storedOp: BodyOp | null; onChange(op: BodyOp): void }) {
  const before = useBodiesBefore(feature);
  if (!(before > 0 || op !== 'new' || (storedOp != null && storedOp !== 'new'))) return null;
  const id = `cad-f-${feature}-op`;
  return (
    <Field label="Operation" htmlFor={id} field="op">
      <Select id={id} label="Operation" field="op" value={op} onChange={(v) => onChange(v as BodyOp)} options={OPS} />
    </Field>
  );
}

export function CheckRow({ feature, field, label, checked, onChange }: { feature: FeatureId; field: string; label: string; checked: boolean; onChange(v: boolean): void }) {
  const id = `cad-f-${feature}-${field}`;
  return (
    <Field label={label} htmlFor={id} field={field}>
      <input id={id} type="checkbox" className="cad-check" data-field={field} checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </Field>
  );
}

/**
 * Which pick field takes viewport clicks: the one the user clicked (until a pick lands in a
 * single-pick field, which hands back with choose(null)), else the first that is still
 * empty (`order`, with its emptiness), else none.
 */
export function useActiveField<K extends string>(order: readonly [K, boolean][]): [K | null, (k: K | null) => void] {
  const [chosen, setChosen] = useState<K | null>(null);
  const firstEmpty = order.find(([, empty]) => empty)?.[0] ?? null;
  return [chosen ?? firstEmpty, setChosen];
}
