// The coding agents' and the MCP server's modules (scripts/server/assistant/agents/**,
// mcp/**, and privacy.ts) export nothing that nothing uses: an export no code names, in its
// own file or any other (scripts, src, e2e), is dead code that drifts from what it was for.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ASSISTANT = join(WEB, 'scripts', 'server', 'assistant');
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'build', 'dist', 'test-results', 'playwright-report']);
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
/** Exports written before phase 3, outside this check: Foundation's own. */
const KNOWN = new Set(['privacy.ts:forgetAll']);

/** Code files under `dir`; no node_modules, builds or dot folders. */
function codeFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...codeFiles(p));
    else if (e.isFile() && CODE.test(e.name)) out.push(p);
  }
  return out;
}

/** The names a module exports by declaration (`export function x`, `export const x`, ...). */
function exportedNames(text) {
  return [...text.matchAll(/^export (?:declare )?(?:async )?(?:function\*? |const |let |class |interface |type |enum )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
}

/**
 * Exports of `modules` that no file of `corpus` names: none outside its own file, and its own
 * file names it only where it declares it. `corpus` maps a path to its text.
 */
function unusedExports(modules, corpus) {
  const out = [];
  for (const m of modules) {
    const own = corpus.get(m);
    for (const name of exportedNames(own)) {
      const word = new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
      if ((own.match(word) ?? []).length > 1) continue;
      let named = false;
      for (const [p, text] of corpus) {
        if (p === m) continue;
        word.lastIndex = 0;
        if (word.test(text)) {
          named = true;
          break;
        }
      }
      if (!named) out.push(`${relative(ASSISTANT, m).split('\\').join('/')}:${name}`);
    }
  }
  return out;
}

describe('assistant exports: self-test', () => {
  it('finds an export nothing names, and passes one its own file or another file uses', () => {
    const corpus = new Map([
      ['/a.ts', 'export function used() {}\nexport const ALONE = 1;\nexport type Kept = string;\nconst k: Kept = "";\nexport async function* gen() {}\n'],
      ['/b.ts', "import { used } from './a.ts';\nused();\n// gen() named in a comment counts as named\n"],
    ]);
    assert.deepEqual(unusedExports(['/a.ts'], corpus).map((n) => n.slice(n.lastIndexOf(':') + 1)), ['ALONE']);
  });
});

describe('assistant exports in this tree', () => {
  it("the coding agents' and the MCP server's modules export nothing that nothing uses", () => {
    const corpus = new Map();
    for (const dir of ['scripts', 'src', 'e2e']) for (const p of codeFiles(join(WEB, dir))) corpus.set(p, readFileSync(p, 'utf8'));
    const modules = [...codeFiles(join(ASSISTANT, 'agents')), ...codeFiles(join(ASSISTANT, 'mcp')), join(ASSISTANT, 'privacy.ts')].filter((p) => p.endsWith('.ts'));
    assert.ok(modules.length > 10, `the modules were found (${modules.length})`);
    const unused = unusedExports(modules, corpus).filter((n) => !KNOWN.has(n));
    assert.deepEqual(unused, [], 'remove these, or use them');
  });
});
