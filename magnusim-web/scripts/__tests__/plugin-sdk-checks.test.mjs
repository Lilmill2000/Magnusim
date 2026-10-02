// The plugin UI kit's build checks (scripts/plugin-sdk-checks.mjs): each rule
// fails on a bad input and passes a good one, and the real kit build passes
// them all, from whatever folder the process runs in.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkCssColours,
  checkCssDesignValues,
  checkCssSelectors,
  checkCssTokens,
  checkKitExternals,
  checkKitInputs,
  KIT_RENDER_SAMPLE,
  kitSample,
} from '../plugin-sdk-checks.mjs';
import { buildKit, SDK_ENTRY_NAME } from '../server/sdk-build.ts';
import { SDK_IMPORTS } from '../server/plugin-sdk.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKENS = readFileSync(join(WEB, 'src', 'theme', 'tokens.css'), 'utf8');

const meta = (inputs, imports = []) => ({
  inputs: Object.fromEntries(inputs.map((p) => [p, { bytes: 1, imports: [] }])),
  outputs: { '<stdout>': { bytes: 1, inputs: {}, imports, exports: [] } },
});

describe('rule 2: plugin-ui.js bundles only src/plugin-ui/', () => {
  it('fails on an input outside the kit', () => {
    assert.equal(checkKitInputs(meta(['src/plugin-ui/index.ts', 'src/islands.tsx']), SDK_ENTRY_NAME).length, 1);
    assert.equal(checkKitInputs(meta(['node_modules/react/index.js']), SDK_ENTRY_NAME).length, 1);
  });
  it('passes the stdin entry, by its exact name, next to kit inputs', () => {
    assert.equal(SDK_ENTRY_NAME, 'plugin-sdk-entry');
    assert.deepEqual(checkKitInputs(meta([SDK_ENTRY_NAME, 'src/plugin-ui/index.ts', 'src/plugin-ui/Button.tsx']), SDK_ENTRY_NAME), []);
    assert.equal(checkKitInputs(meta(['plugin-sdk-entry-2']), SDK_ENTRY_NAME).length, 1);
  });
});

describe('rule 3: external imports are import-map names', () => {
  it('fails on one the map does not name', () => {
    const bad = meta([], [{ path: 'react-dom', kind: 'import-statement', external: true }]);
    assert.equal(checkKitExternals(bad, SDK_IMPORTS).length, 1);
  });
  it('passes react and the JSX runtime', () => {
    const good = meta([], [
      { path: 'react', kind: 'import-statement', external: true },
      { path: 'react/jsx-runtime', kind: 'import-statement', external: true },
    ]);
    assert.deepEqual(checkKitExternals(good, SDK_IMPORTS), []);
  });
});

describe('rule 4: no colour literals', () => {
  it('fails on hex, rgb(), hsl(), white and black', () => {
    for (const css of [
      '.mgk-a { color: #fff; }',
      '.mgk-a { background: #3b5bdb }',
      '.mgk-a { color: rgb(0, 0, 0); }',
      '.mgk-a { color: rgba(0,0,0,.5); }',
      '.mgk-a { color: hsl(0 0% 0%); }',
      '.mgk-a { color: white; }',
      '.mgk-a{border-color:black}',
    ]) {
      assert.ok(checkCssColours(css).length > 0, css);
    }
  });
  it('fails on any named or system colour, anywhere in a value, and on every colour function', () => {
    for (const css of [
      '.mgk-a { color: red; }',
      '.mgk-a { border: 1px solid white; }',
      '.mgk-a { border: 1px solid black; }',
      '.mgk-a { border-left: 3px solid black; }',
      '.mgk-a { outline: 2px solid red; }',
      '.mgk-a { color: oklch(0.6 0.2 25); }',
      '.mgk-a { color: hwb(0 0% 0%); }',
      '.mgk-a { color: lab(50% 40 59); }',
      '.mgk-a { color: color(display-p3 1 0 0); }',
      '.mgk-a { color: color-mix(in srgb, var(--mg-danger) 50%, blue); }',
      '.mgk-a { background: linear-gradient(red, blue); }',
      '.mgk-a { color: Canvas; }',
      '.mgk-a { color: ButtonText; }',
      '.mgk-a { fill: tomato; }',
      '.mgk-a { stroke: gray; }',
      '.mgk-a { color: var(--mg-text, red); }',
      '.mgk-a { box-shadow: 0 1px 2px black; }',
      '@keyframes mgk-k { from { color: red; } }',
      '@media (min-width: 1px) { .mgk-a { color: navy; } }',
    ]) {
      assert.ok(checkCssColours(css).length > 0, css);
    }
  });
  it('passes tokens, the allowed keywords and words that are not colours', () => {
    assert.deepEqual(checkCssColours('.mgk-a { color: var(--mg-text); background: transparent; border-color: currentColor; }'), []);
    for (const css of [
      '.mgk-a { color: inherit; background: none; border-color: revert; }',
      '.mgk-a { border: 1px solid var(--mg-border); background: linear-gradient(var(--mg-bg), transparent); }',
      '.mgk-a { white-space: nowrap; transition: background var(--mg-duration-switch); }',
      '.mgk-a::before { content: "white"; }',
      '.mgk-a { font: revert; font-family: var(--mg-font); text-decoration: underline; }',
    ]) {
      assert.deepEqual(checkCssColours(css), [], css);
    }
  });
});

describe('rule 5: every token read is declared', () => {
  it('fails on an unknown token', () => {
    assert.equal(checkCssTokens('.mgk-a { color: var(--mg-not-a-token); }', TOKENS).length, 1);
  });
  it('passes known tokens', () => {
    assert.deepEqual(checkCssTokens('.mgk-a { color: var(--mg-text); font-size: var(--mg-text-sm); }', TOKENS), []);
  });
});

describe('rule 6: kit classes only', () => {
  it('fails on a core class, a bare element and a state class without mgk-', () => {
    for (const css of [
      '.fp-btn { color: var(--mg-text); }',
      '.mgk-x b { color: var(--mg-text); }',
      'button.mgk-pill.is-on { color: var(--mg-text); }',
      '.mgk-toast.is-error { color: var(--mg-text); }',
      'button { color: var(--mg-text); }',
      '.mgk-a, p { margin: 0; }',
    ]) {
      assert.ok(checkCssSelectors(css).length > 0, css);
    }
  });
  it('passes kit classes, kit modifiers and the kit attribute selectors', () => {
    for (const css of [
      'b.mgk-x-head { color: var(--mg-text); }',
      '[class^="mgk-"]::before { box-sizing: border-box; }',
      '[class*=" mgk-"] { margin: 0; }',
      '[class^=mgk-],[class*=" mgk-"]{margin:0}',
      'button.mgk-pill.mgk-pill--on { color: var(--mg-text); }',
      '.mgk-toast.mgk-toast--error { color: var(--mg-text); }',
      'input.mgk-switch-input:checked + .mgk-switch-track::before { transform: none; }',
    ]) {
      assert.deepEqual(checkCssSelectors(css), [], css);
    }
  });
});

describe('rule 9: design values from tokens, no viewport units', () => {
  it('fails on a raw radius, size, duration or viewport unit', () => {
    for (const css of [
      '.mgk-a { border-radius: 50%; }',
      '.mgk-a { font-size: 12px; }',
      '.mgk-a { transition: transform 150ms; }',
      '.mgk-a { max-width: 70vw; }',
      '.mgk-a { font-weight: 600; }',
      '.mgk-a { z-index: 40; }',
      '.mgk-a { box-shadow: 0 1px 3px var(--mg-border); }',
      '.mgk-a { border-top-left-radius: 2px; }',
      // The font shorthand sets a size and a weight too.
      '.mgk-a { font: bold 14px/1 sans-serif; }',
      '.mgk-a { font: 600 14px serif; }',
      '.mgk-a { font: 700 15px Georgia; }',
      '.mgk-a { font: var(--mg-text-sm) Georgia; font-weight: bold; }',
      '.mgk-a { font: bold var(--mg-text-sm) var(--mg-font); }',
      '.mgk-a { font: larger var(--mg-font); }',
      '.mgk-a { font: menu; }',
      '@keyframes mgk-k { to { font-size: 20px; } }',
    ]) {
      assert.ok(checkCssDesignValues(css).length > 0, css);
    }
  });
  it('passes tokens and the allowed keywords', () => {
    for (const css of [
      '.mgk-a { border-radius: var(--mg-radius-round); }',
      '.mgk-a { font: revert; font-size: var(--mg-text-sm); font-weight: inherit; }',
      '.mgk-a { font: inherit; }',
      '.mgk-a { font: italic var(--mg-weight-semibold) var(--mg-text-sm)/var(--mg-line) var(--mg-font); }',
      '.mgk-a { transition: transform var(--mg-duration-switch); box-shadow: none; z-index: 0; }',
      '.mgk-a { width: 100%; max-width: 220px; height: 18px; }',
    ]) {
      assert.deepEqual(checkCssDesignValues(css), [], css);
    }
  });
});

describe('rule 7: the compile sample', () => {
  it('imports every runtime name and lists it in `all`, then renders kit components', () => {
    const names = ['Button', 'PLUGIN_UI_API_VERSION', 'formatSimTime'];
    const sample = kitSample(names);
    assert.match(sample, /^import \{ Button, PLUGIN_UI_API_VERSION, formatSimTime \} from '@magnusim\/plugin-ui';$/m);
    assert.match(sample, /^export const all = \[Button, PLUGIN_UI_API_VERSION, formatSimTime\];$/m);
    assert.ok(sample.includes(KIT_RENDER_SAMPLE));
    assert.match(KIT_RENDER_SAMPLE, /FieldWidgetProps/);
    for (const tag of ['Button', 'PanelChrome', 'NumberUnitInput', 'Toast', 'LinePlot']) {
      assert.match(KIT_RENDER_SAMPLE, new RegExp(`<${tag}\\b`), tag);
    }
  });
});

describe('the real kit build passes every rule', () => {
  async function checkBuild(variant) {
    const kit = await buildKit(WEB, variant);
    assert.ok(kit.js.length > 0 && kit.css.length > 0, variant);
    assert.deepEqual(checkKitInputs(kit.metafile, SDK_ENTRY_NAME), [], `${variant} inputs`);
    assert.ok(Object.keys(kit.metafile.inputs).includes('src/plugin-ui/index.ts'), `${variant} inputs are relative to the web root`);
    assert.deepEqual(checkKitExternals(kit.metafile, SDK_IMPORTS), [], `${variant} externals`);
    assert.deepEqual(checkCssColours(kit.css), [], `${variant} colours`);
    assert.deepEqual(checkCssTokens(kit.css, TOKENS), [], `${variant} tokens`);
    assert.deepEqual(checkCssSelectors(kit.css), [], `${variant} selectors`);
    assert.deepEqual(checkCssDesignValues(kit.css), [], `${variant} design values`);
  }

  it('in dev and prod', async () => {
    await checkBuild('dev');
    await checkBuild('prod');
  });

  it('from another working folder too (metafile paths come from the web root)', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'magnusim-kit-cwd-'));
    const before = process.cwd();
    try {
      process.chdir(elsewhere);
      await checkBuild('dev');
    } finally {
      process.chdir(before);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
