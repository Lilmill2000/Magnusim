// H14: the colour map tables keep their notices where they ship. The kit's
// plugin-ui.js (served to every workspace frame) carries viridis's CC0 notice
// and cmocean's MIT notice in full, kept by legalComments 'eof' even when
// minified, and the licence texts sit next to the data.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPluginSdk } from '../server/plugin-sdk.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LICENSES = join(WEB, 'src', 'plugin-ui', 'colormaps', 'LICENSES');

const CC0 = ['mpl-colormaps', 'Nathaniel Smith', 'Stefan van der Walt', 'CC0 1.0', 'have waived all copyright'];
const MIT = [
  'The MIT License (MIT)',
  'Copyright (c) 2015 Kristen M. Thyng',
  'Permission is hereby granted, free of charge',
  'The above copyright notice and this permission notice shall be included in all',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
];

/** The text with comment margins (` * `) and line breaks folded, so a phrase can span lines. */
const flat = (text) => text.replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ');

describe('colour map notices', () => {
  it('prod plugin-ui.js from buildPluginSdk keeps the viridis CC0 and the cmocean MIT notices', async () => {
    const files = await buildPluginSdk(WEB, 'prod');
    const js = files.get('plugin-ui.js');
    assert.ok(js && js.length > 1000, 'plugin-ui.js is built');
    const text = flat(js);
    for (const phrase of [...CC0, ...MIT]) assert.ok(text.includes(phrase), `plugin-ui.js keeps "${phrase}"`);
    // The tables themselves ship in the same file.
    assert.match(js, /440154/);
  });

  it('the licence texts sit next to the data', () => {
    const cc0 = flat(readFileSync(join(LICENSES, 'viridis-CC0.txt'), 'utf8'));
    const mit = flat(readFileSync(join(LICENSES, 'cmocean-MIT.txt'), 'utf8'));
    for (const phrase of CC0.filter((p) => p !== 'CC0 1.0')) assert.ok(cc0.includes(phrase), `viridis-CC0.txt has "${phrase}"`);
    assert.ok(cc0.includes('creativecommons.org/publicdomain/zero/1.0'));
    for (const phrase of MIT) assert.ok(mit.includes(phrase), `cmocean-MIT.txt has "${phrase}"`);
  });
});
