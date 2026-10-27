// Appearance: the static proof that a theme change leaves the light look as it was
// (scripts/theme-light-identity.mjs). Each declaration's light value, var() resolved against its
// side's light tokens, compared between a git ref and the working tree.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  appliesInLight,
  compareLight,
  evalCalc,
  isComparedCss,
  lightTokenMaps,
  lightValue,
  mixSrgb,
  parseCss,
  pluginBuildDirs,
  sheetsInWorkingTree,
} from '../theme-light-identity.mjs';

const TOKENS = `/* tokens */
:root,
[data-theme="light"] {
  --mg-bg: #ffffff;
  --mg-primary: #1570ef;
  --mg-series-1: #1570ef;
  --mg-chart-text: #667085;
  --mg-alias: var(--mg-primary);
  --mg-series-lift: 0%;
}
:root { --mg-text-scale: 1; }
:root,
[data-appearance-scope] {
  --mg-text-sm: calc(12px * var(--mg-text-scale));
}
[data-theme="dark"] {
  --mg-bg: #1b1f27;
  --mg-series-lift: 30%;
}
`;

const core = (style, tokens = TOKENS) => new Map([['src/theme/tokens.css', tokens], ['src/style.css', style]]);
const tokensOf = (sheets) => lightTokenMaps(sheets).get('src/style.css');

describe('theme light identity: parsing', () => {
  it('reads each declaration with its at-rules and selector, its line and !important', () => {
    const css = [
      '/* .x { color: red; } */',
      '.a, .b > .c { color: #fff; background: url("a;b{c}.png") }',
      '@media (max-width: 600px) {',
      '  .a { padding: 0 !important; content: "x;y" }',
      '}',
      '.d{margin:0}',
    ].join('\n');
    const decls = parseCss(css).map((d) => [d.context.join(' / '), d.prop, d.value, d.important, d.line]);
    assert.deepEqual(decls, [
      ['.a,.b>.c', 'color', '#fff', false, 2],
      ['.a,.b>.c', 'background', 'url("a;b{c}.png")', false, 2],
      ['@media (max-width: 600px) / .a', 'padding', '0', true, 4],
      ['@media (max-width: 600px) / .a', 'content', '"x;y"', false, 4],
      ['.d', 'margin', '0', false, 6],
    ]);
  });

  it('leaves out what applies only in dark', () => {
    assert.equal(appliesInLight(['[data-theme="dark"]']), false);
    assert.equal(appliesInLight(["[data-theme='dark'] .x"]), true, 'quotes are only normalised by the parser');
    assert.equal(appliesInLight(parseCss("[data-theme='dark'] .x { color: red }")[0].context), false);
    assert.equal(appliesInLight(['[data-theme="dark"] .x,.y']), true);
    assert.equal(appliesInLight(['@media (prefers-color-scheme: dark)', '[data-theme="dark"] .x']), false);
    assert.equal(appliesInLight([':root,[data-theme="light"]']), true);
  });

  it('keeps what also applies in light: dark only inside :not(), or a media query that is not only dark', () => {
    assert.equal(appliesInLight([':root:not([data-theme="dark"]) .x']), true);
    assert.equal(appliesInLight(['.x:not(:is([data-theme="dark"] *))']), true);
    assert.equal(appliesInLight(['[data-theme="dark"] .x:not(.y)']), false);
    assert.equal(appliesInLight(['@media not (prefers-color-scheme: dark)', '.x']), true);
    assert.equal(appliesInLight(['@media (prefers-color-scheme: dark), print', '.x']), true);
    const r = compareLight(core('.a { color: #fff }'), core('.a { color: #fff }\n:root:not([data-theme="dark"]) .a { color: red }\n@media not (prefers-color-scheme: dark) { .b { color: red } }'));
    assert.deepEqual(r.added.map((d) => [d.rule, d.prop]), [[':root:not([data-theme="dark"]) .a', 'color'], ['.b', 'color']]);
  });

  // The theme is html's data-theme, not the system's: on a dark system the light page takes these too.
  it('compares a prefers-color-scheme: dark rule whose selector is not dark', () => {
    assert.equal(appliesInLight(['@media (prefers-color-scheme: dark)', ':root']), true);
    assert.equal(appliesInLight(['@media screen and (prefers-color-scheme: dark)', '.x']), true);
    assert.equal(appliesInLight(['@media (prefers-color-scheme: dark)', ':root:not([data-theme="light"]) .x']), true);
    const media = (rule) => `.a { color: #fff }\n@media (prefers-color-scheme: dark) { ${rule} }`;
    const r = compareLight(core(media('.b { color: #fff }')), core(media('.b { color: #000 }')));
    assert.deepEqual(r.changed.map((d) => [d.rule, d.prop, d.wasLight, d.light]), [['.b', 'color', '#ffffff', '#000000']]);
    const dark = compareLight(core(media('[data-theme="dark"] .b { color: #fff }')), core(media('[data-theme="dark"] .b { color: red }')));
    assert.deepEqual([dark.changed, dark.added, dark.removed], [[], [], []]);
  });
});

describe('theme light identity: values', () => {
  const tokens = tokensOf(core(''));

  it('writes colours one way: hex, rgb() in either syntax and white are the same colour', () => {
    for (const v of ['#fff', '#FFFFFF', '#ffff', 'rgb(255, 255, 255)', 'rgba(255,255,255,1)', 'rgb(255 255 255 / 100%)', 'white', 'var(--mg-bg)']) {
      assert.equal(lightValue(v, tokens), '#ffffff', v);
    }
    assert.equal(lightValue('rgba(18, 22, 32, 0.42)', tokens), lightValue('rgba(18,22,32,.42)', tokens));
    assert.equal(lightValue('transparent', tokens), 'rgba(0,0,0,0)');
    assert.equal(lightValue('0 0 0 1px  #FFF inset', tokens), '0 0 0 1px #ffffff inset');
  });

  it('resolves var() chains and fallbacks, and keeps one it cannot resolve', () => {
    assert.equal(lightValue('1px solid var(--mg-alias)', tokens), '1px solid #1570ef');
    assert.equal(lightValue('var(--nope, var(--mg-bg))', tokens), '#ffffff');
    assert.equal(lightValue('var(--nope)', tokens), 'var(--nope)');
    const ambiguous = tokensOf(core('.a { --x: 1px; } .b { --x: 2px; }'));
    assert.equal(lightValue('var(--x)', ambiguous), 'var(--x)');
  });

  it('takes text sizes at scale 1, so a px size and its token are the same', () => {
    assert.equal(lightValue('var(--mg-text-sm)', tokens), '12px');
    assert.equal(lightValue('600 var(--mg-text-sm)/1.3 "Segoe UI"', tokens), '600 12px/1.3 "Segoe UI"');
    assert.equal(lightValue('calc(15px * var(--mg-text-scale))', tokens), '15px');
    assert.equal(evalCalc('10.5px * 1'), '10.5px');
    assert.equal(evalCalc('100% - 0%'), '100%');
    assert.equal(evalCalc('(2px + 1px) * 2'), '6px');
    assert.equal(evalCalc('1px + 1em'), null);
    assert.equal(evalCalc('var(--x) * 2'), null);
  });

  it('works out color-mix in srgb: a 0% lift is the colour itself', () => {
    assert.equal(lightValue('color-mix(in srgb, #3884e6 calc(100% - var(--mg-series-lift)), white)', tokens), '#3884e6');
    assert.equal(lightValue('color-mix(in srgb, #6941c6 90%, white)', tokens), '#7854cc');
    assert.equal(lightValue('color-mix(in srgb, #ffffff 90%, transparent)', tokens), 'rgba(255,255,255,0.902)');
    assert.equal(lightValue('color-mix(in srgb, #ffffff 90%, transparent)', tokens), lightValue('rgba(255, 255, 255, 0.9)', tokens));
    assert.deepEqual(mixSrgb('in srgb, #000 , #fff'), [127.5, 127.5, 127.5, 1]);
    assert.equal(mixSrgb('in oklab, #000, #fff'), null);
  });
});

describe('theme light identity: comparing', () => {
  it('passes a literal moved onto a token of the same light value, and a fixed revert', () => {
    const before = core('.a { color: #fff; border: 2px solid var(--mg-bg); font-size: 12px }\n.b { fill: #667085 }');
    const after = core('.a { color: var(--mg-bg); border: 2px solid #fff; font-size: var(--mg-text-sm) }\n.b { fill: var(--mg-chart-text) }');
    const r = compareLight(before, after);
    assert.deepEqual([r.changed, r.added, r.removed], [[], [], []]);
    assert.equal(r.compared, 4 + 8);
  });

  it('fails a changed light value: at the token and at each place that uses it', () => {
    const style = '.a { fill: var(--mg-chart-text) }';
    const r = compareLight(core(style), core(style, TOKENS.replace('--mg-chart-text: #667085', '--mg-chart-text: #98a2b3')));
    assert.deepEqual(
      r.changed.map((d) => [d.path, d.rule, d.prop, d.wasLight, d.light]),
      [
        ['src/theme/tokens.css', ':root,[data-theme="light"]', '--mg-chart-text', '#667085', '#98a2b3'],
        ['src/style.css', '.a', 'fill', '#667085', '#98a2b3'],
      ],
    );
    const literal = compareLight(core('.a { color: #fff }'), core('.a { color: #fefefe }'));
    assert.equal(literal.changed.length, 1);
    assert.equal(literal.changed[0].line, 1);
  });

  it('ignores dark values, and lists declarations only on one side (not a new custom property)', () => {
    const r = compareLight(
      core('.a { color: #fff }\n[data-theme="dark"] .a { color: #000 }'),
      core('.a { color: #fff; outline: 1px solid var(--mg-bg) }\n[data-theme="dark"] .a { color: #111 }\n.b { --local: 1px }', TOKENS.replace('--mg-bg: #1b1f27', '--mg-bg: #000000').replace('--mg-primary: #1570ef;', '--mg-primary: #1570ef;\n  --mg-new: #123456;')),
    );
    assert.deepEqual(r.changed, []);
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.added.map((d) => [d.rule, d.prop, d.light]), [['.a', 'outline', '1px solid #ffffff']]);
  });

  it('fails a second declaration that overrides the first in its rule, and one taken away', () => {
    const was = '.a { color: var(--mg-bg) }';
    const r = compareLight(core(was), core('.a { color: var(--mg-bg); color: red }'));
    assert.deepEqual(r.changed.map((d) => [d.rule, d.prop, d.wasLight, d.light, d.line]), [['.a', 'color', '#ffffff', 'red', 1]]);
    assert.deepEqual(r.added.map((d) => [d.rule, d.prop]), [['.a', 'color']]);
    const back = compareLight(core('.a { color: red; color: #fff }'), core('.a { color: red }'));
    assert.deepEqual(back.changed.map((d) => [d.prop, d.wasLight, d.light]), [['color', '#ffffff', 'red']]);
    // An !important declaration paints over a later one: nothing changes.
    const important = compareLight(core('.a { color: #fff !important }'), core('.a { color: #fff !important; color: red }'));
    assert.deepEqual(important.changed, []);
    assert.equal(important.added.length, 1);
    // A changed value is listed once, not again for its rule.
    assert.equal(compareLight(core('.a { color: #fff }'), core('.a { color: #000 }')).changed.length, 1);
  });

  it('compares tokens by name: one moved to another rule, and one gone', () => {
    const moved = (value) => TOKENS.replace('  --mg-chart-text: #667085;\n', '') + `:root { --mg-chart-text: ${value}; }\n`;
    assert.deepEqual(compareLight(core(''), core('', moved('#667085'))).changed, []);
    const r = compareLight(core(''), core('', moved('#000000')));
    assert.deepEqual(r.changed.map((d) => [d.path, d.rule, d.prop, d.wasLight, d.light]), [['src/theme/tokens.css', ':root', '--mg-chart-text', '#667085', '#000000']]);
    // Declared again in a second light rule with another value: both values, so a change.
    const twice = compareLight(core(''), core('', `${TOKENS}.x { --mg-chart-text: #000 }\n`));
    assert.deepEqual(twice.changed.map((d) => [d.prop, d.light]), [['--mg-chart-text', '#000000 | #667085']]);
    const gone = compareLight(core(''), core('', TOKENS.replace('  --mg-chart-text: #667085;\n', '')));
    assert.deepEqual([gone.changed, gone.removed.map((d) => [d.path, d.prop, d.light])], [[], [['src/theme/tokens.css', '--mg-chart-text', '#667085']]]);
  });

  it("resolves a plugin's stylesheets against its own tokens on top of the core's", () => {
    const plugin = (tokens) =>
      new Map([
        ['src/theme/tokens.css', TOKENS],
        ['bundled-plugins/p/src/styles/tokens.css', `:root { --p-bg: ${tokens}; }`],
        ['bundled-plugins/p/src/styles/app.css', '.stage { background: var(--p-bg); color: var(--mg-primary) }'],
        ['src/style.css', '.core { background: var(--p-bg, #fff) }'],
      ]);
    assert.deepEqual(compareLight(plugin('#f0f2f7'), plugin('#f0f2f7')).changed, []);
    const r = compareLight(plugin('#f0f2f7'), plugin('var(--mg-bg)'));
    assert.deepEqual(
      r.changed.map((d) => [d.path, d.prop, d.light]),
      [
        ['bundled-plugins/p/src/styles/tokens.css', '--p-bg', '#ffffff'],
        ['bundled-plugins/p/src/styles/app.css', 'background', '#ffffff'],
      ],
    );
  });
});

describe('theme light identity: stylesheets', () => {
  it('compares src/ and bundled plugins, not CAD, node_modules or a plugin build', () => {
    const dirs = { tunnel2d: 'workspace' };
    assert.equal(isComparedCss('src/style.css', dirs), true);
    assert.equal(isComparedCss('src/plugin-ui/styles/button.css', dirs), true);
    assert.equal(isComparedCss('bundled-plugins/airfoil/workspace/airfoil.css', dirs), true);
    assert.equal(isComparedCss('bundled-plugins/tunnel2d/src/styles/tokens.css', dirs), true);
    assert.equal(isComparedCss('bundled-plugins/tunnel2d/workspace/app.css', dirs), false);
    assert.equal(isComparedCss('bundled-plugins/cad/src/styles/tokens.css', dirs), false);
    assert.equal(isComparedCss('src/x/node_modules/y.css', dirs), false);
    assert.equal(isComparedCss('dist/assets/index.css', dirs), false);
    assert.equal(isComparedCss('src/style.ts', dirs), false);
  });

  it("finds this checkout's stylesheets and tunnel2d's build folder", () => {
    assert.equal(pluginBuildDirs().tunnel2d, 'workspace');
    const paths = [...sheetsInWorkingTree().keys()];
    for (const p of ['src/style.css', 'src/theme/tokens.css', 'bundled-plugins/tunnel2d/src/styles/tokens.css']) assert.ok(paths.includes(p), p);
    assert.equal(paths.filter((p) => p.startsWith('bundled-plugins/cad/') || p.includes('/workspace/app.css')).length, 0);
  });
});
