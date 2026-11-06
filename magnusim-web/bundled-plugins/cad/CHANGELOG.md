# Changelog

What changed in Magnusim CAD, newest first. How to use each part: `README.md`.

## Unreleased (0.2.0-dev)

**Hole makes counterbores, countersinks, drill points, fastener sizes and threads (issue #7).**
- SOLID > Hole has **Size**: Custom diameter, **Clearance hole for a bolt** (a
  metric size M1.6 to M64 and a fit: close, normal or loose, the ISO 273 hole:
  M6 normal is 6.6 mm) or **Tapped hole** (the tap drill: major diameter minus
  the coarse pitch, M6x1 is 5 mm).
- A tapped hole gets a **cosmetic thread**: its cut records it ("M6x1"),
  get_model lists it, and the view draws it as a coil at the thread's diameter,
  one turn per pitch, with its size beside the hole; it runs as deep as the cut
  and follows it. The solid is not threaded. The Extrude panel shows it, with
  Remove.
- **Type** Counterbore (diameter, depth) or Countersink (diameter at the face,
  angle, 90 deg by default): a circle about each hole in the holes' sketch and a
  cut "<name> counterbore" or "<name> countersink" before the hole's own cut.
  With a clearance hole, **From the screw table** sizes them: a socket head cap
  screw's counterbore (ISO 4762, DIN 974-1, M3 to M30: M6 is 11 mm by 6.4 mm) or
  a countersunk head screw's countersink (ISO 10642 at 90 deg, M3 to M20).
  Counterbores or countersinks that would overlap are refused.
- A blind hole's **Bottom** can be a **Drill point** (118 deg by default):
  "<name> tip sketch" on the holes' bottom and the cut "<name> tip" to a point.
- **From a sketch** puts a hole at each of a sketch's points and circle centres,
  and the holes follow those points: the holes' sketch links each centre to its
  point (a new link source, another sketch's points), so moving a point moves its
  hole. The holes are the points there were when it was made: a point added
  later gets no hole, and a point removed leaves its hole where it was, with a
  lost reference warning. That sketch cannot be deleted while holes follow it.
- **Inch sizes**: Unified #0 to 1 in, UNC and UNF ("1/4-20", "#10-32 UNF"): the
  ASME B18.2.8 clearance holes (no #12 or 9/16 in that table) and the tap drills
  for about 75% thread, by drill name (1/4-20: #7, 0.201 in). Inch sizes stay in
  inches in the hole's expressions. The screw-head tables stay metric.
- **Modelled threads**: Thread *Modelled* on a tapped hole also cuts the ISO /
  Unified internal thread into the wall, as the feature "<name> thread" (60 deg
  flanks, a P/8 flat at the major diameter, a helical groove per hole). It
  follows the hole's circles, depth and size; it stops a pitch short of a blind
  hole's bottom and just inside a through hole's far face, and its Length can be
  shorter. A cut the kernel could not make fails in words rather than passing.
- Every size stays an expression the features keep, so the holes follow
  parameters; it is all one undo step, as before. A simple hole is made exactly
  as before. The Assistant's hole takes the same: points, size and fit, type,
  cb_diameter, cb_depth, cs_diameter, cs_angle, tip and tip_angle ("" sizes
  from the screw table).
- A blind hole deeper than the body goes through: Hole now says so ("Hole 2 is
  30 mm deep, deeper than Block there, so it goes through"), and leaves out a
  drill point it asked for. It used to call it blind with no warning.

**Extrude has a Draft angle.**
- Sketch profiles with Blind, Symmetric or Two sides: the walls lean that far
  from the extrude direction, a positive angle narrowing the profile as it goes
  (up to 89 deg either way). The Assistant's extrude takes taper ("" for none).

**Find picks fillets and drilled holes by their shape.**
- INSPECT > Find (and the Assistant's find) takes `fillet` (a round face
  joining two faces smoothly, whatever made it; chamfers are not fillets),
  `fillet 2 mm`, `fillet <= 2 mm` and `fillet >= 5 mm`, `hole 6 mm`,
  `hole <= 6 mm` and `hole >= 10 mm` (every face of the whole drilled holes
  with that bore, through holes too; holes that cross are one hole), and for
  any round face `radius <= 3 mm` / `radius >= 3 mm`: "Body 1 faces fillet <= 2 mm" lists
  "8 faces match ...", each row's type "fillet R2" or "hole Ø6 through", the
  number of holes ("(4 holes)") and a reminder to check the lit faces. A
  query that matches nothing says what the body has ("Body 1 has 4 fillet
  faces, R5").
- Fillets are found on bodies of up to 5,000 faces and drilled holes on bodies
  of up to 2,600 (finding holes takes longer). A larger body is refused in
  words that name both limits, the one the search met first ("Body 1 has 3,000
  faces: holes are found on bodies of up to 2,600 faces and fillets on bodies
  of up to 5,000 faces. Select its faces in the view instead."), and on a body
  between the two its fillets are still found. The Assistant gets the same
  words.

**Delete faces picks fillets and holes by size.**
- Its panel has **Fillets up to** [2 mm] **Add** and **Holes up to Ø** [6 mm]
  **Add**: they add the faces of the fillets up to that radius, or of the
  drilled holes up to that diameter (through holes too), that are not picked
  yet, and say what they added ("Added 8 faces: 1 fillet chain, R2", "Added 4
  faces: 4 holes up to Ø6 mm (4 through)") or why nothing ("No fillets up to 2
  mm on Body 1 that are not already picked (Body 1 has 12 fillet faces, R2 to
  R5)", or a body too large, a surface body). "Up to" is the size itself:
  Holes up to Ø 5.95 mm adds no 6 mm hole. Round voids and other holes with no
  cylinder are not counted as drilled holes ("Body 1 has 1 drilled hole, Ø6,
  and 3 round hollows with no cylinder, which no size matches"). The sizes
  start from the body's size. With no face picked yet they use the Part's one solid body; with two,
  they ask for a click on the body first.
- They pick exactly what the Assistant's `"Body 1 faces fillet <= 2 mm"` and
  `"Body 1 faces hole <= 6 mm"` pick, so a rounded T-block's fillets added this
  way come off as fillets in one go.
- A Ctrl+drag box in the view adds the faces it selects while the panel is
  open (it used to replace the panel's highlight and add nothing).

**Delete faces takes fillets off as fillets where the heal cannot.**
- Deleting every fillet of a part with a cavity on each side (a T-block, an
  I-beam, a plus, a comb, a Z-block) was refused ("healing filled more than the
  gap ..."). When the faces are every fillet of the body up to the largest
  picked radius, Delete faces now takes them off as fillets (Analysis Situs)
  and keeps the result only when it passes the same checks and three more: no
  material taken from a face you kept, no more material changed than the
  fillets held, every face on the surface it came from. The rounded T-block
  comes back as its sharp 32,000 mm³ with every face keeping its name, and the
  row says "Taken off as fillets up to R2 by Analysis Situs: OCCT's heal could
  not do it cleanly". Anything that was right before stays the same.
- When that fails too, the red text says why after the heal's words ("...;
  taking them off as fillets did not work either: 1 of the 42 fillet faces
  could not be taken off (a ring round a boss or a hole cannot be taken off as
  a fillet); the body is unchanged"). Delete faces allows 1.4 s for taking
  fillets off as fillets: when it would take longer, it is not started and the
  red text says how long ("...; taking them off as fillets would take about
  6.5 s (100 fillet faces on a body of 410 faces), and Delete faces allows
  1.4 s for taking fillets off as fillets; the body is unchanged").
- A red Delete faces names the faces that would make the pick whole ("Every
  fillet up to R2 on Body 1 is 40 faces and 39 are picked: with all 40, Delete
  faces can take them off as fillets", or the rest of the fillets and holes
  the picked faces are part of), and its panel's Add the rest adds them. The
  Assistant reads them as `rest` in get_model. When those fillets include
  rings round a boss or a hole (a hole's rim), which cannot come off as
  fillets, it says so instead ("Delete faces cannot take the fillets up to R2
  on Body 1 off as fillets: 2 of the 42 are rings round a boss or a hole") and
  offers no rings to add.
- A Delete faces saved before this keeps the old heal, so the Part rebuilds as
  it was made; when its faces would qualify, its red text says a new Delete
  faces of them may take them off as fillets.

**Delete faces no longer runs into the 20 s stop on fillets that end on other fillets.**
- A T-block rounded R2 on its edges across and then R1 along it: Fillets up to
  1 mm picked the 8 R1 rounds, and OCCT's heal of them ran on until the kernel
  was stopped and restarted ("Delete faces 1 was stopped after 20.0 s"). Each
  R1 round ends in two small corner pieces where it meets the R2 fillets, and
  OCCT's heal grows every face next to a round by the round's length: grown
  36 mm past their 2 mm, the corner pieces took it minutes (568 s, and then it
  failed). Now each round comes off with the corner pieces at its ends, one
  at a time, checked as fillets taken off as fillets are: the row is ok in a
  few seconds with the T-block that has only its R2 fillets, and says "Taken
  off one round at a time, with the 16 corner faces where they meet other
  fillets: OCCT's heal was not run: it would grow 16 small curved faces up to
  10 times their size, which failed or ran past 20 s on every part measured".
  The same works on L, U, plus and plain blocks rounded twice, in either order.
- OCCT's heal now has a time limit: the 20 s (120 s on a part of over 2,000
  faces) the kernel's stop gave it before, so every heal that ended in time
  before ends the same way. Its call gets 20 s more, so a heal that does not
  finish is red in words and the kernel is not restarted for it (a B-spline
  comb's 20 rounds took 58 s): "Delete faces 1 failed: OCCT's heal did not
  finish in 20.0 s; the body is unchanged". OCCT checks the time between its
  steps, so a single step that runs on longer can still meet the stop.
- The one place OCCT's heal does not run first: where it would grow a kept
  curved face (not flat, and not a plane, cylinder, cone, sphere or torus) more
  than 4 times its size, a new Delete faces first takes the faces off the
  other ways, and runs OCCT's heal (with its whole 20 s) only when they
  refuse. Every such heal measured (28 parts) failed or ran past 20 s. Flat
  faces written as B-splines (a heat sink's fin ends, as some exporters write
  every face) are not counted: their heal runs first, as before.
- A red Delete faces on a body over a face limit says what was not looked
  for, naming both limits: "The holes the picked face is part of are not
  looked for on Body 1: it has 3,000 faces, and holes are found on bodies of
  up to 2,600 faces and fillets on bodies of up to 5,000" (it left the holes
  out of the rest with no word, and over 5,000 faces said nothing).
- When every way refuses, the red text says each one once and then that the
  body is unchanged ("...; taking them off as fillets did not work either:
  ...; taking them off with the 16 corner faces where they meet other fillets
  did not work either: ...; the body is unchanged"). The Assistant gets the
  same words and notes.

**Volumes of curved (B-spline) bodies are right.**
- The volume chip, Mass properties, Measure and the Assistant read lofts,
  revolved splines and other B-spline bodies up to 0.2 % off (an airfoil loft
  showed 3.9336 × 10⁷ mm³ for 3.94102 × 10⁷), and after a Press-pull of such a
  body the error could exceed the change itself. They now read what the body
  holds (kernel API 7: each curved face is integrated piece by piece).
- Press-pull no longer refuses small moves of such bodies' faces with a wrong
  volume ("its volume would change by 35,083.5 mm³ instead of about
  -13,565.7 mm³"), and a loft's caps can be moved at all.
- A Combine Cut by a body that only touches a loft's cap says "Nothing to cut"
  instead of passing with the volume going up.
- Mass properties' Centroid, the Assistant's measure and the assembly check
  read the centroid of such bodies right again (a pipe tee's showed
  1.125, 0, 15.37 mm for 0, 0, 6.128 mm; an airfoil loft's was 318 mm off).
- After a Press-pull of a lofted or other B-spline part, its volume comes in
  a fifth of the time (a 206-face pin plate: 1.5 s, not 7.8 s), and a
  Press-pull on a part of a few hundred such faces is given the time it needs
  (a 606-face one took 95 s) instead of being stopped at 60 s.

**Delete faces never passes off a wrong body.**
- Delete faces and heal could fill more than the gap: on a part with a step,
  slot, pocket or channel and every edge rounded, deleting every fillet gave
  the full block (an L-block of 36,000 mm³ came back as its 48,000 mm³ box),
  and Delete faces showed it as done. Now each result is checked: no face you
  kept may go, and no material may be added on one. When the heal does that,
  Delete faces is red and says so: "healing filled more than the gap the
  deleted faces leave: it would add 16,395.4 mm³ over faces you kept (...);
  the body is unchanged". For the
  faces of one Fillet or Chamfer it adds that deleting that feature takes it
  off. Holes, bosses, pockets, slots, single fillets and chamfers, rounded
  boxes and plates, and a wedge's tip come out as before.
- A pattern of faces checks the same, and the Assistant's Delete faces gets
  the same words.
- When the check refuses, Delete faces tries again in two goes (all the faces
  but one next to the fill, then that one) and takes the result if it passes
  the same check: the rounded L-block, U-channel, pocket, slot and side step
  now come back as their sharp shapes (the L-block's 36,000 mm³). A part with
  a cavity on each side (a T-block) is still refused, in the words above.
- Rounds and chamfers that end on a face you keep come off again: a boss's
  corner rounds on its plate, a riser's corners on the step floor, a step
  edge's round against its wall, a notch edge between its walls. They were
  refused ("would add 20.6018 mm³ over faces you kept"): the sharp corner's
  end lies on that face.
- When the check itself cannot be trusted or run, the result is shown with
  "check the result" instead of refused or passed in silence: on some lofted
  bodies (the comparison returned the whole body), on parts over 2,000 faces,
  and after a delete so slow that comparing would take too long. Retrying in
  two goes stops after about 5 s.

**See-through bodies.**
- INSPECT > See-through draws the selected bodies see-through (a selected face
  counts for its body): what is inside and behind them shows, their edges stay,
  and a click goes through them to an opaque face behind. Run again while all of
  them are see-through and they are opaque again; a mix all turn see-through. It
  is in Settings > Keybinds (no key by default) and refuses, with the reason,
  when no body is selected.
- A body's menu (its Bodies row, or a right-click on it in the view) has
  **Make Body 1 see-through** and **Make Body 1 opaque**, next to Hide. The
  Bodies row shows a see-through mark of its own (a hidden body is dimmed; a body
  can be both).
- A section cuts a see-through body with a see-through cap: a body inside it
  keeps its own cap and shows through.
- It is a view, as hiding is: no undo step, never in the model or the
  simulation; the Part keeps it when it is opened again. Pictures (the Assistant's
  and the Picture panel's) draw see-through bodies see-through, as they leave
  out hidden ones; the picture after an Assistant's edit names them. A new body
  made from a see-through one (a split's other pieces, a copy) starts opaque, as
  it starts shown when its source is hidden.
- The Assistant's workspace see_through and opaque do the same (a body, or
  several); get_model's parts, the body tool and the view tool say which bodies
  are see-through.

**Section view on any plane, with an arrow to drag.**
- INSPECT > Section view (key X, in Settings > Keybinds) opens a panel with the
  view cut. The plane can be Top, Front or Right, a construction plane (the cut
  follows its own normal, so a plane at an angle cuts at that angle) or a flat
  face: click it in the view or the tree. The panel names the plane and says
  where the cut is and which side it keeps.
- Offset is a typed length (the Part's units, parameters and expressions as any
  length field), with Middle and Keep the other side, and Cut the view turns it
  off. An arrow on the cut, along the plane's normal, moves it when dragged, and
  Offset follows (Ctrl: whole millimetres).
- The cut follows its plane when an edit moves it (a construction plane turned
  by a parameter, a face that moves as its extrude grows). A deleted plane turns
  the section off with a note, and the next cut starts on Front. With the
  rollback bar above the plane the cut stays where it was, and the note says it
  is rolled back.
- The section is kept with the Part (no undo step) and comes back when it is
  opened again; opened with the bar above its plane, the Part keeps it and it
  comes back once the plane builds. The view tools' section button drives the
  same cut and names a construction plane or face it is on; its More opens the
  panel. The button and INSPECT > Section view turn the cut on where its plane
  is now.
- The Assistant's workspace section and view section take the same planes (a
  construction plane by name, a flat face, "selection", with offset or middle
  and flip); its answer and get_model name the plane (a face with its selector,
  which they take back) and say the panel's note. The Picture panel's Section
  takes a construction plane or the selected flat face too.

**Copy and paste sketch geometry.**
- In a sketch, select lines, arcs, circles, splines or points and press Ctrl+C
  (or right-click > Copy): the panel says what was copied. Ctrl+V (or
  right-click > Paste) picks the copy up: it follows the pointer, held by the
  middle of its box, and snaps to the sketch's points and curves (Ctrl stops
  that). A click (or Enter) places it as one undo step, and the copy is
  selected; Esc puts it down with nothing added.
- The copy is new geometry: construction stays construction, and the relations
  and dimensions between the copied pieces are made again on the copy, so the
  copy is as defined as the original. A dimension keeps its expression where it
  gives the same value in the sketch it is pasted into; where it would not (a
  parameter of another Part, or "2*15" pasted into a Part in inches, where it
  would mean 762 mm) it takes the value it had, and the panel says which.
  Relations and dimensions that also tie geometry you did not copy (to the
  origin, say) are left out, and the panel says how many.
- Paste works in any sketch: another sketch of the Part, on another plane (the
  same 2D shape in that sketch's own directions), or a sketch of another Part.
- In a text or number field (a dimension's value, say) Ctrl+C and Ctrl+V copy
  and paste the text, as always; with no sketch geometry selected, or with text
  selected (the panel's red note, to put in a report), Ctrl+C copies the text.
  Settings > Keybinds lists Copy and Paste under Sketch.
- The Assistant does the same with the sketch tool's copy row: from this sketch
  or another sketch of the Part, or what you copied (in any Part: it reads what
  is held, and pastes all of it), placed at a point or moved by an offset, and
  its answer says what was copied and what was left out.

**Import SVG/DXF into a sketch.**
- In a sketch, MODIFY > Import SVG/DXF picks an SVG or a DXF file (at most 20 MB).
  The Sketch panel says what it read: the lines, arcs, circles, ellipses,
  splines and points, what it left out and why (text, scripts, pictures, links
  to other files...), the size in mm and the ends that meet nothing. The curves
  show in the sketch first; OK adds them as one undo step, Cancel or Esc adds
  nothing.
- Its units set the scale (an SVG's width over its viewBox, else 96 px per
  inch; a DXF's $INSUNITS, or mm when it says none); change it in Scale. Place
  puts the drawing's own origin on the sketch's, or centres it there. A DXF's
  layers can be left out (one the file has off starts left out).
- Curves whose ends meet share one point, so a closed outline is a profile that
  Extrude takes (the panel says how close ends must be to meet; a stray curve
  far off does not change that). No relation is added: the sketch is
  under-defined, as imported geometry is.
- A drawing is only read, never shown as a page: nothing in it runs or loads
  anything. A binary DXF is refused (save it as ASCII DXF). A drawing too heavy
  for the sketch solver is refused, with what it weighs: every later change of
  the sketch solves all of it, so at most about 10,000 points, or 400 arcs, go
  into one sketch (leave layers out). A file made to stall the reading (deep
  nesting, numbers past any size, blocks that insert themselves, huge arrays,
  splines of thousands of points) is read or refused at once.
- The Assistant does the same with a drawing you attach in its panel: the sketch
  tool's import row, with the same summary you see. The app's Assistant panel
  now takes SVG and DXF files.

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
- Check (INSPECT) checks an assembly too, as the Assistant does, in the same
  words. Pick a mode at the top of the panel, then press Check:
  - **Interference**: the pairs of bodies that overlap and the volume they
    share (the selected bodies, or every shown body). Type a clearance to also
    list the pairs closer than it.
  - **Loose parts**: every axis that bodies share, with its parts in order,
    what each rides on, and what stops it on each side. It names each part
    that can slide along its shaft, which way and how far, and each bore with
    nothing in it. A part may have up to 0.5 mm of play (type another play).
  - **Rotation**: pick a body (or select several) and an axis (one its round
    faces lie on, X, Y, Z or a construction axis). It turns the body a full
    turn both ways and gives the first angle it meets each other body.
  Click a row to select its bodies (Ctrl adds them); hover it to light them. A
  long check shows its progress and has Stop. If the Part changes afterwards,
  the result says so. Solids is the check it always had: is each body a valid
  solid.
  - A D or hex shaft in a bore of its shape with clearance all round is loose
    on its shaft (play the clearance), no longer taken for a press fit.
  - A check stopped by its time limit says so in its line ("Stopped at the time
    limit ...") with what helps, and never "Nothing is loose" or "without
    meeting anything".
  - A press fit (a bore drawn a little under its shaft) is listed as a press
    fit in Interference, apart from the bodies that collide.
  - One selected body in Interference is checked against every other shown
    body. Loose parts with bodies selected checks only the shafts near them.
  - A frame plate's clearance hole (a pipe passing through) is no longer
    reported as "Nothing holds the plate"; a hand or crank with nothing in its
    bore is.
  - Rotation's columns say which way they turn: "Counter-clockwise about +Z"
    and "Clockwise".
  - Rods lying across a turning part's path, and thin collars among many
    other bodies, are no longer missed.
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
- Delete a body: right-click it in the tree (or select it and press Delete),
  "Delete Body 1". It goes from the tree and the view, and "Body-Delete 1" is
  added to the history (one undo step: Undo brings the body back). Several
  bodies selected are deleted by one feature. Edit the feature to change which
  bodies it deletes; delete or suppress it to bring them back. The Assistant
  deletes bodies the same way. While a panel is open, the bodies it shows
  picked (Combine's target, say) are the panel's: Delete leaves them alone, and
  a body's menu offers to delete only that body.
- Move/copy body (MODIFY, key M, or "Move/copy Body 1…" in a body's menu, just
  above Delete): move bodies by X, Y and Z, and turn them by an angle about X, Y
  or Z through a pivot (the centre of their box unless you type a point), or
  about an axis you pick (a construction axis, a straight or round edge, a round
  face, a sketch line). It turns first, then moves. "Body-Move 1" is added to
  the history (one undo step; edit, suppress or delete it like any feature). A
  moved body keeps its name and its faces, so a fillet, a sketch on a face or a
  Combine made after it still finds them. **Keep a copy** leaves the bodies
  where they are and moves copies of them instead ("Body 1 (Copy)", new bodies;
  the feature is "Body-Copy 1"). The Assistant moves and copies bodies the same
  way, and says where each one is now.
- Move/copy body has a handle in the view, as Fusion's Move: at the pivot, an
  arrow along X, Y and Z (red, green, blue, as the view's axes) and a ring about
  each (about a picked axis: one ring about it). Drag an arrow to move, a ring
  to turn: the panel's fields show the value as you drag, a label beside the
  handle says it, and the bodies are drawn there at once. Hold Ctrl for whole
  millimetres (0.1 in in an inch Part) and steps of 15°. Let go and the model is
  built there; Done keeps it as one undo step. Escape with the button still down
  puts the drag back. Typing a value moves the handle too. The camera never
  turns under the handle.
- What you made on a moved body goes with it when you change the move or put a
  Move/copy body in before it: a hole, a slot or a boss sketched on its face
  stays where it is on the body (it was left behind, with nothing said), and a
  fillet's edge or a sketch's face on a turned body no longer turns amber with
  "Reference repaired · check". A construction plane on its face goes along too.
- While you edit a Move/copy body, the features after it are rolled back (as
  when you edit a sketch), so the handle drags the bodies as they are just after
  it and letting go builds them where they were drawn.
- Taking a body out of the Move/copy body's Bodies field and clicking it again
  puts it back (it said "That body is a copy this feature makes").
- The Assistant turns bodies about the axes the panel offers (a plane's normal
  is refused, with what works), and "Nothing to move" asks it for a distance or
  an angle instead of a fixed expression.
- In Magnusim CAD, the desktop edition with no projects, a body has no "Leave
  out of the simulation" toggle or menu item and no "still in the simulation"
  words, and the Assistant offers no simulation choice: there is no simulation
  there. A choice made in Magnusim stays with the design.
- In Magnusim CAD nothing else speaks of projects or a simulation either: no
  CFD PREP group or Enclosure command (toolbar, keys, Settings → Keybinds), no
  "or the simulation" in the Banana's hint, no "From the project" row in an
  import's panel, and a missing stored file "is not with the Part any more". A
  Combine on an Enclosure's body leaves Keep the tool bodies as you set it, and
  the volume chip lists the biggest bodies first. An Enclosure made in Magnusim
  stays as it is there: its body is built, and its panel shows its shape,
  bodies and size read-only, with Done and Delete. The Assistant there has no
  send to the simulation, no enclosure and no words of either, and its
  instructions are shorter. In Magnusim all of these are as before.
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
  measure, check an assembly (parts that overlap, parts loose on their shafts,
  what a part hits when it turns), look at pictures of the Part, set parameters, sketch, extrude,
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
  it. R with Center rectangle (or another rectangle) in hand takes up the
  Rectangle, and R again puts it down; the same for each toolbar group's key.
  Escape still steps back one step at a time (it ends a line chain and keeps
  the Line tool). A key typed into a value box stays there. A key you gave one
  of a group's other tools (Centerline, say) takes that tool up even while
  another tool of its group is in hand, as its row in the group's list says.
- Clicking the toolbar button of the tool in hand puts it down too, exactly
  as its key does (also its row in a group's list or a More menu); a click on
  another tool still takes that one up.

**A Join of pieces that do not touch is a note, not a warning.** Joining tools
that do not touch the target (an inlay grouped from spots and rings, used later
by a Cut with Keep tools) keeps the pieces apart in one body, which is often
what you want. Its History row now has a quiet "i" mark instead of the amber
triangle, and its tooltip and panel say, for example, "Note: Inlay holds 8
separate pieces: they don't touch, so they stay apart in one body (fine for a
group like an inlay; to fuse pieces, they must overlap or share a face)". A Cut or Intersect
that leaves a body in more pieces than it had, and a Press-pull that splits a
body, still warn. The Assistant reads the same note.

**Hide a plane, an axis, a point or a sketch from its menu.** Right-click a
reference plane, axis or point, or a sketch, in the history: Hide <name>, and
Show <name> once it is hidden, as its eye in the tree does. Hiding only
changes what is drawn: a hidden plane is not drawn or clicked in the 3D view,
but it stays in the tree, can still be picked there and by name, and what is
built on it (a sketch on a hidden plane, say) builds as before. Its row shows
it is hidden as a hidden body's does: the eye closed, the name and icon
dimmed (a sketch a later feature uses is hidden by default, with its eye closed but its row not dimmed). Hiding is not an undo step, and the Part remembers it when it is
opened again. The Assistant hides and shows them the same way.

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
