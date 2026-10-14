// The browser opens at most 6 connections to the app for all of its tabs, and an event
// stream holds one for as long as it is open: one per linked geometry, per job followed and
// per plugin case stream froze the app. Every stream is a channel on the tab's one stream
// (eventHub.ts openChannel), so `new EventSource(` appears in that file only. A new one
// anywhere else fails this test.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(js|ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('one event stream per tab', () => {
  it('opens an EventSource only in src/api/eventHub.ts', () => {
    const sites: string[] = [];
    for (const file of files(SRC)) {
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/\bnew\s+EventSource\s*\(/.test(line)) sites.push(`${relative(SRC, file).replace(/\\/g, '/')}:${i + 1}`);
        });
    }
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.every((s) => s.startsWith('api/eventHub.ts:')), sites.join(', ')).toBe(true);
  });
});
