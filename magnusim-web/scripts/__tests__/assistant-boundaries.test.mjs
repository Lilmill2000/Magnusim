// The Assistant's boundaries in code.
// - The page (src/**, bundled-plugins/*/ui/**) never imports a provider SDK or the
//   server's assistant code (scripts/server/assistant/**, assistant-routes.ts), not
//   even for types.
// - Only scripts/server/assistant/providers/load-sdk.ts loads the SDKs, and by a
//   variable specifier: Vite's config bundler resolves a literal one when it bundles
//   the server, so a copy without the packages would not start at all. A whole-
//   statement `import type` loads nothing and is allowed; `import { type X }` still
//   loads the module and is not. Inside the server's assistant code no other file
//   loads a module by a variable specifier, require or createRequire.
// - Importing vite.config.js (the whole server graph) creates no assistant folder.
// These hold vacuously until the files they name exist; the self-tests show they bite.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..');
const SELF = fileURLToPath(import.meta.url);

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-boundaries-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'assistant-home');
after(() => rmSync(ROOT, { recursive: true, force: true }));

const { default: ts } = await import('typescript');

const SDKS = ['@anthropic-ai/sdk', 'openai'];
const isSdk = (spec) => SDKS.some((name) => spec === name || spec.startsWith(`${name}/`));
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'build', 'dist', 'test-results', 'playwright-report']);
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/** Code files under `dir` (none when it is missing); no node_modules, builds or dot folders. */
function codeFiles(dir, deep = true) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (deep) out.push(...codeFiles(p));
    } else if (e.isFile() && CODE.test(e.name)) out.push(p);
  }
  return out;
}

const within = (dir, p) => {
  const r = relative(dir, p);
  return r === '' || (!isAbsolute(r) && r.split(sep)[0] !== '..');
};

/**
 * Every module a file names, parsed (comments and strings are not imports):
 * { spec (null: not a literal), typeOnly, line }. `import('x').T` in a type loads nothing
 * and is not listed; in a .d.ts everything is a type.
 */
export function moduleRefs(file, text) {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const declaration = file.endsWith('.d.ts');
  const literal = (n) => (n && ts.isStringLiteralLike(n) ? n.text : null);
  const refs = [];
  const add = (node, spec, typeOnly) =>
    refs.push({ spec, typeOnly: declaration || typeOnly, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) add(node, literal(node.moduleSpecifier), !!node.importClause?.isTypeOnly);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node, literal(node.moduleSpecifier), node.isTypeOnly);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node, literal(node.moduleReference.expression), node.isTypeOnly);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
        add(node, literal(node.arguments[0]), false);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

/** Whether `spec`, named in `file`, reaches the server's assistant code. */
function intoServerAssistant(web, file, spec) {
  if (!spec) return false;
  if (spec.startsWith('.')) {
    const abs = resolve(dirname(file), spec);
    const routes = join(web, 'scripts', 'server', 'assistant-routes');
    return within(join(web, 'scripts', 'server', 'assistant'), abs) || abs === routes || abs.startsWith(`${routes}.`);
  }
  return /(^|\/)scripts\/server\/assistant(\/|-routes\b|$)/.test(spec.replace(/\\/g, '/'));
}

/** What breaks the boundaries in the web folder `web`, by rule; each entry "path:line what". */
export function boundaryProblems(web) {
  const rel = (f) => relative(web, f).split(sep).join('/');
  const read = (f) => readFileSync(f, 'utf8');
  const loadSdk = join(web, 'scripts', 'server', 'assistant', 'providers', 'load-sdk.ts');
  const problems = { page: [], sdkLoads: [], loadSdk: [], assistantLoaders: [] };

  // The page: no SDK and no server assistant code, types included.
  const plugins = join(web, 'bundled-plugins');
  const pluginDirs = existsSync(plugins) ? readdirSync(plugins, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];
  const pageFiles = [...codeFiles(join(web, 'src')), ...pluginDirs.flatMap((e) => codeFiles(join(plugins, e.name, 'ui')))];
  for (const f of pageFiles) {
    const text = read(f);
    if (!/assistant|openai|@anthropic-ai/.test(text)) continue;
    for (const r of moduleRefs(f, text)) {
      if (r.spec && (isSdk(r.spec) || intoServerAssistant(web, f, r.spec))) problems.page.push(`${rel(f)}:${r.line} ${r.spec}`);
    }
  }

  // Everywhere else: no SDK loaded but by load-sdk.ts.
  const everyFile = [
    ...codeFiles(web, false),
    ...['src', 'scripts', 'bundled-plugins', 'e2e', 'templates', join('python', 'tests', 'fixtures')].flatMap((d) => codeFiles(join(web, d))),
  ];
  for (const f of everyFile) {
    if (f === loadSdk || f === SELF) continue;
    const text = read(f);
    if (!/openai|@anthropic-ai/.test(text)) continue;
    for (const r of moduleRefs(f, text)) {
      if (r.spec && isSdk(r.spec) && !r.typeOnly) problems.sdkLoads.push(`${rel(f)}:${r.line} ${r.spec}`);
    }
  }

  // load-sdk.ts: a variable specifier, never a literal SDK one.
  if (existsSync(loadSdk)) {
    const refs = moduleRefs(loadSdk, read(loadSdk));
    for (const r of refs) if (r.spec && isSdk(r.spec) && !r.typeOnly) problems.loadSdk.push(`${rel(loadSdk)}:${r.line} ${r.spec} by a literal`);
    if (!refs.some((r) => r.spec === null)) problems.loadSdk.push(`${rel(loadSdk)} loads no module by a variable specifier`);
  }

  // The rest of the server's assistant code loads modules by literal only.
  const routes = join(web, 'scripts', 'server', 'assistant-routes.ts');
  const assistantFiles = [...codeFiles(join(web, 'scripts', 'server', 'assistant')), ...(existsSync(routes) ? [routes] : [])];
  for (const f of assistantFiles) {
    if (f === loadSdk) continue;
    const text = read(f);
    for (const r of moduleRefs(f, text)) if (r.spec === null) problems.assistantLoaders.push(`${rel(f)}:${r.line} a variable specifier`);
    if (/\bcreateRequire\b/.test(text)) problems.assistantLoaders.push(`${rel(f)} createRequire`);
  }
  return problems;
}

describe('assistant boundaries: self-test', () => {
  it('reads every way a file names a module, and which of them load nothing', () => {
    const refs = (file, text) => moduleRefs(file, text).map((r) => `${r.spec}${r.typeOnly ? ' (type)' : ''}`);
    const src = [
      "import A from '@anthropic-ai/sdk';",
      "import type { B } from 'openai';",
      "import { type C } from 'openai/resources';",
      "import 'side-effect';",
      "export * from './star.ts';",
      "export type { D } from './types.ts';",
      "const m = await import('openai');",
      'const spec = name; const n = await import(spec);',
      "const r = require('@anthropic-ai/sdk/core');",
      "type T = import('openai').default;",
      "// import X from 'commented';",
      "const s = \"import Y from 'in-a-string'\";",
    ].join('\n');
    assert.deepEqual(refs('x.ts', src), [
      '@anthropic-ai/sdk',
      'openai (type)',
      'openai/resources',
      'side-effect',
      './star.ts',
      './types.ts (type)',
      'openai',
      'null',
      '@anthropic-ai/sdk/core',
    ]);
    assert.deepEqual(refs('x.d.ts', "import E from 'openai';"), ['openai (type)']);
    assert.deepEqual(refs('x.tsx', "import F from '../scripts/server/assistant/home.ts'; const el = <div />;"), ['../scripts/server/assistant/home.ts']);
  });

  /** A web folder in a temp dir holding `files` (path -> text). */
  function tree(files) {
    const web = mkdtempSync(join(ROOT, 'web-'));
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(web, p)), { recursive: true });
      writeFileSync(join(web, p), text);
    }
    return web;
  }

  it('finds each kind of break', () => {
    const web = tree({
      'src/a.ts': "import type { M } from '@anthropic-ai/sdk';\n",
      'src/b/c.tsx': "import { home } from '../../scripts/server/assistant/home.ts';\n",
      'src/d.ts': "export { x } from '../scripts/server/assistant-routes.ts';\n",
      'bundled-plugins/demo/ui/e.tsx': "const o = await import('openai');\n",
      'bundled-plugins/demo/workspace/f.js': "import O from 'openai';\n",
      'scripts/server/assistant/providers/load-sdk.ts': "export const loadSdk = () => import('openai');\n",
      'scripts/server/assistant/providers/anthropic.ts': "import { type K } from '@anthropic-ai/sdk';\n",
      'scripts/server/assistant/registry.ts': 'export const load = (p: string) => import(p);\n',
      'scripts/server/assistant-routes.ts': "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\n",
      'e2e/support/g.mjs': "const s = require('@anthropic-ai/sdk');\n",
      'vite.config.js': "import 'openai/shims';\n",
    });
    const p = boundaryProblems(web);
    assert.deepEqual(p.page.sort(), [
      'bundled-plugins/demo/ui/e.tsx:1 openai',
      'src/a.ts:1 @anthropic-ai/sdk',
      'src/b/c.tsx:1 ../../scripts/server/assistant/home.ts',
      'src/d.ts:1 ../scripts/server/assistant-routes.ts',
    ]);
    assert.deepEqual(p.sdkLoads.sort(), [
      'bundled-plugins/demo/ui/e.tsx:1 openai',
      'bundled-plugins/demo/workspace/f.js:1 openai',
      'e2e/support/g.mjs:1 @anthropic-ai/sdk',
      'scripts/server/assistant/providers/anthropic.ts:1 @anthropic-ai/sdk',
      'vite.config.js:1 openai/shims',
    ]);
    assert.deepEqual(p.loadSdk, [
      'scripts/server/assistant/providers/load-sdk.ts:1 openai by a literal',
      'scripts/server/assistant/providers/load-sdk.ts loads no module by a variable specifier',
    ]);
    assert.deepEqual(p.assistantLoaders.sort(), ['scripts/server/assistant-routes.ts createRequire', 'scripts/server/assistant/registry.ts:1 a variable specifier']);
  });

  it('passes the intended shape: types by import type, the SDK by name through loadSdk', () => {
    const web = tree({
      'src/assistant/wire.ts': 'export type TurnEvent = { seq: number };\n',
      'scripts/server/assistant/providers/load-sdk.ts': 'export async function loadSdk(name: string) {\n  const spec = name;\n  return await import(spec);\n}\n',
      'scripts/server/assistant/providers/anthropic.ts':
        "import type Anthropic from '@anthropic-ai/sdk';\nimport { loadSdk } from './load-sdk.ts';\nexport const make = async () => (await loadSdk('@anthropic-ai/sdk')) as typeof Anthropic;\n",
      'scripts/server/assistant/providers/openai.ts': "export type Client = import('openai').default;\n",
      'scripts/server/assistant-routes.ts': "import { loadSdk } from './assistant/providers/load-sdk.ts';\nimport type { TurnEvent } from '../../src/assistant/wire.ts';\n",
    });
    assert.deepEqual(boundaryProblems(web), { page: [], sdkLoads: [], loadSdk: [], assistantLoaders: [] });
  });
});

describe('assistant boundaries in this tree', () => {
  const problems = boundaryProblems(WEB);

  it('no page file (src/**, bundled-plugins/*/ui/**) imports a provider SDK or the server assistant code', () => {
    assert.deepEqual(problems.page, []);
  });

  it('no file but scripts/server/assistant/providers/load-sdk.ts loads a provider SDK', () => {
    assert.deepEqual(problems.sdkLoads, []);
  });

  it('load-sdk.ts (once it exists) loads them by a variable specifier only', () => {
    assert.deepEqual(problems.loadSdk, []);
  });

  it('the rest of the server assistant code loads modules by literal specifiers only', () => {
    assert.deepEqual(problems.assistantLoaders, []);
  });

  it('importing vite.config.js (the whole server graph) creates no assistant folder', async () => {
    const home = process.env.MAGNUSIM_ASSISTANT_HOME;
    const derived = join(ROOT, 'local.assistant'); // what MAGNUSIM_LOCAL_JSON alone would give
    const config = (await import(`${pathToFileURL(join(WEB, 'vite.config.js')).href}?boundaries=1`)).default;
    assert.equal(typeof config, 'object');
    assert.equal(existsSync(home), false, `${home} was created at import`);
    assert.equal(existsSync(derived), false, `${derived} was created at import`);
  });
});
