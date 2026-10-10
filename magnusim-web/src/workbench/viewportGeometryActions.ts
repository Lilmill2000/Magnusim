/**
 * The viewport's right-click on the part (host API 1.7): the shown geometry's actions
 * ("Edit in CAD") at the top of the face menu, each with its line under it (or the reason
 * it is off). A click opens the action with what was right-clicked, so the page can select
 * that face (`ws.context.launch`). runtime.js calls this from showFaceCtxMenu.
 */
import { geometryActionNotice, geometryActionsNow, openGeometryAction } from '../workspace/geometryActions';

const HOST_ATTR = 'data-geom-actions';
let busy = false;

/** What the right-click hit: a face label and a body, or null when it missed the part. */
export interface ViewportHit {
  face?: string;
  body?: string;
}

/**
 * Put the shown geometry's viewport actions in the face menu (or take them out). `close`
 * hides the menu (the app's own).
 */
export function fillViewportGeometryActions(
  menu: HTMLElement,
  o: { projectId: string; geometryId: string; geometryName: string; hit: ViewportHit | null; close: () => void },
): void {
  menu.querySelector(`[${HOST_ATTR}]`)?.remove();
  if (!o.hit || !o.projectId || !o.geometryId) return;
  const entries = geometryActionsNow(o.projectId, o.geometryId, 'viewport');
  if (!entries.length) return;
  const host = document.createElement('div');
  host.setAttribute(HOST_ATTR, o.geometryId);
  for (const entry of entries) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.setAttribute('data-face-act', 'geometry-action');
    btn.setAttribute('data-geom-action', entry.studyKind);
    btn.setAttribute('data-geom-action-plugin', entry.plugin);
    btn.disabled = !entry.enabled || busy;
    const label = document.createElement('span');
    label.textContent = entry.label;
    btn.appendChild(label);
    const line = entry.enabled ? entry.hint : entry.reason;
    if (line) {
      const sub = document.createElement('span');
      sub.className = 'face-ctx-sub';
      if (!entry.enabled) sub.setAttribute('data-geom-action-reason', '1');
      sub.textContent = line;
      btn.appendChild(sub);
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!entry.enabled || busy) return;
      busy = true;
      o.close();
      void openGeometryAction(o.projectId, o.geometryId, entry, { launch: o.hit })
        .then(async (answer) => {
          if (!answer.ok) await geometryActionNotice(answer.title || `Couldn't open ${o.geometryName}`, answer.message || '');
        })
        .finally(() => {
          busy = false;
        });
    });
    host.appendChild(btn);
  }
  const sep = document.createElement('div');
  sep.className = 'face-ctx-sep';
  host.appendChild(sep);
  menu.insertBefore(host, menu.firstChild);
}
