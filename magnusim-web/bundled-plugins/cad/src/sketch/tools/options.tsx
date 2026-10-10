// A sketch tool's options in the sketch panel (P4b): the control spline's
// degree, the offset distance and side, the fillet radius, a pattern's count
// and spacing. A tool lists them (SketchTool.options); the panel draws them
// under the hint with the kit's fields and redraws when the tool's hint or
// preview changes. Every change applies at once (no Apply button).
// Owner: P4b SKETCH.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useReducer } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { Quantity } from '../../types/units';
import { Button, Field, NumberUnitInput, Select } from '../../ui/kit';
import type { SketchMode } from '../mode';

export type ToolOption =
  | { kind: 'choice'; id: string; label: string; value: string; choices: { value: string; label: string }[]; set(v: string): void }
  /** An expression field ("20 mm", "width / 2"); set returns a reason to refuse it. */
  | { kind: 'number'; id: string; label: string; expr: string; quantity: Quantity; set(expr: string, value: number): string | null | void; validate?(v: number): string | null }
  | { kind: 'check'; id: string; label: string; value: boolean; set(v: boolean): void }
  | { kind: 'button'; id: string; label: string; run(): void; disabled?: string | null; primary?: boolean }
  | { kind: 'text'; id: string; text: string };

export function ToolOptions({ mode }: { mode: SketchMode }) {
  const services = useServices();
  // Redraw with the tool (its hint and preview change with its options and steps).
  useStateStore(mode.view, (v) => `${v.hint}|${v.preview ? 1 : 0}|${v.draft?.entities.length ?? 0}`);
  useStateStore(mode.state, (s) => s.tool);
  useStateStore(services.selection, (s) => s.items.length);
  // ux010 (PANELS): a box or a choice whose change moves nothing else on screen (sketch Chamfer's "Same
  // distance on both lines": the hint stays) redraws too; the controlled box snapped back to its old state.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const opts = mode.tool?.options?.() ?? [];
  if (!opts.length) return null;
  const units = services.doc.units;
  return (
    <div
      className="cad-sk-section"
      data-sketch-options={mode.tool?.id}
      onKeyDown={(e) => {
        // fix1 P5: Enter in a field applies it and gives the keyboard back to the sketch, so the next Enter
        // places what the tool set up and letters pick tools again (a refused entry keeps the focus).
        if (e.key !== 'Enter') return;
        const target = e.target as HTMLElement;
        if (target.tagName !== 'INPUT') return;
        const box = e.currentTarget;
        // Final check: a microtask, not a timer. The field's own Enter commit queued React's render (a refusal
        // shows [data-nui-error]) first, so this sees it; and the keyboard is handed back before the next key
        // event. With setTimeout(0) an Enter right after (real Chrome, the frame in its own process) still
        // reached the field, and nothing was placed (cad:p4b-fix1-polish failed 2 of 5 in Chrome).
        queueMicrotask(() => {
          if (!box.querySelector('[data-nui-error]')) target.blur();
        });
      }}
    >
      {opts.map((o) => {
        switch (o.kind) {
          case 'choice':
            return (
              <Field key={o.id} label={o.label} field={`sk-${o.id}`}>
                <Select value={o.value} label={o.label} field={`sk-${o.id}`} options={o.choices} onChange={(v) => {
                  o.set(v);
                  redraw();
                }} />
              </Field>
            );
          case 'number':
            return (
              <Field key={`${o.id}`} label={o.label} field={`sk-${o.id}`}>
                <NumberUnitInput
                  field={`sk-${o.id}`}
                  label={o.label}
                  expr={o.expr}
                  quantity={o.quantity}
                  units={units}
                  validate={o.validate ? (v) => o.validate!(v) : undefined}
                  onCommit={(e, v) => o.set(e, v) ?? null}
                />
              </Field>
            );
          case 'check':
            return (
              <label key={o.id} className="cad-sk-check">
                <input type="checkbox" checked={o.value} onChange={(e) => {
                  o.set(e.target.checked);
                  redraw();
                }} data-sketch-option={o.id} />
                {o.label}
              </label>
            );
          case 'button':
            return (
              <div key={o.id} className="cad-sk-actions">
                <Button variant={o.primary ? 'primary' : 'secondary'} onClick={() => o.run()} disabledReason={o.disabled ?? null} data-sketch-option={o.id}>
                  {o.label}
                </Button>
              </div>
            );
          case 'text':
            return (
              <div key={o.id} className="cad-sk-selected" data-sketch-option={o.id}>
                {o.text}
              </div>
            );
        }
      })}
    </div>
  );
}
