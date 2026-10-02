/**
 * The plugin UI kit's build checks (H14), as pure functions so a test can show
 * each one fail (scripts/__tests__/plugin-sdk-checks.test.mjs).
 * scripts/gen-plugin-sdk.mjs runs them on the kit build the server serves
 * (buildKit in scripts/server/sdk-build.ts). Each returns a list of problems;
 * an empty list passes.
 */

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function splitTopLevel(text, sep) {
  const out = [];
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

function declarations(body) {
  const decls = [];
  for (const decl of splitTopLevel(body, ';')) {
    const colon = decl.indexOf(':');
    if (colon > 0) decls.push([decl.slice(0, colon).trim().toLowerCase(), decl.slice(colon + 1).trim()]);
  }
  return decls;
}

/**
 * Every style rule ({selectors, decls: [[prop, value]]}); @media and @supports
 * looked into. @keyframes frames and @font-face are skipped, or with `all` kept
 * as rules of their own (their selector is the frame or the at-rule), so the
 * value checks read every declaration.
 */
export function cssRules(css, { all = false } = {}) {
  const text = stripComments(css);
  const rules = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim().replace(/^;+/, '').trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') depth -= 1;
      j += 1;
    }
    const body = text.slice(open + 1, j - 1);
    if (prelude.startsWith('@')) {
      if (/^@(media|supports|layer|container)\b/i.test(prelude)) rules.push(...cssRules(body, { all }));
      else if (all && body.includes('{')) rules.push(...cssRules(body, { all }));
      else if (all) rules.push({ selectors: [prelude], decls: declarations(body) });
    } else {
      rules.push({ selectors: splitTopLevel(prelude, ','), decls: declarations(body) });
    }
    i = j;
  }
  return rules;
}

/** Rule 2: every input of plugin-ui.js is under src/plugin-ui/ (the stdin entry, by its exact name, aside). */
export function checkKitInputs(metafile, entryName) {
  const problems = [];
  for (const input of Object.keys(metafile.inputs)) {
    if (input === entryName) continue;
    if (!input.startsWith('src/plugin-ui/')) problems.push(`plugin-ui.js bundles ${input}, which is outside src/plugin-ui/`);
  }
  return problems;
}

/** Rule 3: every import plugin-ui.js leaves to the page is a name in the import map. */
export function checkKitExternals(metafile, importMap) {
  const problems = [];
  for (const output of Object.values(metafile.outputs)) {
    for (const imp of output.imports || []) {
      if (imp.external && !Object.hasOwn(importMap, imp.path)) {
        problems.push(`plugin-ui.js imports ${imp.path}, which the frame import map does not name`);
      }
    }
  }
  return problems;
}

const COLOUR_FUNCTIONS = 'rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark|device-cmyk';

/** A hex colour, a colour function or white/black after a colon, anywhere in a text. */
export const CSS_COLOUR = new RegExp(`#[0-9a-f]{3,8}\\b|\\b(?:${COLOUR_FUNCTIONS})\\(|:\\s*(white|black)\\b`, 'i');

/** The CSS named colours (CSS Color 4) and system colours, current and deprecated, in lower case. */
export const CSS_NAMED_COLOURS = new Set(
  [
    // Named colours.
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood',
    'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray',
    'darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen',
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue',
    'firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew',
    'hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan',
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray',
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue',
    'mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred',
    'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid',
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple',
    'rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue',
    'slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white',
    'whitesmoke yellow yellowgreen',
    // System colours.
    'accentcolor accentcolortext activetext buttonborder buttonface buttontext canvas canvastext field fieldtext graytext',
    'highlight highlighttext linktext mark marktext selecteditem selecteditemtext visitedtext',
    // Deprecated system colours (browsers still draw them).
    'activeborder activecaption appworkspace background buttonhighlight buttonshadow captiontext inactiveborder',
    'inactivecaption inactivecaptiontext infobackground infotext menu menutext scrollbar threeddarkshadow threedface',
    'threedhighlight threedlightshadow threedshadow window windowframe windowtext',
  ]
    .join(' ')
    .split(' '),
);

// Values that name properties, fonts, animations or grid areas, never a colour:
// `transition: background …` is not the old system colour Background.
const NOT_A_COLOUR_PROP =
  /^(transition(-property)?|animation(-name)?|will-change|font(-family|-feature-settings|-variation-settings)?|grid(-[a-z-]+)?|counter-(reset|increment|set)|content|quotes|list-style-type|container(-name)?|view-transition-name|anchor-name|position-anchor)$/;

const STRING = /(["'])(?:\\.|(?!\1)[^\\])*\1/g;
const KIT_TOKEN = /var\(\s*--mg-[\w-]+\s*\)/gi;

/**
 * The colour literals in one CSS value: hex colours, colour functions and, unless
 * `names` is false, named and system colours. var(--mg-*) is how a colour comes
 * in; transparent, currentColor, inherit, revert and none are not colours here.
 * Strings and url() are skipped.
 */
export function colourLiterals(value, { names = true } = {}) {
  const v = String(value).replace(STRING, ' ').replace(/\burl\([^)]*\)/gi, ' ').replace(KIT_TOKEN, ' ');
  const found = [];
  for (const m of v.matchAll(/#[0-9a-f]{3,8}\b/gi)) found.push(m[0]);
  for (const m of v.matchAll(new RegExp(`\\b(?:${COLOUR_FUNCTIONS})\\(`, 'gi'))) found.push(`${m[0]})`);
  if (names) {
    for (const m of v.matchAll(/(?<![\w#.-])-?[a-z_][\w-]*/gi)) {
      if (CSS_NAMED_COLOURS.has(m[0].toLowerCase())) found.push(m[0]);
    }
  }
  return found;
}

/** Rule 4: no colour literal in the kit CSS; colours come through var(--mg-*). */
export function checkCssColours(css) {
  const problems = [];
  for (const rule of cssRules(css, { all: true })) {
    for (const [prop, value] of rule.decls) {
      const found = colourLiterals(value, { names: !NOT_A_COLOUR_PROP.test(prop) });
      if (found.length) {
        problems.push(`${rule.selectors.join(', ')} { ${prop}: ${value} } has a colour literal (${found.join(', ')}); use a --mg-* token`);
      }
    }
  }
  // Anywhere else (outside every block, for one).
  if (!problems.length && CSS_COLOUR.test(stripComments(css))) problems.push('the kit CSS has a colour literal; use a --mg-* token');
  return problems;
}

/** The --mg-* custom properties tokens.css declares. */
export function tokenNames(tokensCss) {
  return new Set([...stripComments(tokensCss).matchAll(/(--mg-[\w-]+)\s*:/g)].map((m) => m[1]));
}

/** Rule 5: every var(--mg-*) the kit CSS reads is declared in src/theme/tokens.css. */
export function checkCssTokens(css, tokensCss) {
  const known = tokenNames(tokensCss);
  const problems = [];
  for (const m of stripComments(css).matchAll(/var\(\s*(--mg-[\w-]+)/g)) {
    if (!known.has(m[1])) problems.push(`${m[1]} is not a token in src/theme/tokens.css`);
  }
  return [...new Set(problems)];
}

// [class^="mgk-"] and [class*=" mgk-"] (quoted or not, as a minifier writes them) match only kit elements.
const KIT_ATTR = /^\[\s*class\s*(\^=\s*(["']?)mgk-\2|\*=\s*(["'])\s+mgk-\3)\s*\]$/;

/** The compound selectors of one complex selector (split at combinators). */
function compounds(selector) {
  const out = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of selector) {
    if (quote) {
      if (ch === quote) quote = '';
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (depth === 0 && /[\s>+~]/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Rule 6: every compound selector has a kit class, and every class starts with mgk-. */
export function checkCssSelectors(css) {
  const problems = [];
  for (const rule of cssRules(css)) {
    for (const selector of rule.selectors) {
      for (const compound of compounds(selector)) {
        const attrs = compound.match(/\[[^\]]*\]/g) || [];
        const bare = compound.replace(/\[[^\]]*\]/g, '');
        const classes = [...bare.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
        const foreign = classes.filter((c) => !c.startsWith('mgk-'));
        if (foreign.length) problems.push(`${selector}: .${foreign.join(', .')} is not a kit class (mgk-*)`);
        const kitClass = classes.some((c) => c.startsWith('mgk-')) || attrs.some((a) => KIT_ATTR.test(a));
        if (!kitClass) problems.push(`${selector}: "${compound}" selects no kit class`);
      }
    }
  }
  return problems;
}

const TOKEN_ONLY = /^(font-size|font-weight|border-radius|border-(top|bottom)-(left|right)-radius|border-(start|end)-(start|end)-radius|box-shadow|z-index)$/;
const TOKEN_VALUE = /^(var\(--mg-[\w-]+\)|revert|inherit|none|0)$/i;
const TIME = /(^|[^\w-])\d*\.?\d+m?s\b/i;
const VIEWPORT = /\d(?:[sld]?v(?:w|h|i|b|min|max))\b/i;

// In the font shorthand: a number (a size or a weight; the line height after `/`
// is taken out first), a weight or size keyword, or a system font.
const FONT_LITERAL =
  /\d|\b(?:bold|bolder|lighter|xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|larger|smaller|caption|icon|menu|message-box|small-caption|status-bar)\b/i;

/** Whether a `font` shorthand sets a size or a weight other than through var(--mg-*). revert and inherit pass. */
function fontShorthandLiteral(v) {
  if (/^(revert|inherit)$/i.test(v)) return false;
  if (/^(initial|unset|revert-layer)$/i.test(v)) return true;
  const rest = v.replace(STRING, ' ').replace(KIT_TOKEN, ' ').replace(/\/\s*\S+/, ' ');
  return FONT_LITERAL.test(rest);
}

/** Rule 9: sizes, weights, radii, shadows, layers and durations come from tokens; no viewport units. */
export function checkCssDesignValues(css) {
  const problems = [];
  for (const rule of cssRules(css, { all: true })) {
    const where = rule.selectors.join(', ');
    for (const [prop, value] of rule.decls) {
      const v = value.replace(/\s*!important$/i, '').trim();
      if (TOKEN_ONLY.test(prop) && !TOKEN_VALUE.test(v)) problems.push(`${where} { ${prop}: ${value} }: use a --mg-* token`);
      if (prop === 'font' && fontShorthandLiteral(v)) {
        problems.push(`${where} { ${prop}: ${value} }: the font shorthand sets a size and a weight; use revert, inherit or --mg-* tokens`);
      }
      if (/^(transition|animation)(-duration|-delay)?$/.test(prop) && TIME.test(v)) {
        problems.push(`${where} { ${prop}: ${value} }: durations come from --mg-* tokens`);
      }
      if (VIEWPORT.test(v)) problems.push(`${where} { ${prop}: ${value} }: no viewport units (page and frame viewports differ)`);
    }
  }
  return problems;
}

/**
 * Rule 7's hand-written part: a plugin that renders kit components and uses
 * kit types against docs/plugins/plugin-ui.d.ts. Runtime names come from the
 * generated import in kitSample(); this part imports types only.
 */
export const KIT_RENDER_SAMPLE = [
  "import type { FieldWidgetProps, LineSeries, ToastKind, UnitSystem } from '@magnusim/plugin-ui';",
  '',
  'export const version: string = PLUGIN_UI_API_VERSION;',
  'export const simTime: string = formatSimTime(0.005);',
  '',
  'export function Rate(p: FieldWidgetProps) {',
  '  return (',
  '    <Button variant="primary" disabled={p.disabled} attrs={{ \'data-rate\': p.id }} onClick={() => p.onChange(4)}>',
  '      {p.label}',
  '    </Button>',
  '  );',
  '}',
  '',
  'export function Fineness(p: FieldWidgetProps) {',
  '  return (',
  '    <NumberUnitInput',
  '      label={p.label}',
  '      id={p.id}',
  '      width="fill"',
  "      valueSi={typeof p.value === 'number' ? p.value : null}",
  '      onCommitSi={(v) => p.onChange(Math.round(v))}',
  '    />',
  '  );',
  '}',
  '',
  'const residuals: LineSeries[] = [',
  "  { key: 'Ux', label: 'Ux' },",
  "  { key: 'p', label: 'p', color: 'var(--mg-series-3)', format: (v) => v.toExponential(2) },",
  '];',
  '',
  'export function Monitor(p: { units: UnitSystem; toast: ToastKind | null; onDone: () => void; onToastClose: () => void }) {',
  '  return (',
  '    <PanelChrome title="Run" onDone={p.onDone} onDelete={() => undefined} footExtra={<span>2 runs</span>}>',
  '      <NumberUnitInput',
  '        label="Inlet length"',
  '        quantity="length"',
  '        units={p.units}',
  '        valueSi={0.25}',
  '        onCommitSi={(v) => void v}',
  '        onLiveSi={(v) => void v}',
  '      />',
  '      <LinePlot',
  '        label="Residuals"',
  "        rows={[{ t: 1, Ux: 1e-2, p: 1e-3 }, { t: 2, Ux: 4e-3, p: 5e-4 }]}",
  '        series={residuals}',
  "        x={{ kind: 'iterations', max: 100 }}",
  "        y={{ scale: 'log' }}",
  '        height={120}',
  '      />',
  '      {p.toast ? <Toast message="Run finished" kind={p.toast} onClose={p.onToastClose} durationMs={0} /> : null}',
  '    </PanelChrome>',
  '  );',
  '}',
].join('\n');

/** The compile sample: every runtime export imported and used, then KIT_RENDER_SAMPLE. */
export function kitSample(names) {
  return [
    `import { ${names.join(', ')} } from '@magnusim/plugin-ui';`,
    '',
    `export const all = [${names.join(', ')}];`,
    '',
    KIT_RENDER_SAMPLE,
    '',
  ].join('\n');
}
