# Changelog

What changed in Magnusim CAD, newest first. How to use each part: `README.md`.

## Unreleased (0.2.0-dev)

**What the Assistant can do, you can do too.**
- Hole (SOLID): click a flat face, click the centres on it (or type them), set
  the diameter and Through or a blind depth, Done. It makes "Hole N sketch" and
  the cut "Hole N" as one undo step, the same two features the Assistant's holes
  are, edited later as a sketch and an extrude. Also in a face's right-click menu.
- A body's colour: click its swatch in the tree, or "Colour…" in its menu.
- The history's order: drag a feature onto another (it goes before or after
  it), or Move up and Move down in its menu. A feature stays below what it uses
  and above what uses it; a move that breaks that is refused and says why.
- Delete with several features selected deletes them all as one undo step, or
  none when a feature left still uses one of them.
- The Back isometric view (key 8, and the views menu); Middle in the section
  view cuts through the middle of the shown bodies.
- Find (INSPECT): select faces, edges, bodies or sketch regions by a query in
  the Assistant's own words ("Body 1 faces >Z", "largest", "hole", "edges of
  Extrude 1.end"), then Select all or click a row.
- Picture (FILE): a picture of the part from up to four set directions, with
  body names or face labels, a section, bodies left out, saved as a PNG. Your
  own view does not move.
- Measure takes a body (its row in the tree: volume, solids, sealed voids,
  whether it is valid; two bodies: their overlap and how many solids they make
  joined), a body's cross-section at Top, Front, Right or a plane of yours, and
  points typed as x, y, z.
- Parameters have a comment, under each row.
- The sketch toolbar's drawing tools come in groups, one button each with an
  arrow beside it that lists the group's tools (the button runs the one used
  last): Line (Centerline, Midpoint line), Rectangle (Center, 3-point corner,
  3-point center, Parallelogram), Circle (Perimeter circle), Arc (Centerpoint,
  Tangent, 3-point, Sector), Slot (five kinds), Spline (Control-point), Ellipse
  (Partial ellipse, Parabola, Conic); Polygon is a button of its own.

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
  leaves the Part as it was (unless a change of yours during it means taking it
  back would undo yours: then what it made before stays, and the chip names
  it). A join, cut or hole that misses the part changes nothing, and the
  Assistant is told why (which way it missed).
- All of one request's changes are one undo step ("Undo Assistant: <your
  request>"). A change of yours in between starts a new one and is never undone
  with the Assistant's.
- The Assistant chip in the dock says what it is doing ("Assistant · Sketch Plate
  sketch · 12 of 120 steps"; on a coding agent, its changes: "3 of 24 changes")
  and has Pause (a step it is making stops where it
  is until Resume), Resume, Stop, Fast / Watch and Ask each step (Keep or
  Discard each step before it is kept). When a request ends
  it shows Undo (while nothing newer was done) and the Part's health ("· Fillet 1
  fails", "· 1 sketch under-defined"); a click on the health selects that
  feature.
- You come first. While you have a panel, a menu, a dialog or a rename open, or
  the rollback bar is not at the end, its edits wait (up to 10 minutes) and the
  chip says what it waits for. Escape, Ctrl+Z or a toolbar command (Parameters
  too) during one of its steps takes over: that step is discarded (all of it,
  for Ctrl+Z between its panels) and the Assistant pauses in this Part until the
  request ends. Undoing its steps
  while the request runs pauses it too. Selecting, hovering and orbiting are not
  taking over.
- Deleting asks you first, in the app's own question: "Allow the Assistant to
  delete features?", "Deletes features from the Part; one Ctrl+Z takes back
  the whole request, this deletion with it."
- Its pictures and measurements never move your camera or change your view.
  Once you move the camera during a request, the Assistant's automatic view
  turns stop for the rest of it. Watching needs the Magnusim window shown: in a
  hidden or covered window its steps run without pauses.

**A dark Magnusim.** With Magnusim's dark appearance (Settings → Appearance),
the Part follows it: dark from the moment it opens, and at once when the look
is changed with the Part open, from any Magnusim window:
- The 3D view turns dark (`#1b1f27`); the parts keep their light surfaces, their
  edges follow what is under them as sketch lines do (dark over a face, as in
  light, so they still show on a face seen head-on; light on the outline's
  outer side, over the background), and the orientation arrows take Magnusim's
  dark axis colours, lit so that an arrow pointing straight at you still stands
  out.
- Sketch lines and points (every state, the line being drawn too, in a sketch
  and on a finished one), reference axes and points, the measure line and the
  Extrude and Enclosure arrows follow what is under them: over a part's face
  of a light colour (the default one or another light one), over a face that
  is picked or under the pointer and over a selected part (whatever its
  colour), and over a section's cut face they keep the colours they have in
  light; over the dark background, and over a part of a dark colour or a
  see-through one, they take light colours. A line that crosses a face's edge
  changes colour there. A selected or hovered line keeps its colour, and the
  band around a line under the pointer is fainter over the dark background,
  so the line's own colour shows in it.
- The Sketch panel's colour dots show both colours (the left half the colour
  over a face), the sketch cursor (a fillet's radius arrow's too) is the
  light one over a face, a selection
  box's caption and a failed Pattern copy's number stay readable, and blue
  text in the Part uses the lighter blue made for dark backgrounds.
- Pictures stay light whatever the appearance: the Picture tool's PNG, the
  Assistant's pictures, and anything else drawn off screen look exactly as in
  light, and the view never flashes light while one is taken.
- The toolbar's icons follow Magnusim's icon size.
- In light the Part is as before; only its orientation arrows take the axis
  colours Magnusim's own 3D views now use (a shade darker).

**Sketching, after trying Magnusim CAD**
- In a sketch the big hand is gone. Over sketch geometry the pointer is a small
  arrow with a tiny icon beside it of what is under it: a point, a line, an arc,
  a circle or an ellipse. A rectangle's, polygon's or slot's sides show as
  lines; fillets, slot ends, open splines, parabolas and conics as arcs; a
  closed spline as a circle; part of an ellipse as an ellipse. While you drag,
  and over a fillet's radius arrow or the banana's picture, the small arrow has
  a four-way arrow beside it.
- The point under the pointer grows, in a light blue disk, so you can see
  which point you are about to click. A selected point is green with a green
  ring round it. Both in light and dark.
- A tool's own key pressed again puts the tool down: L, draw a line, L, and the
  Line tool is gone (what you drew stays; a line or shape you had started is
  dropped, as Escape drops it). It is the key you gave the tool, if you changed
  it; R also puts down Center rectangle and the other rectangles, and so on for
  each toolbar group. Escape still steps back one step at a time (it ends a line
  chain and keeps the Line tool). A key typed into a value box stays there.

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
