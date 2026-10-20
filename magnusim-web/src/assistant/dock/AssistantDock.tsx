/**
 * The Assistant's dock in the app (chat dock spec 1.1): a portal from AppShell into
 * `#assistant-dock-root`, a child of body outside #app, so it shares the app's React tree
 * and stays mounted across Home, the workbench and workspaces, and a workspace's inert cover
 * never reaches it. It wires the header buttons and Ctrl+/ (toggle.ts) while mounted. What a
 * conversation shows comes from useDockContent (content.ts).
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDockContent } from './content';
import { DockShell } from './DockShell';
import { ensureDockRoot } from './root';
import { installDockToggle } from './toggle';

export function AssistantDock() {
  const [root] = useState(() => ensureDockRoot());
  const content = useDockContent();
  useEffect(() => installDockToggle(), []);
  return createPortal(<DockShell content={content} />, root);
}
