/**
 * docs/plugins/API.md and docs/plugins/manifest.schema.json, generated from the
 * sources of truth (never edited by hand):
 *
 *   the manifest      python/tools/plugin_manifest_schema.py, built from
 *                     python/cfddesk/registry/manifest.py (and the loader's patterns)
 *   magnusim_sdk      python/sdk/magnusim_sdk (signatures and docstrings)
 *   the contract      python/cfddesk/registry/contract.py and AnalysisType (analysis.py)
 *   hooks             python/cfddesk/registry/hooks.py (fired and reserved)
 *   the bridge        docs/plugins/workspace-sdk.d.ts ('@magnusim/workspace')
 *   the UI kit        docs/plugins/plugin-ui.d.ts ('@magnusim/plugin-ui')
 *   versions, map     docs/plugins/plugin-sdk.json
 *   builtins          docs/plugins/registry.json (npm run gen:registry)
 *
 * The Python side comes from python/tools/plugin_docs.py, the TypeScript side from
 * the TypeScript checker. API.md's examples are code blocks tagged `test`, which
 * npm run test:docs runs (scripts/doc-tests.mjs).
 *
 *   npm run gen:plugin-docs          write both files
 *   npm run gen:plugin-docs:check    fail when either is out of date (CI)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { PYTHON, pyTool, WEB_ROOT } from './python-env.js';

const DOCS = join(WEB_ROOT, 'docs', 'plugins');
export const API_MD = join(DOCS, 'API.md');
export const SCHEMA_JSON = join(DOCS, 'manifest.schema.json');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

/** The Python side (python/tools/plugin_docs.py). */
export function pythonFacts() {
  const r = spawnSync(PYTHON, [pyTool('plugin_docs.py')], { cwd: WEB_ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`python/tools/plugin_docs.py failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const firstParagraph = (s) => oneLine(String(s || '').split(/\n\s*\n/)[0]);
const cell = (s) => oneLine(s).replace(/\|/g, '\\|');
const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';

// -- TypeScript declarations ------------------------------------------------------------

const FLAGS = ts.TypeFormatFlags.NoTruncation;

/** The exports of an ambient module in a .d.ts, resolved through re-exports. */
export function dtsExports(file, moduleName) {
  const program = ts.createProgram([file], {
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
  });
  const checker = program.getTypeChecker();
  const mod = checker.getAmbientModules().find((m) => m.getName() === `"${moduleName}"`);
  if (!mod) throw new Error(`${file} declares no module ${moduleName}`);
  const docOf = (sym) => firstParagraph(ts.displayPartsToString(sym.getDocumentationComment(checker)));
  const typeText = (t, at) => {
    const text = checker.typeToString(t, at, FLAGS);
    return text.length > 160 ? text.slice(0, 157) + '...' : text;
  };
  const sigText = (name, sig, at) => {
    const params = sig.getParameters().map((p) => {
      const decl = p.valueDeclaration;
      const optional = decl && ts.isParameter(decl) && (decl.questionToken || decl.initializer) ? '?' : '';
      const rest = decl && ts.isParameter(decl) && decl.dotDotDotToken ? '...' : '';
      const pname = p.getName().startsWith('__') ? 'props' : p.getName();
      return `${rest}${pname}${optional}: ${typeText(checker.getTypeOfSymbolAtLocation(p, at), at)}`;
    });
    const tps = sig.getTypeParameters()?.map((tp) => checker.typeToString(tp)).join(', ');
    return `${name}${tps ? `<${tps}>` : ''}(${params.join(', ')}): ${typeText(sig.getReturnType(), at)}`;
  };
  const out = [];
  for (const exp of checker.getExportsOfModule(mod)) {
    const sym = exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp;
    const decl = sym.declarations?.[0];
    if (!decl) continue;
    const name = exp.getName();
    const row = { name, doc: docOf(sym), kind: '', text: '', members: [] };
    if (sym.flags & ts.SymbolFlags.Function) {
      row.kind = 'function';
      const type = checker.getTypeOfSymbolAtLocation(sym, decl);
      row.text = type
        .getCallSignatures()
        .map((s) => sigText(name, s, decl))
        .join('\n');
    } else if (sym.flags & ts.SymbolFlags.Interface) {
      row.kind = 'interface';
      const type = checker.getDeclaredTypeOfSymbol(sym);
      row.text = `interface ${name}`;
      const member = (p, prefix, depth) => {
        const pd = p.valueDeclaration || p.declarations?.[0];
        if (!pd) return;
        const optional = p.flags & ts.SymbolFlags.Optional ? '?' : '';
        const pt = checker.getTypeOfSymbolAtLocation(p, pd);
        const calls = pt.getCallSignatures();
        const name = prefix + p.getName();
        // A group of calls written inline (ws.study, ws.files, ...): one row per call.
        const inline = depth === 0 && ts.isPropertySignature(pd) && pd.type && ts.isTypeLiteralNode(pd.type);
        if (inline) {
          row.members.push({ text: `${name}: { … }`, doc: docOf(p) });
          for (const sub of checker.getPropertiesOfType(pt)) member(sub, `${name}.`, depth + 1);
          return;
        }
        const text =
          (ts.isMethodSignature(pd) || ts.isMethodDeclaration(pd)) && calls.length
            ? calls.map((s) => sigText(name, s, pd)).join('; ')
            : `${name}${optional}: ${typeText(pt, pd)}`;
        row.members.push({ text, doc: docOf(p) });
      };
      for (const p of checker.getPropertiesOfType(type)) member(p, '', 0);
    } else if (sym.flags & ts.SymbolFlags.TypeAlias) {
      row.kind = 'type';
      const t = ts.isTypeAliasDeclaration(decl) ? oneLine(decl.type.getText()) : typeText(checker.getDeclaredTypeOfSymbol(sym), decl);
      row.text = `type ${name} = ${t.length > 200 ? t.slice(0, 197) + '...' : t}`;
    } else if (sym.flags & ts.SymbolFlags.Class) {
      row.kind = 'class';
      row.text = `class ${name}`;
    } else if (sym.flags & ts.SymbolFlags.Variable) {
      row.kind = 'const';
      row.text = `const ${name}: ${typeText(checker.getTypeOfSymbolAtLocation(sym, decl), decl)}`;
    } else continue;
    out.push(row);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

function renderTs(rows) {
  const lines = [];
  const order = ['function', 'const', 'class', 'interface', 'type'];
  for (const kind of order) {
    for (const r of rows.filter((x) => x.kind === kind)) {
      lines.push(`#### ${r.name}`, '', '```ts', r.text, '```', '');
      if (r.doc) lines.push(r.doc, '');
      if (r.members.length) {
        for (const m of r.members) lines.push(`- ${code(m.text)}${m.doc ? `: ${m.doc}` : ''}`);
        lines.push('');
      }
    }
  }
  return lines;
}

// -- Python ----------------------------------------------------------------------------

function renderPyMembers(members, level = '####') {
  const lines = [];
  for (const m of members) {
    if (m.kind === 'function') {
      lines.push(`${level} ${m.name}`, '', '```python', m.signature, '```', '');
      if (m.doc) lines.push(m.doc, '');
    } else if (m.kind === 'class') {
      lines.push(`${level} class ${m.name}${m.bases ? `(${m.bases})` : ''}`, '');
      if (m.doc) lines.push(m.doc, '');
      for (const meth of m.methods) lines.push(`- ${code(meth.signature)}${meth.doc ? `: ${meth.doc}` : ''}`);
      if (m.methods.length) lines.push('');
    }
  }
  const consts = members.filter((m) => m.kind === 'constant');
  if (consts.length) {
    lines.push('Constants:', '');
    for (const c of consts) lines.push(`- ${code(`${c.name} = ${c.value}`)}`);
    lines.push('');
  }
  return lines;
}

// -- the manifest ------------------------------------------------------------------------

function typeOf(p, defs) {
  if (p.$ref) return `[[${p.$ref.split('/').pop()}]]`;
  if (p.anyOf) return p.anyOf.map((o) => typeOf(o, defs)).join(' or ');
  if (p.type === 'array') return p.items?.$ref ? 'array of tables' : `array of ${p.items?.type || 'values'}`;
  if (p.type === 'object') return 'table';
  if (p.type === 'boolean' && p.enum) return 'false';
  return p.type || '';
}

function propRows(props, required = []) {
  const lines = ['| Key | Type | Default | Since | What it is |', '| --- | --- | --- | --- | --- |'];
  for (const [key, p] of Object.entries(props)) {
    const type = p.type === 'array' && p.items?.$ref ? 'array of tables' : typeOf(p);
    const extras = [];
    if (p.enum && p.type !== 'boolean') extras.push(`one of ${p.enum.map((v) => code(JSON.stringify(v))).join(', ')}`);
    if (p.items?.enum) extras.push(`each one of ${p.items.enum.map((v) => code(JSON.stringify(v))).join(', ')}`);
    if (p.pattern) extras.push(`matches ${code(p.pattern)}`);
    if (p.minimum !== undefined || p.maximum !== undefined) extras.push(`${p.minimum ?? ''}..${p.maximum ?? ''}`);
    if (p.maxLength !== undefined) extras.push(`at most ${p.maxLength} characters`);
    if (required.includes(key)) extras.push('required');
    const def = p.default === undefined ? '' : code(JSON.stringify(p.default));
    const what = `${p.description || ''}${extras.length ? ` (${extras.join('; ')})` : ''}`;
    lines.push(`| ${code(key)} | ${cell(type)} | ${cell(def)} | ${p['x-since'] || ''} | ${cell(what)} |`);
  }
  return lines;
}

const TABLE_NAMES = { StudyKind: 'study_kinds', WorkspaceSpec: 'workspaces', StartAction: 'start_actions', Requirement: 'requires' };

// -- the examples (code blocks tagged `test`, run by npm run test:docs) ---------------------

function examples(api) {
  return {
    manifest: [
      '```toml test',
      'key = "hello-workspace"',
      'name = "Hello workspace"',
      'version = "0.1.0"',
      `api_version = "${api}"`,
      'license = "GPL-3.0-or-later"',
      'description = "One study kind with its own page"',
      'authors = ["Your Name"]',
      '',
      '[[workspaces]]',
      'key = "hello"',
      'title = "Hello"',
      'entry = "workspace/index.html"',
      '',
      '[[study_kinds]]',
      'key = "hello"',
      'title = "Hello"',
      'workspace = "hello"',
      'schema_version = 1',
      '```',
    ],
    bridge: [
      '```ts test',
      "import { connect } from '@magnusim/workspace';",
      "import { Button } from '@magnusim/plugin-ui';",
      '',
      'const ws = await connect();',
      'const study = await ws.study.get();',
      '// Save a field; a stale rev is refused, so pass the one you read.',
      'const saved = await ws.study.update({ width: 2 }, study.rev);',
      "const { id } = await ws.jobs.start('hello_count', { steps: 5 });",
      'const stop = ws.jobs.events(id, (ev) => {',
      "  if (ev.event === 'end') stop();",
      '});',
      "ws.ui.toast(`Saved ${saved.title}`, { kind: 'success' });",
      'export const kitButton = Button;',
      '```',
    ],
    service: [
      '```python test',
      'from magnusim_sdk.service import handle, method',
      '',
      '',
      '@method("area")',
      'def area(params, scope):',
      '    return {"area": params["width"] * params["height"]}',
      '',
      '',
      'reply = handle(\'{"id": 1, "method": "area", "params": {"params": {"width": 2, "height": 3}}}\')',
      'assert reply["result"] == {"area": 6}, reply',
      '```',
    ],
  };
}

export function renderApiMd(py, sdkInfo, bridge, kit, registry) {
  const schema = py.manifest_schema;
  const ex = examples(py.api_version);
  const L = [];
  L.push(
    '# Plugin API reference',
    '',
    '<!-- Generated by `npm run gen:plugin-docs` from the app\'s code (scripts/gen-plugin-docs.mjs). Do not edit:',
    '     change the source and run it again. `npm run gen:plugin-docs:check` fails in CI when this file is stale. -->',
    '',
    `Host API **${py.api_version}** · \`magnusim_sdk\` **${py.sdk_version}** · workspace bridge **${sdkInfo.sdk_version}** · ` +
      `plugin UI kit **${sdkInfo.plugin_ui_version}** · React **${sdkInfo.react_version}** · analysis contract **${py.contract.version}**`,
    '',
    'What a plugin can use, generated from the code that implements it. Code blocks tagged `test` are run by `npm run test:docs`.',
    '',
    '1. [The manifest](#1-the-manifest-manifesttoml)',
    '2. [The workspace bridge](#2-the-workspace-bridge-magnusimworkspace)',
    '3. [The plugin UI kit](#3-the-plugin-ui-kit-magnusimplugin-ui)',
    '4. [magnusim_sdk](#4-magnusim_sdk)',
    '5. [The analysis contract](#5-the-analysis-contract)',
    '6. [Hooks](#6-hooks)',
    '7. [Built-in registry](#7-built-in-registry)',
    '',
    '## 1. The manifest (manifest.toml)',
    '',
    'Its JSON Schema is [manifest.schema.json](manifest.schema.json), generated with this file. The host ignores a key it does not know ' +
      '(`npm run plugin:check` warns about one), and from 1.4 leaves out a list value it does not know, with a warning on the plugin\'s Settings row. ' +
      '"Since" is the host API version that added a key; declare at least that `api_version` to use it.',
    '',
    ...ex.manifest,
    '',
    '### Top-level keys',
    '',
    ...propRows(schema.properties, schema.required),
    '',
  );
  for (const [defName, table] of Object.entries(TABLE_NAMES)) {
    const def = schema.$defs[defName];
    L.push(`### [[${table}]]`, '', ...propRows(def.properties, def.required), '');
  }
  for (const table of ['files', 'python', 'default_analysis']) {
    const p = schema.properties[table];
    L.push(`### [${table}]`, '', ...propRows(p.properties, p.required || []), '');
  }

  L.push(
    '## 2. The workspace bridge (@magnusim/workspace)',
    '',
    'A workspace page runs in a sandboxed frame. The host injects this import map into every workspace page; build your page with these names external ' +
      '(`npm run plugin:new` writes a Vite config that does):',
    '',
    '| Import | Served at |',
    '| --- | --- |',
    ...Object.entries(sdkInfo.imports).map(([k, v]) => `| ${code(k)} | ${code(v)} |`),
    '',
    'Types: [workspace-sdk.d.ts](workspace-sdk.d.ts) (copy it into your plugin). Example:',
    '',
    ...ex.bridge,
    '',
    ...renderTs(bridge),
    '## 3. The plugin UI kit (@magnusim/plugin-ui)',
    '',
    'Components and helpers that look like the app\'s own panels, on the design tokens. Types: [plugin-ui.d.ts](plugin-ui.d.ts).',
    '',
    ...renderTs(kit),
    '## 4. magnusim_sdk',
    '',
    'The helpers a plugin may import, in the app and in its own environment (standard library only). A plugin\'s Python code imports only ' +
      '`magnusim_sdk`, `cfddesk.registry` and the standard library. Example (a service method and one request through the service protocol):',
    '',
    ...ex.service,
    '',
  );
  for (const m of py.sdk) {
    L.push(`### ${m.module}`, '');
    if (m.doc) L.push(m.doc, '');
    if (m.reexports?.length) L.push(`Re-exports: ${m.reexports.map(code).join(', ')}.`, '');
    L.push(...renderPyMembers(m.members));
  }
  const c = py.contract;
  L.push('## 5. The analysis contract', '', `Contract version ${c.version} (\`cfddesk.registry.contract\`).`, '');
  if (c.full_doc) L.push(...c.full_doc.split('\n'), '');
  L.push('### AnalysisType', '', c.analysis_type_doc, '', '| Field | Type | Default | What it is |', '| --- | --- | --- | --- |');
  for (const f of c.analysis_type_fields) L.push(`| ${code(f.name)} | ${cell(code(f.type))} | ${f.default ? cell(code(f.default)) : ''} | ${cell(f.doc)} |`);
  L.push('', '### cfddesk.registry.contract', '', ...renderPyMembers(c.members));
  L.push(
    '## 6. Hooks',
    '',
    `The host fires these (host API ${py.api_version}): ${py.hooks.fired.map(code).join(', ')}.`,
    '',
    `Reserved (a plugin may listen; they never fire yet): ${py.hooks.reserved.map(code).join(', ')}.`,
    '',
    '## 7. Built-in registry',
    '',
    'What ships: the core builtins and the bundled plugins (the whole record, with schemas, is [registry.json](registry.json), from `npm run gen:registry`).',
    '',
    '| Kind | Key | Label | From |',
    '| --- | --- | --- | --- |',
  );
  for (const kind of ['analysis', 'solver', 'mesher', 'bc', 'material', 'monitor', 'filter']) {
    for (const row of registry[kind] || []) L.push(`| ${kind} | ${code(row.key)} | ${cell(row.label || '')} | ${cell(row.plugin || '')} |`);
  }
  if (registry.default_analysis) {
    L.push('', `Default analysis: steady ${code(registry.default_analysis.steady)}, transient ${code(registry.default_analysis.transient || '')}.`);
  }
  L.push('');
  return L.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function generate() {
  const py = pythonFacts();
  const sdkInfo = JSON.parse(readFileSync(join(DOCS, 'plugin-sdk.json'), 'utf8'));
  const bridge = dtsExports(join(DOCS, 'workspace-sdk.d.ts'), '@magnusim/workspace');
  const kit = dtsExports(join(DOCS, 'plugin-ui.d.ts'), '@magnusim/plugin-ui');
  const registry = JSON.parse(readFileSync(join(DOCS, 'registry.json'), 'utf8'));
  return {
    api: renderApiMd(py, sdkInfo, bridge, kit, registry),
    schema: JSON.stringify(py.manifest_schema, null, 2) + '\n',
  };
}

const same = (path, text) => existsSync(path) && readFileSync(path, 'utf8').replace(/\r\n/g, '\n') === text;

if (process.argv[1] && process.argv[1].endsWith('gen-plugin-docs.mjs')) {
  let out;
  try {
    out = generate();
  } catch (err) {
    fail(String(err instanceof Error ? err.message : err));
  }
  // --out-dir <dir>: write or check the two files there instead (the tests use it).
  const at = process.argv.indexOf('--out-dir');
  const dir = at > 0 && process.argv[at + 1] ? process.argv[at + 1] : DOCS;
  const apiPath = join(dir, 'API.md');
  const schemaPath = join(dir, 'manifest.schema.json');
  if (process.argv.includes('--check')) {
    const stale = [];
    if (!same(apiPath, out.api)) stale.push('docs/plugins/API.md');
    if (!same(schemaPath, out.schema)) stale.push('docs/plugins/manifest.schema.json');
    if (stale.length) fail(`${stale.join(' and ')} out of date; run npm run gen:plugin-docs`);
    console.log('plugin docs check ok');
  } else {
    writeFileSync(apiPath, out.api);
    writeFileSync(schemaPath, out.schema);
    console.log(`wrote ${dir === DOCS ? 'docs/plugins/' : dir + '/'}API.md and manifest.schema.json`);
  }
}
