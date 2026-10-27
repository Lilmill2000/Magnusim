// The Parameters panel (Fusion's Change Parameters, as a flyout): one row per
// user parameter with its name, expression, value, unit and delete, and its comment under
// them (as the Assistant's set_params comment); an add row at the foot of the table. Each change is one undo step. An invalid name or
// expression shows why inline and is not applied; a change the document
// refuses (a cycle, a parameter in use) shows the document's reason.
// Rows an Assistant step changes flash for FLASH_MS (data-param-changed), in
// the person's open panel as in the Assistant's own (read-only) one.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState, type KeyboardEvent } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { AppServices } from '../../types/app';
import type { Param, ParamId } from '../../types/doc';
import type { Quantity, UnitsService } from '../../types/units';
import { errText, uiFor } from '../controller';
import { ICONS } from '../Icon';
import { Button, EmptyState, IconButton, NumberUnitInput, PanelChrome, Select, exprToStore, formatQuantity } from '../kit';
import { namesIn } from '../../doc/expr';
import { checkParamName } from '../tree/names';

function quantityOptions(units: UnitsService): { value: Quantity; label: string }[] {
  return [
    { value: 'length', label: units.unitLabel('length') || 'mm' },
    { value: 'angle', label: units.units().angle === 'deg' ? 'deg' : 'rad' },
    { value: 'scalar', label: 'No unit' },
  ];
}

/** The parameter's value for the Value column, or why it has none. */
export function paramValue(p: Pick<Param, 'expr' | 'quantity'>, units: UnitsService): { text: string; error: string | null } {
  const r = units.evaluate(p.expr, p.quantity);
  if (!r.ok) return { text: '', error: r.error };
  return { text: formatQuantity(r.value, p.quantity, units.units()), error: null };
}

/** Why an expression cannot be this parameter's, before asking the document. */
export function selfUse(name: string, uses: string[]): string | null {
  return uses.some((u) => u.toLowerCase() === name.toLowerCase()) ? `${name} cannot use itself` : null;
}

const QUANTITY_WORDS: Record<Quantity, string> = { length: 'a length', angle: 'an angle', scalar: 'a plain number' };

/** Why a parameter's expression cannot take another unit kind, said once: "50 mm is a length, not a plain number". */
export function quantityProblem(expr: string, to: Quantity, units: UnitsService): string | null {
  const r = units.evaluate(expr, to);
  if (r.ok) return null;
  const is = (['length', 'angle', 'scalar'] as Quantity[]).find((q) => q !== to && units.evaluate(expr, q).ok);
  return is ? `${expr} is ${QUANTITY_WORDS[is]}, not ${QUANTITY_WORDS[to]}` : `${expr}: ${r.error}`;
}

function NameInput({ p, onError }: { p: Param; onError(msg: string | null): void }) {
  const services = useServices();
  const [text, setText] = useState(p.name);
  const [editing, setEditing] = useState(false);
  const shown = editing ? text : p.name;
  const commit = () => {
    setEditing(false);
    const params = services.doc.state.get().doc.params;
    const check = checkParamName(text, params, p.id);
    if (check.ok === 'same') {
      onError(null);
      return;
    }
    if (check.ok === false) {
      if (!text.trim()) {
        setText(p.name);
        onError(null);
        return;
      }
      setEditing(true);
      onError(check.reason);
      return;
    }
    try {
      const r = services.doc.updateParam(p.id, { name: check.name });
      if (!r.ok) {
        setEditing(true);
        onError(r.reason);
        return;
      }
    } catch (err) {
      setEditing(true);
      onError(errText(err));
      return;
    }
    onError(null);
  };
  return (
    <input
      type="text"
      className="mgk-input cad-param-name"
      aria-label={`Name of ${p.name}`}
      spellCheck={false}
      autoComplete="off"
      maxLength={64}
      value={shown}
      onFocus={() => {
        setText(p.name);
        setEditing(true);
      }}
      onChange={(e) => {
        setText(e.target.value);
        setEditing(true);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setText(p.name);
          setEditing(false);
          onError(null);
        }
      }}
    />
  );
}

/** The longest comment (set_params' comment field). */
export const COMMENT_MAX = 200;

/** A parameter's comment, kept on Enter or leaving the field ("" removes it): one undo step. */
function CommentInput({ p, onError }: { p: Param; onError(msg: string | null): void }) {
  const services = useServices();
  const [text, setText] = useState(p.comment ?? '');
  const [editing, setEditing] = useState(false);
  const shown = editing ? text : (p.comment ?? '');
  const commit = () => {
    setEditing(false);
    const next = text.trim();
    if (next === (p.comment ?? '')) return;
    try {
      const r = services.doc.updateParam(p.id, { comment: next });
      onError(r.ok ? null : r.reason);
    } catch (err) {
      onError(errText(err));
    }
  };
  return (
    <input
      type="text"
      className="mgk-input cad-param-comment"
      aria-label={`Comment of ${p.name}`}
      placeholder="Comment"
      spellCheck={false}
      autoComplete="off"
      maxLength={COMMENT_MAX}
      data-param-comment={p.name}
      value={shown}
      onFocus={() => {
        setText(p.comment ?? '');
        setEditing(true);
      }}
      onChange={(e) => {
        setText(e.target.value);
        setEditing(true);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setText(p.comment ?? '');
          setEditing(false);
        }
      }}
    />
  );
}

/** How long a row the Assistant changed stays flashed. */
export const FLASH_MS = 1500;

const NONE: ReadonlySet<ParamId> = new Set();

/**
 * The parameters an Assistant step just changed (added, renamed, a new expression or unit), each for
 * FLASH_MS: a change of the parameters while a step is open whose newest undo step is that step's.
 */
function useAssistantChanges(services: AppServices): ReadonlySet<ParamId> {
  const [ids, setIds] = useState<ReadonlySet<ParamId>>(NONE);
  useEffect(() => {
    const timers = new Map<ParamId, ReturnType<typeof setTimeout>>();
    const off = services.doc.state.subscribe((s, prev) => {
      if (s.doc.params === prev.doc.params) return;
      const step = services.doc.assistant?.current();
      if (!step || services.doc.assistant?.topGroup()?.tag !== step.owner) return;
      const was = new Map(prev.doc.params.map((p) => [p.id, p]));
      const hit = s.doc.params.filter((p) => {
        const b = was.get(p.id);
        return !b || b.name !== p.name || b.expr !== p.expr || b.quantity !== p.quantity;
      });
      if (!hit.length) return;
      setIds((cur) => new Set([...cur, ...hit.map((p) => p.id)]));
      for (const { id } of hit) {
        clearTimeout(timers.get(id));
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id);
            setIds((cur) => {
              const next = new Set(cur);
              next.delete(id);
              return next.size ? next : NONE;
            });
          }, FLASH_MS),
        );
      }
    });
    return () => {
      off();
      for (const t of timers.values()) clearTimeout(t);
    };
  }, [services]);
  return ids;
}

function ParamRow({ p, changed = false }: { p: Param; changed?: boolean }) {
  const services = useServices();
  const { doc } = services;
  const units = doc.units;
  const [error, setError] = useState<string | null>(null);
  const value = paramValue(p, units);
  const opts = quantityOptions(units);
  return (
    <>
      <tr className={error ? 'is-invalid' : undefined} data-param-row={p.name} data-param-id={p.id} data-param-changed={changed ? '1' : undefined}>
        <td>
          <NameInput p={p} onError={setError} />
        </td>
        <td>
          <NumberUnitInput
            raw
            showUnit={false}
            field="expr"
            label={`Expression of ${p.name}`}
            expr={p.expr}
            quantity={p.quantity}
            units={units}
            validate={(_v, uses) => selfUse(p.name, uses)}
            onCommit={(expr) => {
              try {
                const r = doc.updateParam(p.id, { expr });
                if (!r.ok) return r.reason;
              } catch (err) {
                return errText(err);
              }
              setError(null);
              return null;
            }}
          />
        </td>
        <td className={`cad-param-value${value.error ? ' is-error' : ''}`} data-param-value="1">
          {value.error ? 'Error' : value.text}
        </td>
        <td>
          <Select
            label={`Unit of ${p.name}`}
            value={p.quantity}
            attrs={{ 'data-param-unit': '1' }}
            onChange={(v) => {
              const q = v as Quantity;
              const problem = quantityProblem(p.expr, q, units);
              if (problem) {
                setError(problem);
                return;
              }
              try {
                const res = doc.updateParam(p.id, { quantity: q });
                setError(res.ok ? null : res.reason);
              } catch (err) {
                setError(errText(err));
              }
            }}
            options={opts.map((o) => ({ value: o.value, label: o.label }))}
          />
        </td>
        <td>
          <IconButton
            size="row"
            icon={ICONS.trash}
            label={`Delete ${p.name}`}
            data-param-delete="1"
            onClick={() => {
              try {
                const r = doc.removeParam(p.id);
                // "width can't be deleted: h and Box 1 use it" says it all; other refusals get the prefix.
                setError(r.ok ? null : r.reason.startsWith(`${p.name} can't be deleted`) ? r.reason : `Delete failed: ${r.reason}`);
              } catch (err) {
                setError(`Delete failed: ${errText(err)}`);
              }
            }}
          />
        </td>
      </tr>
      <tr className="cad-param-comment-row" data-param-comment-row={p.name}>
        <td colSpan={5}>
          <CommentInput p={p} onError={setError} />
        </td>
      </tr>
      {error || value.error ? (
        <tr className="cad-param-err-row">
          <td colSpan={5} className="cad-param-err" role="alert" data-param-error={p.name}>
            {error ?? value.error}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function AddRow() {
  const services = useServices();
  const { doc } = services;
  const units = doc.units;
  const [name, setName] = useState('');
  const [expr, setExpr] = useState('');
  const [quantity, setQuantity] = useState<Quantity>('length');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const opts = quantityOptions(units);

  const add = () => {
    const params = doc.state.get().doc.params;
    const check = checkParamName(name, params, null);
    if (check.ok !== true) {
      setError(check.ok === false ? check.reason : 'Enter a name');
      return;
    }
    if (!expr.trim()) {
      setError('Enter an expression, for example 20 mm');
      return;
    }
    // A parameter that names itself is said as such (it is not "unknown" yet).
    const self = selfUse(check.name, namesIn(expr));
    if (self) {
      setError(self);
      return;
    }
    const r = units.evaluate(expr, quantity);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    try {
      const res = doc.addParam({ name: check.name, expr: exprToStore(expr, quantity, units.units()), quantity, ...(comment.trim() ? { comment: comment.trim() } : {}) });
      if (typeof res !== 'string') {
        if (!res.ok) {
          setError(res.reason);
          return;
        }
      }
    } catch (err) {
      setError(errText(err));
      return;
    }
    setName('');
    setExpr('');
    setComment('');
    setError(null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  };
  return (
    <>
      <tr className="cad-param-add" data-param-add="1">
        <td>
          <input
            type="text"
            className="mgk-input cad-param-name"
            aria-label="New parameter name"
            placeholder="Name"
            spellCheck={false}
            autoComplete="off"
            maxLength={64}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={onKey}
          />
        </td>
        <td>
          <input
            type="text"
            className="mgk-input cad-param-expr"
            aria-label="New parameter expression"
            placeholder="Expression"
            spellCheck={false}
            autoComplete="off"
            value={expr}
            onChange={(e) => {
              setExpr(e.target.value);
              setError(null);
            }}
            onKeyDown={onKey}
          />
        </td>
        <td />
        <td>
          <Select label="New parameter unit" value={quantity} onChange={(v) => setQuantity(v as Quantity)} options={opts.map((o) => ({ value: o.value, label: o.label }))} />
        </td>
        <td />
      </tr>
      <tr className="cad-param-comment-row">
        <td colSpan={5}>
          <input
            type="text"
            className="mgk-input cad-param-comment"
            aria-label="New parameter comment"
            placeholder="Comment (optional)"
            spellCheck={false}
            autoComplete="off"
            maxLength={COMMENT_MAX}
            data-param-comment="new"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={onKey}
          />
        </td>
      </tr>
      <tr className="cad-param-add-actions">
        <td colSpan={5}>
          <Button variant="secondary" onClick={add} data-param-add-btn="1">
            + Add parameter
          </Button>
        </td>
      </tr>
      {error ? (
        <tr className="cad-param-err-row">
          <td colSpan={5} className="cad-param-err" role="alert" data-param-error="new">
            {error}
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function ParametersPanel() {
  const services = useServices();
  const ui = uiFor(services);
  const params = useStateStore(services.doc.state, (s) => s.doc.params);
  useStateStore(services.doc.state, (s) => s.doc.units);
  const changed = useAssistantChanges(services);
  return (
    <PanelChrome panel="params" title="Parameters" onDone={() => ui.closePanel()} className="cad-params-panel">
      <table className="cad-params" aria-label="Parameters">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Expression</th>
            <th scope="col">Value</th>
            <th scope="col">Unit</th>
            <th scope="col">
              <span className="cad-sr">Delete</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {params.length ? null : (
            <tr>
              <td colSpan={5}>
                <EmptyState attr={{ 'data-params-empty': '1' }}>No parameters yet</EmptyState>
              </td>
            </tr>
          )}
          {params.map((p) => (
            <ParamRow key={p.id} p={p} changed={changed.has(p.id)} />
          ))}
          <AddRow />
        </tbody>
      </table>
    </PanelChrome>
  );
}
