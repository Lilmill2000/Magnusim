// The sketch's patterns and offsets in the sketch panel (P4b): one row each
// ("Linear pattern 1"), with its count and values as fields that apply at once
// (the copies are laid out again: instances made or removed) and Delete (the
// copies go, the sources stay).
// Owner: P4b SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { SketchFeature, SketchTie } from '../../types/doc';
import { Button, buttonClass, Field, NumberUnitInput } from '../../ui/kit';
import { entityLabel } from '../model';
import type { SketchMode } from '../mode';
import { deleteTie, MAX_INSTANCES, skippedOf, tieLabel, updatePattern } from './pattern';
import { dissolveTie } from './ties';

/** `only` (ux010, the compact Sketch panel): just these patterns' rows (null: every one). */
export function TieRows({ mode, only = null }: { mode: SketchMode; only?: ReadonlySet<string> | null }) {
  const services = useServices();
  const draft = useStateStore(mode.view, (v) => v.draft) as SketchFeature | null;
  const over = useStateStore(mode.view, (v) => [...(v.status?.conflicting ?? []), ...(v.status?.redundant ?? [])].join(','));
  const ties = (draft?.ties ?? []).filter((t) => !only || only.has(t.id));
  // fu2: what the last edit did to a pattern by itself, with Dissolve when the pattern lives on.
  const notice = useStateStore(mode.view, (v) => v.tieNotice ?? null);
  const units = services.doc.units;
  const dissolve = (id: string, label: string) => void mode.apply(`Dissolve ${label}`, (d) => dissolveTie(d, id));
  const noticeEl = notice ? (
    <div className="cad-sk-section" role="status" data-tie-notice="1">
      <span className="cad-sk-selected">{notice.text}</span>
      {notice.tie && ties.some((t) => t.id === notice.tie) ? (
        <>
          {' · '}
          <button type="button" className={buttonClass('link')} data-tie-notice-dissolve={notice.tie} onClick={() => dissolve(notice.tie!, 'pattern')}>
            Dissolve pattern
          </button>
        </>
      ) : null}
    </div>
  ) : null;
  if (!draft || !ties.length) return noticeEl;
  const apply = (label: string, t: SketchTie, patch: Parameters<typeof updatePattern>[2]): string | null => {
    void mode.apply(label, (d) => updatePattern(d, t.id, patch, units));
    return null;
  };
  return (
    <>
    {noticeEl}
    <div className="cad-sk-section" data-sketch-ties="1">
      <div className="cad-field-group-title">Patterns and offsets</div>
      {ties.map((t) => {
        const label = tieLabel(draft, t.id);
        const what = t.sources.map((id) => entityLabel(draft, id));
        const skipped = t.kind === 'offset' ? [] : skippedOf(t);
        const instances = t.kind === 'offset' ? t.copies.length : t.count[0] * t.count[1] - skipped.length;
        const count = (k: 0 | 1, name: string) => (
          <Field key={`${t.id}-c${k}`} label={name} field={`tie-count${k ? 2 : ''}`}>
            <NumberUnitInput
              field={`tie-count${k ? 2 : ''}`}
              label={`${label} ${name}`}
              expr={String(t.count[k])}
              quantity="scalar"
              units={units}
              validate={(v) => (Number.isInteger(v) && v >= (k === 0 ? 2 : 1) && v <= MAX_INSTANCES ? null : `A whole number from ${k === 0 ? 2 : 1} to ${MAX_INSTANCES}`)}
              onCommit={(_e, v) => apply(`${label} count`, t, { count: k === 0 ? [v, t.count[1]] : [t.count[0], v] })}
            />
          </Field>
        );
        const value = (name: string, words: string, quantity: 'length' | 'angle') =>
          t.exprs[name] == null ? null : (
            <Field key={`${t.id}-${name}`} label={words} field={`tie-${name}`}>
              <NumberUnitInput
                field={`tie-${name}`}
                label={`${label} ${words}`}
                expr={t.exprs[name]}
                quantity={quantity}
                units={units}
                validate={quantity === 'length' ? (v) => (v > 0 ? null : 'Must be more than 0') : undefined}
                onCommit={(e) => apply(`${label} ${words.toLowerCase()}`, t, { exprs: { [name]: e } })}
              />
            </Field>
          );
        return (
          <div key={t.id} className="cad-sk-tie" data-sketch-tie={t.id} data-tie-kind={t.kind} data-tie-instances={instances}>
            <div className="cad-sk-selected" title={what.join(', ')}>
              <strong>{label}</strong> of {what.slice(0, 3).join(', ')}
              {what.length > 3 ? ` and ${what.length - 3} more` : ''}
            </div>
            {skipped.length ? (
              <div className="cad-sk-actions" data-tie-skipped={skipped.length}>
                <span className="cad-sk-selected">
                  {skipped.length === 1 ? '1 instance deleted (skipped)' : `${skipped.length} instances deleted (skipped)`}
                </span>
                <Button variant="secondary" data-tie-restore={t.id} onClick={() => void mode.apply(`Restore ${label}`, (d) => updatePattern(d, t.id, { skip: [] }, units))}>
                  Restore
                </Button>
              </div>
            ) : null}
            {over.split(',').includes(t.id) ? (
              <div className="cad-sk-selected" role="status" data-tie-over="1">
                It over-defines the sketch: a copy is also held by another relation. Delete that relation, or this {t.kind === 'offset' ? 'offset' : 'pattern'}.
              </div>
            ) : null}
            {t.kind === 'linear' ? (
              <>
                {count(0, 'Count')}
                {value('spacing1', 'Spacing', 'length')}
                {t.along?.[0] ? <div className="cad-sk-selected">Along {entityLabel(draft, t.along[0])}</div> : value('angle1', 'Direction', 'angle')}
                {t.count[1] > 1 ? (
                  <>
                    {count(1, 'Count 2')}
                    {value('spacing2', 'Spacing 2', 'length')}
                    {t.along?.[1] ? <div className="cad-sk-selected">Along {entityLabel(draft, t.along[1])}</div> : value('angle2', 'Direction 2', 'angle')}
                  </>
                ) : null}
              </>
            ) : t.kind === 'circular' ? (
              <>
                {count(0, 'Count')}
                <label className="cad-sk-check">
                  <input type="checkbox" checked={!!t.full} data-tie-full="1" onChange={(e) => apply(`${label} spacing`, t, { full: e.target.checked, exprs: { angle: t.exprs.angle ?? '90 deg' } })} />
                  Full circle, equal spacing
                </label>
                {t.full ? null : value('angle', 'Total angle', 'angle')}
              </>
            ) : (
              value('distance', 'Distance', 'length')
            )}
            <div className="cad-sk-actions">
              {t.kind === 'offset' ? null : (
                <Button variant="secondary" data-tie-dissolve={t.id} tip="The copies stay where they are, as free geometry" onClick={() => dissolve(t.id, label)}>
                  Dissolve
                </Button>
              )}
              <Button variant="secondary" data-tie-delete={t.id} onClick={() => void mode.apply(`Delete ${label}`, (d) => deleteTie(d, t.id))}>
                Delete {t.kind === 'offset' ? 'offset' : 'pattern'}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
    </>
  );
}
