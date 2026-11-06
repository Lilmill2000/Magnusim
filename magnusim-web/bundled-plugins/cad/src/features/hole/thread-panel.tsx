// The Thread panel (the feature panel conventions of the Chamfer panel): a modelled thread's hole
// and size, said in words (Hole makes it; it follows that hole), and its Length ("" for the whole
// hole: a blind one stops a pitch short of its bottom). Every valid change applies live; Done closes.
// Owner: ASSISTANT (the person's side of hole).
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import type { ExtrudeFeature, ThreadFeature } from '../../types/doc';
import type { FeaturePanelProps } from '../../types/modules';
import { Field, Hint } from '../../ui/kit';
import { P2FeaturePanel, useFeaturePanel } from '../p2/panel';

export function ThreadPanel(props: FeaturePanelProps) {
  const services = useServices();
  const kit = useFeaturePanel<ThreadFeature>(props);
  const f = kit.draft;
  const hole = useStateStore(services.doc.state, (s) => s.doc.features.find((g) => g.id === f.hole) as ExtrudeFeature | undefined);
  const id = `cad-thread-${props.feature}-length`;
  return (
    <P2FeaturePanel props={props} kit={kit}>
      <Hint>{hole?.thread ? `${hole.thread.designation} cut into ${hole.name}, following its holes.` : 'Its tapped hole is gone.'}</Hint>
      <Field label="Length" htmlFor={id} field="length">
        {/* Applied on Enter or leaving the field: each rebuild cuts the thread again (a second or two). */}
        <input
          key={f.length}
          id={id}
          className="mgk-input"
          type="text"
          spellCheck={false}
          placeholder="the whole hole"
          defaultValue={f.length}
          data-field="length"
          onBlur={(e) => e.target.value.trim() !== f.length && kit.update({ length: e.target.value.trim() } as Partial<ThreadFeature>)}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </Field>
      <Hint>Empty: the whole hole (a blind hole's thread stops a pitch short of its bottom).</Hint>
    </P2FeaturePanel>
  );
}
