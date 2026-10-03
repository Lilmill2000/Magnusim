// An in-frame <dialog> for non-destructive choices (design-language §5.15,
// §7.5: the host's confirm is only for destructive actions and its button is
// always red). Focus starts on Cancel, and Enter or Escape there cancels;
// keys inside the dialog never reach the workspace's own shortcuts.
// Owner: P2-FEATURES.
// SPDX-License-Identifier: GPL-3.0-or-later
import { trapDialogKeys } from '../../lib/modal';
import { buttonClass } from '../../ui/kit/Button';

export interface DialogChoice {
  id: string;
  label: string;
}

export function askChoice(opts: { title: string; message: string; choices: DialogChoice[]; cancelLabel?: string; doc?: Document }): Promise<string | null> {
  const doc = opts.doc ?? document;
  const dlg = doc.createElement('dialog');
  dlg.className = 'cad-dialog';
  dlg.setAttribute('data-cad-dialog', '1');
  dlg.setAttribute('aria-labelledby', 'cad-dialog-title');
  dlg.setAttribute('aria-modal', 'true');
  const card = doc.createElement('div');
  card.className = 'cad-dialog-card';
  const h = doc.createElement('h2');
  h.id = 'cad-dialog-title';
  h.textContent = opts.title;
  const p = doc.createElement('p');
  p.textContent = opts.message;
  const actions = doc.createElement('div');
  actions.className = 'cad-dialog-actions';
  card.append(h, p, actions);
  dlg.appendChild(card);
  return new Promise((resolve) => {
    let settled = false;
    const close = (v: string | null) => {
      if (settled) return;
      settled = true;
      if (typeof dlg.close === 'function' && dlg.open) dlg.close();
      dlg.remove();
      resolve(v);
    };
    for (const c of opts.choices) {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = buttonClass('secondary');
      b.textContent = c.label;
      b.setAttribute('data-dialog-choice', c.id);
      b.addEventListener('click', () => close(c.id));
      actions.appendChild(b);
    }
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = buttonClass('secondary');
    cancel.textContent = opts.cancelLabel ?? 'Cancel';
    cancel.setAttribute('data-dialog-choice', 'cancel');
    cancel.addEventListener('click', () => close(null));
    actions.appendChild(cancel);
    // The workspace's shortcuts (Delete, Escape, Ctrl+Z, the view keys) must not act behind the
    // dialog, and Tab goes round its buttons (review P2/P3 round 2: Tab from Cancel left the frame,
    // then 1 turned the view and Delete opened a second dialog on top).
    trapDialogKeys(dlg, () => close(null));
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });
    doc.body.appendChild(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    cancel.focus();
  });
}
