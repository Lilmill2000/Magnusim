import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJsonBody, readBinaryBody, assertSameOrigin } from '../http.ts';
import { WorkerClient } from '../worker.ts';
import { safeProjectPath, pathIsWithin } from '../../safe-path.js';
import { sanitizeFolderName, caseUnderOwner } from '../../project-layout.js';
import { caseDirBelongsToProject, PROJECTS_ROOT } from '../../project-isolation.js';

describe('release safety', () => {
  it('blocks foreign browser origins while permitting same-origin and CLI clients', () => {
    assert.doesNotThrow(() => assertSameOrigin({ headers: {host: 'localhost:8082'} }));
    assert.doesNotThrow(() => assertSameOrigin({ headers: {host: 'localhost:8082', origin: 'http://localhost:8082'} }));
    assert.throws(() => assertSameOrigin({ headers: {host: 'localhost:8082', origin: 'https://example.org'} }), { status: 403 });
    assert.throws(() => assertSameOrigin({ headers: {host: 'localhost:8082', 'sec-fetch-site': 'cross-site'} }), { status: 403 });
  });
  it('rejects traversal, absolute project ids and sibling-prefix paths', () => {
    for (const id of ['..', '../other', 'a/../../other', 'C:\\other', 'trailing.']) {
      assert.throws(() => safeProjectPath(tmpdir(), id));
    }
    const root = join(tmpdir(), 'owner');
    assert.equal(pathIsWithin(join(root, '..', 'other'), root), false);
    assert.equal(caseUnderOwner(join(root, '..', 'owner-other'), root), false);
    assert.equal(caseDirBelongsToProject(join(PROJECTS_ROOT, 'audit', 'case'), 'audit'), true);
    assert.equal(caseDirBelongsToProject(join(tmpdir(), 'outside', 'projects', 'audit', 'case'), 'audit'), false);
  });
  it('makes dot-only and reserved Windows folder names safe', () => {
    for (const name of ['.', '..', '...', 'NUL', 'COM1', 'con.txt']) {
      assert.equal(sanitizeFolderName(name, 'Study'), 'Study');
    }
    assert.equal(sanitizeFolderName('Study name.'), 'Study_name');
  });
  it('rejects malformed JSON and limits buffered request size', async () => {
    const bad = new PassThrough();
    const result = readJsonBody(bad);
    bad.end('{');
    await assert.rejects(result, { status: 400 });
    const large = new PassThrough();
    const bytes = readBinaryBody(large, 3);
    large.end('1234');
    await assert.rejects(bytes, { status: 413 });
  });
  it('rejects an unavailable Python executable without hanging or uncaught events', async () => {
    const worker = new WorkerClient({ python: join(tmpdir(), 'missing-magnusim-python.exe'), maxDeaths: 1, timeoutMs: 300 });
    try { await assert.rejects(worker.call('worker.ping'), /worker|ENOENT/i); }
    finally { worker.stop(); }
  });
});
