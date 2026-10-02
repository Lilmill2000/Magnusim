// H14: one rainbow hue. Every rainbow lookup table in the app (the renders in
// runtime.js and createRainbowLut on the plugin API) reads RAINBOW_HUE from the
// kit's colour maps, so no copy of the hue is left to drift (it was 0.666 in
// lut.ts and 0.667 in the renders).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(WEB, 'src');
const COLORMAPS = 'src/plugin-ui/colormaps/';

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|mjs|cjs|ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const rel = (p) => relative(WEB, p).split(sep).join('/');
const outside = () => walk(SRC).filter((p) => !rel(p).startsWith(COLORMAPS));

describe('one rainbow hue', () => {
  it('RAINBOW_HUE is 0.667 in the colour maps', () => {
    const text = readFileSync(join(WEB, 'src', 'plugin-ui', 'colormaps', 'index.ts'), 'utf8');
    assert.match(text, /^export const RAINBOW_HUE = 0\.667;$/m);
  });

  it('no setHueRange(0.66 literal is left in src outside the colour maps', () => {
    const found = [];
    for (const file of outside()) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/setHueRange\(\s*0\.66/g)) found.push(`${rel(file)}: ${m[0]}`);
    }
    assert.deepEqual(found, []);
  });

  it('every setHueRange in src outside the colour maps starts at RAINBOW_HUE, imported from them', () => {
    const calls = [];
    const wrong = [];
    for (const file of outside()) {
      const text = readFileSync(file, 'utf8');
      const hits = [...text.matchAll(/setHueRange\(\s*([^,)]*)/g)];
      if (!hits.length) continue;
      for (const m of hits) {
        calls.push(rel(file));
        if (m[1].trim() !== 'RAINBOW_HUE') wrong.push(`${rel(file)}: ${m[0]}`);
      }
      if (!/import \{[^}]*\bRAINBOW_HUE\b[^}]*\} from '\.\.\/plugin-ui\/colormaps'/.test(text)) wrong.push(`${rel(file)} does not import RAINBOW_HUE`);
    }
    assert.deepEqual(wrong, []);
    // The four render tables in runtime.js and createRainbowLut.
    assert.deepEqual(
      calls.sort(),
      ['src/viewer/lut.ts', 'src/workbench/runtime.js', 'src/workbench/runtime.js', 'src/workbench/runtime.js', 'src/workbench/runtime.js'],
    );
  });
});
