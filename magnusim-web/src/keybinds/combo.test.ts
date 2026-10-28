import { describe, expect, it } from 'vitest';
import { displayCombo, keyCode, parseCombo, typedCombo } from './combo';

const press = (key: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) => ({ key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

describe('parseCombo', () => {
  it('reads a combo however it is written, in the stored form', () => {
    const cases: [string, string][] = [
      ['ctrl+shift+r', 'Ctrl+Shift+KeyR'],
      ['Cmd+Z', 'Ctrl+KeyZ'],
      ['Shift+KeyR', 'Shift+KeyR'],
      ['shift + r', 'Shift+KeyR'],
      ['1', 'Digit1'],
      ['Ctrl+\\', 'Ctrl+Backslash'],
      ['Ctrl+PgDn', 'Ctrl+PageDown'],
      ['Alt+Shift+Ctrl+f2', 'Ctrl+Alt+Shift+F2'],
      ['Ctrl++', 'Ctrl+Equal'],
      ['esc', 'Escape'],
      ['Option+Del', 'Alt+Delete'],
    ];
    for (const [text, combo] of cases) expect(parseCombo(text), text).toEqual({ ok: true, combo });
  });

  it('says why text is no combo, in the validators words', () => {
    const notAKey = (raw: string) => `${JSON.stringify(raw)} is not a key (modifiers Ctrl, Alt, Shift, Meta in that order, then a KeyboardEvent.code such as KeyR)`;
    for (const raw of ['', 'Ctrl', 'Ctrl+R+T', 'Win+R', 'AltGr+Q', 'Ctrl+Ctrl+R', 'PgDown2', '?'])
      expect(parseCombo(raw), raw).toEqual({ ok: false, why: notAKey(raw.trim()) });
    expect(parseCombo('Ctrl+Numpad5')).toEqual({ ok: false, why: '"Ctrl+Numpad5" never comes from a press: write "Ctrl+Digit5"' });
    expect(parseCombo('NumpadEnter')).toEqual({ ok: false, why: '"NumpadEnter" never comes from a press: write "Enter"' });
  });

  it('keyCode names each key by its code', () => {
    expect([keyCode('r'), keyCode('7'), keyCode('/'), keyCode(' '), keyCode('F12'), keyCode('arrowup'), keyCode('Lang1')]).toEqual(['KeyR', 'Digit7', 'Slash', 'Space', 'F12', 'ArrowUp', '']);
  });
});

describe('displayCombo', () => {
  it('shows letters, digits and punctuation as people read them', () => {
    expect(['Ctrl+Shift+KeyR', 'Digit1', 'Ctrl+Slash', 'Delete', 'Alt+F4', 'NumpadAdd'].map(displayCombo)).toEqual(['Ctrl+Shift+R', '1', 'Ctrl+/', 'Delete', 'Alt+F4', 'NumpadAdd']);
  });
});

describe('typedCombo', () => {
  it('reads punctuation by what it types when that is another key than its place', () => {
    // A layout whose "/" is on another key: Ctrl with it still is the Assistant's key.
    expect(typedCombo(press('/', { ctrlKey: true }), 'Ctrl+Digit7')).toBe('Ctrl+Slash');
    expect(typedCombo(press('/', { ctrlKey: true }), 'Ctrl+Slash')).toBeNull();
    expect(typedCombo(press('r', { ctrlKey: true }), 'Ctrl+KeyR')).toBeNull();
    expect(typedCombo(press('F2'), 'F2')).toBeNull();
    expect(typedCombo(press('/', { metaKey: true }), 'Ctrl+Digit7')).toBe('Ctrl+Slash');
  });
});
