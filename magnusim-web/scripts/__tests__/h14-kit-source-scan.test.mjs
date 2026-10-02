// H14 source scans. The plugin UI kit (src/plugin-ui/) holds no colour literal
// (colours come from tokens) and imports only React and its own files, so the
// frame build never pulls in the core. Every sandboxed frame stays
// `allow-scripts allow-downloads`, never same-origin.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCssColours, colourLiterals } from '../plugin-sdk-checks.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KIT = join(WEB, 'src', 'plugin-ui');

function walk(dir, keep) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, keep));
    else if (keep(p)) out.push(p);
  }
  return out;
}

const rel = (p) => relative(WEB, p).split(sep).join('/');
const isTest = (p) => /\.test\.(ts|tsx|js|mjs)$/.test(p);

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

// Colour data lives in colormaps/data.ts only; colormaps/index.ts builds its stops from the bytes.
const COLOUR_EXEMPT = new Set(['src/plugin-ui/colormaps/data.ts']);
const COLOUR = [
  // Not an HTML character reference such as &#215;.
  [/(?<!&)#[0-9a-fA-F]{3,8}\b/, 'a hex colour'],
  [/\brgba?\(/, 'rgb('],
  [/\bhsla?\(/, 'hsl('],
  [/['"`]\s*(white|black)\s*['"`]/, 'white or black'],
  [/:\s*(white|black)\b(?!-)/, 'white or black'],
];

// Before a string on its line: a style key (`outline: on ? '…' : '…'`,
// `backgroundColor: \`…\``) or an SVG/JSX attribute (`fill="…"`) that can take a colour.
const COLOUR_KEY = /(colou?r|background|border|outline|fill|stroke|shadow|decoration|column-?rule)[\w-]*['"]?\s*[:=]/i;

/** Every string and template literal: its text (template ${…} parts left out) and what comes before it on its line. */
function stringLiterals(text) {
  const out = [];
  const re = /(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;
  for (const m of text.matchAll(re)) {
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    out.push({ before: text.slice(lineStart, m.index), value: m[1] === '`' ? m[2].replace(/\$\{[^}]*\}/g, ' ') : m[2] });
  }
  return out;
}

/**
 * The colour literals in kit source text (comments already stripped): hex, rgb(),
 * hsl() anywhere; any colour function in a string; and a named or system colour
 * in a string that is a style value, a colour attribute or a CSS declaration.
 */
function colourProblems(text) {
  const found = [];
  for (const [re, what] of COLOUR) {
    const m = text.match(re);
    if (m) found.push(`${what} (${m[0]})`);
  }
  for (const { before, value } of stringLiterals(text)) {
    const fn = colourLiterals(value, { names: false }).filter((c) => c.endsWith(')'));
    if (fn.length) found.push(`a colour function (${fn.join(', ')}) in '${value}'`);
    const styleValue = COLOUR_KEY.test(before);
    const names = styleValue ? colourLiterals(value).filter((c) => !c.startsWith('#') && !c.endsWith(')')) : [];
    if (names.length) found.push(`a named colour (${names.join(', ')}) in '${value}'`);
    else if (!styleValue && /^\s*-?[a-z][\w-]*\s*:/i.test(value) && checkCssColours(`.mgk-scan{${value}}`).length) {
      found.push(`a colour in the CSS text '${value}'`);
    }
  }
  return found;
}

const kitSources = () => walk(KIT, (p) => /\.(ts|tsx)$/.test(p) && !isTest(p));

describe('plugin UI kit sources', () => {
  it('hold no colour literal', () => {
    const files = kitSources();
    assert.ok(files.some((f) => rel(f) === 'src/plugin-ui/Button.tsx'), 'the scan reads the kit');
    const found = [];
    for (const file of files) {
      if (COLOUR_EXEMPT.has(rel(file))) continue;
      for (const problem of colourProblems(stripComments(readFileSync(file, 'utf8')))) found.push(`${rel(file)}: ${problem}`);
    }
    assert.deepEqual(found, []);
  });

  it('import only react, react/jsx-runtime and their own files, and no CSS', () => {
    const found = [];
    const IMPORT = /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const file of kitSources()) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const m of text.matchAll(IMPORT)) {
        const spec = m[1] || m[2] || m[3] || m[4];
        if (spec === 'react' || spec === 'react/jsx-runtime') continue;
        if (/\.css(\?|$)/.test(spec)) {
          found.push(`${rel(file)} imports CSS (${spec})`);
          continue;
        }
        if (!spec.startsWith('.')) {
          found.push(`${rel(file)} imports ${spec}`);
          continue;
        }
        const target = resolve(dirname(file), spec);
        const back = relative(KIT, target);
        if (back.startsWith('..') || resolve(KIT, back) !== target) found.push(`${rel(file)} imports ${spec}, outside src/plugin-ui/`);
      }
    }
    assert.deepEqual(found, []);
  });

  it('the scans catch what they look for', () => {
    const text = stripComments("const a = '#3b5bdb'; // #ffffff in a comment\nconst b = { color: 'white' };");
    assert.ok(COLOUR[0][0].test(text));
    assert.ok(COLOUR[3][0].test(text));
    assert.doesNotMatch(stripComments('// #ffffff only here'), COLOUR[0][0]);
    for (const bad of [
      "<div style={{ background: colormapGradient(map), outline: '1px solid black' }} />",
      "const s = { border: '1px solid red' };",
      "const s = { borderLeftColor: 'tomato' };",
      'const s = { boxShadow: `0 0 ${n}px navy` };',
      '<path fill="red" />',
      "<g stroke={'Canvas'} />",
      "const s = { outline: on ? 'none' : '2px solid white' };",
      "el.style.cssText = 'color: red; padding: 0';",
      "const c = 'oklch(0.6 0.2 25)';",
      "const c = `color-mix(in srgb, ${a} 50%, ${b})`;",
    ]) {
      assert.notDeepEqual(colourProblems(bad), [], bad);
    }
    for (const good of [
      "<div style={{ background: colormapGradient(map) }} />",
      "<g fill=\"none\" stroke=\"currentColor\" />",
      'const bg = `repeating-linear-gradient(90deg, ${c} 0 4px, transparent 4px 6px)`;',
      "<span style={{ color: 'var(--mg-text-muted)' }}>Red and blue are not colours here.</span>",
      "const label = 'red line';",
      "return <Hint tone=\"warning\">White space</Hint>;",
      "const t = 'This panel stopped working.';",
    ]) {
      assert.deepEqual(colourProblems(good), [], good);
    }
  });
});

describe('sandboxed frames', () => {
  const SANDBOX_OK = 'allow-scripts allow-downloads';

  it('every sandbox="…" in src is exactly allow-scripts allow-downloads', () => {
    const files = walk(join(WEB, 'src'), (p) => /\.(ts|tsx|html)$/.test(p) && !isTest(p));
    const values = [];
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\bsandbox\s*=\s*["']([^"']*)["']/g)) values.push([rel(file), m[1]]);
    }
    assert.ok(values.some(([f]) => f === 'src/workspace/WorkspaceOverlay.tsx'), 'the workspace frame is scanned');
    assert.deepEqual(values.filter(([, v]) => v !== SANDBOX_OK), []);
  });

  it('nothing in src or scripts grants a frame its own origin', () => {
    // Built here so this file does not match itself.
    const needle = 'allow-same' + '-origin';
    const files = [
      ...walk(join(WEB, 'src'), (p) => /\.(ts|tsx|js|mjs|cjs|html|css)$/.test(p)),
      ...walk(join(WEB, 'scripts'), (p) => /\.(ts|tsx|js|mjs|cjs|html|json)$/.test(p)),
    ];
    assert.ok(files.length > 100);
    assert.deepEqual(files.filter((f) => readFileSync(f, 'utf8').includes(needle)).map(rel), []);
  });
});
