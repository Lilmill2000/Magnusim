// Delete faces panel: the faces to remove (one body), picked in the viewport;
// every change applies live (the body is healed at once). Done closes.
// Kernel API 8: on a red result whose picked faces are only part of the fillets or holes they
// belong to, "Add the rest (+N)" adds the rest its red text names (the build's DeleteFacesOutput:
// the faces get_model lists as `rest`), as clicks on them would. On the Assistant's read-only
// panel it is inert with the other fields.
// Add by size (the Analysis Situs plan §3.3): "Fillets up to [R] Add" and "Holes up to Ø [D] Add"
// add the faces "<body> faces fillet <= R" / "<body> faces hole <= D" name on the body as it is
// before this Delete faces (by-size.ts: the Assistant's selectors and references), only those not
// picked yet, as clicks would; Enter in a size does what its Add does. The sizes start at
// nice(d / 50) and nice(d / 20) of the body's box diagonal and live in the panel only. With no face
// picked yet Add uses the Part's one solid body, else it says to click a face first. A line says
// what Add added, or why nothing (the body has none that size, it is over the face limit, a surface
// body, an old kernel). A Ctrl+drag box in the view while the panel is open adds the faces it
// selects (useBoxPicks: the box only, never a right-click's selection). On the Assistant's panel,
// Add is disabled and a box adds nothing.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { personCall, type PersonCall } from '../../assistant/person-call';
import { boxDiagonal } from '../../assistant/selectors/geometry';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { DeleteFacesFeature } from '../../types/doc';
import type { FeaturePanelProps } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { ASSISTANT_PANEL_DONE, Button, Field, Hint, usePanelOwner } from '../../ui/kit';
import { exprToStore } from '../../ui/kit/format';
import { NumberUnitInput } from '../../ui/kit/NumberUnitInput';
import { useFaceField } from '../p2/fields';
import { P2FeaturePanel, useFeaturePanel, type FeaturePanelKit } from '../p2/panel';
import { useBoxPicks, useSelectionMirror } from '../p2/pick';
import { addBySize } from './by-size';
import { addTarget, defaultSizes, DELETE_FACES_HINT, type SizeKind } from './words';

export function DeleteFacesPanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<DeleteFacesFeature>(props);
  const f = kit.draft;
  const bodyName = useStateStore(services.doc.state, (s) => (f.body ? (s.rebuild.bodies.find((b) => b.id === f.body)?.name ?? s.doc.bodies[f.body]?.name ?? null) : null));
  const faces = useFaceField(services, {
    feature: props.feature,
    body: f.body,
    refs: f.faces,
    active: true,
    oneBody: 'Delete faces works on one body: pick faces of the same body, or remove these first',
    onChange: (body, refs) => kit.set({ body, faces: refs }),
  });
  // A Ctrl+drag box while the panel is open adds the faces it selects.
  useSelectionMirror(services, faces.highlight);
  useBoxPicks(services, true, faces.take);
  const rest = useRest(props.feature, kit.status?.state === 'error', f.faces);
  return (
    <P2FeaturePanel props={props} kit={kit}>
      {faces.element(`Faces to delete${f.faces.length ? ` (${f.faces.length})` : ''}`, 'faces', () => {}, 'Click faces in the viewport to add or remove them; Ctrl+drag a box to add the faces it selects')}
      {rest.length ? (
        <div className="cad-p2-sub" data-delete-rest-row="1">
          <Button variant="secondary" data-delete-rest={rest.length} disabledReason={uiFor(services).editBlock()} tip="Add the faces the red text names to the faces to delete" onClick={() => kit.set({ faces: [...f.faces, ...rest] })}>
            {`Add the rest (+${rest.length})`}
          </Button>
        </div>
      ) : null}
      <AddBySize props={props} kit={kit} />
      {bodyName ? (
        <Field label="Body" field="body">
          <span data-delete-body="1">{bodyName}</span>
        </Field>
      ) : null}
      <div data-delete-hint="1">
        <Hint>{DELETE_FACES_HINT}</Hint>
      </div>
    </P2FeaturePanel>
  );
}

/** The rest a red build of the feature published (DeleteFacesOutput), less the faces picked now. */
function useRest(feature: string, red: boolean, picked: DeleteFacesFeature['faces']): DeleteFacesFeature['faces'] {
  const services = useServices();
  const output = useStateStore(services.doc.state, (s) => s.rebuild.outputs[feature] ?? null);
  if (!red || output?.type !== 'delete-faces') return [];
  return output.restRefs.filter((r) => !picked.some((x) => x.name === r.name));
}

const ROWS: { kind: SizeKind; label: string; lead: string | null; field: string; tip: string }[] = [
  { kind: 'fillets', label: 'Fillets up to', lead: null, field: 'add-fillets', tip: 'Add every fillet face of the body up to this radius that is not picked yet' },
  { kind: 'holes', label: 'Holes up to', lead: 'Ø', field: 'add-holes', tip: 'Add every face of the drilled holes of the body up to this diameter that is not picked yet (through holes too)' },
];

/** "Fillets up to [R] Add", "Holes up to Ø [D] Add" and the line saying what the last Add did. */
function AddBySize({ props, kit }: { props: FeaturePanelProps; kit: FeaturePanelKit<DeleteFacesFeature> }) {
  const services = useServices();
  const ui = uiFor(services);
  const assistant = usePanelOwner() === 'assistant';
  const units = useStateStore(services.doc.state, (s) => s.doc.units);
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  const f = kit.draft;
  const target = addTarget(bodies, f.body);
  const info = 'body' in target ? bodies.find((b) => b.id === target.body) : undefined;
  const defaults = info ? defaultSizes(boxDiagonal(info.bbox), units) : null;
  // What the person typed (the panel's own, for this session); null follows the default. The ref is
  // read at once by Add after a size applied on Enter or on the press that blurred it.
  const [typed, setTyped] = useState<Record<SizeKind, string | null>>({ fillets: null, holes: null });
  const typedRef = useRef(typed);
  const [line, setLine] = useState<{ ok: boolean; words: string } | null>(null);
  const [busy, setBusy] = useState<SizeKind | null>(null);
  const latest = useRef({ kit, f });
  latest.current = { kit, f };
  const call = useRef<PersonCall | null>(null);
  useEffect(() => () => call.current?.stop(), []);

  const exprOf = (k: SizeKind): string => typedRef.current[k] ?? typed[k] ?? (defaults ? `${defaults[k]} ${units.length}` : '');
  const blocked = assistant ? ASSISTANT_PANEL_DONE : (ui.editBlock() ?? ('why' in target ? target.why : null));

  const add = async (k: SizeKind, expr = exprOf(k)) => {
    if (busy || blocked) return;
    const v = services.doc.units.evaluate(expr, 'length');
    if (!v.ok || !(v.value > 0)) {
      setLine({ ok: false, words: `${k === 'fillets' ? 'Fillets up to' : 'Holes up to'}: enter a size above 0` });
      return;
    }
    call.current?.stop();
    const c = personCall(services, 'direct', { kind: 'delete_faces' });
    call.current = c;
    setBusy(k);
    setLine(null);
    const now = latest.current;
    const r = await addBySize(services, { feature: props.feature, body: now.f.body, kind: k, size: v.value, picked: now.f.faces }, c);
    if (call.current !== c) return;
    call.current = null;
    setBusy(null);
    if (!r.ok) {
      setLine({ ok: false, words: r.words });
      return;
    }
    // As clicks add them: only faces not picked meanwhile.
    const cur = latest.current;
    const more = r.added.filter((x) => !cur.f.faces.some((p) => p.name === x.name));
    if (more.length) cur.kit.set({ body: r.body, faces: [...cur.f.faces, ...more] });
    setLine({ ok: true, words: r.words });
  };

  /** Enter in a size: Add with the value the field applies (the field's own Enter applies it first). */
  const onKey = (k: SizeKind) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
    const text = e.target.value.trim();
    if (!text) return;
    const expr = exprToStore(text, 'length', units);
    const v = services.doc.units.evaluate(expr, 'length');
    if (!v.ok || !(v.value > 0)) return;
    void add(k, expr);
  };

  return (
    <div className="cad-delete-by-size" data-delete-by-size="1">
      {ROWS.map((row) => (
        <Field key={row.kind} label={row.label} field={row.field}>
          <div className="cad-delete-add" onKeyDown={onKey(row.kind)}>
            <NumberUnitInput
              field={row.field}
              label={`${row.label}${row.lead ? ` ${row.lead}` : ''}`}
              expr={exprOf(row.kind)}
              quantity="length"
              units={services.doc.units}
              disabled={assistant || !!ui.editBlock()}
              lead={row.lead ? <span className="cad-delete-add-lead">{row.lead}</span> : undefined}
              validate={(v) => (!(v > 0) ? 'The size must be more than 0' : null)}
              onCommit={(e) => {
                typedRef.current = { ...typedRef.current, [row.kind]: e };
                setTyped(typedRef.current);
              }}
            />
            <Button variant="secondary" data-delete-add={row.kind} disabledReason={blocked ?? (busy ? `Finding the ${busy} of the body` : null)} tip={row.tip} onClick={() => void add(row.kind)}>
              Add
            </Button>
          </div>
        </Field>
      ))}
      {busy ? (
        <div className="cad-p2-sub" data-delete-adding={busy}>
          {`Finding the ${busy} of the body…`}
        </div>
      ) : line ? (
        <div className="cad-p2-sub" data-delete-added={line.ok ? 'ok' : 'none'} role="status">
          <Hint tone={line.ok ? 'muted' : 'warning'}>{line.words}</Hint>
        </div>
      ) : null}
    </div>
  );
}
