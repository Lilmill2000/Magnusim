// Edit in CAD: the line over the viewport while the Part opens a project geometry,
// with its button (Stop while it waits or downloads, Try again after an error or a
// Stop), and the note on faces that could not be matched or checked (Close hides it).
// Plain DOM on the frame's body: [data-edit-open] = loading | waiting | matching |
// error | note; [data-edit-open-action] = stop | retry | close. A button that does not
// apply is not in the DOM at all (its words never join the line's text, review N10).
// Owner: LINK (Edit in CAD).
// SPDX-License-Identifier: GPL-3.0-or-later
import type { EditOpenState } from './edit-state';
import type { StateStore } from '../types/state';

export function mountEditOpenView(state: StateStore<EditOpenState>, actions: { stop(): void; retry(): void } = { stop() {}, retry() {} }, doc: Document = document): () => void {
  const el = doc.createElement('div');
  el.className = 'cad-edit-open';
  el.setAttribute('role', 'status');
  el.hidden = true;
  const text = doc.createElement('span');
  text.setAttribute('data-edit-open-line', '1');
  const bar = doc.createElement('span');
  bar.className = 'cad-edit-open-bar';
  const fill = doc.createElement('span');
  bar.append(fill);
  const button = doc.createElement('button');
  button.type = 'button';
  button.addEventListener('click', () => {
    const kind = button.getAttribute('data-edit-open-action');
    if (kind === 'stop') actions.stop();
    else if (kind === 'retry') actions.retry();
    else state.set((s) => ({ ...s, note: null }));
  });
  el.append(text);
  doc.body.append(el);
  const draw = () => {
    const s = state.get();
    const busy = s.line && (s.phase === 'loading' || s.phase === 'waiting' || s.phase === 'matching' || s.phase === 'error' || s.phase === 'removed');
    const kind = busy ? s.phase : s.note ? 'note' : null;
    el.hidden = !kind;
    if (!kind) return;
    el.setAttribute('data-edit-open', kind);
    el.setAttribute('role', kind === 'error' || kind === 'removed' ? 'alert' : 'status');
    text.textContent = busy ? s.line : s.note;
    if (kind === 'loading' && s.fraction != null) {
      fill.style.width = `${Math.round((s.fraction ?? 0) * 100)}%`;
      if (!bar.isConnected) text.after(bar);
    } else bar.remove();
    const action = kind === 'note' ? 'close' : busy && s.action ? s.action : null;
    if (action) {
      button.setAttribute('data-edit-open-action', action);
      button.textContent = action === 'stop' ? 'Stop' : action === 'retry' ? 'Try again' : 'Close';
      if (!button.isConnected) el.append(button);
    } else button.remove();
  };
  draw();
  const off = state.subscribe(draw);
  return () => {
    off();
    el.remove();
  };
}
