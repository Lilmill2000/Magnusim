/**
 * The dock's own root (chat dock spec 1.1): `<div id="assistant-dock-root">`, the last child
 * of body when the app boots, a sibling of #react-root and never inside #app or #home. A
 * workspace makes every child of #app inert (WorkspaceOverlay coverWorkbench), so the dock
 * lives outside it and stays usable over a workspace.
 */
export const DOCK_ROOT_ID = 'assistant-dock-root';

export function ensureDockRoot(): HTMLElement {
  let el = document.getElementById(DOCK_ROOT_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = DOCK_ROOT_ID;
    document.body.appendChild(el);
  }
  return el;
}
