// The floating column over the viewport, top-left: the design tree card, then
// the flyout panel beside it when one is open (the core's "tree then flyout"
// rhythm, style.css:257-297, 459-512). The layout mounts this one component.
// Feature panels come from the module that gives the type's panel
// (services.modules); tool panels from their module.
// ux010 (Daniel 2026-10-07): the tree card and the Sketch panel collapse sideways into slim rails
// at the left edge (src/ui/left-rails.ts). While a sketch is edited the tree is its rail until the
// rail is clicked (for that sketch only); in model mode its chevron is the user's, remembered. A
// collapsed Sketch panel is drawn by the panel itself as its rail (src/sketch/panel.tsx); with the
// tree a rail too, the two rails stand one above the other, so the view keeps all but ~44 px.
// [data-view-cover] spans what is drawn, so framing uses the room the rails free.
// Owner: UI-SHELL; rails ux010 PANELS.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect } from 'react';
import { useServices } from '../lib/services';
import { useStateStore } from '../lib/store';
import { uiFor } from './controller';
import { Flyout } from './kit';
import { railsFor } from './left-rails';
import { ParametersPanel } from './panels/ParametersPanel';
import { DesignTree } from './tree/DesignTree';
import { TreeRail } from './tree/TreeRail';

export function LeftStack() {
  const services = useServices();
  const ui = uiFor(services);
  const rails = railsFor(services);
  const panel = useStateStore(ui.state, (s) => s.panel);
  const sketching = useStateStore(services.mode, (s) => s.mode === 'sketch');
  const r = useStateStore(rails.state);
  const sketchPanel = panel?.kind === 'feature' && panel.type === 'sketch';
  // A sketch started or ended (or another sketch was opened): the tree goes back to the user's own choice.
  const sketchKey = sketching ? (sketchPanel ? panel.feature : 'sketch') : null;
  useEffect(() => rails.sketchChanged(), [rails, sketchKey]);
  let body = null;
  let wide = false;
  if (panel?.kind === 'feature') {
    const Module = services.modules?.panelFor(panel.type) ?? null;
    body = Module ? <Module key={panel.session.id} session={panel.session} feature={panel.feature} isNew={panel.isNew} /> : null;
  } else if (panel?.kind === 'params') {
    body = <ParametersPanel />;
    wide = true;
  } else if (panel?.kind === 'tool') {
    const tool = services.modules?.tool(panel.tool) ?? null;
    if (tool) {
      const Tool = tool.panel;
      body = <Tool key={tool.id} close={() => ui.closePanel()} />;
      wide = !!tool.wide;
    }
  }
  const treeRail = sketching ? !r.treeShownInSketch : r.treeCollapsed;
  const panelRail = !!body && sketchPanel && r.sketchCollapsed;
  // Only rails: one column at the left edge, one above the other.
  const railsOnly = treeRail && (!body || panelRail);
  return (
    <div
      className={`cad-float-stack${railsOnly ? ' is-rails' : ''}${r.ready ? '' : ' is-pending'}`}
      data-cad-left-stack="1"
      data-view-cover="left"
      data-tree-rail={treeRail ? '1' : '0'}
      data-rails-ready={r.ready ? '1' : '0'}
    >
      {treeRail ? (
        <TreeRail sketching={sketching} onOpen={() => rails.setTreeShown(true, sketching)} />
      ) : (
        <DesignTree sketching={sketching} onCollapse={() => rails.setTreeShown(false, sketching)} />
      )}
      {body ? (
        <Flyout wide={wide} rail={panelRail}>
          {body}
        </Flyout>
      ) : null}
    </div>
  );
}
