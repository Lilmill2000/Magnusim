/**
 * The Assistant's dock in the app (chat dock spec 1.1): a portal from AppShell into
 * `#assistant-dock-root`, a child of body outside #app, so it shares the app's React tree
 * and stays mounted across Home, the workbench and workspaces, and a workspace's inert cover
 * never reaches it. It wires the header buttons and Ctrl+/ (toggle.ts), and shows this tab's
 * Assistant questions as its cards (gates.ts), while mounted. What a
 * conversation shows comes from useDockContent (content.ts).
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDockContent } from './content';
import { DockShell } from './DockShell';
import { installGatePresenter } from './gates';
import { ensureDockRoot } from './root';
import { installDockToggle } from './toggle';

export function AssistantDock() {
  const [root] = useState(() => ensureDockRoot());
  const content = useDockContent();
  useEffect(() => installDockToggle(), []);
  // Every question of this tab shows as a card in the dock, never as the app's dialog (spec 4.1).
  useEffect(() => installGatePresenter(), []);
  return createPortal(<DockShell content={content} />, root);
}
