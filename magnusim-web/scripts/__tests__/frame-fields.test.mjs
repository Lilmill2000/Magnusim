import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { caseFrameFields, listFoamTimeDirs } from '../project-layout.js';

function caseWith(times, sidecar) {
  const dir = mkdtempSync(join(tmpdir(), 'frames-'));
  for (const [t, files] of Object.entries(times)) {
    mkdirSync(join(dir, t));
    for (const f of files) writeFileSync(join(dir, t, f), 'x');
  }
  if (sidecar) writeFileSync(join(dir, 'w27-case.json'), JSON.stringify(sidecar));
  return dir;
}

// A saved result frame is one with its analysis's frame fields written, so a
// run that writes only T (the stub analysis) has results too.
describe('result frames follow the case sidecar', () => {
  it('lists the times holding the frame fields the case names', () => {
    const dir = caseWith({ 1: ['T'], 2: ['U'], 3: ['T', 'U'] }, { frame_fields: ['T'] });
    assert.deepEqual([...caseFrameFields(dir)], ['T']);
    assert.deepEqual(listFoamTimeDirs(dir, { complete: true }), ['1', '3']);
  });

  it('needs U and p in a case written before the list', () => {
    const dir = caseWith({ 1: ['U', 'p'], 2: ['U'], 3: ['T'] }, { rho: 1.2 });
    assert.deepEqual([...caseFrameFields(dir)], ['U', 'p']);
    assert.deepEqual(listFoamTimeDirs(dir, { complete: true }), ['1']);
    assert.deepEqual(listFoamTimeDirs(dir), ['1', '2']);
  });

  it('ignores names that are not plain field names', () => {
    const dir = caseWith({ 1: ['T'] }, { frame_fields: ['../x', ''] });
    assert.deepEqual([...caseFrameFields(dir)], ['U', 'p']);
  });
});
