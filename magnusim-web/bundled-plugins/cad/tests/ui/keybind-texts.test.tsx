// Words that name a key name the person's key (review: some still named the fixed default): the
// delete toast's Undo, the Assistant chip's Undo, Line's hint (3-point arc's key makes the tangent
// arc), and the tools' hints that name Place or finish's key (Enter by default); a cleared key is
// left out of the words.
// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it } from 'vitest';
import { keybindsFor } from '../../src/app/keybinds';
import { chipButtons } from '../../src/assistant/AssistantChip';
import { placeKey } from '../../src/sketch/tools/place-key';
import { uiFor } from '../../src/ui/controller';
import type { AppServices } from '../../src/types/app';
import type { AssistantUiState } from '../../src/types/assistant';
import { makeServices } from './fake-doc';

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
});

describe("words that name a key follow the person's keybinds", () => {
  it("the delete toast names Undo's key now (none when cleared)", async () => {
    const t = makeServices();
    const ui = uiFor(t.services);
    dispose = () => ui.dispose();
    const k = keybindsFor(t.services);
    const deleteWithBrokenDependent = () => {
      const a = t.doc.seed('extrude', { name: 'Base' });
      const b = t.doc.seed('extrude', { name: 'Boss' });
      t.doc.setStatus(b.id, null);
      // The rebuild after the delete (later, as the real one): Boss fails without Base.
      const off = t.doc.state.subscribe((s, prev) => {
        if (prev.doc.features.some((f) => f.id === a.id) && !s.doc.features.some((f) => f.id === a.id)) {
          off();
          queueMicrotask(() => t.doc.setStatus(b.id, { state: 'error', message: 'Base is gone' } as never));
        }
      });
      ui.deleteFeature(a.id);
      return new Promise((r) => setTimeout(r, 0));
    };
    k.setKeybind('edit.undo', 'Ctrl+U');
    await deleteWithBrokenDependent();
    expect(t.ws.log.toasts.at(-1)).toEqual({ message: 'Deleted Base: Boss fails without it. Undo (Ctrl+U) brings Base back.', kind: 'error' });
    k.clear('edit.undo');
    await deleteWithBrokenDependent();
    expect(t.ws.log.toasts.at(-1)!.message).toMatch(/fails without it\. Undo brings Base back\.$/);
  });

  it("the Assistant chip's Undo names Undo's key", () => {
    const ended = { phase: 'ended', turn: { id: 't1' } } as unknown as AssistantUiState;
    expect(chipButtons(ended, true, false).find((b) => b.id === 'undo')!.title).toBe("Undo the Assistant's changes of this request (one Ctrl+Z)");
    expect(chipButtons(ended, true, false, 'Ctrl+U').find((b) => b.id === 'undo')!.title).toBe("Undo the Assistant's changes of this request (one Ctrl+U)");
    expect(chipButtons(ended, true, false, null).find((b) => b.id === 'undo')!.title).toBe("Undo the Assistant's changes of this request (one Undo)");
  });

  it("the tools' hints name Place or finish's key", () => {
    const services = { bridge: { prefs: null } } as unknown as AppServices;
    const k = keybindsFor(services);
    expect(placeKey({ services })).toBe('Enter or ');
    k.setKeybind('sketch.enter', 'Space');
    expect(placeKey({ services })).toBe('Space or ');
    k.clear('sketch.enter');
    expect(placeKey({ services })).toBe('');
  });
});
