// The Sketch panel collapsed (ux010, Daniel 2026-10-07: "collapse to the left and not collapse up
// just so it frees up some of the screen space"): a slim rail at the left edge with the sketch's
// state dot, its name read upward, the button that brings the panel back, and Finish sketch (the
// panel's Done) as an icon button. A problem the panel would show (a failed sketch, an over-defined
// one, a lost reference, a refused action) puts a red mark on the rail, its words in the tooltip.
// A sketch the Assistant draws (usePanelOwner, as the panel's chrome reads it) says so on the rail
// too: data-panel-owner="assistant", an "Assistant" mark, and its Finish disabled with the panel
// Done's reason (review: an enabled "Finish sketch" there discarded the Assistant's sketch).
// Owner: ux010 PANELS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef } from 'react';
import { useServices } from '../lib/services';
import { WELL_KNOWN_COMMANDS } from '../types/modules';
import { Icon } from '../ui/Icon';
import { ASSISTANT_PANEL_DONE, usePanelOwner, useTip } from '../ui/kit';
import { RAIL_COMMAND, railsFor, useRailFocus } from '../ui/left-rails';
import { railKeybindMenu, useKeyLabel } from '../ui/keybinds';
import { CHEVRON_RIGHT } from '../ui/tree/TreeRail';
import { SKETCH_ICONS } from './icons';

export function SketchRail({ name, state, words, problem, onExpand }: { name: string; state: string; words: string; problem: string | null; onExpand(): void }) {
  const services = useServices();
  const rails = railsFor(services);
  const ref = useRef<HTMLButtonElement>(null);
  useRailFocus(rails, 'sketch-expand', ref);
  const assistant = usePanelOwner() === 'assistant';
  const label = assistant ? `Show the ${name} panel (the Assistant is drawing it)` : `Show the ${name} panel`;
  const railKey = useKeyLabel(services, RAIL_COMMAND);
  const finishKey = useKeyLabel(services, 'sketch.finish');
  const openTip = useTip({ text: label, detail: problem ? problem : words, ...(railKey ? { shortcut: railKey } : {}) });
  const doneTip = useTip(assistant ? { text: 'Finish sketch', detail: ASSISTANT_PANEL_DONE } : { text: 'Finish sketch', ...(finishKey ? { shortcut: finishKey } : {}) });
  return (
    <div className="cad-rail is-sketch" data-cad-rail="sketch" data-sketch-state={state} data-rail-problem={problem ? '1' : undefined} data-panel-owner={assistant ? 'assistant' : undefined}>
      <button type="button" className="cad-rail-open" data-rail-expand="1" aria-label={problem ? `${label}: ${problem}` : `${label} (${words})`} aria-expanded="false" ref={ref} onContextMenu={(e) => railKeybindMenu(services, e)} onClick={() => {
          rails.focusAfter('sketch-collapse');
          onExpand();
        }} {...openTip}>
        <Icon d={CHEVRON_RIGHT} size={15} className="cad-rail-chevron" />
        <span className={`cad-sk-state is-${state}`} aria-hidden="true">
          <span className="cad-sk-state-dot" />
        </span>
        <span className="cad-rail-label">{name}</span>
        {assistant ? (
          <span className="cad-rail-owner" data-panel-badge="assistant">
            Assistant
          </span>
        ) : null}
        {problem ? (
          <span className="cad-rail-badge" data-rail-alert="1" aria-hidden="true">
            !
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className={assistant ? 'cad-rail-done is-disabled' : 'cad-rail-done'}
        data-rail-done="1"
        aria-label="Finish sketch"
        aria-disabled={assistant || undefined}
        data-disabled-reason={assistant ? ASSISTANT_PANEL_DONE : undefined}
        onClick={() => {
          if (!assistant) void services.commands.run(WELL_KNOWN_COMMANDS.sketchFinish);
        }}
        {...doneTip}
      >
        <Icon d={SKETCH_ICONS.finish} size={16} />
      </button>
    </div>
  );
}
