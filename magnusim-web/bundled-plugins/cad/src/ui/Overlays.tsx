// Things drawn above everything in the frame: the context menu and the
// tooltip layer. The layout mounts this one component last.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useServices } from '../lib/services';
import { useStateStore } from '../lib/store';
import { uiFor } from './controller';
import { ContextMenu, TooltipLayer } from './kit';

export function Overlays() {
  const ui = uiFor(useServices());
  const menu = useStateStore(ui.state, (s) => s.menu);
  return (
    <>
      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} label={menu.label} onClose={ui.closeMenu} /> : null}
      <TooltipLayer />
    </>
  );
}
