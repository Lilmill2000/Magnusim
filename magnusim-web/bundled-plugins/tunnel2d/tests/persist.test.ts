// A saved scene that does not read is kept aside before anything is saved over it.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { keptPath, loadScene } from '../src/app/persist';
import { defaultScene } from '../src/scene/scene';

/** A plugin folder in memory with ws.files' stat, read and write (ifMatch: null = only a new file). */
function folder(files: Record<string, string>, failWrites = false) {
  const writes: { rel: string; data: string; ifMatch: unknown }[] = [];
  const enc = new TextEncoder();
  const ws = {
    files: {
      async stat(rel: string) {
        return rel in files ? { etag: `e-${rel}` } : null;
      },
      async read(rel: string) {
        return rel in files ? enc.encode(files[rel]).buffer : null;
      },
      async write(rel: string, data: ArrayBuffer | string, opts?: { ifMatch?: string | null }) {
        if (failWrites) throw new Error('disk full');
        if (opts?.ifMatch === null && rel in files) throw Object.assign(new Error('exists'), { code: 'changed' });
        const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
        writes.push({ rel, data: text, ifMatch: opts?.ifMatch });
        files[rel] = text;
        return { etag: `e2-${rel}` };
      },
    },
  };
  return { ws: ws as never, writes, files };
}

describe('loading the scene', () => {
  it('a scene that reads is used as it is, and nothing is written', async () => {
    const good = JSON.stringify(defaultScene());
    const f = folder({ 'studies/s1/scene.json': good });
    const r = await loadScene(f.ws, 's1');
    expect(r.problem).toBe('');
    expect(r.etag).toBe('e-studies/s1/scene.json');
    expect(f.writes).toEqual([]);
  });

  it('one that does not read is copied aside, byte for byte, as a new file, before the tunnel starts', async () => {
    const bad = '{"version": 99, "bodies": []}';
    const f = folder({ 'studies/s1/scene.json': bad });
    const r = await loadScene(f.ws, 's1');
    expect(r.problem).toMatch(/newer version/);
    expect(r.kept).toMatch(/^studies\/s1\/scene-unreadable-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}\.json$/);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]).toEqual({ rel: r.kept, data: bad, ifMatch: null });
    // The original is untouched; the new scene saves over it only after this.
    expect(f.files['studies/s1/scene.json']).toBe(bad);
  });

  it('when the copy cannot be made, it says so (kept: null), and the caller saves nothing', async () => {
    const f = folder({ 'studies/s1/scene.json': 'not json' }, true);
    const r = await loadScene(f.ws, 's1');
    expect(r.problem).not.toBe('');
    expect(r.kept).toBeNull();
  });

  it('the kept name says when', () => {
    expect(keptPath('s9', new Date(2026, 10, 12, 9, 30, 5))).toBe('studies/s9/scene-unreadable-2026-11-12-0930-05.json');
  });
});
