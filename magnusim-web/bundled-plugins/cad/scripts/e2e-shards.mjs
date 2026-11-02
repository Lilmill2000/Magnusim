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
    // Kernel API 8 in the Part's worker (Analysis Situs): ready {api: 8, asi}, recognize on part A built in the page.
    'e2e/cad-kernel-api8.spec.ts',
    'e2e/cad-p1-leave-f5.spec.js',
    'e2e/cad-p1-ui-shell.spec.ts',
    'e2e/cad-p1-viewport-basics.spec.ts',
    'e2e/cad-p1-viewport-perf.spec.ts',
    'e2e/cad-p1-review-polish.spec.ts',
    'e2e/cad-p1-review2.spec.ts',
    'e2e/cad-p1-review3.spec.ts',
    'e2e/cad-p15-review1.spec.ts',
    'e2e/cad-panel-done-reach.spec.ts',
    // A panel the Assistant fills: read-only, badged, no viewport tools, taken over by the person.
    'e2e/cad-assistant-panels.spec.ts',
    'e2e/cad-sd-kit.spec.ts',
    'e2e/cad-sd-review2-leave.spec.ts',
    'e2e/cad-p4a-toolbar.spec.ts',
    // P4b fix round 1 (TOOLBAR): the compact model default, the sketch ribbon order, rearranging and Reset.
    'e2e/cad-p4b-toolbar.spec.ts',
    // v0.5.0: the compact sketch toolbar (every drawing group on the bar at 1920 px; what folds at 1600 and below).
    'e2e/cad-sketch-toolbar-fit.spec.ts',
    // v0.5.0 ribbon: groups resized by their line, rows by the bottom edge, sizes from one scale factor.
    'e2e/cad-toolbar-resize.spec.ts',
    // ux010 TOOLBAR builder: Banana for scale (SCALE MODELS after VIEW; never a body; dragged; not linked).
    'e2e/cad-ux010-banana.spec.ts',
    // Pictures drawn off screen (handle.snapshot) and the count of the person's camera moves.
    'e2e/cad-viewport-snapshot.spec.ts',
    // Keybinds: the Set keybind dialog (Replace, Reset), the keys live in a sketch, a change made in Settings applied at once.
    'e2e/cad-keybinds.spec.ts',
    // The dark set: the host's dark appearance (dark view, light marks that keep their light ink over a face, surfaces kept), pictures stay light.
    'e2e/cad-dark-theme.spec.ts',
    // Section view (INSPECT): any plane (a construction plane at an angle), the arrow dragged, a typed offset, flip, off, kept with the Part.
    'e2e/cad-section-view.spec.ts',
    // See-through bodies (INSPECT): the command on the selection, the tree's mark and menu, a click through, the cut, kept with the Part.
    'e2e/cad-see-through.spec.ts',
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
    // The Ellipse group: Ellipse, Partial ellipse, Parabola and Conic drawn, closed and extruded.
    'e2e/cad-ellipse-tools.spec.ts',
    'e2e/cad-p4b-project.spec.ts',
    // Press-pull fix round 1: the angle labels' gap and the label double-click in Mirror (ci2 polish).
    'e2e/cad-p5-fix1-sketch-labels.spec.ts',
    // ux010 PANELS: the tree and the Sketch panel collapse sideways into rails; the compact Sketch panel.
    'e2e/cad-ux010-panels.spec.ts',
    // ux010 TOOLBAR: drag a command from its group's More onto the bar (and back), sketch and model mode.
    'e2e/cad-ux010-toolbar.spec.ts',
    // ux010 TOOLBAR builder: the taped banana picture in a sketch (true size, behind the sketch, dragged, never sketch geometry).
    'e2e/cad-ux010-sketch-banana.spec.ts',
    // ux010 DRAW: construction drawing (Construction / X toggle), a press is never lost (click-drag draws), a new fillet's radius arrow.
    'e2e/cad-ux010-draw.spec.ts',
    // ux010 DRAW: the sketch's own cursors (SVG, keyword fallback) and round points.
    'e2e/cad-ux010-cursors.spec.ts',
    // ux010 DRAW: relation glyphs for the selection only, Show relations (Shift+R), a conflict always shows.
    'e2e/cad-ux010-relations.spec.ts',
    // A sketch the Assistant draws: the person's tools refused with the reason, Escape, Ctrl+Z and Enter take it over.
    'e2e/cad-assistant-sketch.spec.ts',
    // v0.5.0: the DRAW flyouts and the shape tools (slots, polygon, sector, the rectangle, circle, arc and line variants).
    'e2e/cad-sketch-shapes.spec.ts',
    // Daniel's first desktop test: the relations palette by the selection, the construction badge's ×.
    'e2e/cad-sketch-relations-palette.spec.ts',
    // Import SVG/DXF: what the panel says a drawing read, the preview, OK as one undo step, layers, scale, a hostile SVG.
    'e2e/cad-sketch-import.spec.ts',
    // Copy and Paste: Ctrl+C / Ctrl+V and the right-click menu, the copy following the pointer, its dimension, undo, Escape, a value field's own copy.
    'e2e/cad-sketch-copy-paste.spec.ts',
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
    // Parity both ways: the person's Hole, body colour, history order, Back isometric, Find, Picture, Measure's extras.
    'e2e/cad-person-parity.spec.ts',
    // Volumes of B-spline bodies (kernel API 7): a loft's chip, Press-pull of its cap, a Cut by a block that only touches it.
    'e2e/cad-volume-accuracy.spec.ts',
    // INSPECT > Find of fillets and holes by size (kernel API 8) on an imported STEP part: rows, Select all, Delete, refusals.
    'e2e/cad-find-fillets-holes.spec.ts',
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
    // A body's menu in the tree: Delete (a Delete body feature, Undo, Redo, several bodies, the Delete key), and its simulation item in Magnusim.
    'e2e/cad-body-menu.spec.ts',
    // Move/copy body: MODIFY's command and the body's menu, a move, Keep a copy and a turn, Undo, Edit, the key M.
    'e2e/cad-move-body.spec.ts',
    // Combine: a Join of pieces that do not touch is a quiet note in History; a Cut that splits a body warns.
    'e2e/cad-join-note.spec.ts',
    // Check for an assembly (the person's side of the Assistant's check): Loose parts, Interference, Rotation.
    'e2e/cad-assembly-check.spec.ts',
    // Delete faces whose heal would fill past the gap (every blend of a rounded L-block): red, words, the body unchanged.
    'e2e/cad-delete-faces-heal.spec.ts',
    // Delete faces' Add by size (Fillets up to, Holes up to; kernel API 8) and a Ctrl+drag box while its panel is open.
    'e2e/cad-delete-faces-by-size.spec.ts',
  ],
  // The Part as a project geometry (gate:l2-cad and gate:l3-cad's specs) and CAD's start actions.
  link: [
    'e2e/cad-link.spec.ts',
    'e2e/cad-link-plugins.spec.ts',
    'e2e/cad-link-exit.spec.ts',
    'e2e/cad-link-carry.spec.ts',
    'e2e/cad-link-ux.spec.ts',
    'e2e/cad-start.spec.ts',
    // Edit in CAD (host API 1.7): a project geometry opened in a Part, adopted on the first Back with a change (gate:l3-cad).
    'e2e/cad-edit-in-cad.spec.ts',
    // Magnusim keeps every project and simulation item (CFD PREP, the simulation words, the Assistant's send and enclosure).
    'e2e/cad-magnusim-project-items.spec.ts',
  ],
  // The Part's tools for the app's Assistant, each spec on its own host with the Assistant's test
  // switches and the scripted model (e2e/assistant-helpers.ts): the tools offered, watch mode,
  // honest errors, the person first, take-overs, the eval set.
  assistant: ['e2e/cad-assistant-watch.spec.ts', 'e2e/cad-assistant-honest.spec.ts', 'e2e/cad-assistant-coexist.spec.ts', 'e2e/cad-assistant-takeover.spec.ts', 'e2e/cad-assistant-eval.spec.ts', 'e2e/cad-assistant-sketch-tools.spec.ts', 'e2e/cad-assistant-features.spec.ts', 'e2e/cad-assistant-workspace.spec.ts', 'e2e/cad-assistant-dock.spec.ts', 'e2e/cad-assistant-roundtrip.spec.ts', 'e2e/cad-assistant-fillet-selectors.spec.ts'],
  // Opt-in: Daniel's 113 MB STEP (CAD_E2E_BIG_STEP); its tests skip without it.
  // Edit in CAD on the 113 MB STEP (CAD_KERNEL_BIG_STEP or CAD_E2E_BIG_STEP): its timings.
  big: ['e2e/cad-large-step.spec.js', 'e2e/cad-p4b-select-big.spec.ts', 'e2e/cad-edit-in-cad-big.spec.ts'],
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
  ['e2e/assistant-helpers.ts', ['assistant'], "the Assistant specs' host and turns"],
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
  // The Assistant's sketch tool draws through sketch mode and checks with the solver.
  ['src/sketch/', ['sketch', 'assistant'], 'the sketcher'],
  ['src/solver-worker/', ['sketch', 'assistant'], 'the sketch solver'],
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
  // The person's side of the Assistant's hole, find and view tools (their commands on the toolbar: shell too).
  [/^src\/features\/(hole|find|picture)\/index\.tsx?$/, ['solids', 'shell'], "the person's Hole, Find and Picture, their commands"],
  [/^src\/features\/(hole|find|picture)\//, ['solids'], "the person's Hole, Find and Picture"],
  [/^src\/features\/import\/index\.tsx?$/, ['step', 'sketch', 'link', 'big', 'shell'], 'Import STEP, its command'],
  ['src/features/import/', ['step', 'sketch', 'link', 'big'], 'Import STEP'],
  [/^src\/features\/(combine|split)\/index\.tsx?$/, ['step', 'sketch', 'link', 'shell'], 'body tools, their command'],
  [/^src\/features\/(combine|split)\//, ['step', 'sketch', 'link'], 'Combine and Split'],
  [/^src\/features\/(export|measure|press_pull)\/index\.tsx?$/, ['step', 'sketch', 'shell'], 'body tools, their command'],
  [/^src\/features\/(export|measure|press_pull)\//, ['step', 'sketch'], 'Export, Measure and Press-pull'],
  [/^src\/features\/(mass|check|delete_faces)\/index\.tsx?$/, ['step', 'shell'], 'body tools, their command'],
  [/^src\/features\/(mass|check|delete_faces)\//, ['step'], 'Mass, Check and Delete faces'],
  ['src/features/delete_body/', ['step'], 'Delete body (the body menu in the tree)'],
  [/^src\/features\/move_body\/index\.tsx?$/, ['step', 'shell'], 'Move/copy body, its command'],
  ['src/features/move_body/', ['step'], 'Move/copy body'],
  // Section view (INSPECT): the person's panel and arrow (shell), the Assistant's workspace section (assistant).
  ['src/features/section/', ['shell', 'assistant'], 'Section view'],
  // See-through bodies (INSPECT): the person's command and menu (shell), the Assistant's workspace see_through (assistant).
  ['src/features/see_through/', ['shell', 'assistant'], 'See-through bodies'],
  // The assembly checks: the person's Check (step) and the Assistant's check tool.
  ['src/features/assembly/', ['step', 'assistant'], 'the assembly checks'],
  ['src/files/', ['step'], 'file transfer (STEP in and out)'],
  // P4b SELECT: the dock's selection count (the box selection's specs read it).
  [/^src\/features\/selectcount\/index\.tsx?$/, ['sketch', 'shell'], 'the selection count chip, its module'],
  ['src/features/selectcount/', ['sketch'], 'the selection count chip'],
  // What of the Assistant runs in every person's Part: install.ts's camera gate (autoCamera)
  // decides the person's own sketch entry, its reframe and Extrude's turn to Isometric, which every
  // shard's views and clicks rely on (as on Sketch and Extrude themselves); the chip is in every
  // dock. The camera latch (camera.ts) is asked only for the Assistant's own sessions.
  ['src/assistant/install.ts', ALL, "the Assistant's install: the camera gate of every sketch and Extrude"],
  ['src/assistant/AssistantChip.tsx', ['assistant', 'shell'], 'the chip in the dock'],
  // The selectors and find's rows run the person's Find too (INSPECT > Find, cad-person-parity).
  ['src/assistant/selectors/', ['assistant', 'solids'], "the selectors, which the person's Find runs"],
  ['src/assistant/tools/find.ts', ['assistant', 'solids'], "find's rows, which the person's Find lists"],
  // The Assistant's tools (src/assistant), their module (its chip: the dock), the eval harness.
  ['src/assistant/', ['assistant'], 'the Assistant tools'],
  [/^src\/features\/assistant\//, ['assistant', 'shell'], 'its module'],
  ['eval/', ['assistant'], 'the eval harness'],
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
