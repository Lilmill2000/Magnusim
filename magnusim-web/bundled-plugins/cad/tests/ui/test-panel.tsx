// A plain feature panel for the UI shell's tests (the stand-in extrude and
// sketch types of fake-doc.ts): the shell's chrome only (title, Done, Delete
// when removable, the rebuild's error in the foot), so the tree, the menus and
// the keyboard can open, edit and close a panel without a real module.
// Never used by shipped code.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../../src/lib/services';
import { useStateStore } from '../../src/lib/store';
import type { FeaturePanelProps } from '../../src/types/modules';
import { uiFor } from '../../src/ui/controller';
import { DisabledReason, PanelChrome } from '../../src/ui/kit';
import { usePanelDelete } from '../../src/ui/panel-delete';

export function TestFeaturePanel({ session, feature, isNew }: FeaturePanelProps) {
  const services = useServices();
  const ui = uiFor(services);
  const onDelete = usePanelDelete(services, feature, isNew);
  const status = useStateStore(services.doc.state, (s) => s.rebuild.features[feature] ?? null);
  const draft = session.open ? session.draft : (services.doc.state.get().doc.features.find((f) => f.id === feature) ?? session.draft);
  const incomplete = session.incomplete();
  return (
    <PanelChrome
      panel="feature"
      title={draft.name}
      onDone={() => ui.closePanel()}
      doneDisabled={isNew && incomplete ? incomplete : null}
      onDelete={onDelete}
      foot={status?.state === 'error' ? <DisabledReason>{status.message ?? ''}</DisabledReason> : null}
    >
      <div data-feature-panel={draft.type} data-feature-id={feature} data-new={isNew ? '1' : '0'} />
    </PanelChrome>
  );
}
