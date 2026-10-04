// Combine panel: Operation (Join / Cut / Intersect), targets, tools, keep
// tools. Picking the first target moves on to the tools, as Fusion does.
// A new Combine whose first target is an Enclosure's body turns Keep the tool
// bodies on (the fluid domain needs the part kept; SD review round 1: off by
// default, forgetting it consumed the part), unless the user set the switch.
// Every valid change applies live. Done closes.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef, useState } from 'react';
import { useServices } from '../../lib/services';
import type { CombineFeature } from '../../types/doc';
import type { FeaturePanelProps } from '../../types/modules';
import { Field, Select } from '../../ui/kit';
import { useBodyField } from '../p2/fields';
import { P2FeaturePanel, Switch, useFeaturePanel } from '../p2/panel';
import { useSelectionMirror } from '../p2/pick';
import { COMBINE_OPS } from './feature';

export function CombinePanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<CombineFeature>(props);
  const f = kit.draft;
  const [active, setActive] = useState<'targets' | 'tools'>(f.targets.length ? 'tools' : 'targets');
  /** The user set Keep the tool bodies in this panel: it is theirs from then on. */
  const keepSet = useRef(false);
  const enclosureBody = (id: string) => services.doc.state.get().doc.features.some((g) => g.type === 'enclosure' && (g as { creates?: string }).creates === id);
  const targets = useBodyField(services, {
    feature: props.feature,
    ids: f.targets,
    active: active === 'targets',
    refuse: (id) => (f.tools.includes(id) ? 'A body cannot be a target and a tool' : null),
    onChange: (ids) => {
      const keep = props.isNew && !keepSet.current && !f.keepTools && !f.targets.length && ids.length === 1 && enclosureBody(ids[0]);
      kit.set(keep ? { targets: ids, keepTools: true } : { targets: ids });
      if (!f.targets.length && ids.length === 1 && !f.tools.length) setActive('tools');
    },
  });
  const tools = useBodyField(services, {
    feature: props.feature,
    ids: f.tools,
    active: active === 'tools',
    refuse: (id) => (f.targets.includes(id) ? 'A body cannot be a target and a tool' : null),
    onChange: (ids) => kit.set({ tools: ids }),
  });
  useSelectionMirror(services, [...targets.highlight, ...tools.highlight], (items) => {
    if (active === 'targets') targets.take(items);
    else tools.take(items);
  });
  const op = COMBINE_OPS.find((o) => o.value === f.op) ?? COMBINE_OPS[0];
  const id = `cad-combine-${props.feature}-op`;
  return (
    <P2FeaturePanel props={props} kit={kit}>
      <Field label="Operation" htmlFor={id} field="op">
        <Select id={id} label="Operation" field="op" value={f.op} onChange={(v) => kit.set({ op: v as CombineFeature['op'] })} options={COMBINE_OPS.map((o) => ({ value: o.value, label: o.label }))} />
      </Field>
      <div className="cad-p2-sub" data-combine-op-hint="1">
        {op.hint}
      </div>
      {targets.element(`Targets${f.targets.length ? ` (${f.targets.length})` : ''}`, 'targets', () => setActive('targets'), 'Click the bodies to change, in the viewport or the tree')}
      {tools.element(`Tools${f.tools.length ? ` (${f.tools.length})` : ''}`, 'tools', () => setActive('tools'), 'Click the bodies to combine them with')}
      <div className="cad-field">
        <Switch
          field="keep-tools"
          label="Keep the tool bodies"
          checked={f.keepTools}
          onChange={(keepTools) => {
            keepSet.current = true;
            kit.set({ keepTools });
          }}
        />
      </div>
    </P2FeaturePanel>
  );
}
