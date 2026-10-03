// Split panel: the bodies to split, and what splits them (an origin plane with
// an offset, a flat face's plane, or another body, kept or not). Every valid
// change applies live; the pieces it makes are listed. Done closes.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef, useState } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import { parseDerivedBodyId } from '../../doc/features/body-ids';
import { ORIGIN_PLANES, type OriginPlaneRef, type SplitFeature, type SplitTool } from '../../types/doc';
import type { FeaturePanelProps } from '../../types/modules';
import type { SelectionItem } from '../../types/selection';
import { Field, Hint, NumberUnitInput, Select } from '../../ui/kit';
import { useBodyField, useFaceField } from '../p2/fields';
import { P2FeaturePanel, Switch, useFeaturePanel } from '../p2/panel';
import { useSelectionMirror } from '../p2/pick';

const PLANES: OriginPlaneRef[] = ['origin:top', 'origin:front', 'origin:right'];
const KINDS: { value: SplitTool['kind']; label: string }[] = [
  { value: 'plane', label: 'Origin plane' },
  { value: 'face', label: 'Plane of a flat face' },
  { value: 'body', label: 'Another body' },
];

export function SplitPanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<SplitFeature>(props);
  const f = kit.draft;
  const t = f.tool;
  const units = services.doc.units;
  const [active, setActive] = useState<'targets' | 'tool'>(f.targets.length ? 'tool' : 'targets');
  const pieces = useStateStore(services.doc.state, (s) => s.rebuild.bodies.filter((b) => b.feature === props.feature).map((b) => ({ id: b.id, name: b.name, derived: parseDerivedBodyId(props.feature, b.id) != null })));
  const setTool = (tool: SplitTool) => kit.set({ tool });
  /**
   * The last tool of each kind while the panel is open: switching "Split with" away and back
   * gives the plane and its offset (or the face, or the body) back. Review P2/P3 round 4: it
   * reset to the Right plane at 0, so a working 15 mm split silently failed.
   */
  const lastOfKind = useRef<Partial<Record<SplitTool['kind'], SplitTool>>>({});
  lastOfKind.current[t.kind] = t;
  const targets = useBodyField(services, {
    feature: props.feature,
    ids: f.targets,
    active: active === 'targets',
    refuse: (id) => (t.kind === 'body' && t.body === id ? 'That body splits the others: it cannot be split by itself' : null),
    onChange: (ids) => kit.set({ targets: ids }),
  });
  const faceTool = useFaceField(services, {
    feature: props.feature,
    body: t.kind === 'face' ? t.body : '',
    refs: t.kind === 'face' && t.face ? [t.face] : [],
    active: active === 'tool' && t.kind === 'face',
    single: true,
    planar: 'Split by a face needs a flat face: that face is curved',
    onChange: (body, refs) => setTool(refs.length ? { kind: 'face', body, face: refs[0] } : ({ kind: 'face', body: '', face: null } as unknown as SplitTool)),
  });
  const bodyTool = useBodyField(services, {
    feature: props.feature,
    ids: t.kind === 'body' && t.body ? [t.body] : [],
    active: active === 'tool' && t.kind === 'body',
    single: true,
    refuse: (id) => (f.targets.includes(id) ? 'That body is one of the bodies to split' : null),
    onChange: (ids) => setTool({ kind: 'body', body: ids[0] ?? '', keepTool: t.kind === 'body' ? t.keepTool : false }),
  });
  const highlight: SelectionItem[] = [...targets.highlight, ...(t.kind === 'face' ? faceTool.highlight : []), ...(t.kind === 'body' ? bodyTool.highlight : [])];
  useSelectionMirror(services, highlight, (items) => {
    if (active === 'targets') targets.take(items);
    else if (t.kind === 'body') bodyTool.take(items);
  });
  const id = (k: string) => `cad-split-${props.feature}-${k}`;
  return (
    <P2FeaturePanel props={props} kit={kit}>
      {targets.element(`Bodies to split${f.targets.length ? ` (${f.targets.length})` : ''}`, 'targets', () => setActive('targets'), 'Click bodies in the viewport or the tree')}
      <Field label="Split with" htmlFor={id('kind')} field="tool-kind">
        <Select
          id={id('kind')}
          label="Split with"
          field="tool-kind"
          value={t.kind}
          onChange={(v) => {
            const kind = v as SplitTool['kind'];
            setActive('tool');
            const before = lastOfKind.current[kind];
            if (before) setTool(before);
            else if (kind === 'plane') setTool({ kind: 'plane', plane: 'origin:right', offset: '0' });
            else if (kind === 'face') setTool({ kind: 'face', body: '', face: null } as unknown as SplitTool);
            else setTool({ kind: 'body', body: '', keepTool: false });
          }}
          options={KINDS.map((k) => ({ value: k.value, label: k.label }))}
        />
      </Field>
      {t.kind === 'plane' ? (
        <>
          <Field label="Plane" htmlFor={id('plane')} field="plane">
            <Select id={id('plane')} label="Plane" field="plane" value={t.plane} onChange={(v) => setTool({ ...t, plane: v as OriginPlaneRef })} options={PLANES.map((p) => ({ value: p, label: ORIGIN_PLANES[p].label }))} />
          </Field>
          <Field label="Offset" htmlFor={id('offset')} field="offset">
            <NumberUnitInput id={id('offset')} field="offset" label="Offset" expr={t.offset} quantity="length" units={units} onCommit={(e) => kit.update({ tool: { ...t, offset: e } })} />
          </Field>
        </>
      ) : null}
      {t.kind === 'face' ? faceTool.element('Face', 'tool-face', () => setActive('tool'), 'Click a flat face: the body splits along its plane') : null}
      {t.kind === 'body' ? (
        <>
          {bodyTool.element('Tool body', 'tool-body', () => setActive('tool'), 'Click the body to split with')}
          <div className="cad-field">
            <Switch field="keep-tool" label="Keep the tool body" checked={t.keepTool} onChange={(keepTool) => setTool({ ...t, keepTool })} />
          </div>
        </>
      ) : null}
      {pieces.length ? (
        <Field label="Makes" field="pieces">
          <span data-split-pieces={pieces.length}>{pieces.length === 1 ? '1 body' : `${pieces.length} bodies`}</span>
        </Field>
      ) : null}
      <Hint>The first piece keeps the body's name; the others are named after it and can be renamed in the tree.</Hint>
    </P2FeaturePanel>
  );
}
