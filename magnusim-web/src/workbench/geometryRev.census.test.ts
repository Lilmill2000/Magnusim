// The census of the client's saves of face- and body-carrying records (host API 1.5,
// LINK proposal 5.16): every POST of a boundary condition, a material, a refinement or a
// run's settings, and every bcs.set and materials.set, goes through geometryRev.ts: it is
// stamped (withGeometryRev / stampRecords, or postLinkedSave, which stamps) and its
// refusals are handled (fetchLinkedSave / linkedWorkerRpc / postLinkedSave). A site that
// is never stamp-checked (a delete, the wall default) says why with a `census:` comment.
// A new save site that does neither fails this test until someone decides.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const SAVE_URL = /'\/api\/(bcs|materials|mesh-refinements|mesh\/refinements|run\/update)'/;
const SAVE_RPC = /\b(workerRpc|linkedWorkerRpc)(<[^>]*>)?\(\s*'(bcs|materials)\.set'/;
const CALL = /\b(fetch|fetchLinkedSave|apiPost|postJson|postLinkedSave)\(\s*'\/api\/(bcs|materials|mesh-refinements|mesh\/refinements|run\/update)'/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.(js|ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

interface Site {
  file: string;
  line: number;
  text: string;
  ok: boolean;
  why: string;
}

function census(): Site[] {
  const sites: Site[] = [];
  for (const file of files(SRC)) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      const call = CALL.exec(text);
      const rpc = SAVE_RPC.exec(text);
      if (!call && !rpc) return;
      if (call && call[1] === 'fetch') {
        // A read (GET) has no method and no body.
        const next = lines.slice(i, i + 5).join('\n');
        if (!/method:\s*'POST'|body:/.test(next)) return;
      }
      const around = lines.slice(Math.max(0, i - 16), i + 8).join('\n');
      const before = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      let ok = false;
      let why = '';
      if (/census:/.test(before)) {
        ok = true;
        why = 'reviewed: ' + (before.match(/census:\s*([^\n]*)/) || ['', ''])[1];
      } else if (call && call[1] === 'postLinkedSave') {
        ok = true;
        why = 'postLinkedSave stamps and handles refusals';
      } else {
        const handled = (call && call[1] === 'fetchLinkedSave') || (rpc && rpc[1] === 'linkedWorkerRpc');
        const stamped = /withGeometryRev\(|stampRecords\(/.test(around);
        ok = !!handled && stamped;
        why = `${handled ? '' : 'refusals not handled; '}${stamped ? '' : 'not stamped'}`;
      }
      sites.push({ file: relative(SRC, file).replace(/\\/g, '/'), line: i + 1, text: text.trim(), ok, why });
    });
  }
  return sites;
}

describe('the census of face-record saves', () => {
  it('finds the save sites it knows of', () => {
    const where = census().map((s) => `${s.file}:${(SAVE_URL.exec(s.text) || SAVE_RPC.exec(s.text) || ['', ''])[0]}`);
    for (const want of [
      "workbench/runtime.js:'/api/materials'",
      "workbench/runtime.js:'/api/bcs'",
      "workbench/setupPersist.js:linkedWorkerRpc('bcs.set'",
      "workbench/hostWrites.js:'/api/mesh/refinements'",
      "workbench/hostWrites.js:'/api/run/update'",
      "panels/materials/MaterialsPanel.tsx:linkedWorkerRpc<{ materials?: SavedMaterial[]; air?: SavedMaterial }>('materials.set'",
    ]) {
      expect(where).toContain(want);
    }
    // (The dead materials editor of 18443ac and its save are gone: nine sites.)
    expect(census().length).toBeGreaterThanOrEqual(9);
  });

  it('stamps every one and handles its refusals, or says why it need not', () => {
    const bad = census().filter((s) => !s.ok);
    expect(bad.map((s) => `${s.file}:${s.line} ${s.why}: ${s.text}`)).toEqual([]);
  });

  it("postLinkedSave stamps what it sends (the census trusts it)", () => {
    const text = readFileSync(join(SRC, 'workbench', 'hostWrites.js'), 'utf8');
    const def = text.slice(text.indexOf('async function postLinkedSave'), text.indexOf('export async function postRefinements'));
    expect(def).toMatch(/fetchLinkedSave\(/);
    expect(def).toMatch(/withGeometryRev\(/);
  });
});
