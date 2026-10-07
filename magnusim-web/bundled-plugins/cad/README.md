# Magnusim CAD

A parametric part modeler (SolidWorks and Fusion style) that runs as
Magnusim's **Part** workspace. It is an optional bundled plugin that ships
on (Daniel's D33); Settings > Plugins turns it off (Disable), and then nothing
of it runs. A new Part starts from **Design a part** on an empty project or in
the New Project dialog's "Start from", from **New design** on Home (New Project
with "Untitled Part N", one Create), or from the header's **CAD** button (its
menu lists the project's Parts and makes a new one); once a project has a Part,
its STUDIES section lists it and offers **+ New Part**. A Part opens in its own
full-page workspace over the workbench. Today (phases P1-P4b and the SD pass) a
Part is made of sketches (lines, rectangles, circles, arcs, fit-point and
control-point splines; dimensions and constraints solved as you draw) turned
into solids, and of imported STEP files (healed, with their names and colours)
edited directly. Sketch tools beyond drawing: Mirror (copies held symmetric
about a line), Linear and Circular pattern (copies tied to their source,
re-laid out when the count or spacing changes, editable from the Sketch panel),
Offset (a chain of lines, arcs and splines at a distance, one side or both),
Fillet and Chamfer of a corner, Trim and Extend (splines included), and
Construction from the right-click menu (a checkmark state; "Make construction"
/ "Make normal" on a mixed selection), the toolbar or X. **Project** (P) brings
a body's vertices, edges or a face's outer edges into the sketch, or with
Silhouette a body's outline along the sketch normal; **Intersect** adds the
curves where the sketch plane cuts the bodies. Both are linked: drawn purple,
fixed, re-computed at every rebuild, usable by dimensions, relations, Trim and
regions, and turned into ordinary geometry with Break link. A source that
disappears upstream is reported, not blocking: the curves turn amber, "Lost
reference: ..." names what was lost, and the sketch still solves. While
drawing, the pointer also snaps to the model itself (a vertex, an edge's
middle, a point on an edge, a round edge's centre, where an edge pierces the
sketch plane; Ctrl suppresses snapping), and a click there adds the linked
reference and the relation in one undo step; Ctrl+click on a body vertex or
edge adds it to a sketch selection for Coincident, On curve, Midpoint or a
Dimension. Solids: Extrude (blind,
two sides, symmetric, through all, up to a face or a vertex, along a chosen
direction, or a flat face of a body extruded with no sketch), Revolve, Sweep
along a sketched path, and Loft through two or more profiles, each as a new
body or joined, cut or intersected. Edits: Fillet (tangent chains; a radius
that is too large names the edges and the radius that works), Chamfer (one or
two distances), Shell (inside or outside), press-pull, delete faces, split and
Combine (join, cut, intersect). Press-pull moves flat and curved faces (several
at once, of mixed kinds) along their outward normal as a true offset: a sloping
neighbour is extended to meet the moved face (no step), a hole's bore or a boss
changes its radius (out adds material: 2 mm on a 10 mm bore makes it 8 mm, and
the panel says "Bore radius 10 mm → 8 mm"), a fillet changes its radius and stays
tangent, and a pull that would close a hole or cut the part through itself is
red in words with what works ("the hole would close: 9.9 mm or less works").
Fillets and chamfers beside a moved face keep their size (a box top with rounded
edges rises; its walls stay). Where OCCT's offset cannot do it, a cylinder is
opened or closed by a ring of material (the Vortex's outlet pipes), or flat and
curved faces are moved as prisms or thickened faces where every neighbour is
square to them; every result is checked (no face lost, no split from adding
material, a plausible volume change) before it is taken, and a refusal says why
in plain words with a distance that does work. A Press-pull saved before this
keeps its old flat-face prism, so the part rebuilds exactly as it was made. Reference geometry (the toolbar's CONSTRUCT
group): planes (offset, at an angle, through 3 points, midplane, normal to a
curve), axes (through 2 points, of a round face, along an edge, where 2 planes
cross; the origin's X, Y and Z axes are rows under Origin too) and points (at a vertex, a centre, on an edge, where an edge crosses a
plane, coordinates), each a history feature that follows the model and that a
sketch can lie on and a revolve or an extrude can use; a broken one that
nothing uses does not stop the project's update (the header says so as it
lands). The PATTERN group (beside SOLID) has **Linear pattern** (one or two
directions; count with spacing or extent; symmetric), **Circular pattern** (an
origin or CONSTRUCT axis, a straight edge or a round face; full 360° or a set
angle; symmetric) and **Mirror** (an origin or CONSTRUCT plane or a flat face).
Each repeats features (their tool bodies applied with each feature's own
operation, or New body / Join / Cut / Intersect), bodies (copies) or faces of
one body (the boss or pocket they bound, copied); a copy is skipped by a click
on its number in the view, and a pattern of a mirror or a mirror of a pattern
works. Copies are named after the pattern and their instance, so a fillet on
copy 3 survives a count change; a failure is a red feature that says why
("Instances 2 and 3 of Body 1 don't touch Body 1; Join needs overlap. Use New
body or change the spacing") while the model before it still shows. Measure,
mass properties, check, export to STEP; the volume chip shows each body's
volume on its own, never a total. **Normal to** (N, the views menu, and the
right-click menu of a face, a plane, a sketch's row or its curves in the view)
turns the view square to a flat face, an origin or CONSTRUCT plane, or a sketch
(with the sketch's own up); in sketch mode it looks at the open sketch. A curved
face is refused in words. Solids come
only from sketches and STEP: there is no one-click Box or Cylinder (decision
2026-10-01; a Part saved with one opens with that row red, "This part uses a
removed feature (Box 1)", and Delete takes it away). For CFD, **Enclosure** (the
toolbar's CFD PREP group) makes a box or cylinder body around the part's exact
bounding box, with zero, percent or fixed padding and its own value per side
(typed, or dragged by the arrows in the view; Escape during a drag puts it back).
A side may go into the part (one amber note names those sides: the fluid will
leave the cut-off part out) but never past its far side (refused under the
field, and the arrow stops there; also when the part later shrinks under it). It follows the part when the part changes,
it is drawn see-through (a click picks the part inside it), its faces are named
by side ("+X face of Enclosure 1", "Top face"; a cylinder about X has a "+X end"),
and Combine Cut with it as the target (Keep the tool bodies comes on) then gives
the fluid domain. Named parameters drive
any number. Guide rails for Loft and the rest are V1. The model toolbar starts compact (each group's
main command, the rest in its "More" menu) and the sketch ribbon with every
command, labels on one line; right-click a command for Show in toolbar / Move to
More / Move left / Move right / Reset toolbar, or drag it along its group. The
layout is the user's, the same in every project, and another open CAD tab follows a
change at once (the host's plugin prefs, `ws.prefs`; on a host without them it is kept
per project: ARCHITECTURE.md §7 "Toolbar"). Every sketch dimension shows its unit next
to its value ("⌀125 mm", "R10 mm", "(40 mm)" driven, "fx: 40 mm", "30°"), and so do
the value boxes while drawing and the edit box; typing "125 mm", "5 in" or a bare
number (the document's unit) works as before. What a sketch cannot drag (a fully
defined entity, the origin) keeps the normal arrow cursor; a drag of it says why in
the sketch panel ("This line is fully defined: change a dimension to move it").
The description in `manifest.toml` (shown in
Settings > Plugins) names only what ships: update it as features land.

It needs Magnusim's host API 1.6: a Part's design becomes a geometry of its
project (`ws.project.linkGeometry`, the Part study kind's `links_geometry`, 1.5),
and its panels are drawn with the host's UI kit (`@magnusim/plugin-ui`, 1.3).
Each body has an "Include in simulation" toggle (its Bodies row and its menu),
on for every solid body; a body left out is not part of the project's geometry.
The sync runs when the user leaves the Part (the host's exit hook, `ws.nav.onLeave`,
1.6): every way out (Back, the browser's Back, another project, Home, Open in 3D)
saves the Part, brings its geometry up to date and lands in the simulation
viewport with the Part's camera; ARCHITECTURE.md §11 has the export, the face
names and the exit hook. From 1.2
it uses `ws.files` to save a Part's model (etag-checked writes, so two tabs
never overwrite each other) and asks before leaving the workspace while a
change is not saved yet. (The document still falls back to `ws.data` on a 1.1
host; the unit tests' fake host uses that path.)

Everything runs in the browser, in the workspace's sandboxed frame: the OCCT
7.9.3 modeling kernel and FreeCAD's PlaneGCS sketch solver are WebAssembly
modules in the page's own workers. There is no Python backend (`plugin.py`
registers nothing; `manifest.toml` declares the workspace and the study kind).

Licence: GPL-3.0-or-later. Third-party licences: `LICENSES/`.

## Mouse and keys

The view moves as the core viewer's does (Daniel, 2026-10-06), in model mode
and in sketch mode:

| Input | Does |
|---|---|
| Left drag | Orbits, wherever it starts (empty space or a body). In sketch mode a drag that starts on sketch geometry moves it instead (what is under-defined). |
| Shift + left drag, middle drag | Pans |
| Wheel, right drag | Zoom (to the cursor) |
| Alt + left drag | Orbits, always (also while a sketch tool draws) |
| **Ctrl + drag** | **Box select**, starting anywhere: left to right a solid box selects what it encloses, right to left a dashed box what it touches; Ctrl+Shift + drag adds to the selection; an empty box clears it. The caption in the box says what it takes. Model mode: what is visible, edges with no filter, else the filter's bodies / faces / edges / vertices; sketch mode: curves, points and dimension labels, or the sketch filter's kinds |
| Click, Ctrl+click | Select; Ctrl+click toggles one item (and, in a sketch, adds a body vertex or edge, projected) |
| Right click | The context menu |

Keys: model mode E Extrude, Q Press-pull, F Fit, N Normal to, 1-7 the standard
views, Delete (Delete faces on faces), Ctrl+Z / Ctrl+Y. Sketch mode: L Line, R
Rectangle, C Circle, A 3-point arc, S Spline, M Mirror, O Offset, P Project,
D Dimension, T Trim, X Construction, N Normal to, Enter places an open tool
step or finishes the sketch, Escape stops the tool then clears the selection.
The rest are toolbar commands (sketch mode: Control-point spline, Linear and
Circular pattern, Fillet, Chamfer, Intersect; model mode: Linear pattern,
Circular pattern, Mirror and the others); Ctrl held while drawing suppresses
snapping.

## Layout

| Path | What |
|---|---|
| `manifest.toml`, `plugin.py` | What the host reads. `plugin.py` is the only Python file in the plugin. |
| `src/` | TypeScript source of the workspace page and its workers. |
| `workspace/` | **Built output only** (what the host serves to the frame): `index.html`, `app.js`, `app.css`, `kernel/` (kernel worker + `mk32.mjs/.wasm`), `solver/` (`planegcs.mjs/.wasm`). Never edit by hand. |
| `kernel-build/` | OCCT + facade build (pinned sources, patches, scripts). See `kernel-build/SOURCES.md`. |
| `solver-build/` | PlaneGCS build (pinned upstream, our patch, script). See `solver-build/SOURCES.md`. |
| `tests/` | Unit tests (vitest; kernel and solver tests load the real wasm in Node). |
| `e2e/` | Playwright tests against the host app (`e2e/host-server.mjs` starts it with the app's `startHost()`). |
| `scripts/` | `build.mjs` (page + workers), `e2e.mjs` (build + e2e under a lock). |
| `ARCHITECTURE.md` | Areas, contracts and rules for anyone changing the code. |

## Build and test

The plugin has its own toolchain; the core's lint, typecheck and tests never
see `src/`, and the core's `npm test` does not run these: run them here
before every commit. The repository's CI job `cad-plugin` runs them too, and the
core's `npm run test:e2e` (`scripts/e2e-suites.mjs`) runs this suite through
`npm run test:e2e` here when a file of the plugin, or a host file in
`package.json` `magnusim.e2eHostPaths`, changed.

```
cd bundled-plugins/cad
npm ci                 # own node_modules (gitignored)
npm run typecheck      # tsc: src, tests, e2e
npm test               # vitest (unit; the kernel and solver in Node)
npm run build          # src/ -> workspace/ (page + worker modules)
npm run build:check    # workspace/ must be exactly the build of src/ (run before every commit)
npm run test:e2e       # build, start the host app on a free port, run every spec of e2e/ (bundled Chromium, parallel workers)
npm run test:e2e:smoke # the smoke set (@smoke): one path through every area, about 2 min
npm run test:e2e:sketch   # one area shard (shell, sketch, solids, step, link, big): see "The e2e suite" below
npm run test:e2e:changed  # only the shards the changed files need (git status)
npm run test:e2e:changed -- --base origin/master   # ... and the files that differ from origin/master
CAD_E2E_CHANNELS=chrome,msedge npm run test:e2e   # also real Chrome and Edge
npm run test:e2e -- e2e/cad-p1-document.spec.js   # the P1 exit gate only
npm run test:e2e -- e2e/cad-p2-step.spec.js e2e/cad-p3-sketch.spec.js   # the P2 and P3 exit gates
npm run test:e2e -- e2e/cad-p4a-solids.spec.ts e2e/cad-p4a-construct.spec.ts   # P4a: solid features, reference geometry
npm run test:e2e -- e2e/cad-p4a-fix1.spec.ts   # P4a fix round 1: each review finding
npm run test:e2e -- e2e/cad-p4b-pattern.spec.ts e2e/cad-p4b-sketch-tools.spec.ts e2e/cad-p4b-select.spec.ts e2e/cad-p4b-project.spec.ts e2e/cad-p4b-project-step.spec.ts   # P4b: patterns, sketch tools, selection, Project / Intersect (the step gate)
CAD_E2E_VORTEX_STEP=<path> npm run test:e2e   # with the Vortex part: its tests run instead of being skipped
CAD_E2E_BIG_STEP=<path> npm run test:e2e -- e2e/cad-large-step.spec.js  # the 113 MB STEP (opt-in)
npm run test:kernel    # the kernel gates in Node (fixtures/kernel)
npm run test:gate:l2-cad   # LINK: the export against the app's own checker, and the link e2e; fails (never skips) without the app's Python
npm run test:gate:l3-cad:ci   # the L3 gate for CI, as strict, without Daniel's files: every L3 case but cad:l3-vortex-include (below)
CAD_E2E_VORTEX_STEP=<path> npm run test:gate:l3-cad   # exit sync (L3): the exit hook's unit tests and e2e/cad-link-exit.spec.ts; fails (never skips) without the app's Python or the Vortex, on a stray .only, and on any test missing from or added to its census (every test is expected to pass; none is marked test.fail(): see ARCHITECTURE.md §11)
```

- `npm run test:e2e` starts the host app from this checkout with the app's
  own `startHost()` (`e2e/host-server.mjs` over
  `magnusim-web/e2e/support/host-server.mjs`: a temp projects root and prefs,
  no user plugins, a free port from 8170 (or `CAD_E2E_PORT_FROM`) with
  +11..+13 also free, a private Vite dependency cache in `.cache/host-vite`, no
  WSL meshes or solves and no sweep of WSL's cases). CAD ships on: the server
  starts with CAD at its manifest default, the tests turn it on again (as
  Settings' Enable does) when a test turned it off, and the P1 gate's first test
  forgets the choice and checks it is On on a fresh install, then Disable and
  Enable. `e2e/cad-start.spec.ts` clicks each place the start action is offered. Set
  `CAD_E2E_BASE_URL` to use a server that is already running, or
  `CAD_E2E_LOCK=<file>` to share one server between several runs (a live
  server named in the lock is reused, and its prefs file comes from the lock).
- The real-part STEP files are not in the repository: tests read them where they
  are, by path, and only from environment variables. `CAD_E2E_VORTEX_STEP` (the
  Vortex part: every test that needs it, the P2 gate's and the kernel tests
  included, is skipped without it and says so, and fails with the path when the
  variable names no file), `CAD_E2E_BIG_STEP` and `CAD_KERNEL_BIG_STEP` (the
  113 MB part, opt-in). `tests/arch/user-files.test.ts` fails if a copy of one is
  in the plugin.
- The app's Python: the link checker (`python -m magnusim_sdk.link check`) in
  `gate:l2-cad`, `gate:l3-cad`, `tests/kernel/kernel-link.test.ts` and the link
  e2e (`cad-link.spec.ts`, `cad-link-exit.spec.ts`), and the P2 gate's native
  OCP check (cadquery-ocp 7.9.3, inline), run the interpreter that has the app's
  backend installed. `scripts/app-python.mjs` finds it, in this order:
  1. `MAGNUSIM_PYTHON` (the app's own override; `CAD_E2E_PYTHON`, this plugin's
     older name for it, is read after it). A path that is not there, or a command
     that cannot import `cfddesk` and `magnusim_sdk`, is "missing": no other
     Python is tried in its place;
  2. the app's venv, `magnusim-web/python/.venv` (`Scripts/python.exe` on
     Windows, `bin/python` elsewhere);
  3. a `python`, then a `python3`, on `PATH` that can `import cfddesk` and
     `magnusim_sdk`. CI has no venv: the backend is pip-installed into
     setup-python's interpreter, and this finds it.

  With none, the gates FAIL at once and say what they tried (never a skip); the
  tests and specs skip with the same words outside the gates, and fail under
  them. The gates hand the Python they found to everything they start as
  `MAGNUSIM_PYTHON`.
- Kernel and solver binaries are rebuilt only when their sources change, on
  Linux or WSL: `kernel-build/build.sh`, `solver-build/build.sh`. Commit
  `workspace/**/*.wasm` only on version bumps.
- `gate:l3-cad:ci` (`npm run test:gate:l3-cad:ci`) is `gate:l3-cad` for CI,
  which never has Daniel's STEP files. It is just as strict: it fails without
  the app's Python, on any skipped test, on a stray `.only`
  (`--forbid-only`, `--allowOnly=false`), and on any test missing from or added
  to its own census (`L3_E2E_CI_CENSUS` in `scripts/gate-l3-cad.mjs`; the unit
  test `tests/link/gate.test.ts` keeps it equal to every test of
  `e2e/cad-link-exit.spec.ts` that reads no private file). It leaves out exactly
  one case, by `--grep-invert` (not run, so not skipped):
  - `cad:l3-vortex-include`: it imports Daniel's Vortex STEP
    (`CAD_E2E_VORTEX_STEP`), which never leaves his PC. The Vortex is only a
    convenient imported part there, so `cad:l3-include` runs the same case on
    the repository's `fixtures/kernel/flange.step` (a 100 x 100 x 10 plate with
    4 holes): an imported body and a block exit as a two-body geometry, then the
    block left out with its Include toggle (the flange only, the same geometry
    at rev 2), then nothing included (the header says so, the leave goes on).
    Both gates run it.

  The local `gate:l3-cad` stays the full gate (both include cases, the Vortex
  required).

### The e2e suite: shards, smoke, parallel workers

The suite is about 250 tests. Run only what a change can break, and the whole
suite once per phase.

- **Shards** (`scripts/e2e-shards.mjs` `SHARDS`; every spec is in exactly one,
  and `tests/e2e/shards.test.ts` fails on a spec in no shard or in two):

  | Shard | `npm run` | What | Specs |
  |---|---|---|---|
  | shell | `test:e2e:shell` | the tree, the document (P1 gate, save, reload, two tabs), panels, the toolbar, the viewport, leaving, the UI kit | `cad-p1-*`, `cad-p15-review1`, `cad-panel-done-reach`, `cad-sd-kit`, `cad-sd-review2-leave`, `cad-p4a-toolbar` |
  | sketch | `test:e2e:sketch` | the sketcher, profiles, Extrude of them (P3 gate, P2+P3 reviews); P4b's sketch tools, selection (boxes, the mouse binding, Construction, Normal to), Project / Intersect and model snaps | `cad-p3-*`, `cad-p2p3-*`, `cad-p4b-sketch-tools`, `cad-p4b-select`, `cad-p4b-project` |
  | solids | `test:e2e:solids` | P4a: the solid features, CONSTRUCT, edge names; P4b: patterns and mirror, Measure picks through a rebuild | `cad-p4a-solids`, `-construct`, `-fix1`, `-integrate`, `cad-p4b-pattern` |
  | step | `test:e2e:step` | STEP import and edit, Combine, Measure, Export, the Enclosure (P2 gate); P4b's exit gate (a sketch on an imported face with projected edges through an upstream Delete faces) | `cad-p2-step`, `cad-p2-features-step`, `cad-p2-kernel-ops`, `cad-sd-enclosure`, `cad-sd-review1`, `cad-sd-review2`, `cad-p4b-project-step` |
  | link | `test:e2e:link` | the Part as a project geometry (gate:l2-cad and gate:l3-cad's specs), the start actions | `cad-link*`, `cad-start` |
  | big | `test:e2e:big` | opt-in: the 113 MB STEP (`CAD_E2E_BIG_STEP`; skipped without it) | `cad-large-step` |

  A new spec goes into the shard of the area it tests.
- **Changed files** (`npm run test:e2e:changed [-- --base <ref>]`, or
  `-- --files a,b` where there is no git): `RULES` in `scripts/e2e-shards.mjs`
  maps each file to shards, and only those run. `src/sketch/`,
  `src/solver-worker/`, `solver-build/` go to sketch; `src/link/`,
  `src/doc/source-record.ts` and the gate scripts to link; the P4a feature
  folders to solids; the STEP and body-tool folders to step, plus the other
  shards whose specs use them; a feature's `index.ts` to shell as well (the
  toolbar). Shared code runs every shard: `src/doc`, `src/ui`, `src/app`,
  `src/viewport`, `src/naming`, `src/types`, `src/lib`, `src/kernel*`,
  `kernel-build/`, `workspace/` (the build output), `fixtures/`,
  `e2e/helpers.ts` and the rest of `e2e/`, the Extrude, Sketch, Enclosure and
  shared panel folders (every spec uses them), and any host file in
  `magnusim.e2eHostPaths`. Unit tests and docs run nothing. `--plan` prints
  what would run and why.
- **Smoke** (`npm run test:e2e:smoke`, about 2 min): 15 existing tests tagged
  `{ tag: '@smoke' }` (the unit test allows 10-15), one path through every
  area: a new Part, the tree, save and reopen, leaving with a save on its way,
  the toolbar at two sizes, the plate flow, the bracket (Fillet, edge names), a
  linear pattern of a hole, a fit-point spline, the sketch box selection, STEP
  edit and export, the Enclosure, the first link, the header's start action. Tag an existing test; never copy one.
  `--smoke` also narrows a shard: `npm run test:e2e:solids -- --smoke`.
- **Parallel workers on one server.** The runner starts one host server and
  runs every test but the `@serial` ones on DEFAULT_WORKERS (in
  `scripts/e2e.mjs`) workers: a spec file runs in order in one worker, files
  run side by side. Then the `@serial` tests run alone, on one worker (output
  in `test-results/serial`; 17 tests, of which the 113 MB ones and viewport-perf
  skip without their file or channel; P4b added `cad:p4b-select-box-10k`, which
  times a box over 10,000 faces, the box timings along the user's path, and the
  three toolbar tests that change the user's layout in the host's plugin prefs):
  they turn CAD off, break its manifest, forget its choice in the prefs file,
  click Settings > Plugins > Disable, read Home's list of every project, or
  time the server or the browser (`cad:p2-step-contention`'s latencies, the
  viewport's frame rate, the 113 MB part's budgets), which other workers' load
  would distort. Each test makes its own project, the save
  budget is the page's own, downloads and outputs are per test, and the specs
  with a server of their own find a free port and their own Vite cache.
  `CAD_E2E_WORKERS=N` (or `-- --workers N`) changes the count; with `CI` set
  it is 1 unless `CAD_E2E_WORKERS` says otherwise.

  Measured on this PC (Ryzen 9 9950X3D, 32 threads, 94 GB, other sessions
  running), the full suite in Chromium with the Vortex set, wall clock of the
  whole command (build, server, both phases):

  | Workers | Wall | Runs |
  |---|---|---|
  | 1 (the runner before the split) | 44.8 min | 1 |
  | 2 | 21.7 min | 1 |
  | 3 (the default) | 17.0-17.5 min (19.5 min for the first) | 6; the last two with no failure |

  The parallel phase is bound by the one server's throughput (its length is
  the summed test time over the workers), so more workers mostly add
  contention. `net::ERR_NO_BUFFER_SPACE` (this PC's Windows socket-buffer
  failure, seen at one worker in earlier phases too) can fail a test that
  loads a page; it is environmental: repeat the test alone.

- **The phase rule** (from now on, in every phase prompt):
  - fix rounds run the affected shards plus smoke:
    `npm run test:e2e:changed` (or the named shards) and `npm run test:e2e:smoke`;
  - the full suite runs ONCE per phase, at the end: `npm run test:e2e` in
    Chromium with the parallel workers, plus Chrome once
    (`CAD_E2E_CHANNELS=chrome npm run test:e2e -- --project chrome`);
  - a flaky spec gets 5 lone repeats, never a full restart:
    `npm run test:e2e -- e2e/<spec> -g "<test id>" --repeat-each 5 --workers 1`.

## Separation rules

- The core never imports the plugin, and the plugin never imports core code:
  the page talks to the app only through `@magnusim/workspace` (the bridge),
  wrapped in `src/lib/bridge.ts`.
- `plugin.py` is the only `.py` file (`python/tools/plugin_boundary.py` checks
  every `.py` in the plugin; `node_modules/` holds none today).
- React, React DOM, the bridge and the UI kit (`@magnusim/plugin-ui`) come
  from the host's import map; they are never bundled. The unit tests run the
  kit's own source (`vitest.config.ts` alias). Workers get no import map: worker modules are self-contained.
- The frame has no localStorage, IndexedDB or cookies, no `/api/`, no popups
  and no `alert`/`confirm`. Saved state goes through the bridge.
- No change in the core is needed to build or run the plugin. The host
  features it uses (plugin files with etags, unsaved-work questions, frame
  focus, off-by-default plugins, the UI kit) are generic host API 1.2 and
  1.3, listed in `ARCHITECTURE.md` §9.
- Dependencies must be GPL-3.0-compatible; code from AGPL projects or
  jsketcher is never copied.
