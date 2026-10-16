// T6: the shortcuts the help lists are the README's, and capture file names.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SHORTCUTS } from '../src/app/shortcuts';
import { captureName } from '../src/app/capture';

describe('the keyboard shortcuts', () => {
  it("the README's table lists each one the help shows, and no other", () => {
    const md = readFileSync(join(__dirname, '..', 'README.md'), 'utf8');
    const section = md.slice(md.indexOf('## Keyboard shortcuts'), md.indexOf('## Requirements'));
    const rows = section
      .split(/\r?\n/)
      .filter((l) => l.startsWith('| ') && !l.startsWith('| Keys') && !l.startsWith('|---'))
      .map((l) => l.split('|')[1].trim());
    expect(rows.sort()).toEqual(SHORTCUTS.map((s) => s.keys).sort());
  });
});

describe('capture file names', () => {
  it('say what they are and when they were made', () => {
    expect(captureName('png', new Date(2026, 9, 14, 9, 5, 7))).toBe('tunnel-2026-10-14-0905-07.png');
    expect(captureName('webm', new Date(2026, 0, 2, 23, 59, 0))).toBe('tunnel-2026-01-02-2359-00.webm');
  });
});
