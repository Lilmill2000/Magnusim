import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOutput } from '../w21-mesh-generate.js';

// A mesher's output goes to its Windows log one chunk at a time. Each chunk used to rewrite
// the whole log so far, so a long mesh log cost the square of its size in writes.
describe('mesh generate log', () => {
  it('writes each chunk once: bytes written grow with the output, not its square', () => {
    let appended = 0;
    let rewritten = 0;
    const io = {
      appendFileSync: (_p, s) => {
        appended += Buffer.byteLength(s);
      },
      writeFileSync: (_p, s) => {
        rewritten += Buffer.byteLength(s);
      },
    };
    const lines = [];
    const out = generateOutput('mesh.log', (l) => lines.push(l), io);
    const chunk = 'Meshing surface 1 of 1 (step 12) ...........\n';
    for (let i = 0; i < 2000; i++) out.add(Buffer.from(chunk));
    const total = Buffer.byteLength(chunk) * 2000;
    assert.equal(appended, total);
    assert.equal(rewritten, 0, 'no whole-log rewrite while output streams');
    assert.equal(lines.length, 2000);
    out.save();
    assert.equal(rewritten, total, 'one rewrite at the end');
  });

  it('keeps the log, its text and its lines whole, with lines split across chunks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-log-'));
    try {
      const log = join(dir, 'generate.log');
      writeFileSync(log, '', 'utf8');
      const lines = [];
      const out = generateOutput(log, (l) => lines.push(l));
      out.add(Buffer.from('{"kind":"progress","st'));
      out.add('age":"gmsh"}\r\nline two\nRESULT {"ok":');
      out.add('true}');
      assert.deepEqual(lines, ['{"kind":"progress","stage":"gmsh"}', 'line two']);
      out.flushCarry();
      assert.deepEqual(lines.slice(2), ['RESULT {"ok":true}']);
      out.note('\nCOUNT_PARSE_ERROR: x\n');
      assert.equal(lines.length, 3, 'a note is not parsed as output');
      const want = '{"kind":"progress","stage":"gmsh"}\r\nline two\nRESULT {"ok":true}\nCOUNT_PARSE_ERROR: x\n';
      assert.equal(out.text(), want);
      assert.equal(readFileSync(log, 'utf8'), want);
      out.save();
      assert.equal(readFileSync(log, 'utf8'), want);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is what both generators write their output with', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'w21-mesh-generate.js'), 'utf8');
    assert.equal(src.split('generateOutput(winLog, flushParsedLine)').length - 1, 2);
    assert.doesNotMatch(src, /writeFileSync\(winLog, logBuf/);
  });
});
