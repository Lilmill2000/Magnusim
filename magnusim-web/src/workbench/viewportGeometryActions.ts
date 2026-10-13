/**
 * The viewport's right-click on the part (host API 1.7): the shown geometry's actions
 * ("Edit in CAD") at the top of the face menu, each with its line under it (or the reason
 * it is off). A click opens the action with what was right-clicked, so the page can select
 * that face (`ws.context.launch`). runtime.js calls this from showFaceCtxMenu.
 *
 * The actions come from the project tree's last read. Right after a project opens, the
 * part can be drawn (and right-clicked) before that read lands: the menu then opens
 * without them, and puts them in when the read comes, while it is still open.
 */
import { geometryActionNotice, geometryActionsNow, openGeometryAction, subscribeGeometryActions } from '../workspace/geometryActions';

const HOST_ATTR = 'data-geom-actions';
let busy = false;

/** What the right-click hit: a face label and a body, or null when it missed the part. */
export interface ViewportHit {
  face?: string;
  body?: string;
}

type FillOpts = { projectId: string; geometryId: string; geometryName: string; hit: ViewportHit | null; close: () => void };

/** The menu last filled, so a tree read that lands while it is open can fill it again. */
let lastFill: { menu: HTMLElement; o: FillOpts } | null = null;

/**
 * Put the shown geometry's viewport actions in the face menu (or take them out). `close`
 * hides the menu (the app's own).
 */
export function fillViewportGeometryActions(menu: HTMLElement, o: FillOpts): void {
  lastFill = { menu, o };
  // The listeners are a set: hearing again is a no-op (and survives a test's reset).
  subscribeGeometryActions(refreshOpenMenu);
  fillNow(menu, o);
}

/** A tree read landed: the menu, if it is still open, gets the actions it now knows. */
function refreshOpenMenu(): void {
  const last = lastFill;
  if (!last || last.menu.hidden || !last.menu.isConnected) return;
  fillNow(last.menu, last.o);
  // Taller now: keep it inside the viewport, as the menu's own placement does.
  const box = last.menu.offsetParent as HTMLElement | null;
  if (box) {
    const top = Math.min(last.menu.offsetTop, box.clientHeight - last.menu.offsetHeight - 8);
    last.menu.style.top = `${Math.max(8, top)}px`;
  }
}

function fillNow(menu: HTMLElement, o: FillOpts): void {
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
