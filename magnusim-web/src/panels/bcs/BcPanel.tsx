import { useEffect, useState, type ReactNode } from 'react';
import type { RJSFSchema } from '@rjsf/utils';
import type { BcFamilyRow } from '../../api/registry.gen';
import { canonicalBcType, colorOf, defaultsChoiceText, familiesFor, familyOf } from '../../bcCatalog';
import { SchemaForm } from '../../forms/SchemaForm';
import { dispatchPanelDone, type IslandProps } from '../../islands';
import { faceDisplay, lostDisplay, subscribeFaceNames } from '../../workbench/faceNames';
import { usePluginUiLoaded, useSlotComponent, type BcSettingsProps } from '../../plugin-api/slots';
import {
  bcFlowBasis,
  bcStateNow,
  clearBcFaces,
  createBc,
  deleteBc,
  focusBcFace,
  forgetLostFaces,
  openBc,
  openBcDefaults,
  openBcPicker,
  subscribeBcState,
  unassignBcFace,
  updateBc,
  type BcRecord,
  type BcState,
  type LostFaceEntry,
} from '../legacyBridge';
import { pickSchemaValues, useRegistryReady } from '../scope';

/** The lost entries of a BC record (a linked geometry's update put them there). */
export function lostFacesOf(bc: BcRecord | null | undefined): LostFaceEntry[] {
  const raw = bc ? (bc as { lost_faces?: unknown }).lost_faces : null;
  return Array.isArray(raw) ? (raw.filter((e) => e && typeof e === 'object') as LostFaceEntry[]) : [];
}

/** Why a face is listed as lost, in the user's words. */
export function lostReason(e: LostFaceEntry): string {
  if (e.reason === 'claimed_twice') return 'It merged with a face of another boundary condition: pick it on one of them.';
  if (e.reason === 'held_elsewhere') return 'It is back, but another boundary condition has it now.';
  if (e.reason === 'stale') return 'Saved for an older version of the geometry: pick its faces again.';
  return 'Gone from the geometry. It comes back here if the face does.';
}

/** The record's lost faces, each with Forget (D19). */
function LostFaces({ bc, studyId, onError }: { bc: BcRecord; studyId: string | null; onError: (e: unknown) => void }) {
  const lost = lostFacesOf(bc);
  if (!lost.length) return null;
  return (
    <div className="mat-assign-block" data-bc-lost="1">
      <div className="mat-assign-head">
        <span className="mat-k">Lost faces ({lost.length})</span>
      </div>
      <ul className="mat-assign-list" aria-label="Lost faces">
        {lost.map((e) => (
          <li key={`${e.field}|${e.old}`} className="bc-assign-item" data-lost-face={e.old} data-lost-reason={e.reason}>
            <span className="bc-assign-pick" title={lostReason(e)}>
              {lostDisplay(e)}
            </span>
            <button
              type="button"
              className="mat-clear-link"
              onClick={() =>
                void forgetLostFaces({ study_id: studyId || '', kind: 'bc', id: bc.id, entry: { field: e.field, old: e.old } }).catch(onError)
              }
            >
              Forget
            </button>
          </li>
        ))}
      </ul>
      <div className="mat-assign-hint">{lost.length === 1 ? lostReason(lost[0]) : 'These faces are not on the geometry now. Each one comes back here if its face does.'}</div>
    </div>
  );
}

/**
 * The boundary-condition hub, picker and editor. The types, their hints and
 * colours, and each type's fields come from the BC families the study's
 * analysis offers (registry kind bc_family); a family's own editor is the
 * plugin component its `ui` names ('bc-settings' slot).
 */

/** "Pressure · face 10@Body1"; a family field the study's defaults name shows too ("Wall · Slip · ..."). */
export function bcCardSub(bc: BcRecord, studyDefaults?: Record<string, unknown> | null): string {
  const choice = defaultsChoiceText(bc, studyDefaults);
  const type = String(bc.bc_type || '');
  const faces = (bc.faces || []).map(faceDisplay).join(', ') || 'no faces';
  return choice ? `${type} · ${choice} · ${faces}` : `${type} · ${faces}`;
}

/** Live runtime BC state (records, open BC, its faces, defaults, picker selection). */
export function useBcState(): BcState | null {
  const [state, setState] = useState<BcState | null>(() => bcStateNow());
  useEffect(() => {
    setState(bcStateNow());
    return subscribeBcState(setState);
  }, []);
  return state;
}

/** The families the study's analysis offers; null until the page has the registry. */
function useFamilies(analysisKey: string | undefined): BcFamilyRow[] | null {
  const registry = useRegistryReady();
  return registry ? familiesFor(analysisKey) : null;
}

function report(e: unknown, setNote: (s: string) => void, what: string) {
  setNote(e instanceof Error ? e.message : `${what} failed`);
}

function DoneButton() {
  return (
    <button type="button" className="js-btn tree-panel-done" onClick={() => dispatchPanelDone()}>
      Done
    </button>
  );
}

function BcLegend({ families }: { families: BcFamilyRow[] }) {
  return (
    <div className="bc-legend">
      {families.map((f) => (
        <span key={f.key}>
          <i className={`hub-swatch hub-swatch-${colorOf({ bc_type: f.record_type })}`} /> {f.label}
        </span>
      ))}
    </div>
  );
}

/** Overview: legend, one card per BC (click opens its editor), Defaults, Add. */
export function BcHub() {
  const state = useBcState();
  const families = useFamilies(state?.analysis_key) || [];
  const [note, setNote] = useState('');
  const bcs = state?.bcs || [];
  return (
    <div data-bc-hub="1">
      <div className="sim-def-head">
        <span className="sim-def-title">Boundary conditions</span>
      </div>
      <BcLegend families={families} />
      <p className="mat-assign-hint">Every assigned face is shown on the model, color-coded by type.</p>
      <ul className="hub-list">
        {bcs.length ? (
          bcs.map((bc) => (
            <li key={bc.id}>
              <button type="button" className="hub-item" data-open-bc={bc.id} onClick={() => openBc(bc.id)}>
                <span className="hub-item-main">
                  <span className={`hub-swatch hub-swatch-${colorOf(bc)}`} />
                  <span className="hub-item-name">{bc.name}</span>
                  <span className="hub-item-sub">{bcCardSub(bc, state?.defaults)}</span>
                </span>
              </button>
              <button
                type="button"
                className="hub-item-del"
                data-del-bc={bc.id}
                onClick={() => void deleteBc(bc.id).catch((e) => report(e, setNote, 'Delete'))}
              >
                Delete
              </button>
            </li>
          ))
        ) : (
          <li className="hub-empty">No boundary conditions yet</li>
        )}
      </ul>
      <button type="button" className="hub-item hub-item-defaults" data-bc-defaults="1" onClick={() => openBcDefaults()}>
        <span className="hub-item-main">
          <span className="hub-swatch hub-swatch-default" />
          <span className="hub-item-name">Defaults</span>
          <span className="hub-item-sub">{state?.defaults_summary || 'Unassigned faces: no-slip walls'}</span>
        </span>
      </button>
      <button
        type="button"
        className="js-btn"
        data-bc-open-picker="1"
        onClick={() => openBcPicker()}
      >
        Add boundary condition
      </button>
      {note ? (
        <p className="mat-assign-hint" role="alert">
          {note}
        </p>
      ) : null}
      <div className="sim-def-foot">
        <DoneButton />
      </div>
    </div>
  );
}

/** Choose a type, click faces in the viewport, then Add. Clicking a type never creates anything. */
export function BcPicker() {
  const state = useBcState();
  const families = useFamilies(state?.analysis_key);
  const [selected, setSelected] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const pending = state?.pending_faces || [];
  const family = (families || []).find((f) => f.key === selected) || null;

  async function add() {
    if (!family) return;
    setBusy(true);
    setNote('');
    try {
      await createBc(family.record_type);
    } catch (e) {
      report(e, setNote, 'Add');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-bc-picker="1">
      <div className="sim-def-head">
        <span className="sim-def-title">Boundary conditions</span>
        <button type="button" className="fp-close" aria-label="Close" onClick={() => dispatchPanelDone()}>
          x
        </button>
      </div>
      <button type="button" className="ml-type ml-type-defaults" data-bc-defaults="1" onClick={() => openBcDefaults()}>
        <span className="ml-type-name">Defaults</span>
        <span className="ml-type-sub">{state?.defaults_summary || 'Unassigned faces: no-slip walls'}</span>
      </button>
      <div className="picker-divider" />
      {(families || []).map((f) => (
        <button
          key={f.key}
          type="button"
          className={`ml-type${selected === f.key ? ' is-selected' : ''}`}
          data-bc-key={f.key}
          aria-pressed={selected === f.key}
          onClick={() => setSelected(f.key)}
        >
          <span className="ml-type-name">{f.label}</span>
          {f.hint ? <span className="ml-type-sub">{f.hint}</span> : null}
        </button>
      ))}
      {families === null ? (
        <p className="mat-assign-hint" data-bc-types-loading="1">
          Loading boundary condition types…
        </p>
      ) : !families.length ? (
        <p className="mat-assign-hint" data-bc-types-none="1">
          This simulation&apos;s analysis offers no boundary conditions, or their plugin is off.
        </p>
      ) : null}
      <p className="mat-assign-hint">
        Click a face in the viewport to select it. Add assigns that face to the new boundary condition.
      </p>
      {pending.length ? (
        <p className="mat-assign-hint" data-bc-pending="1">
          Selected: {pending.join(', ')}
        </p>
      ) : null}
      {note ? (
        <p className="mat-assign-hint" role="alert">
          {note}
        </p>
      ) : null}
      <div className="picker-actions">
        <button
          type="button"
          className="js-btn js-btn-kick"
          data-bc-add="1"
          disabled={!family || busy}
          title={family ? `Add a ${family.label} boundary condition` : 'Choose a type first'}
          onClick={() => void add()}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mat-row">
      <span className="mat-k">{label}</span>
      <span className="mat-v">{children}</span>
    </div>
  );
}

function hasFields(family: BcFamilyRow): boolean {
  const props = (family.fields as { properties?: Record<string, unknown> } | null)?.properties;
  return !!props && typeof props === 'object' && Object.keys(props).length > 0;
}

/** The fields a generic form edited that differ from the record. */
function changedFields(values: Record<string, unknown>, bc: BcRecord): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (JSON.stringify(v) !== JSON.stringify(bc[k])) patch[k] = v;
  }
  return patch;
}

/**
 * A BC's own fields: the component its family's `ui` names, else a form from
 * the family's fields, else (no plugin knows its type) a read-only row; the
 * saved fields are kept either way.
 */
function BcFields(props: Omit<BcSettingsProps, 'family'> & { family: BcFamilyRow | undefined }) {
  const { bc, family, save } = props;
  const Slot = useSlotComponent<BcSettingsProps>('bc-settings', family?.ui || undefined);
  const loaded = usePluginUiLoaded();
  if (!family) {
    return (
      <Row label="Settings">
        <span data-bc-plugin-off="1">This boundary condition&apos;s plugin is off</span>
      </Row>
    );
  }
  if (Slot) return <Slot {...props} family={family} />;
  // Its plugin's UI is still loading: never flash the generic form in its place.
  if (family.ui && !loaded) return null;
  if (!hasFields(family)) return null;
  const schema = family.fields as RJSFSchema;
  return (
    <SchemaForm
      schema={schema}
      formData={pickSchemaValues(bc, schema)}
      hideFooter
      onCommit={(values) => {
        const patch = changedFields(values, bc);
        if (Object.keys(patch).length) void save(patch);
      }}
    />
  );
}

/** The line a family's plugin draws under the assigned faces (its 'bc-faces-note'), if any. */
function BcFacesNote(props: BcSettingsProps) {
  const Note = useSlotComponent<BcSettingsProps>('bc-faces-note', props.family.ui || undefined);
  return Note ? <Note {...props} /> : null;
}

/** One BC: type, its values, and the faces assigned by clicking the model. */
export function BcEditor() {
  const state = useBcState();
  const families = useFamilies(state?.analysis_key) || [];
  const [note, setNote] = useState('');
  // A linked geometry's face names arrive with its preview.
  const [, setNamesSeen] = useState(0);
  useEffect(() => subscribeFaceNames(() => setNamesSeen((n) => n + 1)), []);
  const bc = state?.bcs.find((b) => String(b.id) === String(state.active_id)) || null;
  if (!bc || !state) {
    return (
      <div data-bc-editor="1">
        <p className="mat-assign-hint">Open a boundary condition from the tree or the overview.</p>
        <div className="mat-panel-foot foot-end">
          <DoneButton />
        </div>
      </div>
    );
  }
  const id = bc.id;
  const faces = state.draft_faces;
  const family = familyOf(bc);
  const save = (patch: Record<string, unknown>): Promise<void> =>
    updateBc(id, patch as Partial<BcRecord>).then(
      () => undefined,
      (e) => report(e, setNote, 'Save'),
    );
  const typeNow = canonicalBcType(bc.bc_type);
  const typeOptions = families.map((f) => ({ value: String(f.record_type), label: f.label }));
  if (!typeOptions.some((o) => o.value === typeNow)) typeOptions.push({ value: typeNow, label: family?.label || typeNow });
  const slotProps = { bc, imperial: !!state.imperial, faces, save, flowBasis: bcFlowBasis };

  return (
    <div data-bc-editor="1" data-bc-id={id}>
      <div className="mat-panel-head">
        <span className="mat-panel-title" data-bc-title="1">
          {bc.name}
        </span>
      </div>
      <div className="mat-panel-body">
        <Row label="Type">
          <select
            className="bc-select"
            aria-label="Boundary condition type"
            value={typeNow}
            onChange={(e) => void save({ bc_type: e.target.value })}
          >
            {typeOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Row>
        <BcFields {...slotProps} family={family} />
        <div className="mat-assign-block">
          <div className="mat-assign-head">
            <span className="mat-k">Assigned faces ({faces.length})</span>
            <button type="button" className="mat-clear-link" disabled={!faces.length} onClick={() => void clearBcFaces()}>
              Clear list
            </button>
          </div>
          <ul className="mat-assign-list" aria-label="Assigned faces" data-face-picker="1">
            {faces.map((f) => (
              <li key={f} className={`bc-assign-item${state.focus_face === f ? ' is-focus' : ''}`} data-face-id={f}>
                <button type="button" className="bc-assign-pick" onClick={() => focusBcFace(f)}>
                  {faceDisplay(f)}
                </button>
                <button type="button" className="bc-assign-x" aria-label={`Remove ${f}`} onClick={() => unassignBcFace(f)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <div className="mat-assign-hint">Click a face in the viewport to assign it. It highlights when selected.</div>
          {family ? <BcFacesNote {...slotProps} family={family} /> : null}
        </div>
        <LostFaces bc={bc} studyId={state.simulation_id} onError={(e) => report(e, setNote, 'Forget')} />
        {note ? (
          <p className="mat-assign-hint" role="alert">
            {note}
          </p>
        ) : null}
        <div className="mat-panel-foot">
          <button
            type="button"
            className="mat-clear-link"
            title="Delete boundary condition"
            onClick={() => void deleteBc(id).catch((e) => report(e, setNote, 'Delete'))}
          >
            Delete
          </button>
          <DoneButton />
        </div>
      </div>
    </div>
  );
}

/** Registered for the hub, the "+" picker and the editor hosts. */
export function BcPanel(props: IslandProps) {
  if (props.panelId === 'panel-bc-editor') return <BcEditor />;
  if (props.panelId === 'panel-bc-picker') return <BcPicker />;
  return <BcHub />;
}
