// The design tree as a slim rail at the left edge of the view (ux010): the whole rail is one
// button that brings the tree card back. A failed feature still shows: a red count on the rail,
// what failed in its tooltip. Also the chevrons the tree card and the Sketch panel collapse with.
// Owner: ux010 PANELS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef } from 'react';
import { useServices } from '../../lib/services';
import { useStateStore } from '../../lib/store';
import { Icon, ICONS } from '../Icon';
import { useTip } from '../kit';
import { RAIL_SHORTCUT, railsFor, useRailFocus } from '../left-rails';

/** A chevron pointing left (collapse sideways) and right (expand), 24 viewBox outlines. */
export const CHEVRON_LEFT = 'M14.5 6l-6 6 6 6';
export const CHEVRON_RIGHT = 'M9.5 6l6 6-6 6';

export function TreeRail({ onOpen, sketching }: { onOpen(): void; sketching: boolean }) {
  const services = useServices();
  const rails = railsFor(services);
  const ref = useRef<HTMLButtonElement>(null);
  useRailFocus(rails, 'tree-rail', ref);
  // One string (a stable snapshot): the failed features' names as JSON.
  const failed = useStateStore(services.doc.state, (s) => JSON.stringify(s.doc.features.filter((f) => s.rebuild.features[f.id]?.state === 'error').map((f) => f.name)));
  const names = JSON.parse(failed) as string[];
  const label = 'Show the design tree';
  const tip = useTip({
    text: label,
    detail: names.length ? `${names.length === 1 ? 'Failed' : `${names.length} failed`}: ${names.join(', ')}` : sketching ? 'For this sketch only: it comes back by itself at Done' : undefined,
    ...(sketching ? {} : { shortcut: RAIL_SHORTCUT }),
  });
  return (
    <button type="button" className="cad-rail is-tree" data-cad-rail="tree" aria-label={names.length ? `${label} (${names.length} failed)` : label} aria-expanded="false" ref={ref} onClick={() => {
        rails.focusAfter('tree-collapse');
        onOpen();
      }} {...tip}>
      <Icon d={CHEVRON_RIGHT} size={15} className="cad-rail-chevron" />
      <Icon d={ICONS.part} size={15} />
      <span className="cad-rail-label">Design tree</span>
      {names.length ? (
        <span className="cad-rail-badge" data-rail-failed={names.length} aria-hidden="true">
          {names.length}
        </span>
      ) : null}
    </button>
  );
}
