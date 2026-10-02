/**
 * Helpers for the plugin UI kit's CSS tests (src/plugin-ui/styles/*-css.test.ts).
 *
 * In a workspace frame, /plugin-sdk/theme.css (src/plugin-sdk/base.css) styles
 * bare elements: a button's border, padding and background, an input's border,
 * the focus ring. The app page does not. So the base rule of each kit control
 * (button.mgk-btn, input.mgk-input, ...) must set every property base.css sets
 * on that element, or the control looks different in a frame.
 *
 * Files are read from disk: vitest turns a `?raw` CSS import into ''.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The gen check's own rules (scripts/plugin-sdk-checks.mjs: colours, design
// values, selectors), so each part's CSS test holds its file to them as well.
export { checkCssColours, checkCssDesignValues, checkCssSelectors } from '../../scripts/plugin-sdk-checks.mjs';

function readHere(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

/** A kit stylesheet's text: `readKitCss('button.css')` is src/plugin-ui/styles/button.css. */
export function readKitCss(name: string): string {
  return readHere(`../plugin-ui/styles/${name}`);
}

const frameBaseCss = readHere('../plugin-sdk/base.css');

/** The app's own stylesheet (src/style.css): the core rules the kit copies. */
export function readAppCss(): string {
  return readHere('../style.css');
}

/** Every --mg-* token src/theme/tokens.css declares, by name. */
export function tokenValues(): Record<string, string> {
  const css = readHere('../theme/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  return Object.fromEntries([...css.matchAll(/(--mg-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/** `props` with each var(--mg-*) replaced by its tokens.css value, to compare with a core rule. */
export function withTokens(props: Record<string, string>): Record<string, string> {
  const tokens = tokenValues();
  const resolve = (v: string) => v.replace(/var\((--mg-[\w-]+)\)/g, (m, name: string) => tokens[name] ?? m);
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, resolve(v)]));
}

export interface CssRule {
  selectors: string[];
  props: Record<string, string>;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    else if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Every style rule, in order; rules inside @media and @supports included, @keyframes left out. */
export function cssRules(css: string): CssRule[] {
  const text = stripComments(css);
  const rules: CssRule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') depth -= 1;
      j += 1;
    }
    const body = text.slice(open + 1, j - 1);
    if (prelude.startsWith('@')) {
      if (/^@(media|supports|layer)\b/i.test(prelude)) rules.push(...cssRules(body));
    } else {
      const props: Record<string, string> = {};
      for (const decl of splitTopLevel(body, ';')) {
        const colon = decl.indexOf(':');
        if (colon > 0) props[decl.slice(0, colon).trim().toLowerCase()] = decl.slice(colon + 1).trim();
      }
      rules.push({ selectors: splitTopLevel(prelude, ','), props });
    }
    i = j;
  }
  return rules;
}

/** The declarations of every rule whose selector list holds exactly `selector`, merged in order. */
export function ruleProps(css: string, selector: string): Record<string, string> {
  const want = selector.replace(/\s+/g, ' ').trim();
  const out: Record<string, string> = {};
  for (const rule of cssRules(css)) {
    if (rule.selectors.some((s) => s.replace(/\s+/g, ' ') === want)) Object.assign(out, rule.props);
  }
  return out;
}

/**
 * A selector that matches a bare `element` (no class) in some state: `button`,
 * `button:hover`, `:focus-visible`. Universal `*` rules are left out: the kit's
 * styles/base.css sets box-sizing on every kit element itself.
 */
function matchesBareElement(selector: string, element: string): boolean {
  const s = selector.trim();
  if (/[\s>+~]/.test(s)) return false;
  const m = s.match(/^([a-z][a-z0-9-]*)?((?::[a-z-]+)*)$/i);
  if (!m) return false;
  const tag = m[1] || '';
  if (!tag && !m[2]) return false;
  return !tag || tag.toLowerCase() === element.toLowerCase();
}

/** Every property the frame's base.css sets on a bare `element`, in any state (sorted). */
export function frameBaseProps(element: string): string[] {
  const props = new Set<string>();
  for (const rule of cssRules(frameBaseCss)) {
    if (rule.selectors.some((s) => matchesBareElement(s, element))) {
      for (const p of Object.keys(rule.props)) props.add(p);
    }
  }
  return [...props].sort();
}

/** The properties base.css sets on `element` that the kit rule `selector` does not set. */
export function missingFrameBaseProps(css: string, selector: string, element: string): string[] {
  const set = ruleProps(css, selector);
  return frameBaseProps(element).filter((p) => !(p in set));
}

/** [ids, classes + attributes + pseudo-classes, elements + pseudo-elements] of one complex selector. */
export function specificity(selector: string): [number, number, number] {
  let s = selector.replace(/\[[^\]]*\]/g, () => ' .attr ');
  let a = 0;
  let b = 0;
  let c = 0;
  s = s.replace(/::[a-z-]+/gi, () => {
    c += 1;
    return ' ';
  });
  s = s.replace(/#[\w-]+/g, () => {
    a += 1;
    return ' ';
  });
  s = s.replace(/\.[\w-]+|:[a-z-]+/gi, () => {
    b += 1;
    return ' ';
  });
  for (const part of s.split(/[\s>+~]+/)) {
    if (/^[a-z][a-z0-9-]*$/i.test(part)) c += 1;
  }
  return [a, b, c];
}
