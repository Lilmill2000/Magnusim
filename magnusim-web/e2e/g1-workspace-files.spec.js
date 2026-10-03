import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHost } from './support/host-server.mjs';

// G1, a plugin's binary files (ws.files) as a workspace uses them: a 40 MB file
// written from the sandboxed frame arrives on disk byte for byte (SHA-256) with
// progress, reads back the same, lists with its etag, follows a conditional write
// (ifMatch), stops at the plugin's cap without leaving anything behind, never
// writes a study's record, and deletes. A second app server with the ws-demo
// fixture ([files] max_file_mb = 48, max_total_mb = 96).
const PROJECT = 'sample-project-steady-state-e2e';
const KEY = 'ws-demo';
const MB = 1024 * 1024;

function stage(t0, msg) {
  console.log(`[g1 +${Math.round((Date.now() - t0) / 1000)}s] ${msg}`);
}

test('gate:g1-workspace-files a workspace stores, reads, guards and deletes large files in its project', async ({ page, request }) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const t0 = Date.now();
  const host = await startHost({ name: 'g1', pluginsFrom: 'python/tests/fixtures/workspace-plugins' });
  const { base, projects } = host;
  const pluginRoot = join(projects, PROJECT, 'plugins', KEY);
  const onDisk = (rel) => join(pluginRoot, ...rel.split('/'));
  const sha = (buf) => createHash('sha256').update(buf).digest('hex');
  try {
    const made = await request.post(`${base}/api/plugin-studies/create`, { data: { project_id: PROJECT, plugin: KEY, kind: 'bench_case', title: 'Big files' } });
    const study = (await made.json()).study;
    await page.goto(`${base}/#/p/${PROJECT}/ws/${KEY}/bench/${study.id}`);
    await expect(page.frameLocator('#workspace-frame').locator('#bench-title')).toHaveText('Big files', { timeout: 60_000 });
    const frame = page.frames().find((f) => f.url().includes(`/plugins/${KEY}/workspace/`));
    expect(frame, 'workspace frame').toBeTruthy();
    expect(await frame.evaluate(() => window.__ws.context.hostVersion)).toBe('1.5');
    stage(t0, 'workspace open');

    // 40 MB from an ArrayBuffer: progress, the file on disk, the same bytes back.
    const rel = `studies/${study.id}/imports/part.step`;
    const wrote = await frame.evaluate(async ({ rel, size }) => {
      const ws = window.__ws;
      const data = new Uint8Array(size);
      for (let off = 0; off < size; off += 65536) crypto.getRandomValues(data.subarray(off, Math.min(size, off + 65536)));
      const progress = [];
      const result = await ws.files.write(rel, data.buffer, { onProgress: (done, total) => progress.push([done, total]) });
      const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
      const own = hex(await crypto.subtle.digest('SHA-256', data));
      const back = await ws.files.read(rel);
      const backHash = hex(await crypto.subtle.digest('SHA-256', back));
      const stat = await ws.files.stat(rel);
      const list = await ws.files.list(`studies/${ws.context.study.id}`);
      return { result, progress, own, backHash, backSize: back.byteLength, stat, list, callerIntact: data.byteLength };
    }, { rel, size: 40 * MB });
    expect(wrote.result).toMatchObject({ rel, size: 40 * MB });
    expect(wrote.result.sha256).toBe(wrote.own);
    expect(wrote.backHash).toBe(wrote.own);
    expect(wrote.backSize).toBe(40 * MB);
    expect(wrote.callerIntact).toBe(40 * MB);
    expect(wrote.progress.length).toBeGreaterThanOrEqual(3);
    expect(wrote.progress[wrote.progress.length - 1]).toEqual([40 * MB, 40 * MB]);
    expect(wrote.stat).toMatchObject({ rel, size: 40 * MB, etag: wrote.result.etag });
    expect(wrote.list.map((f) => f.rel)).toContain(rel);
    expect(sha(readFileSync(onDisk(rel)))).toBe(wrote.own);
    stage(t0, '40 MB written, read back and hashed');

    // A Blob write, then conditional writes with the etag.
    const cond = await frame.evaluate(async ({ rel }) => {
      const ws = window.__ws;
      const refused = (p) => p.then(() => 'written', (e) => e.code || e.message);
      const first = await ws.files.write(`${rel}.meta.json`, new Blob([JSON.stringify({ v: 1 })], { type: 'application/json' }));
      const second = await ws.files.write(`${rel}.meta.json`, new Blob([JSON.stringify({ v: 2 })]), { ifMatch: first.etag });
      return {
        stale: await refused(ws.files.write(`${rel}.meta.json`, new Blob(['{"v":3}']), { ifMatch: first.etag })),
        createOnly: await refused(ws.files.write(`${rel}.meta.json`, new Blob(['{"v":4}']), { ifMatch: null })),
        current: await refused(ws.files.write(`${rel}.meta.json`, new Blob(['{"v":5}']), { ifMatch: second.etag })),
        viaData: await ws.data.read(`${rel}.meta.json`),
      };
    }, { rel });
    expect(cond).toEqual({ stale: 'changed', createOnly: 'changed', current: 'written', viaData: { v: 5 } });
    stage(t0, 'conditional writes');

    // Over the plugin's cap (48 MB a file): refused, nothing left behind.
    const over = await frame.evaluate(async () => {
      const ws = window.__ws;
      return ws.files.write('big/over.bin', new Blob([new Uint8Array(60 * 1024 * 1024)])).then(() => 'written', (e) => e.code);
    });
    expect(over).toBe('too_large');
    expect(existsSync(onDisk('big/over.bin'))).toBe(false);
    const staging = join(pluginRoot, '.magnusim-staging');
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
    stage(t0, 'cap enforced, nothing left behind');

    // A study's record is never written as a file; the record stays as it was.
    const recordPath = onDisk(`studies/${study.id}/study.json`);
    const before = readFileSync(recordPath);
    const record = await frame.evaluate(async (sid) => {
      const ws = window.__ws;
      const refused = (p) => p.then(() => 'written', (e) => e.code);
      return [
        await refused(ws.files.write(`studies/${sid}/study.json`, new Blob(['{}']))),
        await refused(ws.files.write(`Studies/${sid}/Study.JSON`, new Blob(['{}']))),
        await refused(ws.files.delete(`studies/${sid}`, { recursive: true })),
      ];
    }, study.id);
    expect(record).toEqual(['study_record', 'study_record', 'study_record']);
    expect(readFileSync(recordPath).equals(before)).toBe(true);
    stage(t0, 'study record refused');

    // Delete: gone on disk and from the list.
    const del = await frame.evaluate(async ({ rel }) => {
      const ws = window.__ws;
      const out = await ws.files.delete(rel);
      const list = await ws.files.list('');
      return { out, listed: list.map((f) => f.rel), missing: await ws.files.read(rel) };
    }, { rel });
    expect(del.out).toEqual({ deleted: 1 });
    expect(del.listed).not.toContain(rel);
    expect(del.missing).toBeNull();
    expect(existsSync(onDisk(rel))).toBe(false);
    stage(t0, 'deleted');
  } finally {
    host.stop();
  }
});
