# The Part's tools for the app's Assistant

Developer reference for `src/assistant/` (owner: ASSISTANT). The app's Assistant
(host API 1.9, unreleased: `ws.assistant`) calls tools a workspace page offers; the
Part offers 18, `cad__get_model` to `cad__view`, with one fixed guide. This file says
how the pieces fit, how to add a tool, and how to test one. What each tool takes and
answers is in its own description (`src/assistant/schemas.ts`), which is also what the
model reads.

## How a call goes

1. `src/features/assistant/index.tsx` is a module like every feature folder: its
   `install` is `installAssistant` (`install.ts`), its chip `AssistantChip.tsx`.
2. `installAssistant` makes the page's state (`runtime.ts`: the chip's store, the turns
   the host told of, the call keys, the revision, the hold points, the ledger),
   publishes `services.apis.assistant` (the camera gate other areas ask, and the store),
   listens to the host's turns (`turn-info.ts`), then registers **once** for the page's
   life: every tool of `schemas.ts` and `GUIDE` (`guide.ts`). After a `not_connected`
   answer it registers again when the tab shows; after `remote`, `no_assistant` or
   `not_allowed` never. A tool whose code is not in this build is still offered: the
   grammar and the prompt cache stay the same while tools are added.
3. Each call runs `createCallHandler` (`call.ts`): its key (`session-key.ts`:
   `turn:<id>`, `mcp:<session>`, or `ext:<n>` for an outside client's calls), its
   context (`CallCtx` in `src/types/assistant.ts`), the tool's code from
   `tools/index.ts`, and the reply.

## A reply

A tool returns `ToolReply` `{text, data, summary?, images?}`:

- `text` is one line (at most 200 characters), `summary` the turn log's line (160; the
  model never gets it);
- `data` is compact JSON in mm, mm², mm³ and degrees (`numbers.ts`: lengths to 1e-4,
  areas and volumes to 6 significant figures), every list at most 200 items, every
  container at most 6 deep inside `data` (the app turns depth 8 into null, and cuts
  every string at 2000 characters and newlines into spaces);
- `call.ts` adds `rev` to every `data`, and `user_changes` when the person changed the
  committed Part since the key's last call (`rev.ts`).

A refusal or failure is thrown as `ToolError(reason, message, {hint?, detail?})`
(`errors.ts`). The reason fixes the code (`invalid_input`, `failed`, `busy`,
`not_ready`) and the hint (`HINTS`, also in `help errors`); the message starts with
the reason; `detail.reason` names it. On a host without the turn events the hint goes
into the message. Anything else thrown is `internal`; an aborted call is `stopped`.

## Adding a tool

1. Write `src/assistant/tools/<name>.ts` exporting `tool: ToolImpl` (`kind: 'read'` or
   `'edit'`, `run(ctx)`).
2. Uncomment its line in `tools/index.ts` (each line has a comment line above it, so
   commits that add different tools merge cleanly).
3. A tool that makes a feature type registers its reader with
   `registerFeatureIo(type, {tool, inputsOf, values, pathOf})` (`features-io.ts`) from its own
   file, so `get_model detail full` shows those features in its fields and `edit_feature`
   takes its field names (`feature-tools.ts` has the shared pieces: see below).
4. Its schema is already in `schemas.ts`; change it only with the spec (the app's host
   test `scripts/__tests__/assistant-cad-tools.test.mjs` pins the strict budget).

## Reading the Part (`get_model`, `model.ts`)

Reads wait (at most 30 s, a sign of life every 5 s) for the Part to open and the kernel
to start (`busy.ts`), then for the rebuild to catch up (`doc.settled()`). Reply budgets
(`turn-info.ts`): brief 8 KB (3 KB on a local turn), older features collapsing above 80
(30); full 24 KB (12 KB); one sketch 16 KB (8 KB). A local turn whose model has less than
24,000 tokens of context answers `not_ready` `small_context`.

## An edit call (`step.ts`, `judge.ts`, `ledger.ts`, `busy.ts`, `pace.ts`)

An edit tool is `{kind: 'edit', run: (ctx) => runEdit(ctx, tool)}` with an `EditTool`
`{plan, apply, sealed?, reply}`. `runEdit` makes one call one Assistant step
(`doc.assistant`), all or nothing:

1. **The gate** (`busy.ts` `waitForEdit`): `not_ready` while the Part cannot take edits
   (`not_editable`; `opening_geometry` while Edit in CAD opens it), `busy`/`other_turn` for a
   call of a turn that is not the one running here, then the **wait for the person**: the
   rollback bar not at the end, a panel of theirs (an idle Parameters panel does not count), a
   typed value, a rename, a menu, a dialog, a toolbar drag, or the Assistant paused. While it
   holds, the chip is `waiting` with what it asks ("close the Fillet 2 panel"), and progress
   carries `waiting: true` (every 5 s), so the turn's minutes stop. It is checked again on
   every change of the stores behind those signals; after 10 minutes (`EDIT_WAIT_MS`, the
   test handle's `setHoldS` shortens it) the call answers `busy` `person_editing`,
   `rolled_back` or `paused`. A key or a held pointer in the frame is a soft wait (800 ms of
   quiet, at most 10 s). Reads never wait.
2. **Plan** against the settled Part: every refusal (`invalid_input` with the row at fault)
   before anything changes. The hold point `after-plan` follows; a person who opened something
   meanwhile is waited for again and the call plans anew (at most three times).
3. **Apply** inside the step, through the person's own paths (`openEditForAssistant`, the
   Part's one-shot edits inside `step.run`), with `ctx.checkpoint({hold, pace, label})` at each
   pace point: it throws on a stop, a take-over (`busy` `taken_over` with its `why`; the
   Assistant pauses in this Part until the turn ends), a change of the Part by someone else
   (`busy` `changed`) or a draft the call did not write. Hold points: `after-open`,
   `between-opens`, `before-commit`.
4. **Judge** (`judge.ts`) once the rebuild settled: a failed rebuild or a kernel stop is
   `kernel_failed`; the call's own feature failing is `feature_failed` with its own message and
   actions; a value edit (`set_params`, `edit_feature` with only `set`) that turns a working
   feature red is `broke_downstream`; those revert. A structural edit keeps what it broke
   (`broke`; `get_model` marks it `broken_by_you`). Warnings: the own feature's, a feature newly
   warning, a body with more solids.
5. **Seal** the step's undo steps into the key's group (`ledger.ts` `groupLabel`: "Assistant:
   <request>", or "Assistant (other app): <first part> +N"), and keep the call in the key's
   ledger (its mark, the model after) for the `undo` tool and `get_model`'s
   `undo.your_steps`. Anything that fails reverts the step to its mark exactly; a revert the
   person's own change refuses answers with `detail.kept`. A Stop, a stall or Back (the call's
   signal) reverts synchronously in the abort handler.

The answer's `data` is `EditData` (`report()`: the feature, what was resolved, the bodies
created, changed and removed, warnings, broke, fixed) plus the tool's own fields.

**Pace** (`pace.ts`): `watch` (the default, the person's choice in `ws.prefs`
`assistant.pace`) waits at each pace point (a panel open 450 ms, a parameter row 150 ms, before
the commit 250 ms, ...), at most 6 s per call; never while the window is hidden, after a
rebuild over 1.5 s, or at `fast`. Tests force the pace without writing the preference
(`setPace(pace, scale)` on the test handle; the vitest harness runs `fast`).

**The pause** (`busy.ts` `createPause`): set by a take-over, by the person's undo or redo of
the Assistant's steps while its turn runs, or by the chip's Pause; it ends with its turn (the
host's turn events) or, without them, at the next key. The chip shows `paused` ("you took
over", "you undid its steps").

## Deleting (`delete`, `tools/delete.ts`)

`delete` is the one destructive tool: the app asks the person before the call reaches the
page ("Allow the Assistant to delete features?", with its confirm note "Deletes features from
the Part; Ctrl+Z brings them back." in place of "can't be undone"), so a declined call never
runs here. The plan resolves every name (any case, or its id; a name given twice or not in the
Part is refused, every problem at once), then finds every feature outside the list that uses
one in it: its parents, or the makers of the bodies it names (`dependencies` in
`doc/features/hooks.ts`, the Part's own rule; `removeBlock` names only the first). Any user
refuses the call with nothing changed: `in_use`, the message naming every user and the body it
uses it through, `detail.users` one row per `{feature, uses, via}`. The apply checks the Part
again as it is then (the person may have changed it while the call planned: `in_use`, or
`changed` for a listed feature already gone), then runs the Part's own `remove` for each, newest
first, inside the step, so the list's own users go before what they use; the hold point
`before-commit` follows. A delete is structural: features that fail afterwards are kept and
listed in `broke`. The deleted features leave the person's selection, as the person's own
Delete does, and the step's selection restore never brings back a feature or body that is gone.
The answer's `data` adds `deleted` (the names, in history order).

## Selectors (`selectors/`, `labels.ts`, `find`)

One string names faces, edges, vertices, bodies, planes, axes or sketch regions
(`help selectors` lists every form; `selectors/parse.ts` has the grammar). The pieces:

- `labels.ts`: a face's label from its stored name (`Base.end`, `Base.side(r.top)`,
  `Pipe.side(o@a2)`, `Fillet 1.fillet(2)`, `Row.copy(3)`, ...). Faces that share one get
  `~1`, `~2` in a fixed order (`LabelIndex`); a split face's label warns. The parser reads
  back every label it writes (tests pin the round trip on real bodies).
- `selectors/parse.ts`: pure; the Part's names come in as data, the longest known name
  wins, quotes are allowed, and a body and a feature of one name are read by the grammar.
  Errors carry the 1-based column (`bad_selector`, `detail.column`).
- `selectors/resolve.ts`: `withScene(ctx, {before?, sketch?, self?}, fn)` reads the shown
  bodies once the rebuild caught up (a new feature), or `doc.bodiesBefore(feature)` (an
  edit), and runs `fn` again once when the Part rebuilt or the kernel restarted meanwhile
  (`busy`/`changed` the second time). Inside: `selectOne(sc, text, want, field)` for a
  single-entity field (none: `nothing_selected`; several: `selector_ambiguous` with at most
  8 candidates, each with a handle), `selectSet` for a set field, `selectAny` for find, and
  `echo(sc, selected)` for an edit's `resolved` line (`... live set` / `fixed set` for
  `edges of`).
- `selectors/refs.ts`: what a feature keeps, by the person's own rules (`pickFace`,
  `refOfEdge`/`refOfVertex`, the CONSTRUCT kinds of `GeomRef`, `refOfRegion`): a face the
  feature made itself is `self_reference`, one made after it `later_feature`, an unnamed
  body's `not_named`.
- `selectors/handles.ts`: `#f3`, `#e7`, `#v2`, `#b1`, per key (cleared when the key
  changes, at most 2000); each keeps the stored reference and is resolved again on use
  (`moved: check` when it moved, `selector_stale` when it is gone). find, view and the
  selectors share the key's one table, and the body tool takes a `#b` handle.
- `selectors/topo-cache.ts`: one `topo` call per shape (the 32 newest kept, chunks with
  progress above 2000 faces, dropped on a kernel restart); it is also a `NamingLookup`.
- `selectors/geometry.ts`: a point on a face, hole or boss for round faces, a flat face's
  frame in words.

`find` (`tools/find.ts`) lists the matches as `FindRow`s and lights them in the person's
view for 1.5 s at the watch pace (the shown bodies only; never at the fast pace or while the
window is hidden).

## Sketches (`sketch/`, the `sketch` tool, `edit_feature` on dimensions)

One `sketch` call is one Assistant step. Everything is checked and solved before the step
opens, so a refused call changes nothing and no panel opens:

- `sketch/support.ts`: `on` through the plane selector (bodies before the sketch for an
  edit): an origin plane, a construction plane, one flat face (its stored reference by the
  person's pick rules), or `<plane or face> offset <length> [flip]`, which makes a
  CONSTRUCT plane `<sketch> plane` in the same step, reuses an identical built one, or moves
  the edited sketch's own plane while nothing else uses it.
- `sketch/macros.ts`: each entity kind as points, lines, circles and arcs whose stored ids
  are `<id>__<part>` (the model writes `<id>.<part>`: `r.top`, `p.2`, `p.p2`), with the
  relations that keep its shape (`r__h_top`, ...). `KIND_DOF` is pinned on the real solver.
- `sketch/compile.ts`: ids, every `at` problem at once (`bad_entity`), joins (ends within
  0.05 mm are one point, the first entity's; near misses up to 0.5 mm warn; points the
  edited sketch keeps apart stay apart), `infer` (`<line>__h` / `__v`, inferred), refs
  checked against `sketch/signatures.ts` (the solver's own forms, pinned by
  `signatures.test.ts`), values stored with units, at most 180 constraints (200 with the
  inferred). A kept entity of an edited sketch keeps its stored points.
- `sketch/solve.ts`: the solver apart from sketch mode (`analyzeFeature`): `expr_error`,
  then the inferred relations that repeat yours go (newest touching first; the unneeded come
  back), `sketch_conflict` naming each constraint and its partner (a macro's own as
  `internal`), `sketch_unsolved`, `sketch_collapsed`, and the answer's `moved` and `free`.
- `sketch/write.ts`: inside the step, through the person's paths: the offset plane's panel,
  then `SketchMode.startSketch(support, {step})` (or the Edit panel), one `apply` of the
  solution, the rebuild, `finish({step})`. Hold points `after-open`, `between-opens` (after
  the plane), `sketch-step:1` (after the apply), `before-commit`. This is the fast path; the
  watch path (drawing entity by entity) comes with watch mode.
- `sketch/describe.ts`: a stored sketch in the tool's input form (`get_model feature`,
  registered as the sketch type's `FeatureIo`): intact macros as macros, the rest as
  primitives by their stored ids, `infer` for the tool's own inferred relations; `inputs:
  null` with `unsupported` (projected edges, splines, patterns, fixed points, driven
  dimensions, trimmed pieces) or `too_big` (150 entities, 200 constraints, or the reply's
  room). Resent as it is, the sketch comes back the same. `refOf` names stored ids as the
  model does (`free`, `open`, `bounded_by`, conflicts).
- `sketch/dims.ts`: `edit_feature` set rows naming a sketch's dimension ids: checked headless,
  then one sketch-mode `apply` of the new values (the stored geometry solved again), a value
  edit for the judge.
- `sketch/flip.ts`: `flipped` in `set_params` and `edit_feature` answers: a sketch whose
  output changed and whose region loops turned over, or whose two-point dimensions turned
  round.

## Measuring (`measure`, `measure.ts`, `measure-targets.ts`)

A read like `get_model`: it waits for the Part to open and the rebuild to catch up, then
measures the bodies built now (the rollback bar's, said in `note` when it is not at the
end). `measure.ts` gives the raw numbers, which the tool rounds and the eval's facts can
read as they are:

- one body: `DocService.measure` (volume, area, centre of mass, bounding box, solids,
  shells); `voids` is shells minus solids for closed solids, null for a surface body;
- one face, edge or vertex: kernel `measure {a}` (plus `topo` for a curved face's axis
  point), a point on a face by the selectors' rule (`selectors/geometry.ts` `pointOnFace`,
  the same `point_mm` find gives), a round edge's circumference or arc angle;
- two targets: kernel `measure {a, b}`; two bodies also `boolean common` then `props`
  (the overlap; empty is 0) and `boolean fuse` then `props` (the union's solids and
  voids), each made shape released;
- one body with `section`: kernel `section`, its loops as sketch curves, `sketch_regions`;
  the material is the regions at even depth.

When the model, the rebuild or the kernel's worker changes while it measures, it measures
again once; a second change is `busy`/`changed`.

Targets (`measure-targets.ts`): a body's name or id (a name is the body's first), `(x, y,
z)`, `selection` (one selected thing), Top/Front/Right (XY/XZ/YZ) with `offset <length>`
and `flip`, X/Y/Z axis, origin, and construction planes, axes and points by name. Every
other selector (faces, edges and vertices, handles from find or view, the selectors' planes
and axes) goes to `measure-selectors.ts`, which the measure tool registers with
`registerSelectorResolver`: find's selectors on the bodies built now, one thing per target
(several are `selector_ambiguous` with handles), a selector's warning as `warning`. A text
that is neither a body nor a selector answers `bad_selector` with the selector's column and
the forms that work. The section takes the same planes, `selection` with a flat face, and a
flat face by selector (`Base.end offset -5 mm`).

## Pictures (`view`, `view.ts`)

`view` draws the Part off screen through `ViewportHandle.snapshot`: each picture has its
own orthographic camera, so the person's camera, saved view, section view and count of
camera moves never change, and nothing is written. One view fills the picture; 2 to 4
make a 2 x 2 sheet with each tile's name. The long side is 768 px (`small`) or 1280 px
(`large`; a local turn always gets small). The page encodes a PNG on an
`OffscreenCanvas`, or a JPEG (quality 0.85) when the PNG is over 1.4 MB.

- `hide` takes body names (any case) or ids; `section` is `""` or
  `<Top|Front|Right> [offset <length>] [flip]` (parameters allowed), and the data says
  what the cut keeps ("z <= 4 mm").
- `labels: 'bodies'` writes each shown body's name at its box's centre; `'faces'` puts a
  `#fN` handle on the 30 largest faces the picture shows, where the picture really sees
  that face (`visibleFaceAt`), at the middle of what shows, else in a roomy triangle.
  Each handle keeps the face's stored reference (`pickFace`), never an index, with its
  label, in the key's one table (`selectors/handles.ts`): find and every selector read a
  picture's `#f3`, and find numbers on after it.
- The data lists the views and their mm per px, the shown and hidden bodies (and those
  hidden in the tree), the cut, the labels, the shown sketches' dimension values
  (pictures carry no HTML overlays), `software_renderer`, and a `note` when the person's
  sketch or the rollback bar rolls later features back, or the window is hidden.
- A turn whose model reads no images (the host's turn says `images: false`) answers
  `not_ready` `no_images` and draws nothing; no 3D view, a view without `snapshot` or a
  lost graphics context answers `not_ready` `no_viewport`.
- Tests draw on a recording canvas (`setViewRaster`), since jsdom has none.

## Fillets, chamfers, shells, patterns and combine (`modify`, `pattern`, `combine`)

Each makes one feature, or with `edit: "<name>"` replaces that feature's inputs (its type must
be the tool's kind: `wrong_feature_type` otherwise), as one edit call. What they share is in
`feature-tools.ts`:

- `editTarget` and `nameFor`: the `edit` and `name` fields (`not_found`, `wrong_feature_type`,
  `name_taken`); a new name is passed to the panel only after the check.
- `fillFeature(ctx, plan, {edit, type, fields, label})`: the person's own panel opens read-only
  through `openForAssistant` with every field at once (a new feature), or `openEditForAssistant`
  and one `session.update` with every top-level field whole (an edit); a `macrotask()`, the
  `after-open` checkpoint (pace `open`), the rebuild, the `before-commit` checkpoint (pace
  `commit`), then the honest Done. The feature failing before its Done is `feature_failed` with
  CAD's own message and actions (`kernel_failed` when the kernel stopped it). It sets the plan's
  own feature, which the judge reads.
- `createdLabels`: the labels of the faces the feature made (`EditData.created`:
  `Fillet 1.fillet(2)`, `Shell 1.inner(Base.side(l1))`, `Row.copy(3)`).
- `faceText`, `edgeText`, `axisText`, `planeText`, `bodyText`: a stored reference as the
  selector `get_model full` writes in a feature's `inputs` (a label; `<body> face at (x, y, z)`
  for a face with none, or a split face), so the inputs can be sent back with `edit`.
- `pathIn`: a `FeatureIo.pathOf` that takes the tool's field names (`size`, `count`,
  `spacing`, ...) and the feature's own expression paths (`radius`) for `edit_feature`.

The tools:

- `modify` (`tools/modify.ts`): fillet and chamfer targets are faces or edges on one body. A
  face, and `edges of <face>` with no filter, is kept as a face (a live set: every edge of it
  as the part changes), an edge as an edge (a fixed set); the answer says which (`kept_as`)
  and how many edges were rounded (`edges`, with the kernel's tangent chains). A shell's
  targets are the faces it opens; `inward` true keeps the outer size. A size the kernel cannot
  make answers CAD's own message ("a radius of 20 mm is too large for ...: 2.9 mm or less
  works").
- `pattern` (`tools/pattern.ts`): linear (`dir1`, and `dir2` with about2, always by spacing),
  circular (`360 deg` is a full turn: evenly), mirror. Items are feature names (refused with
  the pattern panel's own words when they cannot be repeated), body selectors, or face
  selectors on one body. A mirror about `<plane> offset <length>` makes the construction plane
  first in the same step (two panels, the `between-opens` checkpoint between them; an edit
  moves the plane above the mirror), or uses one the Part has with the same base, offset and
  flip. Spacing is a pitch above 0 (the hint says flip).
- `combine` (`tools/combine.ts`): targets and tools are body selectors (`bodies of <pattern>`,
  `all bodies`, `#b` handles); they are expanded and deduplicated, and the targets are taken
  out of the tools, which must not then be empty. A join of pieces that do not touch warns
  (the body's solids went up, and CAD's own warning).

Tests: `modify.test.ts`, `pattern-combine.test.ts` (real kernel: volumes by formula, round
trips of `get_model full` inputs, refusals), `feature-tools.test.ts` (a Stop at
`before-commit`, Escape at `after-open`, a person's panel or change at `between-opens` of the
offset mirror); e2e `cad:assistant-honest-fillet`.

## The person's view

The chip (`[data-chip="assistant"][data-assistant-state]`) and the frame's
`.cad-app[data-assistant]` follow `state.ts`: `off`, `idle`, `thinking` (a turn runs, no
call), `working` (a call runs: the tool's title), `ended` (for 120 s, or until the Part
changes). Without the host's turn events the chip stays 10 s after the last call.

## Tests

- Vitest: `tests/assistant/` over `harness.ts` (a real DocService on the real kernel,
  every module's feature types, the real solver, the UI controller and the fake host's
  `ws.assistant`, `tests/fakes/assistant-sdk.ts`). Real-kernel tests give each test an
  explicit timeout. `parts.ts` makes sketches with the ids a test names faces by,
  extrudes of their regions, a fillet of an edge and a sketch on a face.
- Hold points (`testing.ts`): a test holds a point (`after-settled` for reads; `after-plan`,
  `after-open`, `between-opens`, `sketch-step:<n>` and `before-commit` for edits), the call
  stops there until the test releases it. No sleeps.
- `assistantHarness({sketchMode: true})` runs the real sketch mode too (the sketch tool and
  edit_feature on dimensions draw through it). The sketch tool's files: `signatures`,
  `sketch-compile`, `sketch-solve`, `sketch-tool`, `regions` (`sketch-tools.ts` has the
  input builders and a block made from the tool's rectangle).
- `window.__CAD__.assistant`: the tools, the chip's state, the calls answered (`calls`,
  with each error's reason), the turns, the hold points, `setHoldS(s)` (the edits' wait for the
  person), `setPace(pace, scale)`, `paused()`, and `setToolset('core')` for the eval's A/B
  runs.
- The edit tools' vitest files: `step`, `judge`, `busy`, `pace`, `ledger`, `tools-edit`
  (`parts.ts` makes the plate and its fillet as the person would).
- E2E shard `assistant` (`npm run test:e2e:assistant`): each spec runs its own app
  server with the Assistant's test switches and the app's scripted model
  (`e2e/assistant-helpers.ts`); the app's turn helpers are vendor-neutral and take this
  suite's `expect` (`setExpect`). Ports: `CAD_E2E_PORT_FROM` + 60, 70, 80, 90, 100.
