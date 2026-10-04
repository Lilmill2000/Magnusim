// The Imported feature's panel (proposal §4.9 step 3): while a file imports,
// its progress (upload percent, then the kernel steps with their seconds) and
// Cancel; then the file, the bodies it made, the diagnostics (problems before
// and after healing, faces in no solid) and Heal all with a tolerance and
// knitting. Heal all writes a new healed BREP from the shapes as read (or the
// stored source) and is part of the panel's one undo step. Done closes.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useState } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { ImportFeature } from '../../types/doc';
import type { FeaturePanelProps } from '../../types/modules';
import { uiFor } from '../../ui/controller';
import { Button, DisabledReason, Field, FieldGroup, Hint, NumberUnitInput } from '../../ui/kit';
import { formatBytes } from '../../files/words';
import { P2FeaturePanel, Switch, useFeaturePanel } from '../p2/panel';
import { DEFAULT_HEAL_TOLERANCE, type StageProgress } from './pipeline';
import { importRunsFor } from './runs';

const pct = (p: StageProgress) => (p.total ? `${Math.min(100, Math.floor(((p.done ?? 0) / p.total) * 100))}%` : '');
const secs = (p: StageProgress, now: number) => `${Math.max(0, Math.floor((now - p.since) / 1000))} s`;

/** "30 ms", "1.2 s" (a time under a second reads in ms, not "0.0 s"). */
export function msWords(ms: number): string {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "Uploading flange.step · 45%", "Reading flange.step · 12 s". */
export function stageWords(p: StageProgress, fileName: string, now: number): string {
  switch (p.stage) {
    case 'hashing':
      return `Checking ${fileName}`;
    case 'uploading':
      return `Uploading ${fileName} · ${pct(p) || '0%'}`;
    case 'reading':
      return `Reading ${fileName} · ${secs(p, now)}`;
    case 'healing':
      return `Healing · ${secs(p, now)}`;
    case 'writing':
      return `Writing the healed shapes · ${secs(p, now)}`;
    case 'storing':
      return `Storing the healed shapes · ${pct(p) || '0%'}`;
    case 'loading':
      return `Loading ${fileName} · ${pct(p) || '0%'}`;
  }
}

/**
 * What the diagnostics say in one line ("0 problems", "3 problems found · 0 left
 * after healing"); "· not a closed solid" when faces are in no solid or edges
 * are open (review P2/P3 round 1: "0 problems" sat above "6 faces not in a
 * solid" and "8 edges are still open").
 */
export function diagnosticsLine(f: ImportFeature, healedOnRead: boolean, open = false): string {
  const d = f.diagnostics;
  if (!d) return 'Not checked';
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const tail = open ? ' · not a closed solid' : '';
  if (healedOnRead || d.problemsBefore === d.problemsAfter) return `${n(d.problemsAfter, 'problem', 'problems')}${tail}`;
  return `${n(d.problemsBefore, 'problem', 'problems')} found · ${d.problemsAfter} left after healing${tail}`;
}

function Progress({ p, fileName, onCancel, cancelLabel }: { p: StageProgress; fileName: string; onCancel(): void; cancelLabel: string }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), 500);
    return () => clearInterval(t);
  }, []);
  const byteStage = p.total != null;
  const width = byteStage && p.total ? `${Math.min(100, ((p.done ?? 0) / p.total) * 100)}%` : undefined;
  return (
    <div className="cad-progress" data-import-progress={p.stage} role="status" aria-live="polite">
      <div className="cad-progress-line">
        <span data-import-stage="1">{stageWords(p, fileName, now)}</span>
        <Button variant="secondary" onClick={onCancel} data-import-cancel="1">
          {cancelLabel}
        </Button>
      </div>
      <div className={`cad-progress-track${byteStage ? '' : ' is-busy'}`}>
        <div className="cad-progress-bar" style={width ? { width } : undefined} />
      </div>
    </div>
  );
}

export function ImportPanel(props: FeaturePanelProps) {
  const services = useServices();
  const ui = uiFor(services);
  const kit = useFeaturePanel<ImportFeature>(props);
  const runs = importRunsFor(services);
  const run = useStateStore(runs.state, (s) => s.runs[props.feature] ?? null);
  const bodies = useStateStore(services.doc.state, (s) => s.rebuild.bodies);
  const defs = useStateStore(services.doc.state, (s) => s.doc.bodies);
  const output = useStateStore(services.doc.state, (s) => s.rebuild.outputs[props.feature] ?? null);
  const units = services.doc.units;
  const f = kit.draft;
  const done = !!f.brep?.rel && f.items.length > 0;
  const shells = f.items.filter((it) => it.kind === 'shell').length;
  // Faces in no solid now: those of the surface bodies the import makes (after a knit, none; it said
  // "6 faces not in a solid" from the first read even after knitting had made the solid).
  const looseNow = f.items.filter((it) => it.kind === 'shell').reduce((n, it) => n + (bodies.find((b) => b.id === it.body)?.faces ?? 0), 0);
  const [tolExpr, setTolExpr] = useState(() => `${f.heal?.tolerance ?? DEFAULT_HEAL_TOLERANCE} mm`);
  const [tol, setTol] = useState<number>(f.heal?.tolerance ?? DEFAULT_HEAL_TOLERANCE);
  const [knit, setKnit] = useState<boolean>(f.heal?.sew || shells > 0 || (run?.outcome?.looseFaces ?? 0) > 0);
  useEffect(() => {
    // Knitting is the obvious next step once surface bodies show up.
    if (shells > 0) setKnit(true);
  }, [shells]);
  const busy = !!run?.progress;
  const healing = busy && done;
  const outcome = run?.outcome ?? null;
  // Faces in no solid, or edges still open: the body is not a closed solid.
  const open = looseNow > 0 || shells > 0 || (f.diagnostics?.freeEdges ?? 0) > 0;

  const extraFoot = [];
  if (run?.error) extraFoot.push(<DisabledReason key="run-error">{run.error}</DisabledReason>);

  const fileLine = f.source?.fileName ? `${f.source.fileName}${f.source.size ? ` · ${formatBytes(f.source.size)}` : ''}` : '';

  return (
    <P2FeaturePanel
      props={props}
      kit={kit}
      extraFoot={extraFoot}
      quietIncomplete
      doneDisabled={busy ? (done ? 'Wait for Heal all to finish, or Cancel it' : `Wait for ${f.source.fileName} to finish importing, or Cancel it`) : run?.error && !done ? null : undefined}
    >
      {fileLine ? (
        <Field label="File" field="file">
          <span className="cad-p2-readout" data-import-file="1">
            {fileLine}
          </span>
        </Field>
      ) : null}
      {f.source?.unit ? (
        <Field label="Length unit" field="unit">
          <span data-import-unit="1">{f.source.unit}</span>
        </Field>
      ) : null}
      {run?.progress ? (
        <Progress
          p={run.progress}
          fileName={f.source.fileName || run.fileName}
          cancelLabel="Cancel"
          onCancel={() => {
            if (!done && props.isNew) ui.deletePanelFeature();
            else runs.stop(props.feature);
          }}
        />
      ) : null}
      {done ? (
        <>
          <FieldGroup title={`Bodies (${f.items.length})`}>
            <table className="cad-p2-table" data-import-bodies="1">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th className="num">Faces</th>
                  <th>Check</th>
                </tr>
              </thead>
              <tbody>
                {f.items.map((it) => {
                  const b = bodies.find((x) => x.id === it.body);
                  // Before the rebuild has made the body: the kernel's count from this import or heal.
                  const counted = b ? b.faces : (outcome?.faceCounts?.[it.index] ?? null);
                  return (
                    <tr key={it.body} data-import-body={it.body}>
                      <td>
                        <span className="cad-swatch" style={{ background: defs[it.body]?.color ?? it.stepColor ?? undefined }} aria-hidden="true" /> {defs[it.body]?.name ?? it.stepName}
                      </td>
                      <td>{it.kind === 'solid' ? 'Solid' : 'Surface'}</td>
                      {/* The count from the import itself, then the rebuilt body's; "…" only for a Part opened
                          again before its rebuild has made the body (the 113 MB part's cell was blank once). */}
                      <td className="num" title={counted != null ? undefined : 'Counted when the part is rebuilt'} data-import-faces={it.body}>
                        {counted != null ? counted.toLocaleString('en-US') : '…'}
                      </td>
                      {/* A surface body passes the shape check but closes no solid: it reads Open, not Valid. */}
                      <td className={!it.valid ? 'cad-p2-bad' : it.kind === 'shell' ? 'cad-p2-warn' : 'cad-p2-ok'} title={it.reason ?? (it.kind === 'shell' && it.valid ? 'No shape errors, but the faces do not close a solid' : undefined)} data-import-check={it.body}>
                        {!it.valid ? 'Not valid' : it.kind === 'shell' ? 'Open' : 'Valid'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </FieldGroup>
          <FieldGroup title="Diagnostics">
            <div className={`cad-p2-readout${open ? ' cad-p2-warn' : ''}`} data-import-diagnostics="1">
              {diagnosticsLine(f, !!outcome?.healedOnRead || !!f.diagnostics?.healedOnRead, open)}
            </div>
            {outcome?.healedOnRead || f.diagnostics?.healedOnRead ? <Hint>Large file: healed while it was read.</Hint> : null}
            {/* What healing changed is said by what a user sees change: the problems found and left (the line
                above), faces knit, edges still open, faces not in a solid. ShapeFix's own count of shapes it
                touched is not shown: it counts changes no one can see (review P2/P3 round 4: "Healing changed 1
                shape" beside "0 problems" on a clean flange read as a contradiction). */}
            {looseNow > 0 ? (
              <div className="cad-p2-warn" data-import-loose="1">
                {looseNow === 1 ? '1 face' : `${looseNow} faces`} not in a solid
              </div>
            ) : null}
            {shells > 0 ? (
              <div className="cad-p2-warn" data-import-shells="1">
                {/* Knit already tried at this tolerance: the advice is a larger one (it still said "knit ... with Heal all"). */}
                {shells === 1 ? '1 surface body' : `${shells} surface bodies`}
                {f.heal?.sew ? `: the faces did not knit at ${units.format(f.heal.tolerance, 'length')}: raise the tolerance and Heal all again` : ': knit the faces into solids with Heal all'}
              </div>
            ) : null}
            {f.diagnostics?.sewn ? <Hint>{f.diagnostics.sewn === 1 ? '1 face was' : `${f.diagnostics.sewn} faces were`} knit.</Hint> : null}
            {f.diagnostics?.freeEdges ? <Hint>{f.diagnostics.freeEdges === 1 ? '1 edge is' : `${f.diagnostics.freeEdges} edges are`} still open.</Hint> : null}
            {outcome && outcome.problemsAfter.length ? (
              <>
                <div className="cad-p2-sub">Left after healing</div>
                <ul className="cad-p2-problems" data-import-problems="after">
                  {outcome.problemsAfter.map((p, i) => (
                    <li key={i}>
                      {p.body}: {p.status}
                      {p.where ? ` · ${p.where}` : ''}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {outcome && outcome.problemsBefore.length ? (
              <>
                <div className="cad-p2-sub">Found when read</div>
                <ul className="cad-p2-problems" data-import-problems="before">
                  {outcome.problemsBefore.map((p, i) => (
                    <li key={i}>
                      {p.body}: {p.status}
                      {p.where ? ` · ${p.where}` : ''}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </FieldGroup>
          <FieldGroup title="Heal">
            <Field label="Tolerance" htmlFor={`cad-imp-${props.feature}-tol`} field="tolerance">
              <NumberUnitInput
                id={`cad-imp-${props.feature}-tol`}
                field="tolerance"
                label="Tolerance"
                expr={tolExpr}
                quantity="length"
                units={units}
                validate={(v) => (v >= 1e-7 && v <= 1 ? null : 'Tolerance must be between 0.0000001 mm and 1 mm')}
                onCommit={(e, v) => {
                  setTolExpr(e);
                  setTol(v);
                }}
              />
            </Field>
            <div className="cad-field">
              <Switch field="knit" label="Knit faces into solids" checked={knit} onChange={setKnit} disabledReason={busy ? 'Wait for the current step' : null} />
            </div>
            <div className="cad-p2-actions">
              <Button variant="secondary" data-import-heal="1" disabledReason={busy ? 'Wait for the current step' : (ui.editBlock() ?? null)} onClick={() => void runs.healAll(props.session, tol, knit)}>
                Heal all
              </Button>
              {/* Only when healing had something to do (UX review: "Healed at 0.001 mm" beside "0 problems"). */}
              {f.heal.sew || (f.diagnostics?.problemsBefore ?? 0) > 0 || (f.diagnostics?.problemsAfter ?? 0) > 0 || (f.diagnostics?.sewn ?? 0) > 0 ? (
                <span className="cad-p2-sub" data-import-healed="1">
                  Healed at {units.format(f.heal.tolerance, 'length')}
                  {f.heal.sew ? ', knit' : ''}
                </span>
              ) : null}
            </div>
            {/* How the shapes were loaded, for a Part opened again; not right after this panel imported or healed them. */}
            {healing || outcome ? null : output && output.type === 'import' ? (
              <Hint>
                <span data-import-output={output.from}>
                  {output.from === 'brep' ? 'Loaded from the stored healed shapes' : 'Healed again from the stored STEP'} in {msWords(output.ms)}
                </span>
              </Hint>
            ) : null}
          </FieldGroup>
        </>
      ) : null}
    </P2FeaturePanel>
  );
}
