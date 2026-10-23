/**
 * The notice of a save refused as stale (phase 5, C2 §6.5): the Assistant's copy when this
 * window heard it write the record within 60 s, another app's, else another window's; one
 * button, through confirmAction as a notice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const confirmAction = vi.fn(async (_o: unknown) => true);
vi.mock('./dialogs', () => ({ confirmAction: (o: unknown) => confirmAction(o) }));
const heard = vi.fn((_kind: string, _id: string): 'assistant' | 'app' | null => null);
vi.mock('./uiSync', () => ({ heardWrite: (kind: string, id: string) => heard(kind, id) }));

import { releaseFocus, showStaleNotice, staleCopy, STALE_OK, STALE_TITLE } from './staleNotice';

afterEach(() => {
  confirmAction.mockClear();
  heard.mockReset();
  heard.mockImplementation(() => null);
});

describe('the copy', () => {
  it('names the Assistant when it wrote the record', () => {
    expect(staleCopy('bc', 'Inlet', 'assistant')).toBe(
      'The Assistant changed boundary condition "Inlet" while you were editing it. Your change was not saved. The panel now shows the saved values. Make your change again if you still want it.',
    );
  });

  it('says another window otherwise', () => {
    expect(staleCopy('bc', 'Inlet', null)).toBe(
      'Boundary condition "Inlet" was changed in another window while you were editing it. Your change was not saved. The panel now shows the saved values. Make your change again if you still want it.',
    );
  });

  it('says another app for an MCP client or a coding agent', () => {
    expect(staleCopy('mesh', 'Mesh 1', 'app')).toMatch(/^Another app on this PC changed mesh "Mesh 1" while you were editing it\. Your change was not saved\./);
  });

  it('names each kind, and one with no name', () => {
    expect(staleCopy('material', 'Air', null)).toMatch(/^Material "Air" was changed/);
    expect(staleCopy('refinement', 'Wall', null)).toMatch(/^Mesh refinement "Wall" was changed/);
    expect(staleCopy('run', 'Run 1', 'assistant')).toMatch(/^The Assistant changed run "Run 1"/);
    expect(staleCopy('mesh', '', null)).toMatch(/^This mesh was changed in another window/);
    expect(staleCopy('bc_defaults', '', null)).toMatch(/^The boundary condition defaults were changed in another window while you were editing them\./);
  });
});

describe('the notice', () => {
  it('is one button through confirmAction, with who wrote it', async () => {
    heard.mockImplementation(() => 'assistant');
    await showStaleNotice('bc', 'bc-7', 'Inlet');
    expect(heard).toHaveBeenCalledWith('bc', 'bc-7');
    expect(confirmAction).toHaveBeenCalledWith({ title: STALE_TITLE, copy: staleCopy('bc', 'Inlet', 'assistant'), yes: STALE_OK, notice: true });
    expect(STALE_TITLE).toBe('Not saved: changed elsewhere');
    expect(STALE_OK).toBe('OK');
  });
});

describe('releaseFocus', () => {
  it('blurs the field the person was in, so it commits nothing once the panel reloads', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      input.focus();
      expect(document.activeElement).toBe(input);
      releaseFocus();
      expect(document.activeElement).not.toBe(input);
      releaseFocus();
    } finally {
      input.remove();
    }
  });
});
