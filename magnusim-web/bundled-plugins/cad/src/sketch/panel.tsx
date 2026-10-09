// The Sketch panel (flyout, PanelChrome with the blue sketch accent) shown
// while a sketch is edited: its plane, its definition state, what the active
// tool expects next, what is selected (Construction, Delete), the constraints
// that over-define it with a one-click delete each, and Done (= Finish sketch).
// Delete discards a new sketch or removes an existing one (refused, with the
// reason in the foot, while a later feature uses it). Also the in-frame
// "Make it driven?" question when a new dimension would over-define the sketch.
// ux010 (Daniel 2026-10-07: "only show the absolutely necessary information. So if I adjust the
// dimension, it could just show that dimension there"): compact unless Details is open (remembered,
// src/ui/left-rails.ts). Compact shows the head (name, state dot and words, the collapse chevron),
// the tool's hint and its own inputs, the dimension being edited or just placed, the pattern made
// in this sketch or the one selected, notes, and every problem (a failed sketch, a warning, the
// constraints that over-define it, a lost reference): never hidden. Details adds the plane, the
// selection with its actions, every pattern, the references and the tips. The head's chevron
// collapses the panel sideways into its rail (src/sketch/rail.tsx; remembered too).
// Owner: P3-SKETCH; compact and rail ux010 PANELS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from 'react';
import { trapDialogKeys } from '../lib/modal';
import { useServices } from '../lib/services';
import { useStateStore } from '../lib/store';
import { FEATURE_ACTION_LABELS, ORIGIN_PLANES, type SketchFeature } from '../types/doc';
import type { FeaturePanelProps } from '../types/modules';
import type { SketchOutput } from '../types/sketch';
import { uiFor } from '../ui/controller';
import { Icon } from '../ui/Icon';
import { usePanelDelete, usePanelDeleteBlock } from '../ui/panel-delete';
import { Button, buttonClass, DisabledReason, Field, Hint, PanelChrome, useTip } from '../ui/kit';
import { RAIL_SHORTCUT, railsFor, useRailFocus } from '../ui/left-rails';
import { CHEVRON_LEFT } from '../ui/tree/TreeRail';
import { statusText } from './dof';
import { constraintLabel, entityLabel, isDimension, refLabel } from './model';
import { modeFor, type SketchMode } from './mode';
import { SketchRail } from './rail';
import { describeFace, splitMerged } from '../naming';
// P4b (SKETCH): the active tool's options and the sketch's patterns.
import { ToolOptions } from './tools/options';
import { TieRows } from './tools/tie-rows';
import { LinksBlock } from './project/panel';

function DrivenQuestion({ title, copy, accept, resolve }: { title: string; copy: string; accept: string; resolve(yes: boolean): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute('open', '');
      }
    }
    yes.current?.focus();
    const cancel = (e: Event) => {
      e.preventDefault();
      resolve(false);
    };
    // Keys inside the dialog never reach the workspace's shortcuts: Enter and Space press the
    // focused button, Escape cancels, Tab goes round Cancel and the action. (Review P2/P3 round 1:
    // Enter ran Finish sketch behind the dialog; round 2: one Tab sent the keyboard out of the
    // frame, and Enter then did the same.)
    const untrap = trapDialogKeys(d, () => resolve(false));
    d.addEventListener('cancel', cancel);
    return () => {
      d.removeEventListener('cancel', cancel);
      untrap();
      if (d.open) d.close();
    };
  }, [resolve]);
  return (
    <dialog ref={ref} className="cad-sk-dialog" data-sketch-question="driven" aria-labelledby="cad-sk-q-title" aria-modal="true">
      <div className="cad-sk-dialog-card">
        <h2 id="cad-sk-q-title">{title}</h2>
        <p className="cad-sk-dialog-copy">{copy}</p>
        <div className="cad-sk-dialog-actions">
          <button type="button" className={buttonClass('secondary')} data-question-cancel="1" onClick={() => resolve(false)}>
            Cancel
          </button>
          <button type="button" ref={yes} className={buttonClass('primary')} data-question-accept="1" onClick={() => resolve(true)}>
            {accept}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** ux010: a hint's first sentence (the compact panel shows one line; the rest is in the tooltip and Details). */
export function firstSentence(text: string): string {
  const m = /^(.+?[.!?])\s+(?=[A-Z(])/.exec(text);
  return m ? m[1] : text;
}

/** ux010: the hint in one line: the tool's short version, else its first sentence, cut with an ellipsis; the full text as its tooltip. */
function OneLineHint({ mode, hint }: { mode: SketchMode; hint: string }) {
  const line = mode.tool?.shortHint?.() || firstSentence(hint);
  return (
    <div className="cad-sk-hint is-one-line" data-sketch-hint="1" data-hint-full={hint} title={line !== hint ? hint : undefined}>
      <Hint>{line}</Hint>
    </div>
  );
}

/** ux010: the head's chevron that slides the panel into its rail at the left edge. */
function CollapseButton({ onCollapse }: { onCollapse(): void }) {
  const rails = railsFor(useServices());
  const ref = useRef<HTMLButtonElement>(null);
  useRailFocus(rails, 'sketch-collapse', ref);
  const tip = useTip({ text: 'Collapse the panel to the left', shortcut: RAIL_SHORTCUT });
  return (
    <button type="button" className="cad-collapse-btn" data-sketch-collapse="1" aria-label="Collapse the Sketch panel to the left" aria-expanded="true" ref={ref} onClick={() => {
        rails.focusAfter('sketch-expand');
        onCollapse();
      }} {...tip}>
      <Icon d={CHEVRON_LEFT} size={15} />
    </button>
  );
}

export function SketchPanel({ session, feature, isNew }: FeaturePanelProps) {
  const services = useServices();
  const ui = uiFor(services);
  const mode = modeFor(services);
  const rails = railsFor(services);
  const { sketchCollapsed: collapsed, sketchDetails: full } = useStateStore(rails.state, (s) => ({ sketchCollapsed: s.sketchCollapsed, sketchDetails: s.sketchDetails }));
  const view = useStateStore(mode!.view);
  const tool = useStateStore(mode!.state, (s) => s.tool);
  const items = useStateStore(services.selection, (s) => s.items);
  const status = useStateStore(services.doc.state, (s) => s.rebuild.features[feature] ?? null);
  // A link that lost what it follows (P4b SELECT): a problem, shown in compact form and on the rail.
  const lostLinks = useStateStore(services.doc.state, (s) => {
    const out = s.rebuild.outputs[feature] as SketchOutput | undefined;
    const links = out?.type === 'sketch' ? (out.links ?? {}) : {};
    return Object.keys(links)
      .filter((id) => links[id].state === 'lost')
      .join(',');
  });
  // The face a sketch lies on, named as Press-pull and Measure name it: its number on the body as
  // shown ("Face 6 of Body 1"), where it came from in the tooltip ("End face of Extrude 1"); by
  // where it came from alone when the body shown does not have it. Review P2/P3 round 4: "Face of Body 1".
  const face = useStateStore(services.doc.state, (s) => {
    const d = (s.doc.features.find((f) => f.id === feature) ?? session.draft) as SketchFeature;
    if (d.support?.kind !== 'face') return null;
    const sup = d.support;
    const body = s.rebuild.bodies.find((b) => b.id === sup.body);
    const from = sup.face?.name ? describeFace(sup.face.name, (id) => s.doc.features.find((f) => f.id === id)?.name ?? null, body?.names?.faces ?? null) : `A face of ${body?.name ?? 'a body'}`;
    const at = body?.names && sup.face?.name ? body.names.faces.findIndex((n) => n === sup.face.name || splitMerged(n).includes(sup.face.name)) : -1;
    return { label: at >= 0 && body ? `Face ${at + 1} of ${body.name}` : from, from };
  });
  // P4a: a sketch on a CONSTRUCT plane names it ("Plane 1").
  const refPlane = useStateStore(services.doc.state, (s) => {
    const d = (s.doc.features.find((f) => f.id === feature) ?? session.draft) as SketchFeature;
    const sup = d.support;
    return sup?.kind === 'feature' ? (s.doc.features.find((f) => f.id === sup.feature)?.name ?? 'A deleted plane') : null;
  });
  const note = useStateStore(ui.state, (s) => s.panelNote);
  const onDelete = usePanelDelete(services, feature, isNew);
  const deleteBlock = usePanelDeleteBlock(services, feature, isNew);
  const draft = (view.draft ?? session.draft) as SketchFeature;
  // ux010: the dimension being edited, or the last one edited or placed while this tool is on.
  const [lastDim, setLastDim] = useState<string | null>(null);
  useEffect(() => {
    if (view.editing) setLastDim(view.editing);
  }, [view.editing]);
  useEffect(() => setLastDim(null), [tool]);
  // ux010: the patterns made while this panel is open (the newest is the current one).
  const tiesAtOpen = useRef<Set<string> | null>(null);
  if (!tiesAtOpen.current) tiesAtOpen.current = new Set((draft.ties ?? []).map((t) => t.id));
  if (!mode) return null;

  const plane = draft.support?.kind === 'plane' ? ORIGIN_PLANES[draft.support.plane].label : (refPlane ?? face?.label ?? 'A face');
  const planeTitle = face && face.label !== face.from ? `${face.label}, from ${face.from}` : undefined;
  const state = view.status?.state ?? draft.solved?.state ?? 'unsolved';
  const words = view.status ? statusText(view.status, draft.entities.length === 0) : 'Solving…';
  const selected = items.filter((it) => it.kind === 'sketch' && it.feature === feature);
  const entities = selected.filter((it) => it.kind === 'sketch' && it.what === 'entity');
  const over = [...(view.status?.conflicting ?? []), ...(view.status?.redundant ?? [])];
  const flagged = draft.constraints.filter((c) => over.includes(c.id));
  // Not solved with nothing flagged: values that cannot all hold (a triangle's sides 10, 7.81 and 30).
  // The driving dimensions are what can be changed, each with a one-click delete (review P2/P3 round 1:
  // only "Not solved" showed, with no list, and every new edit was refused).
  const unsolvable = !flagged.length && view.status?.state === 'unsolved' ? draft.constraints.filter((c) => isDimension(c) && c.driving) : [];
  const overList = flagged.length ? flagged : unsolvable;

  const foot = [];
  if (view.note) foot.push(<DisabledReason key="sketch-note">{view.note}</DisabledReason>);
  if (note) foot.push(<DisabledReason key="note">{note}</DisabledReason>);
  if (status?.state === 'error' && status.message) {
    const fixes = (status.actions ?? []).map((a) => ({ label: FEATURE_ACTION_LABELS[a], run: () => ui.runFeatureAction(feature, a) }));
    foot.push(
      <DisabledReason key="error" fixes={fixes}>
        {status.message}
      </DisabledReason>,
    );
  } else if (status?.state === 'warning' && status.message) {
    foot.push(
      <div key="warning" role="status" data-warning="1">
        <Hint tone="warning">{status.message}</Hint>
      </div>,
    );
  }

  // The rail: what would make the panel red or amber, in words, so a collapsed panel hides no problem.
  const lostCount = lostLinks ? lostLinks.split(',').length : 0;
  const problem =
    (status?.state === 'error' && status.message) ||
    view.note ||
    note ||
    (state === 'over' || state === 'unsolved' ? words : null) ||
    (lostCount ? (lostCount === 1 ? 'Lost reference: open the panel to see it' : `${lostCount} lost references: open the panel to see them`) : null) ||
    (status?.state === 'warning' && status.message) ||
    null;

  if (collapsed) {
    // The active tool's own inputs, beside the rail while the panel is collapsed (the panel is never
    // opened for them: that would fight the user). Gone when the tool ends; back in the panel when it opens.
    const toolInputs = (mode.tool?.options?.() ?? []).length > 0 || tool === 'project' || tool === 'intersect';
    return (
      <>
        <div className="cad-rail-group">
          <SketchRail name={draft.name} state={state} words={words} problem={problem} onExpand={() => rails.setSketchCollapsed(false)} />
          {toolInputs ? (
            <div className="cad-tool-card" data-sketch-tool-card={tool} role="group" aria-label="The tool's options">
              <OneLineHint mode={mode} hint={view.hint} />
              <ToolOptions mode={mode} />
              <LinksBlock mode={mode} feature={feature} draft={draft} refs="none" />
            </div>
          ) : null}
        </div>
        {view.prompt ? <DrivenQuestion title={view.prompt.title} copy={view.prompt.copy} accept={view.prompt.accept} resolve={view.prompt.resolve} /> : null}
      </>
    );
  }

  const selectedWords = selected
    .map((it) => {
      if (it.kind !== 'sketch') return '';
      if (it.what === 'constraint') {
        const c = draft.constraints.find((x) => x.id === it.id);
        return c ? constraintLabel(draft, c, services.doc.units).split(' · ')[0] : '';
      }
      return it.what === 'entity' ? entityLabel(draft, it.id) : refLabel(draft, it.id);
    })
    .filter(Boolean);

  // Compact: the patterns relevant now (made in this panel, the newest; one with a selected curve;
  // one that over-defines the sketch; the one a notice is about). Details: every pattern.
  const ties = draft.ties ?? [];
  let currentTies: Set<string> | null = null;
  if (!full) {
    currentTies = new Set<string>();
    const made = ties.filter((t) => !tiesAtOpen.current!.has(t.id));
    if (made.length) currentTies.add(made[made.length - 1].id);
    const picked = new Set(entities.map((it) => (it.kind === 'sketch' ? it.id : '')));
    for (const t of ties) {
      if (over.includes(t.id) || view.tieNotice?.tie === t.id) currentTies.add(t.id);
      else if (picked.size && (t.sources.some((id) => picked.has(id)) || t.copies.some((c) => Object.values(c.entities).some((id) => picked.has(id))))) currentTies.add(t.id);
    }
  }
  const dimId = view.editing ?? lastDim;
  const dim = dimId ? draft.constraints.find((c) => c.id === dimId && isDimension(c)) : null;

  return (
    <>
      <PanelChrome
        panel="sketch"
        title={draft.name}
        accent="sketch"
        className={full ? 'is-details' : 'is-compact'}
        onRename={(next) => ui.renameFeature(feature, next)}
        onDone={() => mode.finish()}
        onDelete={onDelete}
        deleteBlock={deleteBlock}
        foot={foot.length ? foot : null}
        headAside={
          <span className="cad-sk-head-aside">
            <span className={`cad-sk-state is-${state}`} data-sketch-state={state} title={words}>
              <span className="cad-sk-state-dot" aria-hidden="true" />
              <span className="cad-sk-state-words">{state === 'unsolved' && view.status ? 'Not solved' : words}</span>
            </span>
            <CollapseButton onCollapse={() => rails.setSketchCollapsed(true)} />
          </span>
        }
        footLeft={
          <button type="button" className="cad-sk-details-btn" data-sketch-details={full ? 'open' : 'closed'} aria-expanded={full} aria-controls={`cad-sk-body-${feature}`} onClick={() => rails.setSketchDetails(!full)}>
            Details {full ? '▾' : '▸'}
          </button>
        }
      >
        <div id={`cad-sk-body-${feature}`} data-sketch-panel={feature} data-new={isNew ? '1' : '0'} data-sketch-compact={full ? '0' : '1'}>
          {full ? (
            <Field label="Plane">
              <span className="cad-sk-plane" data-sketch-plane="1" title={planeTitle}>
                {plane}
              </span>
            </Field>
          ) : null}
          {full ? (
            <div className="cad-sk-hint" data-sketch-hint="1">
              <Hint>{view.hint}</Hint>
            </div>
          ) : (
            <OneLineHint mode={mode} hint={view.hint} />
          )}
          {/* P4b (SKETCH) */}
          <ToolOptions mode={mode} />
          <TieRows mode={mode} only={currentTies} />
          {/* Shown while the next segment is a tangent arc too (its preview has no line): it vanished once ticked. */}
          {(mode.tool?.id === 'line' || mode.tool?.id === 'centerline') && (view.lineArc || view.preview?.lines.length) ? (
            <label className="cad-sk-check">
              <input type="checkbox" checked={view.lineArc} onChange={() => mode.tool?.toggleArc?.()} data-sketch-line-arc="1" />
              Tangent arc next (A)
            </label>
          ) : null}
          {dim ? (
            <div className="cad-sk-dimension" data-sketch-dimension={dim.id} data-dimension-editing={view.editing === dim.id ? '1' : '0'}>
              <Field label="Dimension">
                <span className="cad-sk-dimension-value" title={constraintLabel(draft, dim, services.doc.units)}>
                  {constraintLabel(draft, dim, services.doc.units)}
                </span>
              </Field>
            </div>
          ) : null}
          {full && selected.length ? (
            <div className="cad-sk-section" data-sketch-selection="1">
              <div className="cad-field-group-title">Selected</div>
              <div className="cad-sk-selected" title={selectedWords.join(', ')}>
                {selectedWords.length > 4 ? `${selectedWords.slice(0, 4).join(', ')} and ${selectedWords.length - 4} more` : selectedWords.join(', ')}
              </div>
              <div className="cad-sk-actions">
                {entities.length ? (
                  <Button variant="secondary" onClick={() => void services.commands.run('sketch.construction')} data-sketch-action="construction">
                    Construction
                  </Button>
                ) : null}
                <Button variant="secondary" onClick={() => void mode.deleteSelected()} data-sketch-action="delete">
                  Delete selected
                </Button>
              </div>
            </div>
          ) : null}
          {overList.length ? (
            <div className="cad-sk-section" data-sketch-conflicts="1">
              <div className="cad-field-group-title">{!flagged.length ? 'Dimensions that cannot all hold' : view.status?.conflicting.length ? 'Conflicting constraints' : 'Redundant constraints'}</div>
              {!flagged.length ? <Hint>Change one (double-click its label) or delete one.</Hint> : null}
              <ul className="cad-sk-conflicts">
                {overList.map((c) => (
                  <li key={c.id} data-conflict={c.id}>
                    <span className="cad-sk-conflict-name">{constraintLabel(draft, c, services.doc.units)}</span>
                    <button
                      type="button"
                      className={buttonClass('danger')}
                      data-conflict-delete={c.id}
                      onClick={() => {
                        mode.select([{ what: 'constraint', id: c.id }], false);
                        void mode.deleteSelected();
                      }}
                    >
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {/* P4b (SELECT): Project / Intersect options and the sketch's references (linked geometry); compact: only lost ones. */}
          <LinksBlock mode={mode} feature={feature} draft={draft} refs={full ? 'all' : 'lost'} />
          {full ? <Hint>Ctrl while drawing adds no constraints. Alt+drag orbits; middle drag pans.</Hint> : null}
        </div>
      </PanelChrome>
      {view.prompt ? <DrivenQuestion title={view.prompt.title} copy={view.prompt.copy} accept={view.prompt.accept} resolve={view.prompt.resolve} /> : null}
    </>
  );
}
