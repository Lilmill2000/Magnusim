# Changelog

What changed in Magnusim CAD, newest first. How to use each part: `README.md`.

## Unreleased (0.2.0-dev)

**The Assistant builds in the Part.** This needs Magnusim's Assistant, which is
still in development for Magnusim 0.5.0 (Settings > Assistant: a cloud provider
with your own key, or a local server on this PC). How to use it: "The Assistant
in the Part" in `README.md`.
- In an open Part the Assistant can read the design, find faces and edges,
  measure, look at pictures of the Part, set parameters, sketch, extrude,
  revolve, sweep and loft, drill holes, fillet, chamfer and shell, pattern and
  mirror, combine bodies, name and colour bodies, change, rename, suppress or
  move features, undo its own steps and delete features.
- You watch it work in the Part's own panels and sketch mode: a panel opens, its
  values go in, the part rebuilds, and in a sketch the relations and dimensions
  pull the shape into place. Its panels carry an "Assistant" badge and cannot be
  typed in; their Done says "The Assistant is filling this in · Esc takes over
  (the Assistant pauses)". A Parameters panel you have open stays open and
  flashes the rows the Assistant changed.
- Each call is all or nothing: a step that fails, is stopped or is taken over
  leaves the Part as it was. A join, cut or hole that misses the part changes
  nothing, and the Assistant is told why (which way it missed).
- All of one request's changes are one undo step ("Undo Assistant: <your
  request>"). A change of yours in between starts a new one and is never undone
  with the Assistant's.
- The Assistant chip in the dock says what it is doing ("Assistant · Sketch Plate
  sketch · 12 of 120 steps") and has Pause, Resume, Stop, Fast / Watch and Ask
  each step (Keep or Discard each step before it is kept). When a request ends
  it shows Undo (while nothing newer was done) and the Part's health ("· Fillet 1
  fails", "· 1 sketch under-defined"); a click on the health selects that
  feature.
- You come first. While you have a panel, a menu, a dialog or a rename open, or
  the rollback bar is not at the end, its edits wait (up to 10 minutes) and the
  chip says what it waits for. Escape, Ctrl+Z or a toolbar command (Parameters
  too) during one of its steps takes over: that step is discarded
  and the Assistant pauses in this Part until the request ends. Undoing its steps
  while the request runs pauses it too. Selecting, hovering and orbiting are not
  taking over.
- Deleting asks you first, in the app's own question: "Allow the Assistant to
  delete features?", "Deletes features from the Part; Ctrl+Z brings them back."
- Its pictures and measurements never move your camera or change your view.
  Once you move the camera during a request, the Assistant's automatic view
  turns stop for the rest of it. Watching needs the Magnusim window shown: in a
  hidden or covered window its steps run without pauses.

## 0.1.0 (October 2026)

The first release. Magnusim CAD is a parametric part modeler built into
Magnusim as the Part workspace. It ships on; Settings > Plugins turns it off.

**Start a part**
- Design a part from an empty project, from the New Project dialog, from
  "New design" on Home, or from the CAD button in the project header.

**Sketch**
- Lines, rectangles, circles, arcs, points, centerlines, fit-point and
  control-point splines, with snapping and typed lengths while you draw.
- Relations (Coincident, Horizontal, Vertical, Parallel, Perpendicular, Tangent,
  Equal, Midpoint, Symmetric, Concentric, Collinear, Fix) and dimensions with
  their units on the label. The sketch says how defined it is.
- Trim, Extend, Offset, sketch Fillet and Chamfer, Mirror, linear and circular
  sketch patterns.
- Project a body's vertices, edges, faces or silhouette into a sketch, and
  Intersect the sketch plane with the bodies. These curves follow the model.
- Snap to the model while drawing; construction geometry (see below).

**Sketching, after the first trial**
- Construction drawing: Construction (X, in Draw's More) turns it on and off;
  while it is on, every line, rectangle, circle, arc and spline you draw is
  construction. Right-click still turns a drawn curve into construction.
- A click counts where you pressed, even while the mouse is still moving, and
  a click and drag draws a line, rectangle, circle or arc in one go.
- A new sketch fillet shows an arrow on its arc: drag it to change the radius
  (it stops at the largest radius the corner takes and says why).
- Drag a command from a group's More menu onto the toolbar: it goes where you
  drop it and the group's last command moves to More.
- The Sketch panel is compact: the name and state, what the tool wants next,
  the dimension you are editing, and Done. Details shows the rest; its chevron
  (or `Ctrl+\`) slides it into a slim rail at the left edge.
- While you edit a sketch, the design tree slides into a rail at the left edge
  to free the view; click the rail to see the tree.
- The pointer in a sketch is a thin crosshair with the tool's icon beside it,
  and an open hand over geometry you can drag (closed while you drag); sketch
  points are drawn round.
- Relations show only for the geometry you select. Show relations (VIEW,
  Shift+R) shows them all and is remembered; a relation in conflict always
  shows, in red.
- Banana for scale (a new SCALE MODELS group after VIEW): a yellow 3D banana
  beside the part, dragged anywhere, never a body or part of the simulation;
  in a sketch, a true-size picture of a banana taped to the sketch's plane.

**Solids and edits**
- Extrude (blind, two sides, symmetric, through all, up to a face or a vertex;
  or a flat face of a body with no sketch), Revolve, Sweep and Loft, each as a
  new body or joined, cut or intersected.
- Fillet, Chamfer, Shell, Combine (join, cut, intersect), Split, Delete faces
  and heal.
- Press-pull on flat and curved faces: a hole or a boss changes its radius, a
  fillet stays tangent, sloping neighbours are extended, and a move that cannot
  work says which distance does.
- Linear pattern, Circular pattern and Mirror of features, bodies or faces.
- Reference planes, axes and points.

**STEP files**
- Import STEP with healing, names and colours (tested up to a 113 MB part),
  edit it with every tool above, and export STEP (AP214 or AP242).
- Edit in CAD: a STEP, IGES or BREP part imported in the simulation view opens
  in CAD from its tree row's right-click, the viewport's right-click on the
  part, or its Geometry panel. The Part imports it by itself; Back with a
  change updates that geometry in place with its boundary conditions (or saves
  it as a new one), and Back with no change leaves it as it was. The original
  file is kept.

**For CFD**
- Enclosure: a box or cylinder of air around the part, with zero, percent or
  fixed padding and a drag arrow per side. Combine Cut then gives the fluid
  volume.
- Leaving the Part updates the project's geometry in place: boundary conditions
  follow face names, meshes are marked out of date, and each body has an
  "Include in simulation" toggle.

**Everyday use**
- Design tree with rollback, suppress and rename; named parameters and
  expressions; undo and redo; automatic saving, with a clear choice when another
  tab saved the same Part.
- Measure, Mass properties, Check, the section view and a volume chip that
  never adds bodies together.
- The toolbar starts compact and is yours to arrange: show a command in the bar
  or move it into its group's More menu, reorder it, or reset the layout.
- Mouse like the simulation viewer: left drag orbits, Ctrl + drag box-selects.

Known limitations: see "Known limitations in 0.1.0" in `README.md`.
