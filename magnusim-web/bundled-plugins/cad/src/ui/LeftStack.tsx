// The floating column over the viewport, top-left: the design tree card, then
// the flyout panel beside it when one is open (the core's "tree then flyout"
// rhythm, style.css:257-297, 459-512). The layout mounts this one component.
// Feature panels come from the module that gives the type's panel
// (services.modules); tool panels from their module.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../lib/services';
import { useStateStore } from '../lib/store';
import { uiFor } from './controller';
import { Flyout } from './kit';
import { ParametersPanel } from './panels/ParametersPanel';
import { DesignTree } from './tree/DesignTree';

export function LeftStack() {
  const services = useServices();
  const ui = uiFor(services);
  const panel = useStateStore(ui.state, (s) => s.panel);
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
  return (
    <div className="cad-float-stack" data-cad-left-stack="1" data-view-cover="left">
      <DesignTree />
      {body ? <Flyout wide={wide}>{body}</Flyout> : null}
    </div>
  );
}
