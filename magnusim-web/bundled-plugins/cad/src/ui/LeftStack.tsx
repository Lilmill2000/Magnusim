// The floating column over the viewport, top-left: the design tree card, then
// the flyout panel beside it when one is open (the core's "tree then flyout"
// rhythm, style.css:257-297, 459-512). The layout mounts this one component.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../lib/services';
import { useStateStore } from '../lib/store';
import { uiFor } from './controller';
import { Flyout } from './kit';
import { FeaturePanel } from './panels/FeaturePanel';
import { ParametersPanel } from './panels/ParametersPanel';
import { DesignTree } from './tree/DesignTree';

export function LeftStack() {
  const ui = uiFor(useServices());
  const panel = useStateStore(ui.state, (s) => s.panel);
  return (
    <div className="cad-float-stack" data-cad-left-stack="1">
      <DesignTree />
      {panel ? (
        <Flyout wide={panel.kind === 'params'}>
          {panel.kind === 'feature' ? <FeaturePanel key={panel.session.id} panel={panel} /> : <ParametersPanel />}
        </Flyout>
      ) : null}
    </div>
  );
}
