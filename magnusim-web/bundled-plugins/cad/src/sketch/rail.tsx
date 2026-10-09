// The Sketch panel collapsed (ux010, Daniel 2026-10-07: "collapse to the left and not collapse up
// just so it frees up some of the screen space"): a slim rail at the left edge with the sketch's
// state dot, its name read upward, the button that brings the panel back, and Finish sketch (the
// panel's Done) as an icon button. A problem the panel would show (a failed sketch, an over-defined
// one, a lost reference, a refused action) puts a red mark on the rail, its words in the tooltip.
// Owner: ux010 PANELS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef } from 'react';
import { useServices } from '../lib/services';
import { WELL_KNOWN_COMMANDS } from '../types/modules';
import { Icon } from '../ui/Icon';
import { useTip } from '../ui/kit';
import { RAIL_SHORTCUT, railsFor, useRailFocus } from '../ui/left-rails';
import { CHEVRON_RIGHT } from '../ui/tree/TreeRail';
import { SKETCH_ICONS } from './icons';

export function SketchRail({ name, state, words, problem, onExpand }: { name: string; state: string; words: string; problem: string | null; onExpand(): void }) {
  const services = useServices();
  const rails = railsFor(services);
  const ref = useRef<HTMLButtonElement>(null);
  useRailFocus(rails, 'sketch-expand', ref);
  const label = `Show the ${name} panel`;
  const openTip = useTip({ text: label, detail: problem ? problem : words, shortcut: RAIL_SHORTCUT });
  const doneTip = useTip({ text: 'Finish sketch', shortcut: 'Enter' });
  return (
    <div className="cad-rail is-sketch" data-cad-rail="sketch" data-sketch-state={state} data-rail-problem={problem ? '1' : undefined}>
      <button type="button" className="cad-rail-open" data-rail-expand="1" aria-label={problem ? `${label}: ${problem}` : `${label} (${words})`} aria-expanded="false" ref={ref} onClick={() => {
          rails.focusAfter('sketch-collapse');
          onExpand();
        }} {...openTip}>
        <Icon d={CHEVRON_RIGHT} size={15} className="cad-rail-chevron" />
        <span className={`cad-sk-state is-${state}`} aria-hidden="true">
          <span className="cad-sk-state-dot" />
        </span>
        <span className="cad-rail-label">{name}</span>
        {problem ? (
          <span className="cad-rail-badge" data-rail-alert="1" aria-hidden="true">
            !
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className="cad-rail-done"
        data-rail-done="1"
        aria-label="Finish sketch"
        onClick={() => void services.commands.run(WELL_KNOWN_COMMANDS.sketchFinish)}
        {...doneTip}
      >
        <Icon d={SKETCH_ICONS.finish} size={16} />
      </button>
    </div>
  );
}
