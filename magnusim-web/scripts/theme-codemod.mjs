/**
 * Colour literals in src/style.css that equal a design token's light value become that token
 * (src/theme/tokens.css), so the dark set (and any later theme) reaches them. A literal is only
 * replaced by a token with exactly its value, so the light look is unchanged, pixel for pixel.
 *
 * Several tokens share a value (#fff is --mg-bg and --mg-primary-text; #1570ef is --mg-primary,
 * --mg-info and --mg-series-1): the token is chosen by what the declaration paints (text,
 * background, border), in ROLES' order. A literal with no token of its value, one whose value
 * has tokens but none for what it paints, a custom property's own value and a var() fallback
 * are left as they are and listed (--report FILE writes them as JSON).
 *
 * A declaration followed on its line by a comment that starts with "fixed" paints the same in
 * every theme (the white capture frame over its dark mask): its literals are left and listed
 * apart, as fixed, and do not count as left.
 *
 * Px font sizes (font-size, and the size in a font shorthand) become their --mg-text-* token, or
 * calc(Npx * var(--mg-text-scale)) for a size with no token, so Settings' text size reaches them;
 * at scale 1 each is the same px.
 *
 *   node scripts/theme-codemod.mjs            what it would change
 *   node scripts/theme-codemod.mjs --write    change src/style.css
 *   node scripts/theme-codemod.mjs --report out.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = join(WEB, 'src', 'theme', 'tokens.css');
const STYLE = join(WEB, 'src', 'style.css');

/** What a declaration paints, by its property. */
export function roleOf(prop) {
  const p = prop.toLowerCase();
  if (p === 'color' || p === 'fill' || p === 'stroke' || p === 'caret-color' || p === 'text-decoration-color' || p === '-webkit-text-fill-color') return 'text';
  if (p.startsWith('background')) return 'background';
  if (p.startsWith('border') || p.startsWith('outline') || p === 'column-rule-color') return 'border';
  if (p === 'box-shadow' || p === 'text-shadow') return 'shadow';
  return null;
}

/** For each role, the tokens it may use, in order (the first of a value's tokens on this list wins). */
export const ROLES = {
  text: [
    'text', 'text-strong', 'text-muted', 'text-subtle', 'text-body', 'text-secondary', 'primary-text', 'link', 'link-strong',
    'link-strong-hover', 'primary-ink', 'primary-hover', 'danger', 'success', 'warning', 'info', 'tooltip-text', 'danger-solid',
  ],
  background: [
    'bg', 'surface', 'surface-muted', 'selected-bg', 'danger-bg', 'success-bg', 'warning-bg', 'btn-neutral-bg', 'btn-neutral-hover',
    'btn-disabled-bg', 'primary', 'primary-hover', 'danger-solid', 'danger-solid-hover', 'tooltip-bg', 'plot-bg', 'plot-tip-bg',
    'switch-off', 'divider', 'border-subtle', 'danger', 'success', 'warning',
  ],
  border: [
    'border', 'border-subtle', 'header-border', 'selected-border', 'danger-border', 'divider', 'card-border', 'control-border',
    'btn-neutral-border', 'primary', 'primary-hover', 'danger', 'success', 'warning', 'bg',
  ],
  shadow: ['focus'],
};

/** The px font sizes the text tokens hold (at scale 1): px -> token name (without --mg-). */
export function textTokens(css) {
  const map = new Map();
  for (const m of css.matchAll(/--mg-(text-[a-z0-9]+)\s*:\s*calc\((\d+(?:\.\d+)?)px \* var\(--mg-text-scale\)\);/g)) {
    if (!map.has(m[2])) map.set(m[2], m[1]);
  }
  return map;
}

/** A colour literal as one spelling: #rrggbb(aa) in lower case, rgb(a) with plain numbers and no spaces. */
export function normalize(lit) {
  const s = lit.trim().toLowerCase();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    if (h.length === 3 || h.length === 4) return `#${[...h].map((c) => c + c).join('')}`.replace(/^(#[0-9a-f]{6})ff$/, '$1');
    return s.replace(/^(#[0-9a-f]{6})ff$/, '$1');
  }
  const m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (!m) return s;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map((x) => String(Number(x)));
  if (parts.length === 4 && parts[3] === '1') parts.pop();
  if (parts.length === 3) return `#${parts.map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`;
  return `rgba(${parts.join(',')})`;
}

/** The light colour tokens (the first :root block): normalized value -> token names (without --mg-), in file order. */
export function lightTokens(css) {
  const root = /:root[^{]*\{([\s\S]*?)\n\}/.exec(css);
  if (!root) throw new Error('tokens.css has no :root block');
  const map = new Map();
  for (const m of root[1].matchAll(/--mg-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const v = m[2].trim();
    if (!/^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i.test(v)) continue;
    const k = normalize(v);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(m[1]);
  }
  return map;
}

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;

/** Each declaration outside comments: its property, value and the value's index in the file. */
function declarations(styleCss) {
  // Comments blanked (same length) so their text is never matched and indexes stay the file's.
  const masked = styleCss.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
  return [...masked.matchAll(/(^|[;{\s])(-{0,2}[a-zA-Z][a-zA-Z0-9-]*)\s*:\s*([^;{}]+)(?=;|\})/g)].map((d) => {
    const end = d.index + d[0].length;
    return {
      prop: d[2],
      value: d[3],
      valueStart: end - d[3].length,
      fixed: /^;[ \t]*\/\*[ \t]*fixed\b/.test(styleCss.slice(end, end + 64)),
    };
  });
}

/** The edits: each colour literal in a declaration, its token or why it stays. */
export function plan(styleCss, tokens) {
  const lineOf = (i) => styleCss.slice(0, i).split('\n').length;
  const edits = [];
  const skipped = [];
  const fixed = [];
  for (const { prop, value, valueStart, fixed: isFixed } of declarations(styleCss)) {
    for (const c of value.matchAll(COLOR_RE)) {
      const at = valueStart + c.index;
      const lit = c[0];
      const line = lineOf(at);
      const before = value.slice(0, c.index);
      const why = (reason) => skipped.push({ line, prop, literal: lit, reason });
      if (isFixed) {
        fixed.push({ line, prop, literal: lit });
        continue;
      }
      if (prop.startsWith('--')) {
        why('a custom property');
        continue;
      }
      // Inside var(--x, <here>): a fallback, left as it is.
      if ((before.match(/var\(/g) || []).length > (before.match(/\)/g) || []).length) {
        why('a var() fallback');
        continue;
      }
      const role = roleOf(prop);
      const names = tokens.get(normalize(lit)) || [];
      if (!names.length) {
        why('no token has this value');
        continue;
      }
      const order = role ? ROLES[role] : [];
      const pick = order.find((n) => names.includes(n));
      if (!pick) {
        why(`its tokens (${names.map((n) => `--mg-${n}`).join(', ')}) are not ${role || 'a role this property has'}'s`);
        continue;
      }
      edits.push({ at, length: lit.length, line, prop, literal: lit, to: `var(--mg-${pick})` });
    }
  }
  return { edits, skipped, fixed };
}

/** The edits for px font sizes: font-size's px, and a font shorthand's size (its first px). */
export function planFonts(styleCss, sizes) {
  const lineOf = (i) => styleCss.slice(0, i).split('\n').length;
  const edits = [];
  for (const { prop, value, valueStart } of declarations(styleCss)) {
    if (prop !== 'font-size' && prop !== 'font') continue;
    const m = /(^|[\s(])(\d+(?:\.\d+)?)px\b/.exec(value);
    if (!m || /var\(|calc\(/.test(value.slice(0, m.index + m[1].length))) continue;
    const at = valueStart + m.index + m[1].length;
    const literal = `${m[2]}px`;
    const name = sizes.get(m[2]);
    const to = name ? `var(--mg-${name})` : `calc(${literal} * var(--mg-text-scale))`;
    edits.push({ at, length: literal.length, line: lineOf(at), prop, literal, to });
  }
  return edits;
}

export function apply(styleCss, edits) {
  let out = styleCss;
  for (const e of [...edits].sort((a, b) => b.at - a.at)) out = `${out.slice(0, e.at)}${e.to}${out.slice(e.at + e.length)}`;
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const style = readFileSync(STYLE, 'utf8');
  const tokensCss = readFileSync(TOKENS, 'utf8');
  const colours = plan(style, lightTokens(tokensCss));
  const fonts = planFonts(style, textTokens(tokensCss));
  const { skipped, fixed } = colours;
  const edits = [...colours.edits, ...fonts];
  const byToken = {};
  for (const e of edits) byToken[e.to] = (byToken[e.to] || 0) + 1;
  console.log(`${colours.edits.length} colour literals to tokens, ${skipped.length} left, ${fixed.length} fixed; ${fonts.length} font sizes to tokens`);
  console.log(Object.entries(byToken).sort((a, b) => b[1] - a[1]).map(([t, n]) => `  ${t} ${n}`).join('\n'));
  const at = process.argv.indexOf('--report');
  if (at > 0) writeFileSync(process.argv[at + 1], `${JSON.stringify({ edits, skipped, fixed }, null, 2)}\n`);
  if (process.argv.includes('--write')) {
    writeFileSync(STYLE, apply(style, edits));
    console.log(`wrote ${STYLE}`);
  }
}
