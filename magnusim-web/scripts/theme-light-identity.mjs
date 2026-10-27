/**
 * Proves from the CSS alone that a theme change leaves the light look as it was. Every declaration
 * that applies in light, in every stylesheet under src/ and bundled-plugins/* (the CAD plugin,
 * node_modules and built output left out), is compared between a git ref (default HEAD) and the
 * working tree. Each side's var() are resolved against that side's light tokens (src/theme/tokens.css,
 * and a plugin's own token files for its stylesheets), text sizes are taken at scale 1, calc() and
 * color-mix(in srgb) are worked out and colours are written one way (#fff is #ffffff, 8-bit channels
 * and alpha). A declaration whose light value differs fails, listed. One only in the ref or only in
 * the working tree is listed to check by hand (a custom property alone paints nothing, so a new one
 * is not), and fails with --strict.
 *
 * Declarations under [data-theme="dark"] are dark only, and left out. One under prefers-color-scheme:
 * dark alone is compared: the theme is html's data-theme, so it also applies in light on a dark system.
 * Declarations are matched by stylesheet, at-rules, selector (its nth rule) and property (its nth),
 * and a rule's property also by the declaration that paints it (its last, an !important one first).
 * Custom properties are matched by name too, per family (the core, each plugin): a token moved to
 * another rule still has its light value compared, and one gone is listed as removed. Some are only
 * read from code (vtk, WebGPU), where no stylesheet use would show the change.
 *
 *   node scripts/theme-light-identity.mjs [ref] [--strict] [--json]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---- Stylesheets ----

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build']);

/** A plugin's build output folder (vite.config's build.outDir, from its root), or ''. */
function pluginOutDir(viteConfig) {
  const root = /\broot:\s*['"]([^'"]+)['"]/.exec(viteConfig)?.[1] || '.';
  const out = /\boutDir:\s*['"]([^'"]+)['"]/.exec(viteConfig)?.[1];
  return out ? posix.normalize(posix.join(root, out)) : 'dist';
}

/** Whether a stylesheet path (relative to magnusim-web, with /) is one this check compares. */
export function isComparedCss(path, buildDirs = {}) {
  if (!path.endsWith('.css')) return false;
  const parts = path.split('/');
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  if (parts[0] === 'src') return true;
  if (parts[0] !== 'bundled-plugins' || parts.length < 3 || parts[1] === 'cad') return false;
  const out = buildDirs[parts[1]];
  return !(out && `${parts.slice(2).join('/')}`.startsWith(`${out}/`));
}

/** Each bundled plugin's build output folder, read from its vite config in the working tree. */
export function pluginBuildDirs(web = WEB) {
  const dirs = {};
  const root = join(web, 'bundled-plugins');
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
      const p = join(root, name, f);
      if (existsSync(p)) dirs[name] = pluginOutDir(readFileSync(p, 'utf8'));
    }
  }
  return dirs;
}

function walk(dir, rel, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), `${rel}${e.name}/`, out);
    } else if (e.name.endsWith('.css')) out.push(`${rel}${e.name}`);
  }
}

function git(args, web) {
  const r = spawnSync('git', args, { cwd: web, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

/** path -> text of the compared stylesheets at a git ref. */
export function sheetsAtRef(ref, web = WEB) {
  const dirs = pluginBuildDirs(web);
  const paths = git(['ls-tree', '-r', '--name-only', ref], web).split('\n').filter((p) => isComparedCss(p, dirs));
  return new Map(paths.map((p) => [p, git(['show', `${ref}:./${p}`], web)]));
}

/** path -> text of the compared stylesheets in the working tree. */
export function sheetsInWorkingTree(web = WEB) {
  const dirs = pluginBuildDirs(web);
  const paths = [];
  for (const top of ['src', 'bundled-plugins']) if (existsSync(join(web, top))) walk(join(web, top), `${top}/`, paths);
  return new Map(paths.filter((p) => isComparedCss(p, dirs)).sort().map((p) => [p, readFileSync(join(web, p), 'utf8')]));
}

// ---- Parsing ----

/** Index of the bracket that closes the one at `open`, skipping strings; -1 if none. */
function closing(s, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [pairs[s[open]]];
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const end = s.indexOf(c, i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** The text with comments blanked (same length, newlines kept), strings left alone. */
function blankComments(css) {
  let out = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") {
      const end = css.indexOf(c, i + 1);
      const stop = end < 0 ? css.length - 1 : end;
      out += css.slice(i, stop + 1);
      i = stop;
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end < 0 ? css.length : end + 2;
      out += css.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
    } else out += c;
  }
  return out;
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

/** One selector list, written one way: single spaces, none around combinators and commas. */
function normSelector(s) {
  return oneLine(s)
    .replace(/\s*([>+~,])\s*/g, '$1')
    .replace(/\[\s*([\w-]+)\s*=\s*'([^']*)'\s*\]/g, '[$1="$2"]')
    .replace(/\[\s*([\w-]+)\s*=\s*([\w-]+)\s*\]/g, '[$1="$2"]');
}

/**
 * Every declaration: { context (enclosing at-rules and selectors, outermost first), prop, value,
 * important, line }. Nested blocks (at-rules, CSS nesting) put their prelude on the context.
 */
export function parseCss(css) {
  const text = blankComments(css);
  const lineAt = [];
  let line = 1;
  for (let i = 0; i <= text.length; i++) {
    lineAt.push(line);
    if (text[i] === '\n') line += 1;
  }
  const decls = [];
  const declaration = (from, to, context) => {
    const raw = text.slice(from, to);
    const colon = raw.indexOf(':');
    if (colon < 0 || !context.length || raw.trim().startsWith('@')) return;
    const prop = raw.slice(0, colon).trim();
    if (!/^-{0,2}[a-zA-Z][\w-]*$/.test(prop)) return;
    let value = raw.slice(colon + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
    const line = lineAt[from + raw.length - raw.trimStart().length];
    decls.push({ context, prop: prop.startsWith('--') ? prop : prop.toLowerCase(), value, important, line });
  };
  const block = (from, to, context) => {
    let start = from;
    for (let i = from; i < to; i++) {
      const c = text[i];
      if (c === '"' || c === "'") {
        const end = text.indexOf(c, i + 1);
        i = end < 0 || end >= to ? to : end;
      } else if (c === '(' || c === '[') {
        const end = closing(text, i);
        i = end < 0 || end >= to ? to : end;
      } else if (c === '{') {
        const end = closing(text, i);
        const stop = end < 0 || end >= to ? to : end;
        const prelude = text.slice(start, i);
        block(i + 1, stop, [...context, prelude.trim().startsWith('@') ? oneLine(prelude) : normSelector(prelude)]);
        i = stop;
        start = stop + 1;
      } else if (c === ';') {
        declaration(start, i, context);
        start = i + 1;
      }
    }
    if (start < to) declaration(start, to, context);
  };
  block(0, text.length, []);
  return decls;
}

const DARK_SELECTOR = /\[data-theme="dark"\]/;
// :not([data-theme="dark"]) applies in light, and one inside :is() or :has() may: what a
// functional pseudo-class holds never makes a selector dark only.
const PSEUDO_GROUP = /:[\w-]+\((?:[^()]|\([^()]*\))*\)/g;

/**
 * Whether a declaration's context applies in light: some selector of each list not dark. No at-rule
 * makes it dark only: the theme is html's data-theme, so a prefers-color-scheme: dark rule also
 * paints in light on a dark system unless its selector is dark too. :not([data-theme="light"]) is
 * not dark either: the light page's html may have no data-theme at all.
 */
export function appliesInLight(context) {
  for (const c of context) {
    if (c.startsWith('@')) continue;
    if (splitArgs(c).every((s) => DARK_SELECTOR.test(s.replace(PSEUDO_GROUP, '')))) return false;
  }
  return true;
}

// ---- Values ----

const NAMED = { white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0] };

/** A colour as [r, g, b, a] (0..255, 0..1), or null: hex, rgb()/rgba() in either syntax, a few names. */
export function parseColour(s) {
  const v = s.trim().toLowerCase();
  if (NAMED[v]) return NAMED[v];
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (hex) {
    const h = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    const byte = (i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255);
    return [byte(0), byte(2), byte(4), byte(6) / 255];
  }
  const fn = /^rgba?\(([^()]*)\)$/.exec(v);
  if (!fn) return null;
  const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length !== 3 && parts.length !== 4) return null;
  const num = (p, scale) => (p.endsWith('%') ? (Number(p.slice(0, -1)) / 100) * scale : Number(p));
  const c = [num(parts[0], 255), num(parts[1], 255), num(parts[2], 255), parts[3] === undefined ? 1 : num(parts[3], 1)];
  return c.every(Number.isFinite) ? c : null;
}

/** A colour as it paints: 8-bit channels and alpha, #rrggbb when opaque, else rgba(r,g,b,a). */
export function colourText([r, g, b, a]) {
  const byte = (v) => Math.min(255, Math.max(0, Math.round(v)));
  const alpha = byte(a * 255);
  if (alpha === 255) return `#${[r, g, b].map((v) => byte(v).toString(16).padStart(2, '0')).join('')}`;
  return `rgba(${byte(r)},${byte(g)},${byte(b)},${Number((alpha / 255).toFixed(3))})`;
}

/** Top-level comma-separated arguments. */
function splitArgs(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** color-mix(in srgb, A [p1], B [p2]) as CSS Color 5 mixes it (premultiplied alpha), or null. */
export function mixSrgb(args) {
  const [space, ...stops] = splitArgs(args);
  if (oneLine(space).toLowerCase() !== 'in srgb' || stops.length !== 2) return null;
  const parsed = stops.map((stop) => {
    const m = /^(.*?)(?:\s+(-?\d*\.?\d+)%)?$/.exec(stop.trim());
    const pct = /^(-?\d*\.?\d+)%\s+(.*)$/.exec(stop.trim());
    const colour = parseColour(pct ? pct[2] : m[1]);
    const p = pct ? Number(pct[1]) : m[2] === undefined ? undefined : Number(m[2]);
    return { colour, p };
  });
  if (parsed.some((x) => !x.colour)) return null;
  let [p1, p2] = parsed.map((x) => x.p);
  if (p1 === undefined && p2 === undefined) [p1, p2] = [50, 50];
  else if (p1 === undefined) p1 = 100 - p2;
  else if (p2 === undefined) p2 = 100 - p1;
  const sum = p1 + p2;
  if (!(sum > 0)) return null;
  const [w1, w2] = [p1 / sum, p2 / sum];
  const [c1, c2] = parsed.map((x) => x.colour);
  const a = c1[3] * w1 + c2[3] * w2;
  const ch = (i) => (a === 0 ? 0 : (c1[i] * c1[3] * w1 + c2[i] * c2[3] * w2) / a);
  return [ch(0), ch(1), ch(2), a * Math.min(1, sum / 100)];
}

/** calc() over numbers and one unit (12px * 1, 100% - 0%): its result, or null. */
export function evalCalc(expr) {
  const tokens = expr.match(/-?\d*\.?\d+(?:e-?\d+)?[a-z%]*|[-+*/()]/gi) || [];
  if (tokens.join('') !== expr.replace(/\s+/g, '')) return null;
  let i = 0;
  const factor = () => {
    const t = tokens[i++];
    if (t === '(') {
      const v = sum();
      return tokens[i++] === ')' ? v : null;
    }
    const m = /^(-?\d*\.?\d+(?:e-?\d+)?)([a-z%]*)$/i.exec(t || '');
    return m ? { n: Number(m[1]), unit: m[2].toLowerCase() } : null;
  };
  const term = () => {
    let v = factor();
    while (v && (tokens[i] === '*' || tokens[i] === '/')) {
      const op = tokens[i++];
      const w = factor();
      if (!w) return null;
      if (op === '*' && (v.unit === '' || w.unit === '')) v = { n: v.n * w.n, unit: v.unit || w.unit };
      else if (op === '/' && w.unit === '' && w.n !== 0) v = { n: v.n / w.n, unit: v.unit };
      else return null;
    }
    return v;
  };
  const sum = () => {
    let v = term();
    while (v && (tokens[i] === '+' || tokens[i] === '-')) {
      const op = tokens[i++];
      const w = term();
      if (!w || w.unit !== v.unit) return null;
      v = { n: op === '+' ? v.n + w.n : v.n - w.n, unit: v.unit };
    }
    return v;
  };
  const v = sum();
  return v && i === tokens.length ? `${Number(v.n.toFixed(4))}${v.unit}` : null;
}

/** var() replaced from `tokens` (a fallback when the token is unknown), until none is left or a loop. */
export function resolveVars(value, tokens, depth = 0) {
  if (depth > 24) return value;
  let out = '';
  for (let i = 0; i < value.length; ) {
    const at = value.indexOf('var(', i);
    if (at < 0 || (at > 0 && /[\w-]/.test(value[at - 1]))) {
      if (at < 0) {
        out += value.slice(i);
        break;
      }
      out += value.slice(i, at + 4);
      i = at + 4;
      continue;
    }
    const end = closing(value, at + 3);
    if (end < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, at);
    const [name, ...rest] = splitArgs(value.slice(at + 4, end));
    const fallback = rest.length ? rest.join(',') : undefined;
    const known = tokens.get(name.trim());
    if (typeof known === 'string') out += resolveVars(known, tokens, depth + 1);
    else if (known === undefined && fallback !== undefined) out += resolveVars(fallback, tokens, depth + 1);
    else out += `var(${name.trim()}${fallback !== undefined ? `,${resolveVars(fallback, tokens, depth + 1)}` : ''})`;
    i = end + 1;
  }
  return out;
}

/** calc(), color-mix(in srgb), rgb() and rgba() worked out, innermost first. */
function simplify(s) {
  let out = '';
  for (let i = 0; i < s.length; ) {
    const fn = /^([a-zA-Z][\w-]*)\(/.exec(s.slice(i));
    if (fn && (i === 0 || !/[\w-]/.test(s[i - 1]))) {
      const open = i + fn[1].length;
      const end = closing(s, open);
      if (end < 0) {
        out += s.slice(i);
        break;
      }
      const name = fn[1].toLowerCase();
      const inner = name === 'url' ? s.slice(open + 1, end) : simplify(s.slice(open + 1, end));
      let done = null;
      if (name === 'calc') done = evalCalc(inner);
      else if (name === 'color-mix') {
        const c = mixSrgb(inner);
        done = c && colourText(c);
      } else if (name === 'rgb' || name === 'rgba') {
        const c = parseColour(`${name}(${inner})`);
        done = c && colourText(c);
      }
      out += done ?? `${fn[1]}(${inner})`;
      i = end + 1;
    } else {
      out += s[i];
      i += 1;
    }
  }
  return out;
}

/** A light value written one way: var() resolved, calc and colours worked out, spacing normalised. */
export function lightValue(value, tokens) {
  let v = simplify(resolveVars(value, tokens));
  v = v.replace(/#[0-9a-fA-F]{3,8}\b/g, (h) => {
    const c = parseColour(h);
    return c ? colourText(c) : h;
  });
  v = v.replace(/(?<![\w#-])(white|black|transparent)(?![\w-])/gi, (n) => colourText(NAMED[n.toLowerCase()]));
  return oneLine(v)
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*,\s*/g, ',');
}

// ---- Tokens ----

/** Where a stylesheet's var() look: the core (src/) or one plugin's own sheets on top of the core's. */
function familyOf(path) {
  const parts = path.split('/');
  return parts[0] === 'bundled-plugins' ? `plugin:${parts[1]}` : 'core';
}

const AMBIGUOUS = Symbol('ambiguous');

/**
 * For each family, the light custom properties: name -> value as declared (AMBIGUOUS when light
 * rules declare it with different values). Text and icon scales are 1, as designed. get(path) is
 * the map a stylesheet's var() look in. family(name) is a family's map, the names it declares, and
 * by name each light declaration of a token there (the family's own, else the core's).
 */
export function lightTokenMaps(sheets) {
  const own = new Map();
  const declared = new Map();
  for (const [path, css] of sheets) {
    const fam = familyOf(path);
    if (!own.has(fam)) {
      own.set(fam, new Map());
      declared.set(fam, new Map());
    }
    const map = own.get(fam);
    const decls = declared.get(fam);
    for (const d of parseCss(css)) {
      if (!d.prop.startsWith('--') || !appliesInLight(d.context)) continue;
      const prev = map.get(d.prop);
      map.set(d.prop, prev === undefined || prev === d.value ? d.value : AMBIGUOUS);
      if (!decls.has(d.prop)) decls.set(d.prop, []);
      decls.get(d.prop).push({ path, line: d.line, rule: d.context[d.context.length - 1], value: d.value, important: d.important });
    }
  }
  const core = new Map([...(own.get('core') || new Map())]);
  core.set('--mg-text-scale', '1');
  core.set('--mg-icon-scale', '1');
  const maps = new Map([['core', core]]);
  for (const [fam, map] of own) if (fam !== 'core') maps.set(fam, new Map([...core, ...map]));
  const coreDecls = declared.get('core') || new Map();
  const family = (fam) => {
    const decls = declared.get(fam) || new Map();
    return { tokens: maps.get(fam) || core, names: [...decls.keys()], decls: (name) => decls.get(name) || coreDecls.get(name) };
  };
  return { get: (path) => maps.get(familyOf(path)) || core, families: [...own.keys()], family };
}

// ---- Comparing ----

/**
 * Every light declaration of a set of stylesheets, by key (path, context, nth rule, prop, nth), and
 * for each rule's property (the key without its nth) the declaration that paints it.
 */
function lightDeclarations(sheets, tokens) {
  const out = new Map();
  const winners = new Map();
  for (const [path, css] of sheets) {
    const map = tokens.get(path);
    const ruleSeen = new Map();
    let lastRule = null;
    let ruleKey = '';
    const propSeen = new Map();
    for (const d of parseCss(css)) {
      if (!appliesInLight(d.context)) continue;
      // A rule is one context; repeated contexts (the same selector again later) are numbered.
      if (d.context !== lastRule) {
        lastRule = d.context;
        const ctx = d.context.join(' / ');
        const n = (ruleSeen.get(ctx) || 0) + 1;
        ruleSeen.set(ctx, n);
        ruleKey = `${path} | ${ctx} #${n}`;
        propSeen.clear();
      }
      const m = (propSeen.get(d.prop) || 0) + 1;
      propSeen.set(d.prop, m);
      const entry = {
        path,
        line: d.line,
        rule: d.context[d.context.length - 1],
        prop: d.prop,
        written: `${oneLine(d.value)}${d.important ? ' !important' : ''}`,
        light: `${lightValue(d.value, map)}${d.important ? ' !important' : ''}`,
      };
      out.set(`${ruleKey} | ${d.prop} #${m}`, entry);
      const won = winners.get(`${ruleKey} | ${d.prop}`);
      if (!won || d.important || !won.important) winners.set(`${ruleKey} | ${d.prop}`, { entry, important: d.important });
    }
  }
  return { decls: out, winners };
}

const lastOf = (list) => list[list.length - 1];

/** A token's light declarations in one family as one entry: its values joined when they differ. */
function tokenEntry(name, decls, tokens) {
  const each = (d, v) => `${v}${d.important ? ' !important' : ''}`;
  const join = (list) => [...new Set(list)].sort().join(' | ');
  const last = lastOf(decls);
  return {
    path: last.path,
    line: last.line,
    rule: last.rule,
    prop: name,
    written: join(decls.map((d) => each(d, oneLine(d.value)))),
    light: join(decls.map((d) => each(d, lightValue(d.value, tokens)))),
  };
}

/**
 * Compares two sets of stylesheets (path -> text). changed: declarations whose light value differs,
 * a rule's property whose painting declaration does, and tokens whose light value does by name;
 * added, removed: declarations on one side only (a new custom property left out).
 */
export function compareLight(before, after) {
  const tokA = lightTokenMaps(before);
  const tokB = lightTokenMaps(after);
  const a = lightDeclarations(before, tokA);
  const b = lightDeclarations(after, tokB);
  const changed = [];
  const added = [];
  const removed = [];
  const reported = new Set();
  let compared = 0;
  for (const [key, was] of a.decls) {
    const now = b.decls.get(key);
    if (!now) {
      if (!was.prop.startsWith('--')) removed.push(was);
      continue;
    }
    compared += 1;
    if (was.light !== now.light) {
      changed.push({ ...now, was: was.written, wasLight: was.light, wasLine: was.line });
      reported.add(key.replace(/ #\d+$/, ''));
    }
  }
  for (const [key, now] of b.decls) if (!a.decls.has(key) && !now.prop.startsWith('--')) added.push(now);
  // A second declaration of a property added to a rule (or one taken away) changes what paints
  // although every declaration matched by its nth kept its value.
  for (const [key, was] of a.winners) {
    const now = b.winners.get(key);
    if (!now || reported.has(key) || was.entry.light === now.entry.light) continue;
    changed.push({ ...now.entry, was: was.entry.written, wasLight: was.entry.light, wasLine: was.entry.line });
    reported.add(key);
  }
  // Tokens by name: a token moved to another rule is matched by key on neither side.
  const reportedTokens = new Set(changed.filter((d) => d.prop.startsWith('--')).map((d) => `${familyOf(d.path)} | ${d.prop}`));
  let tokens = 0;
  for (const fam of new Set([...tokA.families, ...tokB.families])) {
    const was = tokA.family(fam);
    const now = tokB.family(fam);
    for (const name of new Set([...was.names, ...now.names])) {
      const wasDecls = was.decls(name);
      if (!wasDecls) continue;
      const nowDecls = now.decls(name);
      const wasEntry = tokenEntry(name, wasDecls, was.tokens);
      if (!nowDecls) {
        removed.push(wasEntry);
        continue;
      }
      tokens += 1;
      const nowEntry = tokenEntry(name, nowDecls, now.tokens);
      if (wasEntry.light === nowEntry.light || reportedTokens.has(`${fam} | ${name}`)) continue;
      changed.push({ ...nowEntry, was: wasEntry.written, wasLight: wasEntry.light, wasLine: wasEntry.line });
    }
  }
  return { compared, tokens, changed, added, removed };
}

function report(result, { ref, sheets, strict }) {
  const lines = [`theme-light-identity: ${ref} -> working tree, ${sheets} stylesheets, ${result.compared} light declarations and ${result.tokens} tokens compared`];
  const where = (d) => `${d.path}:${d.line} ${d.rule} { ${d.prop} }`;
  lines.push(`changed in light: ${result.changed.length}`);
  for (const d of result.changed) lines.push(`  FAIL ${where(d)}: ${d.was} (${d.wasLight}) -> ${d.written} (${d.light})`);
  lines.push(`only in ${ref} (removed): ${result.removed.length}${strict ? '' : ', check by hand'}`);
  for (const d of result.removed) lines.push(`  ${where(d)}: ${d.written} (${d.light})`);
  lines.push(`only in the working tree (added): ${result.added.length}${strict ? '' : ', check by hand'}`);
  for (const d of result.added) lines.push(`  ${where(d)}: ${d.written} (${d.light})`);
  const failed = result.changed.length > 0 || (strict && result.added.length + result.removed.length > 0);
  lines.push(failed ? 'FAILED: the light look changes' : 'OK: no light value changed');
  return { text: lines.join('\n'), failed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const ref = args.find((a) => !a.startsWith('--')) || 'HEAD';
  const strict = args.includes('--strict');
  const before = sheetsAtRef(ref);
  const after = sheetsInWorkingTree();
  const result = compareLight(before, after);
  const sheets = new Set([...before.keys(), ...after.keys()]).size;
  const { text, failed } = report(result, { ref, sheets, strict });
  console.log(args.includes('--json') ? JSON.stringify({ ref, sheets, ...result }, null, 2) : text);
  process.exitCode = failed ? 1 : 0;
}
