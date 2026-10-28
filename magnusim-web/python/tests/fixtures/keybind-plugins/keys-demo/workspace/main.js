// The Board workspace: its commands with the keys they have now (the defaults in commands.json
// with the person's "keybinds" pref on top), and which one a key press ran. A change made in
// Settings → Keybinds reaches it as a prefs change, without a reload.
import { connect } from '@magnusim/workspace';

// commands.json's commands (the page cannot fetch the app's files from its sandboxed frame).
const COMMANDS = [
  { id: 'sketch.rectangle', label: 'Rectangle', keys: ['KeyR'] },
  { id: 'sketch.line', label: 'Line', keys: ['KeyL'] },
  { id: 'model.extrude', label: 'Extrude', keys: ['KeyE'] },
  { id: 'view.fit', label: 'Fit', keys: ['KeyF'] },
];

let mine = {};
const keysOf = (c) => (Array.isArray(mine[c.id]) ? mine[c.id] : c.keys);

/** A press as the app keeps keys: Cmd as Ctrl, a letter by the letter it types. */
function comboOf(e) {
  const letter = e.key.length === 1 && /[a-z]/i.test(e.key) ? `Key${e.key.toUpperCase()}` : e.code;
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', letter].filter(Boolean).join('+');
}

function paint() {
  const list = document.getElementById('keys-list');
  list.replaceChildren(
    ...COMMANDS.map((c) => {
      const li = document.createElement('li');
      li.dataset.command = c.id;
      li.textContent = `${c.label}: ${keysOf(c).join(', ') || 'no key'}`;
      return li;
    }),
  );
}

const ws = await connect();
window.__ws = ws;
mine = (await ws.prefs.get('keybinds')) || {};
document.getElementById('keys-title').textContent = ws.context.study.title;
paint();
ws.prefs.onChange((key, value) => {
  if (key !== 'keybinds') return;
  mine = value || {};
  paint();
});
document.addEventListener('keydown', (e) => {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
  const combo = comboOf(e);
  const hit = COMMANDS.find((c) => keysOf(c).includes(combo));
  document.getElementById('keys-ran').textContent = `Ran: ${hit ? hit.label : 'nothing'} (${combo})`;
});
