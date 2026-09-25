import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { readJsonBody } from '../http.ts';

test('media upload, Unicode download, byte ranges, rename and index containment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'magnusim-media-'));
  const previous = process.env.MAGNUSIM_PROJECTS_ROOT;
  process.env.MAGNUSIM_PROJECTS_ROOT = root;
  const { handleW28Api } = await import('../../w28-media.js');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      await handleW28Api(req, res, url, url.pathname.split('/').filter(Boolean), {
        readJsonBody,
        sendJson: (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); return true; },
      });
    } catch (error) { res.writeHead(error.status || 500); res.end(String(error)); }
  });
  try {
    mkdirSync(join(root, 'test-project'));
    writeFileSync(join(root, 'active.json'), JSON.stringify({ project_id: 'other-project' }));
    const { createGeometryFolder, createStudyFolder, createRunFolder } = await import('../../project-layout.js');
    const project = join(root, 'test-project');
    createGeometryFolder(project, { id: 'g', name: 'G', original_filename: 'G' });
    createStudyFolder(project, 'g', { id: 'study-a', name: 'A' });
    createStudyFolder(project, 'g', { id: 'study-b', name: 'B' });
    const owned = createRunFolder(project, 'study-a', { id: 'test', name: 'Run test' });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const query = 'project_id=test-project&owner=run-test&simulation_id=study-a';
    assert.equal((await fetch(`${base}/api/media/list?project_id=test-project&owner=run-test`)).status, 400);
    const uploaded = await fetch(`${base}/api/media/upload?${query}&name=${encodeURIComponent('测试')}`, { method: 'POST', body: '0123456789' });
    assert.equal(uploaded.status, 200);
    const { item } = await uploaded.json();
    const url = `${base}/api/media/file?${query}&id=${item.id}&download=1`;
    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.match(full.headers.get('content-disposition'), /filename\*=UTF-8''%/);
    assert.equal(await full.text(), '0123456789');
    const suffix = await fetch(url, { headers: { Range: 'bytes=-3' } });
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get('content-range'), 'bytes 7-9/10');
    assert.equal(await suffix.text(), '789');
    const invalid = await fetch(url, { headers: { Range: 'bytes=20-30' } });
    assert.equal(invalid.status, 416);
    const renamed = await fetch(`${base}/api/media/rename`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: 'test-project', simulation_id: 'study-a', owner: 'run-test', id: item.id, name: 'Renamed' }) });
    assert.equal((await renamed.json()).item.name, 'Renamed');
    const invalidProject = await fetch(`${base}/api/media/list?project_id=../test-project&owner=run-test`);
    assert.equal(invalidProject.status, 400);
    writeFileSync(join(owned.dir, 'media', 'index.json'), JSON.stringify([{ id: 'escape', file: '../../../active.json' }]));
    assert.equal((await fetch(`${base}/api/media/file?${query}&id=escape`)).status, 404);

    const ownedRun = createRunFolder(project, 'study-a', { id: 'runA', name: 'Run A' });
    const scoped = 'project_id=test-project&owner=run-runA&simulation_id=study-a';
    const uploadedScoped = await fetch(`${base}/api/media/upload?${scoped}&name=shot`, { method: 'POST', body: 'abc' });
    assert.equal(uploadedScoped.status, 200);
    const listedA = await (await fetch(`${base}/api/media/list?${scoped}`)).json();
    assert.equal(listedA.items.length, 1);
    const listedB = await (await fetch(`${base}/api/media/list?project_id=test-project&owner=run-runA&simulation_id=study-b`)).json();
    assert.deepEqual(listedB.items, []);
    assert.equal((await fetch(`${base}/api/media/file?${scoped}&id=${listedA.items[0].id}`)).status, 200);
    assert.equal(existsSync(join(ownedRun.dir, 'media', 'index.json')), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.MAGNUSIM_PROJECTS_ROOT; else process.env.MAGNUSIM_PROJECTS_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
