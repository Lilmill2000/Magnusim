// The Extrude panel (flyout, PanelChrome; proposal §3.1, ARCHITECTURE §7):
//   Profiles   the regions it extrudes (a click on a shaded region in the
//              view adds or removes one; x removes; hover shows it in the
//              view), each with its area, "repaired" or "lost"
//              P4a: or one flat face of a body (Daniel's item 8: a click on a
//              flat face while no profile is picked), extruded with no sketch
//   Direction  Extent Blind / Symmetric / Two sides / Through all (Both sides) /
//              Up to (a flat face or a vertex, and an Offset); Distance (and
//              Distance 2); Flip direction; the arrow in the view drags the distance
//   Operation  New body / Join / Cut / Intersect, once a body is made before
//              it in history (or when it is not New body, so it can go back)
// Every valid change applies live (the body is the preview); Done closes;
// Delete removes it (a new one: discards it); errors in the foot with their fix.
// Owner: P3-PROFILES (src/features/extrude/).
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import { FEATURE_ACTION_LABELS, type BodyOp, type BodyRef, type ExtrudeExtentDef, type ExtrudeFeature, type Feature, type RegionRef } from '../../types/doc';
import { describeFace } from '../../naming';
import { Switch } from '../p2/panel';
import { featureNameOf, SelectionMirror, useAxisField, useTargetField } from '../solids/fields';
import { usePicksLines } from '../solids/view';
import type { FeaturePanelProps } from '../../types/modules';
import type { DocUnits, Expr } from '../../types/units';
import { errText, uiFor } from '../../ui/controller';
import { usePanelDelete, usePanelDeleteBlock } from '../../ui/panel-delete';
import { DisabledReason, displayOf, Field, FieldGroup, Hint, NumberUnitInput, PanelChrome, Select } from '../../ui/kit';
import { formatReadout, MM_PER } from '../../ui/kit/format';
import { MIN_SIZE_MM } from '../../doc/features/primitives';
import { overlayColors } from '../sketch/colors';
import { drawnSketches, profilesView, sketchOutput } from '../sketch/view';
import { handleGeometry, startPanelTool } from './handle';
import { entityParents, PROFILE_REPAIRED, resolveRegionRef } from './profiles';

const OPS: { value: BodyOp; label: string }[] = [
  { value: 'new', label: 'New body' },
  { value: 'join', label: 'Join' },
  { value: 'cut', label: 'Cut' },
  { value: 'intersect', label: 'Intersect' },
];

const EXTENTS: { value: ExtrudeExtentDef['kind']; label: string }[] = [
  { value: 'blind', label: 'Blind' },
  { value: 'symmetric', label: 'Symmetric' },
  { value: 'two', label: 'Two sides' },
  { value: 'through_all', label: 'Through all' },
  { value: 'to', label: 'Up to' },
];

/** "1,256.64 mm²" in the document's length unit. */
export function formatArea(mm2: number, units: DocUnits): string {
  const per = MM_PER[units.length];
  return `${formatReadout(mm2 / (per * per))} ${units.length}²`;
}

/** Each profile as the panel lists it: found (exact or repaired) with its area, or lost. */
export function profileRows(f: ExtrudeFeature, s: Parameters<typeof sketchOutput>[0] & { doc: { features: Feature[] } }) {
  const sketchId = f.profiles[0]?.sketch;
  const out = sketchId ? sketchOutput(s, sketchId) : null;
  const sketch = s.doc.features.find((g) => g.id === sketchId);
  const parents = entityParents(sketch && sketch.type === 'sketch' ? sketch.entities : []);
  return f.profiles.map((p: RegionRef, i) => {
    const r = out ? resolveRegionRef(p, out.regions, parents) : ({ ok: false } as const);
    return { i, ref: p, ok: r.ok, key: r.ok ? r.key : null, repaired: r.ok && r.how === 'repaired', area: r.ok ? r.region.area : null };
  });
}

export function ExtrudePanel({ session, feature, isNew }: FeaturePanelProps) {
  const services = useServices();
  const ui = uiFor(services);
  const onDelete = usePanelDelete(services, feature, isNew);
  const deleteBlock = usePanelDeleteBlock(services, feature, isNew);
  const { doc } = services;
  const stored = useStateStore(doc.state, (s) => (s.doc.features.find((f) => f.id === feature) ?? null) as ExtrudeFeature | null);
  const status = useStateStore(doc.state, (s) => s.rebuild.features[feature] ?? null);
  const bodiesBefore = useStateStore(doc.state, (s) => {
    const st = s.rebuild.features[feature];
    if (st && typeof st.bodiesBefore === 'number') return st.bodiesBefore;
    const idx = s.doc.features.findIndex((f) => f.id === feature);
    const above = idx >= 0 ? s.doc.features.slice(0, idx) : s.doc.features.slice(0, s.view.rollback ?? s.doc.features.length);
    const makesBody = (f: Feature) => ('op' in f ? f.op === 'new' : f.type === 'import' || f.type === 'split');
    return above.filter((f) => makesBody(f) && !f.suppressed && (s.rebuild.features[f.id]?.state === 'ok' || s.rebuild.features[f.id]?.state === 'warning')).length;
  });
  const units = useStateStore(doc.state, (s) => s.doc.units);
  useStateStore(doc.state, (s) => s.doc.params);
  const rebuildSeq = useStateStore(doc.state, (s) => s.rebuild.seq);
  const outputs = useStateStore(doc.state, (s) => s.rebuild.outputs);
  const note = useStateStore(ui.state, (s) => s.panelNote);
  const handle = useStateStore(services.viewport, (s) => s.handle);
  const [, setTick] = useState(0);
  const tool = useRef<ReturnType<typeof startPanelTool> | null>(null);
  /** Flip direction was ticked here because Cut or Intersect was picked (flipForOp). */
  const autoFlipped = useRef(false);

  const draft = (session.open ? session.draft : (stored ?? session.draft)) as ExtrudeFeature;
  /** Up to's pick list takes viewport clicks (it is active while it waits for its face or vertex). */
  const [targetActive, setTargetActive] = useState(false);
  const toTarget = draft.extent.kind === 'to' ? draft.extent.target : null;
  const waitingTarget = draft.extent.kind === 'to' && !toTarget;
  const target = useTargetField(services, {
    feature,
    value: toTarget,
    active: draft.extent.kind === 'to' && (targetActive || waitingTarget),
    onChange: (t: BodyRef | null) => {
      const e = draft.extent;
      if (e.kind !== 'to') return;
      const refused = update({ extent: { ...e, target: t } } as Partial<Feature>);
      if (refused) ui.setPanelNote(refused);
      else setTargetActive(!t);
    },
  });

  /** The optional direction (an axis) takes viewport clicks only after its box is clicked. */
  const [dirActive, setDirActive] = useState(false);
  const direction = useAxisField(services, {
    feature,
    value: draft.direction ?? null,
    active: dirActive,
    empty: 'Normal to the profile',
    planes: true,
    onChange: (a) => {
      const refused = update({ direction: a } as Partial<Feature>);
      if (refused) ui.setPanelNote(refused);
      setDirActive(false);
    },
  });
  usePicksLines(services, direction.lines);
  const rows = profileRows(draft, { rebuild: { ...doc.state.get().rebuild, outputs }, doc: doc.state.get().doc });
  const sketchId = draft.profiles[0]?.sketch ?? null;
  // Is any profile on show to click? (A sketch an extrude uses is hidden until its eye shows it.)
  const mode = useStateStore(services.mode, (m) => m.mode);
  const view = useStateStore(profilesView(services));
  useStateStore(doc.state, (s) => s.view.sketches);
  const pickable = drawnSketches(doc.state.get(), mode, view, doc.features).some((d) => d.output.regions.length > 0);
  const sketchName = sketchId ? (doc.state.get().doc.features.find((f) => f.id === sketchId)?.name ?? 'a deleted sketch') : null;

  const update = (patch: Partial<Feature>): string | null => {
    const block = ui.editBlock();
    if (block) return block;
    if (!session.open) return 'This panel is no longer editing the feature';
    try {
      session.update(patch);
    } catch (err) {
      return `${isNew ? 'Create' : 'Edit'} failed: ${errText(err)}`;
    }
    setTick((n) => n + 1);
    if (note) ui.setPanelNote(null);
    return null;
  };

  // The view: this extrude's profiles drawn as picked, its sketch shown, and it does not hide the sketch it picks from.
  const usedKey = rows.map((r) => r.key ?? '').join('\n');
  useEffect(() => {
    const view = profilesView(services);
    view.set({
      used: rows.flatMap((r) => (r.key && sketchId ? [{ feature: sketchId, key: r.key }] : [])),
      forced: sketchId ? [sketchId] : [],
      ignoreUser: feature,
    });
  }, [usedKey, sketchId, feature]);
  useEffect(
    () => () => {
      profilesView(services).set({ used: [], forced: [], ignoreUser: null, hover: null });
    },
    [],
  );

  // The pointer tool (profile clicks, the distance arrow) for as long as the panel is open.
  useEffect(() => {
    if (!handle || typeof handle.pushTool !== 'function') return;
    const t = startPanelTool(services, handle, { session, note: (text) => ui.setPanelNote(text), color: overlayColors().under });
    tool.current = t;
    return () => {
      t.stop();
      tool.current = null;
    };
  }, [handle, session]);
  useEffect(() => {
    tool.current?.refresh();
  });
  void rebuildSeq;

  // A new extrude seen straight along its direction (right after Finish sketch the view still looks
  // at the sketch): its arrow would point at the viewer and its depth would not show, so the view
  // turns to Isometric once, as SOLIDWORKS turns to trimetric (review P2/P3 round 2).
  const turned = useRef(false);
  useEffect(() => {
    if (!isNew || turned.current || !handle || typeof handle.camera !== 'function') return;
    const g = handleGeometry(draft, services);
    if (!g) return;
    turned.current = true;
    const c = handle.camera();
    const d = [c.target[0] - c.position[0], c.target[1] - c.position[1], c.target[2] - c.position[2]];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    if (Math.abs((d[0] * g.axis[0] + d[1] * g.axis[1] + d[2] * g.axis[2]) / len) > Math.cos((25 * Math.PI) / 180)) handle.setView('iso');
  });

  let incomplete: string | null = null;
  try {
    incomplete = session.incomplete();
  } catch (err) {
    incomplete = errText(err);
  }
  const doneDisabled = isNew && incomplete ? incomplete : null;

  const fieldErrors: string[] = [];
  const unitsSvc = doc.units;
  const distanceField = (key: 'distance' | 'distance2', label: string, expr: Expr, validate: (v: number) => string | null) => {
    const id = `cad-f-${feature}-${key}`;
    const storedError = displayOf(expr, 'length', unitsSvc).error;
    if (storedError) fieldErrors.push(storedError);
    return (
      <Field key={key} label={label} htmlFor={id} field={key}>
        <NumberUnitInput
          id={id}
          field={key}
          label={label}
          expr={expr}
          quantity="length"
          units={unitsSvc}
          validate={validate}
          onCommit={(e) => update({ extent: { ...draft.extent, [key]: e } as ExtrudeExtentDef } as Partial<Feature>)}
        />
      </Field>
    );
  };

  const ext = draft.extent;
  const otherMm = (key: 'distance' | 'distance2'): number | null => {
    if (ext.kind !== 'two') return null;
    const r = unitsSvc.evaluate(key === 'distance' ? ext.distance2 : ext.distance, 'length');
    return r.ok ? r.value : null;
  };
  const offsetId = `cad-f-${feature}-offset`;
  const extentFields =
    ext.kind === 'through_all'
      ? [
          <Switch
            key="both"
            field="both"
            label="Both sides"
            checked={!!ext.both}
            onChange={(v) => {
              const refused = update({ extent: { ...ext, both: v } } as Partial<Feature>);
              if (refused) ui.setPanelNote(refused);
            }}
          />,
        ]
      : ext.kind === 'to'
        ? [
            <div key="target">{target.element('Up to', 'target', () => setTargetActive(true), 'Click a flat face or a vertex in the view: the extrude ends on its plane')}</div>,
            <Field key="offset" label="Offset" htmlFor={offsetId} field="offset">
              <NumberUnitInput id={offsetId} field="offset" label="Offset" expr={ext.offset} quantity="length" units={unitsSvc} onCommit={(e) => update({ extent: { ...ext, offset: e } } as Partial<Feature>)} />
            </Field>,
          ]
        : ext.kind === 'blind'
      ? [distanceField('distance', 'Distance', ext.distance, (v) => (v === 0 ? 'Distance must not be 0' : Math.abs(v) < MIN_SIZE_MM ? 'Distance must be at least 0.000001 mm' : null))]
      : ext.kind === 'symmetric'
        ? [distanceField('distance', 'Total distance', ext.distance, (v) => (!(v > 0) ? 'Distance must be more than 0' : v < MIN_SIZE_MM ? 'Distance must be at least 0.000001 mm' : null))]
        : [
            distanceField('distance', 'Distance 1', ext.distance, (v) => (otherMm('distance') != null && v + (otherMm('distance') as number) === 0 ? 'The two distances must not add up to 0' : null)),
            distanceField('distance2', 'Distance 2', ext.distance2, (v) => (otherMm('distance2') != null && v + (otherMm('distance2') as number) === 0 ? 'The two distances must not add up to 0' : null)),
          ];

  const setExtentKind = (kind: ExtrudeExtentDef['kind']) => {
    if (kind === ext.kind) return;
    let distance = ext.distance;
    // A blind extrude the other way ("-25 mm") becomes a symmetric one of that length.
    const now = unitsSvc.evaluate(distance, 'length');
    if (kind === 'symmetric' && now.ok && now.value < 0 && /^\s*-/.test(distance)) distance = distance.replace(/^\s*-\s*/, '');
    const next: ExtrudeExtentDef =
      kind === 'two'
        ? { kind, distance, distance2: ext.kind === 'two' ? ext.distance2 : distance }
        : kind === 'through_all'
          ? { kind, distance, both: ext.kind === 'through_all' ? ext.both : false }
          : kind === 'to'
            ? { kind, distance, target: ext.kind === 'to' ? ext.target : null, offset: ext.kind === 'to' ? ext.offset : `0 ${unitsSvc.units().length}` }
            : { kind, distance };
    const refused = update({ extent: next } as Partial<Feature>);
    if (refused) ui.setPanelNote(refused);
  };

  const removeProfile = (i: number) => {
    const next = draft.profiles.filter((_, k) => k !== i);
    const refused = update({ profiles: next } as Partial<Feature>);
    if (refused) ui.setPanelNote(refused);
    profilesView(services).set({ hover: null });
  };

  /**
   * A sketch on a face: Cut and Intersect go into the body, as SOLIDWORKS' Extruded Cut does,
   * so picking one turns a blind extrude that points out of the face round (the face's outward
   * normal is the sketch's); going back to New body or Join turns it back if that was done
   * here. Review P2/P3 round 4: Cut said "Nothing to cut" until Flip direction was ticked.
   */
  const flipForOp = (op: BodyOp): { flip?: boolean } => {
    const sk = sketchId ? doc.state.get().doc.features.find((f) => f.id === sketchId) : null;
    if (!sk || sk.type !== 'sketch' || sk.support?.kind !== 'face' || ext.kind !== 'blind') return {};
    const d = unitsSvc.evaluate(ext.distance, 'length');
    if (!d.ok || d.value === 0) return {};
    const outward = d.value > 0 !== !!draft.flip;
    const into = op === 'cut' || op === 'intersect';
    if (into && outward) {
      autoFlipped.current = true;
      return { flip: !draft.flip };
    }
    if (!into && !outward && autoFlipped.current) {
      autoFlipped.current = false;
      return { flip: !draft.flip };
    }
    return {};
  };

  const opRow =
    bodiesBefore > 0 || draft.op !== 'new' || (stored != null && stored.op !== 'new') ? (
      <Field label="Operation" htmlFor={`cad-f-${feature}-op`} field="op">
        <Select
          id={`cad-f-${feature}-op`}
          label="Operation"
          field="op"
          value={draft.op}
          onChange={(v) => {
            const op = v as BodyOp;
            const refused = update({ op, ...flipForOp(op) } as Partial<Feature>);
            if (refused) ui.setPanelNote(refused);
          }}
          options={OPS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </Field>
    ) : null;

  const fname = featureNameOf(services);
  const faceWords = draft.face ? describeFace(draft.face.ref.name, fname, services.doc.state.get().rebuild.bodies.find((b) => b.id === draft.face!.body)?.names?.faces ?? null) : '';
  const faceRow = draft.face ? (
    <li className="bc-assign-item" data-profile="face" data-profile-state={status?.state === 'error' && /not found on|no longer flat/.test(status.message ?? '') ? 'lost' : 'ok'}>
      <span className="cad-profile-name" title={faceWords}>
        {faceWords}
      </span>
      <span className="mat-assign-state">flat face</span>
      <button
        type="button"
        className="bc-assign-x"
        aria-label="Remove the face"
        data-profile-remove="face"
        onClick={() => {
          const refused = update({ face: null } as Partial<Feature>);
          if (refused) ui.setPanelNote(refused);
        }}
      >
        ×
      </button>
    </li>
  ) : null;
  const body = (
    <>
      <FieldGroup title={draft.face ? 'Profile (a flat face)' : sketchName ? `Profiles (${sketchName})` : 'Profiles'}>
        <ul className="mat-assign-list cad-profile-list" data-profile-list="1" aria-label="Profiles">
          {faceRow}
          {rows.map((r) => (
            <li
              key={`${r.i}:${r.ref.region}`}
              className={`bc-assign-item${r.ok ? '' : ' is-lost'}${r.repaired ? ' is-repaired' : ''}`}
              data-profile={r.i}
              data-profile-state={r.ok ? (r.repaired ? 'repaired' : 'ok') : 'lost'}
              onMouseEnter={() => r.key && sketchId && profilesView(services).set({ hover: { feature: sketchId, key: r.key } })}
              onMouseLeave={() => profilesView(services).set({ hover: null })}
            >
              <span className="cad-profile-name">Profile {r.i + 1}</span>
              <span className="mat-assign-state" data-profile-area={r.area ?? undefined}>
                {r.ok ? (r.repaired ? `repaired · ${formatArea(r.area as number, units)}` : formatArea(r.area as number, units)) : 'lost'}
              </span>
              <button type="button" className="bc-assign-x" aria-label={`Remove profile ${r.i + 1}`} data-profile-remove={r.i} onClick={() => removeProfile(r.i)}>
                ×
              </button>
            </li>
          ))}
        </ul>
        <Hint>
          {draft.face
            ? 'The face is extruded along its outward normal (Flip direction: into the body)'
            : rows.length
              ? 'Click shaded regions in the view to add or remove profiles'
              : pickable
                ? services.doc.state.get().rebuild.bodies.length
                  ? 'No profiles yet: click a shaded region of a sketch, or a flat face of a body, in the view'
                  : 'No profiles yet: click a shaded region of a sketch in the view'
                : services.doc.state.get().rebuild.bodies.length
                  ? 'No profiles yet: click a flat face of a body in the view (the sketches with closed profiles are hidden; show one with its eye in the tree)'
                  : 'No profiles yet: the sketches with closed profiles are hidden; show one with its eye in the tree'}
        </Hint>
      </FieldGroup>
      <FieldGroup title="Direction">
        <Field label="Extent" htmlFor={`cad-f-${feature}-extent`} field="extent">
          <Select id={`cad-f-${feature}-extent`} label="Extent" field="extent" value={ext.kind} onChange={(v) => setExtentKind(v as ExtrudeExtentDef['kind'])} options={EXTENTS.map((o) => ({ value: o.value, label: o.label }))} />
        </Field>
        {extentFields}
        {direction.element('Along', 'direction', () => setDirActive(true), 'Click a line or centerline, a straight edge, an axis, or a plane or flat face (its normal), in the view or the tree, to extrude along it; remove it to go along the normal again')}
        <Field label="Flip direction" htmlFor={`cad-f-${feature}-flip`} field="flip">
          <input
            id={`cad-f-${feature}-flip`}
            type="checkbox"
            className="cad-check"
            data-field="flip"
            checked={!!draft.flip}
            onChange={(e) => {
              const refused = update({ flip: e.target.checked } as Partial<Feature>);
              if (refused) ui.setPanelNote(refused);
              // The user's own choice from now on: changing the Operation no longer turns it back.
              else autoFlipped.current = false;
            }}
          />
        </Field>
      </FieldGroup>
      {opRow}
      {/* Up to's face or vertex shown picked (only then: the mirror takes over the selection). */}
      {draft.extent.kind === 'to' ? <SelectionMirror items={target.highlight} /> : null}
    </>
  );

  const saidByField = (msg: string | null | undefined) => !!msg && fieldErrors.some((e) => msg === e || msg.endsWith(`: ${e}`));
  const pending = stored != null && JSON.stringify(draft) !== JSON.stringify(stored);
  const foot = [];
  if (note) foot.push(<DisabledReason key="note">{note}</DisabledReason>);
  if (status?.state === 'error' && !(saidByField(status.message) && !status.actions?.length)) {
    const fixes = (status.actions ?? []).map((a) => ({ label: FEATURE_ACTION_LABELS[a], run: () => ui.runFeatureAction(feature, a) }));
    foot.push(
      <DisabledReason key="error" fixes={fixes}>
        {status.message || `${draft.name} failed`}
      </DisabledReason>,
    );
  } else if (status?.state === 'warning' && status.message) {
    foot.push(
      <div key="warning" role="status" data-warning={status.message.includes(PROFILE_REPAIRED) ? 'profile-repaired' : '1'}>
        <Hint tone="warning">{status.message}</Hint>
      </div>,
    );
  }
  if (incomplete && isNew) {
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
        const why = ui.renameFeature(feature, next);
        if (!why) setTick((n) => n + 1);
        return why;
      }}
      onRenameGiveUp={(why) => ui.setPanelNote(`Rename failed: ${why}`)}
      renameLabel="feature"
      onDone={() => ui.closePanel()}
      doneDisabled={doneDisabled}
      onDelete={onDelete}
      deleteBlock={deleteBlock}
      foot={foot.length ? foot : null}
    >
      <div data-feature-panel="extrude" data-feature-id={feature} data-new={isNew ? '1' : '0'}>
        {body}
      </div>
    </PanelChrome>
  );
}
