// Appearance: the codemod that moved style.css's colour literals and px font sizes onto the design
// tokens (scripts/theme-codemod.mjs). Only a token with exactly a literal's value replaces it, chosen
// by what the declaration paints; everything else is left and listed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { apply, lightTokens, normalize, plan, planFonts, roleOf, textTokens } from '../theme-codemod.mjs';

const TOKENS = `:root,
[data-theme="light"] {
  color-scheme: light;
  --mg-text: #101828;
  --mg-bg: #ffffff;
  --mg-primary: #1570ef;
  --mg-primary-text: #ffffff;
  --mg-primary-ink: #1570ef;
  --mg-border: #d0d5dd;
  --mg-focus: rgba(21, 112, 239, 0.35);
  --mg-radius-sm: 4px;
}
:root,
[data-appearance-scope] {
  --mg-text-xs: calc(11px * var(--mg-text-scale));
  --mg-text-sm: calc(12px * var(--mg-text-scale));
  --mg-text-2xs: calc(10.5px * var(--mg-text-scale));
}
[data-theme="dark"] {
  --mg-text: #e6e9ef;
  --mg-bg: #1b1f27;
}
`;

describe('theme codemod', () => {
  it('normalizes a colour to one spelling', () => {
    assert.equal(normalize('#FFF'), '#ffffff');
    assert.equal(normalize('#ffff'), '#ffffff');
    assert.equal(normalize('#1570EFff'), '#1570ef');
    assert.equal(normalize('rgb(255, 255, 255)'), '#ffffff');
    assert.equal(normalize('rgba(21,112,239,1)'), '#1570ef');
    assert.equal(normalize('rgba(21, 112, 239, 0.35)'), 'rgba(21,112,239,0.35)');
    assert.equal(normalize('rgb(21 112 239 / 0.35)'), 'rgba(21,112,239,0.35)');
  });

  it('knows what a property paints', () => {
    assert.equal(roleOf('color'), 'text');
    assert.equal(roleOf('fill'), 'text');
    assert.equal(roleOf('background-color'), 'background');
    assert.equal(roleOf('border-left'), 'border');
    assert.equal(roleOf('outline'), 'border');
    assert.equal(roleOf('box-shadow'), 'shadow');
    assert.equal(roleOf('width'), null);
  });

  it('reads the light colours only, every token of a value in file order', () => {
    const map = lightTokens(TOKENS);
    assert.deepEqual(map.get('#ffffff'), ['bg', 'primary-text']);
    assert.deepEqual(map.get('#1570ef'), ['primary', 'primary-ink']);
    assert.deepEqual(map.get('rgba(21,112,239,0.35)'), ['focus']);
    assert.equal(map.has('#e6e9ef'), false, 'the dark set is not read');
    assert.equal(map.has('4px'), false);
    assert.deepEqual([...textTokens(TOKENS)], [['11', 'text-xs'], ['12', 'text-sm'], ['10.5', 'text-2xs']]);
  });

  it('picks the token by what the declaration paints', () => {
    const css = '.a { color: #FFF; background: #fff; border: 1px solid #1570ef; }\n.b { color: #1570ef; }\n';
    const { edits, skipped } = plan(css, lightTokens(TOKENS));
    assert.deepEqual(
      edits.map((e) => [e.line, e.prop, e.literal, e.to]),
      [
        [1, 'color', '#FFF', 'var(--mg-primary-text)'],
        [1, 'background', '#fff', 'var(--mg-bg)'],
        [1, 'border', '#1570ef', 'var(--mg-primary)'],
        [2, 'color', '#1570ef', 'var(--mg-primary-ink)'],
      ],
    );
    assert.deepEqual(skipped, []);
    assert.equal(
      apply(css, edits),
      '.a { color: var(--mg-primary-text); background: var(--mg-bg); border: 1px solid var(--mg-primary); }\n.b { color: var(--mg-primary-ink); }\n',
    );
  });

  it('leaves a literal with no token, a role with none, a custom property, a var() fallback and comments', () => {
    const css = [
      '/* color: #ffffff; */',
      '.a { color: #123456; }',
      '.b { box-shadow: 0 0 0 1px #ffffff; }',
      '.c { --x: #ffffff; }',
      '.d { color: var(--y, #ffffff); }',
      '.e { width: 4px; }',
    ].join('\n');
    const { edits, skipped } = plan(css, lightTokens(TOKENS));
    assert.deepEqual(edits, []);
    assert.deepEqual(
      skipped.map((s) => [s.line, s.literal, s.reason]),
      [
        [2, '#123456', 'no token has this value'],
        [3, '#ffffff', "its tokens (--mg-bg, --mg-primary-text) are not shadow's"],
        [4, '#ffffff', 'a custom property'],
        [5, '#ffffff', 'a var() fallback'],
      ],
    );
  });

  it('moves px font sizes onto the text tokens, or a scaled calc when no token has the size', () => {
    const css = [
      '.a { font-size: 12px; }',
      '.b { font: 600 11px/1.3 "Segoe UI", sans-serif; }',
      '.c { font-size: 15px !important; }',
      '.d { font-size: 10.5px; }',
      '.e { font-size: 0.92em; font: inherit; }',
      '.f { font-size: var(--mg-text-sm); font-size: calc(12px + 1px); }',
      '/* font-size: 12px; */',
    ].join('\n');
    const edits = planFonts(css, textTokens(TOKENS));
    assert.deepEqual(
      edits.map((e) => [e.line, e.prop, e.literal, e.to]),
      [
        [1, 'font-size', '12px', 'var(--mg-text-sm)'],
        [2, 'font', '11px', 'var(--mg-text-xs)'],
        [3, 'font-size', '15px', 'calc(15px * var(--mg-text-scale))'],
        [4, 'font-size', '10.5px', 'var(--mg-text-2xs)'],
      ],
    );
    const out = apply(css, edits);
    assert.match(out, /\.b \{ font: 600 var\(--mg-text-xs\)\/1\.3 "Segoe UI", sans-serif; \}/);
    assert.match(out, /\.c \{ font-size: calc\(15px \* var\(--mg-text-scale\)\) !important; \}/);
  });

  it('a second run changes nothing', () => {
    const css = '.a { color: #fff; background: #FFFFFF; font: 700 12px/1 x; }\n.b { font-size: 11px; color: #123456; }\n';
    const tokens = lightTokens(TOKENS);
    const sizes = textTokens(TOKENS);
    const once = apply(css, [...plan(css, tokens).edits, ...planFonts(css, sizes)]);
    assert.notEqual(once, css);
    assert.deepEqual(plan(once, tokens).edits, []);
    assert.deepEqual(planFonts(once, sizes), []);
    assert.equal(plan(once, tokens).skipped.length, 1);
  });
});
