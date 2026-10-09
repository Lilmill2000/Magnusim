// The CAD e2e suite in area shards, and which shards a changed file needs.
// scripts/e2e.mjs runs them (npm run test:e2e:<shard>, test:e2e:changed);
// tests/e2e/shards.test.ts fails when a spec is in no shard or in two, and checks the map.
//
// Paths here are relative to the plugin folder (bundled-plugins/cad), with '/'.
// A file outside the plugin is given relative to the plugin too ("../../src/app/x.js"):
// the host files the suite depends on (package.json magnusim.e2eHostPaths) run every shard.
// SPDX-License-Identifier: GPL-3.0-or-later

/** Every spec of e2e/ in exactly one shard. */
export const SHARDS = {
  // The Part in the host: the workspace and its tree, the document (save, reload, two tabs,
  // P1's gate), panels, the toolbar, the viewport, leaving the Part, the UI kit.
  shell: [
    'e2e/cad-p1-scaffold.spec.ts',
    'e2e/cad-p1-document.spec.js',
    'e2e/cad-p1-doc-storage.spec.ts',
    'e2e/cad-p1-kernel-ops.spec.ts',
    'e2e/cad-p1-leave-f5.spec.js',
    'e2e/cad-p1-ui-shell.spec.ts',
    'e2e/cad-p1-viewport-basics.spec.ts',
    'e2e/cad-p1-viewport-perf.spec.ts',
    'e2e/cad-p1-review-polish.spec.ts',
    'e2e/cad-p1-review2.spec.ts',
    'e2e/cad-p1-review3.spec.ts',
    'e2e/cad-p15-review1.spec.ts',
    'e2e/cad-panel-done-reach.spec.ts',
    'e2e/cad-sd-kit.spec.ts',
    'e2e/cad-sd-review2-leave.spec.ts',
    'e2e/cad-p4a-toolbar.spec.ts',
    // P4b fix round 1 (TOOLBAR): the compact model default, the sketch ribbon order, rearranging and Reset.
    'e2e/cad-p4b-toolbar.spec.ts',
  ],
  // The sketcher (tools, relations, dimensions, value boxes), profiles, and Extrude of them
  // (P3's gate and the P2+P3 review rounds).
  sketch: [
    'e2e/cad-p3-sketch.spec.js',
    'e2e/cad-p3-sketch-mode.spec.ts',
    'e2e/cad-p3-profiles-extrude.spec.ts',
    'e2e/cad-p3-profiles-sketchmode.spec.ts',
    'e2e/cad-p2p3-integrate.spec.ts',
    'e2e/cad-p2p3-review1.spec.ts',
    'e2e/cad-p2p3-review1-polish.spec.ts',
    'e2e/cad-p2p3-review2.spec.ts',
    'e2e/cad-p2p3-review3.spec.ts',
    'e2e/cad-p2p3-review4.spec.ts',
    // P4b SELECT: Construction from the menu, box selection (sketch and model mode), Project / Intersect.
    'e2e/cad-p4b-select.spec.ts',
    // P4b SKETCH: splines, mirror, linear and circular patterns, offset, fillet and chamfer.
    'e2e/cad-p4b-sketch-tools.spec.ts',
    'e2e/cad-p4b-project.spec.ts',
    // Press-pull fix round 1: the angle labels' gap and the label double-click in Mirror (ci2 polish).
    'e2e/cad-p5-fix1-sketch-labels.spec.ts',
    // ux010 PANELS: the tree and the Sketch panel collapse sideways into rails; the compact Sketch panel.
    'e2e/cad-ux010-panels.spec.ts',
    // ux010 TOOLBAR: drag a command from its group's More onto the bar (and back), sketch and model mode.
    'e2e/cad-ux010-toolbar.spec.ts',
    // ux010 DRAW: construction drawing (Construction / X toggle), a press is never lost (click-drag draws), a new fillet's radius arrow.
    'e2e/cad-ux010-draw.spec.ts',
  ],
  // P4a: Revolve, Sweep, Loft, Fillet, Chamfer, Shell, the Extrude extents, CONSTRUCT,
  // edge and vertex names.
  solids: [
    'e2e/cad-p4a-solids.spec.ts',
    'e2e/cad-p4a-construct.spec.ts',
    'e2e/cad-p4a-fix1.spec.ts',
    'e2e/cad-p4a-integrate.spec.ts',
    // P4b PATTERN: Linear pattern, Circular pattern, Mirror (features, bodies, faces), Measure picks.
    'e2e/cad-p4b-pattern.spec.ts',
    // P4b fix round 1 (PATTERN): one test per review finding.
    'e2e/cad-p4b-fix1-pattern.spec.ts',
  ],
  // STEP in and out and the body tools: import and edit (press-pull, delete faces, split),
  // Combine, Measure, Mass, Check, Export, the Enclosure (P2's gate, the SD pass).
  step: [
    'e2e/cad-p2-step.spec.js',
    'e2e/cad-p2-features-step.spec.ts',
    'e2e/cad-p2-kernel-ops.spec.ts',
    'e2e/cad-sd-enclosure.spec.ts',
    'e2e/cad-sd-review1.spec.ts',
    'e2e/cad-sd-review2.spec.ts',
    // P4b SELECT: a sketch on an imported face with projected edges through Delete faces (the exit gate).
    'e2e/cad-p4b-project-step.spec.ts',
    // Press-pull on curved faces (kernel API 6): bores, fillets, slopes, the flange STEP and the Vortex.
    'e2e/cad-p5-pressPull-curved.spec.ts',
  ],
  // The Part as a project geometry (gate:l2-cad and gate:l3-cad's specs) and CAD's start actions.
  link: [
    'e2e/cad-link.spec.ts',
    'e2e/cad-link-plugins.spec.ts',
    'e2e/cad-link-exit.spec.ts',
    'e2e/cad-link-carry.spec.ts',
    'e2e/cad-link-ux.spec.ts',
    'e2e/cad-start.spec.ts',
  ],
  // Opt-in: Daniel's 113 MB STEP (CAD_E2E_BIG_STEP); its tests skip without it.
  big: ['e2e/cad-large-step.spec.js', 'e2e/cad-p4b-select-big.spec.ts'],
};

export const SHARD_NAMES = Object.keys(SHARDS);

/** Tags (Playwright `{ tag }`): the smoke set, and the tests that change what the whole app sees. */
export const SMOKE_TAG = '@smoke';
export const SERIAL_TAG = '@serial';

/** Every shard but the opt-in one, for a file the whole suite depends on. */
const ALL = 'all';

/**
 * File -> shards, first match wins. A pattern ending in '/' is a folder; else the exact file
 * or a RegExp. 'all' runs every shard, 'none' runs nothing (no e2e test reads the file).
 * A feature folder maps to the shards whose specs use it; its index.ts (the command's label,
 * group, keys and icon) to the shell shard too, whose toolbar spec reaches every command.
 */
export const RULES = [
  // Not read by any e2e test.
  [/^tests\//, 'none', 'unit tests'],
  [/^docs\//, 'none', 'docs'],
  [/^LICENSES\//, 'none', 'licences'],
  [/^[^/]+\.md$/, 'none', 'docs'],
  [/(^|\/)\.gitignore$/, 'none', 'git'],
  ['vitest.config.ts', 'none', 'unit tests'],
  ['test-results/', 'none', 'test output'],
  ['.cache/', 'none', 'local cache'],
  // The suite's own machinery.
  ['e2e/', ALL, 'e2e support (helpers, setup, config)'],
  ['scripts/gate-l2-cad.mjs', ['link'], 'gate:l2-cad'],
  ['scripts/gate-l2-cad.d.mts', ['link'], 'gate:l2-cad'],
  ['scripts/gate-l3-cad.mjs', ['link'], 'gate:l3-cad'],
  ['scripts/gate-l3-cad.d.mts', ['link'], 'gate:l3-cad'],
  // The app's Python: the link checker, and the P2 gate's native OCP check.
  ['scripts/app-python.mjs', ['link', 'step'], "the app's Python"],
  ['scripts/app-python.d.mts', ['link', 'step'], "the app's Python"],
  ['scripts/', ALL, 'build and e2e scripts'],
  // Areas.
  ['src/link/', ['link'], 'LINK'],
  ['src/doc/source-record.ts', ['link'], "the study record's source_version"],
  ['src/sketch/', ['sketch'], 'the sketcher'],
  ['src/solver-worker/', ['sketch'], 'the sketch solver'],
  ['solver-build/', ['sketch'], 'the sketch solver'],
  // Every spec makes its solids from sketches and Extrudes (helpers addSketch, addSolid, drawBlock).
  ['src/features/sketch/', ALL, 'Sketch, the feature every solid starts from'],
  ['src/features/extrude/', ALL, 'Extrude, which every spec uses'],
  // Shared by the feature panels (picks, fields, dialogs, refs, repair).
  ['src/features/p2/', ALL, "the features' shared panel code"],
  // The Enclosure is used in every area's specs (link-ux, panel-done-reach, P4a fix 1, ...).
  ['src/features/enclosure/', ALL, 'the Enclosure'],
  [/^src\/features\/(revolve|sweep|loft|fillet|chamfer|shell|refgeom|pickinfo|solids)\/index\.tsx?$/, ['solids', 'shell'], 'P4a, its command'],
  [/^src\/features\/(revolve|sweep|loft|fillet|chamfer|shell|refgeom|pickinfo|solids)\//, ['solids'], 'P4a solids and CONSTRUCT'],
  // P4b PATTERN: the PATTERN group (its command on the toolbar: shell too).
  [/^src\/features\/pattern\/index\.tsx?$/, ['solids', 'shell'], 'PATTERN, its commands'],
  ['src/features/pattern/', ['solids'], 'Linear pattern, Circular pattern, Mirror'],
  [/^src\/features\/import\/index\.tsx?$/, ['step', 'sketch', 'link', 'big', 'shell'], 'Import STEP, its command'],
  ['src/features/import/', ['step', 'sketch', 'link', 'big'], 'Import STEP'],
  [/^src\/features\/(combine|split)\/index\.tsx?$/, ['step', 'sketch', 'link', 'shell'], 'body tools, their command'],
  [/^src\/features\/(combine|split)\//, ['step', 'sketch', 'link'], 'Combine and Split'],
  [/^src\/features\/(export|measure|press_pull)\/index\.tsx?$/, ['step', 'sketch', 'shell'], 'body tools, their command'],
  [/^src\/features\/(export|measure|press_pull)\//, ['step', 'sketch'], 'Export, Measure and Press-pull'],
  [/^src\/features\/(mass|check|delete_faces)\/index\.tsx?$/, ['step', 'shell'], 'body tools, their command'],
  [/^src\/features\/(mass|check|delete_faces)\//, ['step'], 'Mass, Check and Delete faces'],
  ['src/files/', ['step'], 'file transfer (STEP in and out)'],
  // P4b SELECT: the dock's selection count (the box selection's specs read it).
  [/^src\/features\/selectcount\/index\.tsx?$/, ['sketch', 'shell'], 'the selection count chip, its module'],
  ['src/features/selectcount/', ['sketch'], 'the selection count chip'],
  // Shared code: every shard.
  ['src/', ALL, 'shared code'],
  ['kernel-build/', ALL, 'the kernel'],
  ['workspace/', ALL, 'the build output'],
  ['fixtures/', ALL, 'kernel fixtures'],
];

/** Glob-free match of one rule's pattern. */
function matches(pattern, rel) {
  if (pattern instanceof RegExp) return pattern.test(rel);
  return pattern.endsWith('/') ? rel.startsWith(pattern) : rel === pattern;
}

/** The shard that holds a spec (plugin-relative path), or null. */
export function shardOfSpec(rel) {
  for (const [name, specs] of Object.entries(SHARDS)) if (specs.includes(rel)) return name;
  return null;
}

/**
 * The shards a changed file needs: {shards: string[], why: string}. `rel` is relative to the
 * plugin folder ('src/sketch/mode.ts', or '../../src/app/x.js' for a host file).
 * `hostPaths` is package.json magnusim.e2eHostPaths (paths from magnusim-web).
 */
export function shardsForFile(rel, hostPaths = []) {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  const all = SHARD_NAMES.filter((s) => s !== 'big');
  if (p.startsWith('../')) {
    // Outside the plugin: magnusim-web/<x> is "../../<x>".
    const web = p.startsWith('../../') && !p.startsWith('../../../') ? p.slice('../../'.length) : null;
    if (web && !web.startsWith('bundled-plugins/') && hostPaths.some((h) => (h.endsWith('/') ? web.startsWith(h) : web === h))) return { shards: all, why: `host file (e2eHostPaths): ${web}` };
    return { shards: [], why: 'outside the plugin, not a host file it depends on' };
  }
  if (/^e2e\/.*\.spec\.[jt]s$/.test(p)) {
    const s = shardOfSpec(p);
    // A spec in no shard (tests/e2e/shards.test.ts fails on it): run everything.
    return s ? { shards: [s], why: 'its spec' } : { shards: all, why: 'a spec in no shard' };
  }
  for (const [pattern, to, why] of RULES) {
    if (!matches(pattern, p)) continue;
    if (to === 'none') return { shards: [], why };
    return { shards: to === ALL ? all : [...to], why };
  }
  // Anything else in the plugin (manifest.toml, plugin.py, package.json, configs): every shard.
  return { shards: all, why: 'plugin file' };
}

/** The shards a set of changed files needs, in SHARDS order, with the files behind each. */
export function shardsForFiles(rels, hostPaths = []) {
  const why = Object.fromEntries(SHARD_NAMES.map((s) => [s, []]));
  const none = [];
  for (const rel of rels) {
    const r = shardsForFile(rel, hostPaths);
    if (!r.shards.length) none.push({ file: rel, why: r.why });
    for (const s of r.shards) why[s].push(rel);
  }
  const shards = SHARD_NAMES.filter((s) => why[s].length);
  return { shards, why: Object.fromEntries(shards.map((s) => [s, why[s]])), none };
}

/** The specs of some shards, in SHARDS order. */
export function specsOf(shards) {
  return SHARD_NAMES.filter((s) => shards.includes(s)).flatMap((s) => SHARDS[s]);
}
