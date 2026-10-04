// The parts every P2 feature panel shares, following the feature panel
// conventions (as src/features/extrude/ExtrudePanel.tsx): live apply through the session,
// Done in the foot (disabled with the reason while a new feature is
// incomplete), Delete (discards a new feature, removes an existing one), no
// header tick, the rebuild's error with its fixes ("Try repair") or warning in
// the foot, and "Not applied: ..." for a typed change that cannot apply.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Toggle } from '@magnusim/plugin-ui';
import { useId, useState, type ReactNode } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import { FEATURE_ACTION_LABELS, type Feature, type FeatureStatus } from '../../types/doc';
import type { FeaturePanelProps } from '../../types/modules';
import { errText, uiFor } from '../../ui/controller';
import { usePanelDelete, usePanelDeleteBlock } from '../../ui/panel-delete';
import { DisabledReason, Hint, PanelChrome } from '../../ui/kit';

export interface FeaturePanelKit<F extends Feature> {
  /** The feature as last typed (the document holds its last valid version). */
  draft: F;
  /** The stored feature, or null while a new one is not in the document yet. */
  stored: F | null;
  status: FeatureStatus | null;
  /** Apply a change; returns why it could not be made, or null. */
  update(patch: Partial<F>): string | null;
  /** Apply, and show a refusal in the foot. */
  set(patch: Partial<F>): void;
  incomplete: string | null;
  /** The user changed something in this panel (a new feature's "Pick ..." is red only from then on). */
  touched: boolean;
}

export function useFeaturePanel<F extends Feature>({ session, feature }: FeaturePanelProps): FeaturePanelKit<F> {
  const services = useServices();
  const ui = uiFor(services);
  const stored = useStateStore(services.doc.state, (s) => (s.doc.features.find((f) => f.id === feature) ?? null) as F | null);
  const status = useStateStore(services.doc.state, (s) => s.rebuild.features[feature] ?? null);
  useStateStore(services.doc.state, (s) => s.doc.units);
  useStateStore(services.doc.state, (s) => s.doc.params);
  const note = useStateStore(ui.state, (s) => s.panelNote);
  const [, setTick] = useState(0);
  const [touched, setTouched] = useState(false);
  const draft = (session.open ? session.draft : (stored ?? session.draft)) as F;
  const update = (patch: Partial<F>): string | null => {
    const block = ui.editBlock();
    if (block) return block;
    if (!session.open) return 'This panel is no longer editing the feature';
    try {
      session.update(patch as Partial<Feature>);
    } catch (err) {
      return `${session.isNew ? 'Create' : 'Edit'} failed: ${errText(err)}`;
    }
    setTick((n) => n + 1);
    setTouched(true);
    if (note) ui.setPanelNote(null);
    return null;
  };
  let incomplete: string | null = null;
  try {
    incomplete = session.incomplete();
  } catch (err) {
    incomplete = errText(err);
  }
  return {
    draft,
    stored,
    status,
    update,
    set(patch) {
      const why = update(patch);
      if (why) ui.setPanelNote(why);
    },
    incomplete,
    touched,
  };
}

/** PanelChrome for a P2 feature: title rename, Done, Delete, and the foot lines. */
export function P2FeaturePanel<F extends Feature>({
  props,
  kit,
  children,
  extraFoot,
  doneDisabled,
  quietIncomplete = false,
  fieldsSay = null,
}: {
  props: FeaturePanelProps;
  kit: FeaturePanelKit<F>;
  children: ReactNode;
  /** Lines before the rebuild's own (an action's progress or refusal). */
  extraFoot?: ReactNode[];
  /**
   * Done's state when the panel knows better than "incomplete": a reason to wait
   * (an import still running), or null (Done may close: a failed new import is
   * discarded by it). Undefined: the incomplete reason of a new feature.
   */
  doneDisabled?: string | null;
  /** The panel says itself what a new feature still waits for (an import's progress): no red "incomplete" line. */
  quietIncomplete?: boolean;
  /**
   * What a field of the panel already shows under itself (an Enclosure side the part shrank
   * under): the rebuild's failure that says the same is not said again at the foot (SD final review).
   */
  fieldsSay?: string | null;
}) {
  const services = useServices();
  const ui = uiFor(services);
  const note = useStateStore(ui.state, (s) => s.panelNote);
  const onDelete = usePanelDelete(services, props.feature, props.isNew);
  const deleteBlock = usePanelDeleteBlock(services, props.feature, props.isNew);
  const [, setTick] = useState(0);
  const { draft, stored, status, incomplete } = kit;
  const pending = stored != null && JSON.stringify(draft) !== JSON.stringify(stored);
  const foot: ReactNode[] = [...(extraFoot ?? [])];
  if (note) foot.push(<DisabledReason key="note">{note}</DisabledReason>);
  // While the panel shows a change the Part could not take yet ("Pick a flat face to split with"), the
  // rebuild's error is about the stored version the panel no longer shows: it is left out (review P2/P3
  // round 1: a stale "Split 1 failed: the Right plane does not cut ..." stayed beside it).
  const stale = !!incomplete && pending;
  const saidInField = !!fieldsSay && !!status?.message && status.message.includes(fieldsSay) && !status.actions?.length;
  if (status?.state === 'error' && !stale && !saidInField) {
    const fixes = (status.actions ?? []).map((a) => ({ label: FEATURE_ACTION_LABELS[a], run: () => ui.runFeatureAction(props.feature, a) }));
    foot.push(
      <DisabledReason key="error" fixes={fixes}>
        {status.message || `${draft.name} failed`}
      </DisabledReason>,
    );
  } else if (status?.state === 'warning' && status.message && !stale) {
    foot.push(
      <div key="warning" role="status" data-warning="1">
        <Hint tone="warning">{status.message}</Hint>
      </div>,
    );
  }
  if (incomplete && props.isNew) {
    // What a new feature waits for: a plain hint until the user has done something in the panel,
    // then a reason (UX review: "Pick at least one target" was red before any interaction).
    if (!quietIncomplete)
      foot.push(
        kit.touched ? (
          <DisabledReason key="incomplete">{incomplete}</DisabledReason>
        ) : (
          <div key="incomplete" data-incomplete-hint="1">
            <Hint>{incomplete}</Hint>
          </div>
        ),
      );
  }
  else if (incomplete && pending)
    foot.push(
      <Hint key="incomplete">
        <span className="cad-not-applied">Not applied: {incomplete}</span>
      </Hint>,
    );
  const done = doneDisabled !== undefined ? doneDisabled : props.isNew && incomplete ? incomplete : null;
  return (
    <PanelChrome
      panel="feature"
      title={draft.name}
      accent="feature"
      onRename={(next) => {
        const why = ui.renameFeature(props.feature, next);
        if (!why) setTick((n) => n + 1);
        return why;
      }}
      onRenameGiveUp={(why) => ui.setPanelNote(`Rename failed: ${why}`)}
      renameLabel="feature"
      onDone={() => ui.closePanel()}
      doneDisabled={done}
      onDelete={onDelete}
      deleteBlock={deleteBlock}
      foot={foot.length ? foot : null}
    >
      <div data-feature-panel={draft.type} data-feature-id={props.feature} data-new={props.isNew ? '1' : '0'}>
        {children}
      </div>
    </PanelChrome>
  );
}

/**
 * A labelled on/off switch: the host kit's Toggle (the core's .switch, a real
 * checkbox), its words beside it as its label. data-field and data-switch mark
 * the row for tests (`[data-switch="knit"] input`); a disabled switch says why
 * in the row's tooltip.
 */
export function Switch({ checked, onChange, label, field, disabledReason }: { checked: boolean; onChange(v: boolean): void; label: string; field: string; disabledReason?: string | null }) {
  const id = useId();
  return (
    <div className="cad-switch-row" data-field={field} data-switch={field} title={disabledReason ?? undefined}>
      <Toggle id={id} label={label} checked={checked} disabled={!!disabledReason} onChange={onChange} />
      <label className="cad-switch-label" htmlFor={id}>
        {label}
      </label>
    </div>
  );
}
