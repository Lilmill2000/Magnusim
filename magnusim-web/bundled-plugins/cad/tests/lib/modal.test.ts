// In-frame modal dialogs (review P2/P3 round 2): Tab goes round the dialog's buttons, never out of
// it; while one is open the workspace keyboard runs no shortcut, and a Tab that reaches the page
// outside it goes back into it. Reload words: what a Reload after a conflict dropped from this tab.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKeyboard } from '../../src/app/keyboard';
import { openModal, trapDialogKeys } from '../../src/lib/modal';
import { reloadWords } from '../../src/ui/StatusDock';

function dialog(labels: string[]) {
  const d = document.createElement('dialog');
  for (const l of labels) {
    const b = document.createElement('button');
    b.textContent = l;
    d.appendChild(b);
  }
  document.body.appendChild(d);
  d.setAttribute('aria-modal', 'true');
  d.setAttribute('open', '');
  return { d, buttons: [...d.querySelectorAll('button')] };
}

const press = (el: Element, key: string, shiftKey = false) => el.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('modal dialogs', () => {
  it('Tab and Shift+Tab go round the buttons; Escape calls back; keys stay in the dialog', () => {
    const { d, buttons } = dialog(['Cancel', 'Make it driven']);
    const esc = vi.fn();
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    const off = trapDialogKeys(d, esc);
    buttons[1].focus();
    press(buttons[1], 'Tab');
    expect(document.activeElement).toBe(buttons[0]);
    press(buttons[0], 'Tab');
    expect(document.activeElement).toBe(buttons[1]);
    press(buttons[1], 'Tab', true);
    expect(document.activeElement).toBe(buttons[0]);
    press(buttons[0], 'Tab', true);
    expect(document.activeElement).toBe(buttons[1]);
    press(buttons[1], 'Escape');
    expect(esc).toHaveBeenCalledTimes(1);
    expect(outside).not.toHaveBeenCalled();
    off();
    document.removeEventListener('keydown', outside);
  });

  it('the workspace keyboard runs no shortcut while a modal dialog is open; a Tab outside it goes into it', () => {
    const kb = createKeyboard(document);
    const run = vi.fn(() => true);
    kb.bind({ combo: '1', run });
    kb.bind({ combo: 'Delete', run });
    press(document.body, '1');
    expect(run).toHaveBeenCalledTimes(1);
    const { d, buttons } = dialog(['Delete feature', 'Cancel']);
    expect(openModal(document)).toBe(d);
    press(document.body, '1');
    press(document.body, 'Delete');
    expect(run).toHaveBeenCalledTimes(1);
    press(document.body, 'Tab');
    expect(document.activeElement).toBe(buttons[0]);
    d.removeAttribute('open');
    expect(openModal(document)).toBeNull();
    press(document.body, 'Delete');
    expect(run).toHaveBeenCalledTimes(2);
    kb.dispose();
  });
});

describe('reload words', () => {
  it('names the features made in this tab that the reload dropped', () => {
    const after = { features: [{ id: 'a' }, { id: 'b' }] };
    expect(reloadWords({ features: [{ id: 'a', name: 'Box 1' }, { id: 'c', name: 'Cylinder 1' }] }, after)).toBe("Reloaded the other tab's version: Cylinder 1, made in this tab and not saved, is gone.");
    expect(reloadWords({ features: [{ id: 'c', name: 'Cylinder 1' }, { id: 'd', name: 'Box 3' }, { id: 'e', name: 'Box 4' }] }, after)).toBe(
      "Reloaded the other tab's version: Cylinder 1, Box 3 and Box 4, made in this tab and not saved, are gone.",
    );
    expect(reloadWords({ features: [{ id: 'a', name: 'Box 1' }] }, after)).toBe("Reloaded the other tab's version: this tab's changes that were not saved are gone.");
  });
});
