# Magnusim CAD 0.1.0

A parametric part modeler in the style of SolidWorks and Fusion, built into
Magnusim as the **Part** workspace. You draw sketches, turn them into solids,
edit STEP files, wrap the part in an air volume for CFD, and go back to the
simulation with the part already in the project.

It is a bundled plugin and it is on by default. Settings > Plugins turns it off
(Disable); while it is off, nothing of it runs. Everything runs in the app's
window: the modeling kernel (Open CASCADE 7.9.3) and the sketch solver
(FreeCAD's PlaneGCS) run as WebAssembly in the workspace's own workers, so CAD
needs no Python, no WSL and no internet connection.

What is new in each version: `CHANGELOG.md`. How it is built: the
[Developer](#developer) section below and `ARCHITECTURE.md`.

## Contents

- [Start a part](#start-a-part)
- [The workspace](#the-workspace)
- [Sketches](#sketches)
- [Constraints and dimensions](#constraints-and-dimensions)
- [Solids](#solids)
- [Modify: fillets, shells, booleans and direct edits](#modify-fillets-shells-booleans-and-direct-edits)
- [Patterns and mirror](#patterns-and-mirror)
- [Reference geometry](#reference-geometry)
- [STEP files: import, edit, export](#step-files-import-edit-export)
- [CFD prep: Enclosure and Combine](#cfd-prep-enclosure-and-combine)
- [Measure and inspect](#measure-and-inspect)
- [History, parameters, undo and saving](#history-parameters-undo-and-saving)
- [Back to the simulation](#back-to-the-simulation)
- [Mouse and keys](#mouse-and-keys)
- [Known limitations in 0.1.0](#known-limitations-in-010)
- [Licence](#licence)
- [Developer](#developer)

## Start a part

A Part lives in a project, like a simulation study. Start one from any of these:

- **Design a part**, beside "Add geometry", on a project with no geometry yet.
- **Start from: Design a part** in the New Project dialog.
- **New design** on Home: it makes a project ("Untitled Part N") and opens a
  Part in one step.
- The **CAD** button in the project header: its menu lists the project's Parts
  and makes a new one.
- Once a project has a Part, the tree's STUDIES section lists it, with
  **+ New Part**.

The Part opens in its own full-page workspace over the project. It uses the
project's units (millimetres, inches and so on); a typed value may carry its own
unit ("125 mm", "5 in").

## The workspace

- **Toolbar** across the top. In model mode its groups are SKETCH, SOLID,
  PATTERN, MODIFY, CONSTRUCT, CFD PREP, INSPECT and FILE, then the views and
  Undo / Redo. It starts compact: each group shows its main one or two commands
  (Sketch; Extrude; Linear pattern; Fillet and Chamfer; Plane; Enclosure;
  Measure; Import STEP), and the rest of the group is in its **More ▾** menu. In
  sketch mode the ribbon shows DRAW, CONSTRAIN, DIMENSION and MODIFY.
  - Arrange it your way: right-click a command for **Show in toolbar**, **Move to
    More**, **Move left**, **Move right** and **Reset toolbar**, or drag a command
    along its group. The layout is yours in every project, and another open CAD
    tab follows a change at once.
  - A command that cannot run right now is greyed, and its tooltip says why
    ("Make or import a body first").
- **Design tree** on the left: **Origin** (the Top, Front and Right planes and
  the X, Y and Z axes), **Bodies**, and **History**, the features in build order
  with a rollback bar.
- **Feature panels** open on the left when you make or edit a feature. Changes
  apply live as you type or pick; **Done** closes the panel; **Delete** removes
  the feature (on a new one it discards it).
- **Viewport** with the view triad, the views menu (the standard views, Normal
  to, Perspective or Orthographic, Shaded, Shaded + edges, Wireframe), the
  **Selection filter** (Bodies, Faces, Edges, Vertices, Planes) and the
  **Section view**.
- **Chips** at the bottom: the selected body's volume (or each body's, never a
  total), the number of items selected, the save state and the sketch's state.

## Sketches

Click **Sketch** (or right-click a flat face: **New sketch on this face**), then
pick an origin plane, a CONSTRUCT plane or a flat face of a body. The view turns
square to the sketch. **Finish sketch** (or Enter with no tool step open) leaves
sketch mode; the camera stays where it is.

**Draw** (DRAW group):

- **Line** (L): chained lines, click by click. A, or a drag from the end, makes
  a tangent arc.
- **Rectangle** (R, two corners) and **Center rectangle**.
- **Circle** (C), **3-point arc** (A), **Tangent arc**, **Point**,
  **Centerline**.
- **Spline** (S): a fit-point spline through the points you click. Double-click
  or Enter places it; a click on its first point closes it. Its fit points are
  ordinary sketch points: dimension them, relate them, drag them.
- **Control-point spline**: degree 3 (or 5), pulled by its control points;
  the control polygon shows dashed while it is selected.
- **Construction** (X), or right-click a selection: **Construction** turns
  curves into construction geometry and back. A mixed selection offers **Make
  construction** and **Make normal**.

While you draw, a value box follows the pointer: type a length or an angle and
press Enter or Tab. The pointer snaps to the sketch (ends, midpoints, centres,
curves, horizontal and vertical) and to the model itself: a body's vertex, an
edge's middle, a point on an edge, a round edge's centre (hover the rim first),
and the point where an edge pierces the sketch plane. Clicking a model snap adds
a linked reference and the relation in one undo step. Hold Ctrl to draw without
snapping.

**Modify** (MODIFY group):

- **Trim** (T) and **Extend**: click the piece to cut off, or the end to extend
  to the next curve. Splines can be trimmed and trimmed against.
- **Offset** (O): point at a curve; its chain (lines, arcs and splines joined end
  to end) is previewed on the pointer's side. Click to place; **Both sides** is
  an option. Line and arc offsets stay tied to their source.
- **Fillet** and **Chamfer** of a sketch corner, with a Radius or Distance
  dimension you can edit later.
- **Mirror** (M): pick entities, then the mirror line. The copies stay
  symmetric to their source.
- **Linear pattern** (one or two directions; count, spacing, angle or "Along a
  line") and **Circular pattern** (about the origin or a picked centre; full
  circle or a total angle). The copies are tied to their source and follow it.
  Each pattern has a row in the Sketch panel where you change its count,
  spacing or angle, bring back a deleted copy, or **Dissolve** it (the copies
  become free geometry where they are). Deleting a pattern's source makes the
  next copy the source; the message offers **Dissolve pattern** instead.
- **Project** (P): click a body's vertex, edge or face to bring it into the
  sketch, or switch on **Silhouette** and click a body for its outline seen
  along the sketch normal. Works on imported STEP bodies too.
- **Intersect**: the curves where the sketch plane cuts the bodies (all shown
  bodies, or the ones you click).

Projected and intersected curves are **linked**: drawn purple, fixed in place,
and recomputed whenever the model rebuilds, so a sketch built on them follows
the model. Dimensions, relations, Trim (against them) and regions all use them.
**Break link** (right-click, or the panel's References row) turns one into
ordinary geometry. If its source disappears upstream, the curve turns amber,
the panel says "Lost reference: ...", and the sketch still solves; nothing is
blocked.

**Select** in a sketch: click, Ctrl+click to toggle, or **Ctrl + drag a box**.
Dragging left to right selects what the box encloses (solid box); right to left,
what it touches (dashed box). Ctrl+Shift + drag adds to the selection. In sketch
mode the Selection filter offers Points, Curves and Dimensions.

## Constraints and dimensions

**Relations** (CONSTRAIN group): Coincident, Horizontal, Vertical, Parallel,
Perpendicular, Tangent, Equal, Midpoint, Symmetric, Concentric, Collinear and
Fix. Select the items first, then click the relation; if the selection does not
fit, the button says what it needs. Many relations are added for you while you
draw (inferred).

**Dimensions** (D): pick one or two items and place the label. Lengths,
distances, radii, diameters and angles. Every label shows its unit ("⌀125 mm",
"R10 mm", "40 mm", "30°"). Double-click a label to change it; type a number,
a value with a unit, or an expression using your named parameters ("fx: 40 mm"
marks a value from an expression). A dimension that would over-define the
sketch can be placed as a **driven** (reference) dimension, shown in brackets:
"(40 mm)".

**How defined the sketch is**: the sketch chip says "Under defined · 2 DOF",
"Fully defined", or which relations conflict. Free geometry is drawn in blue and
fully defined geometry in black; an over-defined sketch shows red. Drag
under-defined geometry to move it; a fully defined entity keeps the normal arrow
and the panel says why it cannot move ("This line is fully defined: change a
dimension to move it").

## Solids

Solids come only from sketches and from STEP files: there is no one-click box
or cylinder. Every body-making feature has an **Operation**: New body, Join,
Cut or Intersect, with the bodies it works on.

**Join merges bodies that only touch** (face to face, with no overlap) into one
body, as well as bodies that overlap. This is by design (decided for 0.1.0): two
blocks placed side by side and joined become one solid. Use New body to keep
touching bodies apart.

- **Extrude** (E): pick sketch regions (profiles). Extents: blind, two sides,
  symmetric, through all, or up to a face or a vertex, with an offset; along the
  sketch normal or a chosen direction; Flip. You can also extrude a **flat face
  of a body** directly, with no sketch: right-click it, **Extrude face**. A drag
  arrow in the view changes the distance.
- **Revolve**: profiles about an axis (a centerline or line of the sketch, a
  straight or round edge, a round face's axis, an origin or CONSTRUCT axis); one
  side, symmetric or two sides, by an angle.
- **Sweep**: a profile along a sketched path; **Follow path** or **Keep
  orientation**.
- **Loft**: through two or more profiles, in the order you pick them (Move up /
  Move down); **Ruled** for straight sides.

## Modify: fillets, shells, booleans and direct edits

- **Fillet**: round edges with a radius. Tangent edges are taken as a chain. A
  radius that is too large names the edges and says which radius works.
- **Chamfer**: one distance, or two (Flip sides swaps them). A distance that is
  too large says what works.
- **Shell**: hollow a body to a wall thickness, removing the faces you pick;
  inside or outside.
- **Combine**: Join, Cut or Intersect several target bodies with several tool
  bodies; **Keep the tool bodies** is an option.
- **Split**: cut a body in two by a plane, a flat face or another body.
- **Delete faces and heal**: remove faces (a hole, a fillet, a boss) and let
  the kernel close the gap.
- **Press-pull** (Q): move faces along their normal. Out adds material, in
  removes it. Flat and curved faces, several at once:
  - a sloping neighbour is extended to meet the moved face, so no step is left;
  - a hole's bore or a boss changes its radius, and the panel says so ("Bore
    radius 10 mm → 8 mm"; 2 mm out on a 10 mm bore makes it 8 mm);
  - a fillet face changes its radius and stays tangent;
  - fillets and chamfers beside a moved face keep their size;
  - a move that would close a hole, cut the part through itself or leave a step
    is refused in red with a distance that works ("the hole would close: 9.9 mm
    or less works").

Every result is checked (still a valid solid, no face lost, a plausible volume
change) before it is taken. When a feature fails, it turns red with the reason
in plain words, and the model before it still shows.

## Patterns and mirror

The PATTERN group, beside SOLID:

- **Linear pattern**: one or two directions (an edge, an axis, a sketch line, or
  a plane's or flat face's normal), count with spacing or total extent,
  symmetric.
- **Circular pattern**: about an origin or CONSTRUCT axis, a straight edge or a
  round face; full 360° with equal spacing, or a set angle; symmetric.
- **Mirror**: across an origin or CONSTRUCT plane, or a flat face.

Each one repeats **features** (applied with each feature's own operation, or New
body / Join / Cut / Intersect), **bodies** (copies, named "Body 1 (Instance 2)")
or **faces** of one body (the boss or pocket they bound). Select what to repeat
before you click the command, or pick it in the panel. Numbered markers in the
view show each copy: click one to skip that copy, and use **Make it again** in
the panel to bring it back. Patterns of mirrors and mirrors of patterns work.
Copies keep stable names, so a fillet on copy 3 survives a change of count.

## Reference geometry

The CONSTRUCT group adds history features you can sketch on, extrude along,
revolve about, pattern about or mirror across. They follow the model when it
changes.

- **Plane**: offset, at an angle, through 3 points, midplane, normal to a curve
  at a point.
- **Axis**: through two points, of a round face, along an edge, where two planes
  cross.
- **Point**: at a vertex, at the centre of an arc, circle or sphere, on an edge
  at a distance or a percentage, where an edge crosses a plane, or at
  coordinates.

The origin's X, Y and Z axes are rows under Origin and can be used the same way.

## STEP files: import, edit, export

- **Import STEP** (FILE group): the file is read, healed (faces knitted into
  solids within a tolerance you can change) and added as an **Imported** feature,
  keeping the bodies' names and colours. A large file shows its progress and can
  be cancelled; a 113 MB, 11,776-face part imports in under a minute.
- Edit it with the same tools as a native part: Press-pull, Delete faces,
  Split, Combine, Fillet, Chamfer, Shell, sketches on its faces, Project of its
  edges. Each edit is a feature on top of the import, so it can be changed or
  undone later.
- **Export STEP**: the bodies you pick, as STEP AP214 or AP242, in the length
  unit you choose.

## CFD prep: Enclosure and Combine

**Enclosure** (CFD PREP group) makes the box or cylinder of air around the part,
once the part has a body:

- **Box**, or **Cylinder** with its axis, around the exact bounding box of the
  bodies you choose (all of them by default).
- **Padding**: **Zero** (tight to the part, the default), **Percent** of the
  part's size, or **Fixed** distance. Each side then has its own value: type it,
  or drag that side's arrow in the view (Escape during a drag puts it back).
- A side may go into the part (an amber note names it: the fluid leaves out the
  part beyond it), but never past the part's far side.
- It follows the part when the part changes, keeping your padding. It is drawn
  see-through, so a click picks the part inside it. Its faces are named by side
  ("+X face of Enclosure 1", "Top face"), which become clear patch names in the
  simulation.

The air volume is always a separate step: **Combine**, **Cut**, with the
Enclosure as the target and the part as the tool (**Keep the tool bodies**
comes on). Rename the result, for example to "Fluid".

## Measure and inspect

- **Measure**: click faces, edges and vertices for distances, angles, lengths,
  radii and areas. Its picks survive a rebuild that keeps their geometry.
- **Mass properties**: volume, surface area, centroid and size, for each body
  and in total.
- **Check**: each body is "Valid", or its problems are listed by kind with
  where they are.
- The **volume chip** shows the selected body's volume; with nothing selected it
  lists each body on its own. It never adds bodies together.
- **Section view** cuts the view along an origin plane, so you can reach faces
  inside the part.

## History, parameters, undo and saving

- **History**: right-click a feature for Edit, Rename, Suppress or Unsuppress,
  Roll back to here, Roll to end and Delete. Drag the rollback bar to see the
  part as it was at that feature. A feature that breaks because something
  upstream changed is marked red with the reason; a reference it can follow
  only approximately says "Reference repaired · check".
- **Parameters**: named values with units and expressions. Use them in any
  number field ("width * 2").
- **Undo and redo** (Ctrl+Z, Ctrl+Y): up to 100 steps. One panel, one drag or one
  action is one step.
- **Saving is automatic.** The save chip says Saved, or what it is waiting for.
  If you leave while a change is still being written, the app asks first.
- **Two tabs**: if another tab saved the same Part while this tab has an
  unsaved change, you choose: **Reload (discard my change)** or **Keep mine
  (replace the other tab's save)**. Nothing is lost silently.

## Back to the simulation

A Part is **linked** to one geometry of its project. There is no export step:

- **Leave the Part** any way you like (Back, the browser's Back, another
  project, Home). The Part saves, the project's geometry is brought up to date,
  and you land in the simulation viewport looking at the part the way you left
  it. The first time, the geometry is created; after that it is updated in
  place.
- **Include in simulation**: each body has this toggle (its Bodies row and its
  menu). It is on for every solid body. A hidden body is still in the
  simulation while it is included.
- **Studies are kept**: boundary conditions and refinements follow faces by
  their CAD names. If a named face is gone, you are told which. Meshes are marked
  out of date; nothing is deleted.
- If nothing changed, leaving is instant. If a feature is broken, leaving asks
  first ("Couldn't update the project", with the reason). A broken reference
  plane, axis or point that nothing uses does not stop the update.

## Mouse and keys

The view moves the way the simulation viewer's does, in model and sketch mode:

| Input | Does |
|---|---|
| Left drag | Orbits, wherever it starts. In sketch mode, a drag that starts on sketch geometry moves it instead (what is under-defined). |
| Shift + left drag, middle drag | Pans |
| Wheel, right drag | Zooms (to the cursor) |
| Alt + left drag | Orbits, always (also while a sketch tool draws) |
| **Ctrl + drag** | **Box select**: left to right selects what the box encloses (solid box), right to left what it touches (dashed box); Ctrl+Shift + drag adds; an empty box clears. In model mode it takes what is visible: edges with no filter, else the filter's bodies, faces, edges or vertices. |
| Click, Ctrl+click | Select; Ctrl+click toggles one item (in a sketch it also adds a body vertex or edge, projected) |
| Right click | The context menu |

**Model mode:** E Extrude, Q Press-pull, F Fit, N Normal to, 1–7 the standard
views (Front, Back, Left, Right, Top, Bottom, Isometric), Delete (on faces:
Delete faces), Ctrl+Z / Ctrl+Y, Escape clears the selection.

**Sketch mode:** L Line, R Rectangle, C Circle, A 3-point arc, S Spline,
M Mirror, O Offset, P Project, D Dimension, T Trim, X Construction, N Normal to
(the open sketch), Enter places an open tool step or finishes the sketch,
Escape stops the tool, then clears the selection. Ctrl held while drawing turns
snapping off.

**Normal to** (N, the views menu, and the right-click menu of a face, a plane, a
sketch's row or its curves in the view) turns the view square to a flat face, a
plane or a sketch. A curved face is refused in words.

## Known limitations in 0.1.0

**Scope.** 0.1.0 makes multi-body parts. Assemblies and joints, surface
modeling, 2D drawings, sheet metal and feature recognition on imported parts are
not part of it. There is no hole wizard, draft, variable-radius fillet, guide
rail for Loft or Sweep, or 3D sketch yet. A geometry that was added to a project
as a STEP file cannot be opened in CAD yet: start a Part and use Import STEP.

**Size.** The kernel runs in the browser with at most 4 GB of memory. A 113 MB
STEP file (about 12,000 faces) works but takes up to a minute to import; much
larger files may not fit. On a PC without graphics acceleration, a box selection
or Escape on such a part pauses for about a second.

**Press-pull** refuses, rather than leave a step, when a face next to the moved
face is not square to it and OCCT's offset cannot extend it. On imported parts
this includes many pipes and cones that meet spline faces. Faces tangent to a
moved face always move with it (the panel says how many); there is no switch to
keep them still. Only a simple fillet (one face between two faces) is re-rounded;
a chain of fillets or a corner blend is refused. Chamfers keep their size only
when a Chamfer feature made them. Some spline faces cannot be offset at all, and
the refusal says so. On parts over 2,000 faces the "what works" distance is not
searched ("A smaller distance may work").

**Sketches.**
- An offset of a spline is a new spline through offset points: it does not
  follow later changes of the source spline.
- Extend works on lines and arcs, not splines (a line or an arc can be extended
  to a spline).
- Dimensions take a spline's points, not the curve itself (no length or
  curvature dimension).
- Sketch Fillet works on two lines, or a line and an arc, that share a corner.
- Chamfer "Same distance" writes two dimensions with the same value; changing
  one does not change the other.
- A projected face, silhouette or intersection whose number of curves changes
  after an upstream edit keeps its old curves until you open the sketch ("changed:
  open Sketch N to update it").
- The centre snap needs the round edge hovered first. Spline edges of a body
  offer only their end points and pierce points as snaps.

**Patterns.** A pattern of faces copies the boss or pocket the faces bound; it
does not move the original faces. A copy far outside the view has no marker;
use the panel's Make it again row. Sketch features default to New body: a
Revolve or Sweep touching a body is not joined to it until you choose Join.

**Selection.** A box takes only what is visible. Planes are not boxed (click
them), and in Wireframe faces and bodies are not boxed.

**Other.**
- Sweep's Keep orientation does not move the profile to the start of the path.
- On very large imports, Fillet's "which radius works" search can run out of
  time; you then get the failure without a suggestion.
- The note that a broken, unused reference was left out of the update shows in
  the header while you leave, not in the landing report.
- Some blends OCCT 7.9.3 cannot build (for example a small tangential inlet
  blend on a cyclone part).

## Licence

GPL-3.0-or-later, like Magnusim (the repository's `LICENSE`). The third-party
parts the plugin ships (Open CASCADE, PlaneGCS, Eigen, Boost headers, the
Emscripten and LLVM runtimes, musl, three.js, three-mesh-bvh) and where their
sources are: `LICENSES/README.md`.

## Developer

### Host API

It needs Magnusim's host API 1.6: a Part's design becomes a geometry of its
project (`ws.project.linkGeometry`, the Part study kind's `links_geometry`, 1.5),
and its panels are drawn with the host's UI kit (`@magnusim/plugin-ui`, 1.3).
The sync runs when the user leaves the Part (the host's exit hook,
`ws.nav.onLeave`, 1.6); ARCHITECTURE.md §11 has the export, the face names and
the exit hook. From 1.2 it uses `ws.files` to save a Part's model (etag-checked
writes, so two tabs never overwrite each other) and asks before leaving the
workspace while a change is not saved yet. (The document still falls back to
`ws.data` on a 1.1 host; the unit tests' fake host uses that path.) The toolbar
layout uses the host's per-user plugin prefs (`ws.prefs`) when the host has them,
else it is kept per project (ARCHITECTURE.md §7 "Toolbar").

There is no Python backend (`plugin.py` registers nothing; `manifest.toml`
declares the workspace, the study kind and the start actions). The description
in `manifest.toml` (shown in Settings > Plugins) names only what ships: update it
as features land, and run `npm run gen:registry` in `magnusim-web` after.

### Layout

| Path | What |
|---|---|
| `manifest.toml`, `plugin.py` | What the host reads. `plugin.py` is the only Python file in the plugin. |
| `src/` | TypeScript source of the workspace page and its workers. |
| `workspace/` | **Built output only** (what the host serves to the frame): `index.html`, `app.js`, `app.css`, `kernel/` (kernel worker + `mk32.mjs/.wasm`), `solver/` (`planegcs.mjs/.wasm`), `pick/` (the picking worker). Never edit by hand. |
| `kernel-build/` | OCCT + facade build (pinned sources, patches, scripts). See `kernel-build/SOURCES.md`. |
| `solver-build/` | PlaneGCS build (pinned upstream, our patch, script). See `solver-build/SOURCES.md`. |
| `LICENSES/` | Third-party licence texts and the LGPL source and relinking notes. |
| `tests/` | Unit tests (vitest; kernel and solver tests load the real wasm in Node). |
| `e2e/` | Playwright tests against the host app (`e2e/host-server.mjs` starts it with the app's `startHost()`). |
| `fixtures/` | Synthetic STEP files and native reference values for the kernel tests. |
| `scripts/` | `build.mjs` (page + workers), `e2e.mjs` (build + e2e under a lock), the shard map and the gates. |
| `docs/` | `p2p3-plan.md`: the P2/P3 build plan (schema, kernel API 3, extension points). |
| `ARCHITECTURE.md` | Areas, contracts and rules for anyone changing the code. |
| `CHANGELOG.md` | What changed in each version, for users. |

### Build and test

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

  Measured on the development PC (Ryzen 9 9950X3D, 32 threads, 94 GB, other
  work running), the full suite in Chromium with the Vortex set, wall clock of
  the whole command (build, server, both phases):

  | Workers | Wall | Runs |
  |---|---|---|
  | 1 (the runner before the split) | 44.8 min | 1 |
  | 2 | 21.7 min | 1 |
  | 3 (the default) | 17.0-17.5 min (19.5 min for the first) | 6; the last two with no failure |

  The parallel phase is bound by the one server's throughput (its length is
  the summed test time over the workers), so more workers mostly add
  contention. `net::ERR_NO_BUFFER_SPACE` (a Windows socket-buffer failure seen
  on that PC, at one worker in earlier phases too) can fail a test that loads a
  page; it is environmental: repeat the test alone.

- **The phase rule:**
  - fix rounds run the affected shards plus smoke:
    `npm run test:e2e:changed` (or the named shards) and `npm run test:e2e:smoke`;
  - the full suite runs ONCE per phase, at the end: `npm run test:e2e` in
    Chromium with the parallel workers, plus Chrome once
    (`CAD_E2E_CHANNELS=chrome npm run test:e2e -- --project chrome`);
  - a flaky spec gets 5 lone repeats, never a full restart:
    `npm run test:e2e -- e2e/<spec> -g "<test id>" --repeat-each 5 --workers 1`.

### Separation rules

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
  focus, off-by-default plugins, the UI kit, linked geometries, the exit hook,
  start actions, plugin prefs) are generic host APIs, listed in
  `ARCHITECTURE.md` §9.
- Dependencies must be GPL-3.0-compatible; code from AGPL projects or
  jsketcher is never copied.
