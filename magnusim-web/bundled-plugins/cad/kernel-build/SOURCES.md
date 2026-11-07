# Kernel: sources, build and pins

`workspace/kernel/mk32.wasm` + `mk32.mjs` are Open CASCADE Technology 7.9.3
compiled to WebAssembly with a small C++ facade (`facade/`). JavaScript calls
the facade through a plain C ABI (`mk_call(json)`, `mk_alloc`, `mk_free`):
no embind, so nothing needs `eval` or `new Function` under the workspace
frame's Content-Security-Policy. The build also compiles a pinned part of
Analysis Situs' asiAlgo (`asi/`, below) into `libasi.a` and links it: since
kernel API 8 (shipped 2026-11-02) the facade's Analysis Situs ops
(`facade/asi_ops.cpp`: `recognize`, `suppress_blends`, `debug_reshape`) call
it, so `mk32.wasm` holds the asiAlgo code they reach (`LICENSES/README.md`).
Kernel API 9 (2026-11-02) adds defeature's time budget (below, with OCCT patch
0002), recognize's two face limits and the budget's words. Kernel API 10
(2026-11-06) has boolean and combine say when OCCT answered as if the inputs
were apart (`as_if_apart`, below).

## Pins

| What | Version | Where |
|---|---|---|
| OCCT | tag `V7_9_3`, commit `a016080bf6738d6aeae020badee4e888ad1540a5` | github.com/Open-Cascade-SAS/OCCT |
| Emscripten | emsdk `6.0.10`: emcc 6.0.10 (`d6c521a7f05449857c76bd99e396895583cf2083`), upstream release `666337b525e673e769121856d175f6f52b8ead64`, emsdk checkout `e566f7bdcc7735f44037911c24b87a58a3c93145` | github.com/emscripten-core/emsdk |
| Analysis Situs | tag `v2026.1.1`, commit `3c3ec3ff077ef71eaee39dc062e01aada475808f` (2026-05-26): 169 of its files, vendored in `asi/upstream/` | gitlab.com/ssv/AnalysisSitus |
| CMake / Ninja | any recent (3.28 / 1.11 used) | build host |

`env.sh` holds the pins; `use_emsdk` refuses any emcc other than 6.0.10 at
`d6c521a7`.

## Our changes to OCCT

- `occt-patches/0001-allocate-optimal-throws.patch`: `Standard::AllocateOptimal`
  returned an unchecked `malloc()`; in WebAssembly address 0 is valid memory, so
  an out-of-memory mesh run corrupted static data. It now throws
  `Standard_OutOfMemory`, as `Standard::Allocate` does.
- `occt-patches/0002-defeature-trim-progress.patch` (2026-11-02):
  `BOPAlgo_RemoveFeatures` (`BRepAlgoAPI_Defeaturing`, Delete faces' heal)
  trimmed each grown face with a `BOPAlgo_Builder` that got no progress range,
  so a progress indicator was not asked whether to stop while it ran (8-11 s
  for one grown face on the rounded T-block below). The trim now gets the
  loop's range. It only adds progress polls: without an indicator, or with one
  that never breaks, the results are the same (the 127-case defeature corpus:
  the same BREP bytes, history, validity and volume; see "defeature's time
  budget").
- OCCT is built with `-UOCC_CONVERT_SIGNALS` (no setjmp-based signal handling:
  wasm SjLj inside try/catch miscompiles).
- `build-occt.sh` checks that the OCCT source is exactly the pinned commit plus
  these patches before it builds.

`facade/facade.cpp` and `facade/mkjson.hpp` are the facade (GPL-3.0-or-later).
What it does and its rules: `ARCHITECTURE.md` §5 and the typed contract in
`src/types/kernel-protocol.ts`.

## Analysis Situs (`asi/`)

Analysis Situs' asiAlgo recognises fillets (blends) and drilled holes, and can
take fillets off (`SuppressBlendsInc`). The kernel build compiles the part of
it those need.

- `asi/upstream/`: Analysis Situs' `LICENSE` and 169 of its source files,
  exactly as published at the pin (43 `.cpp` and 126 headers, 1,900,705
  bytes): the 43 files in `asi/sources.txt` (link order) and every Analysis
  Situs header their compile includes. `asi/FILES.sha256` lists the sha256 of
  all 170. `build-asi.sh` refuses to build when a file differs, a CRLF checkout
  included, or when a file is there that it does not list. The root
  `.gitattributes` keeps `asi/upstream/` byte for byte and the rest of
  `kernel-build/` LF.
- Never vendored: `src/asiAlgo/mesh/occt62/` (J. R. Shewchuk's Triangle, not
  free for commercial use) and the rest of that repository. `asi/vendor.sh`
  takes the files again with `git show <commit>:<path>` from a blob-less clone,
  so nothing else is even fetched; its header records how the committed files
  were taken (from the sparse checkout of the 2026-10-29 build proof, which
  left out `mesh/occt62/` and `data/`).
- `asi/closure.sh` checks that the vendored files are exactly what
  `sources.txt` compiles and includes, and their licences: 167 BSD-3-Clause
  (copyright Sergey Slyadnev, OPEN CASCADE SAS, Quaoar Studio LLC, Julia
  Slyadneva) and `asiAlgo_UnifySameDomain.{h,cpp}`, derived from OCCT, under
  OCCT's LGPL-2.1 with the Open CASCADE exception. With `--src <a full
  checkout>/src` it prints the new list for `vendor.sh --list` after
  `sources.txt` changes; regenerate it, and check the licences, whenever
  `sources.txt` or the facade's calls into Analysis Situs change. Licence texts
  and holders: `LICENSES/AnalysisSitus-BSD-3-Clause.txt`.

Our changes, all outside `asi/upstream/`:

- `asi/asi-occt79-wasm.patch` (14 files, +88/−25 lines, no algorithm
  changed). Analysis Situs targets OCCT 7.6, and OCCT 7.8 changed the hasher
  protocol of its NCollection maps: the old-style hashers get the new call
  operators. `ASI_NO_VIS_IO` compiles out the windowing, offscreen rendering
  and STL reading and writing in `asiAlgo_Utils.cpp`. `ASI_NO_EIGEN` compiles
  out its one use of Eigen (`InterpolatePoints`, which nothing compiled here
  calls), so the kernel build needs no Eigen. The hunks are under the licence
  of the files they change (BSD-3-Clause).
- One hunk is for speed only (2026-11-02):
  `asiAlgo_CheckDihedralAngle::AngleBetweenFaces` reads the cached edge maps
  of the two faces in place instead of copying both for every adjacent pair.
  The copies made building the adjacency graph quadratic in the edges of a
  face: finding the fillets (`holes: false`) of a 5,002-face prism took 2.5 s,
  now 0.74 s; a 4,983-face gear with every tooth corner rounded 2.4 s, now
  1.0 s (Node). Every `recognize` and `suppress_blends` answer on the
  2026-11-02 gate corpus (254 bodies: the code-built parts and their BREP,
  STEP, B-spline, split and tolerance variants, the 11 NIST parts, combs and
  a plate) is the same as before the hunk. The references are taken after
  both faces' maps are in the cache, so they do not rest on the map keeping
  its items in place (OCCT 7.9.3's `NCollection_IndexedDataMap` does: a
  resize relinks its nodes and never moves them).
- `asi/asi_occt79_compat.h` (GPL-3.0-or-later): OCCT's removed global
  `HashCode` / `IsEqual` helpers and the `ASI_OCCT78_HASHER` macro the patch
  uses. It is force-included into the Analysis Situs files only, never into
  the facade.
- Built with `-DASI_NO_VIS_IO -DASI_NO_EIGEN`, and `USE_TBB`, `USE_MOBIUS`,
  `USE_VTK` and `USE_RAPIDJSON` undefined (single-threaded; no Mobius, VTK or
  RapidJSON): the vendored set is complete only under these.
- wasm32 only: `build.sh --variant wasm64` links without it, and builds the
  facade with `-DMK_NO_ASI` (its Analysis Situs ops answer that the build has
  none).

## recognize's face limits (API 9, measured 2026-11-02)

A running wasm call cannot be stopped, so `recognize` refuses a body too big to
search in time before it starts, with two limits since API 9: 5,000 faces for a
query that finds fillets (`max_fillet_faces`) and 2,600 for one that finds
holes (`max_hole_faces`); a query that asks for both meets the smaller. The
words name both, the one the query ran into first: "this body has 5,400 faces:
fillets are found on bodies of up to 5,000 faces and holes on bodies of up to
2,600", "this body has 3,000 faces: holes are found on bodies of up to 2,600
faces and fillets on bodies of up to 5,000". A call's `max_faces` sets both (API
8's one limit, 2,000 by default then) and keeps API 8's words: "this body has
2,412 faces: fillets and holes are found on bodies of up to 2,000".

- The rule (gate G4): the slowest measured body at the limit takes at most 3 s
  in Node and 4.5 s in the app's browser worker (a module worker, Chromium 152).
  Measured with the adjacency graph's speed hunk on real parts (the NIST parts
  patterned side by side or fused onto a plate to 2,600 and 5,000 faces, pin-fin
  and plate-fin heat sinks, gears with rounded teeth, brackets and plates with
  rounded holes; none binds) and round 1's families.
- Fillets bind on bodies whose two faces carry every edge: a comb rounded on its
  lateral edges takes 1.00 s at 5,010 faces (0.87 s in the browser), a 620-tooth
  gear 0.98 s at 4,983 faces, a 5,002-sided prism 0.74 s; the comb takes 2.84 s
  at 8,890. 5,000 leaves about 3x.
- Holes bind on a plain plate with one face per hole (the drill-hole search is
  quadratic, the speed hunk does not change it): 2.52 s at 2,606 faces (2.49 s
  in the browser), 2.94 s at 2,806, 3.23 s at 2,906. Real parts with holes near
  2,600 faces take 0.53-0.73 s. 2,600 leaves about 16 %; the hole path slows
  when the machine is busy (3.0-3.45 s at 2,606 faces with three other
  single-thread jobs).

## suppress_blends' budget (measured 2026-11-02)

`asiAlgo_SuppressBlendsInc` builds a new adjacency graph and recognises the
fillets again after every chain it takes off, so its time grows faster than the
number of chains, and a running wasm call cannot be stopped: one past the
watchdog kills the worker and rebuilds the whole Part. `suppress_blends`
therefore predicts the run from counts it has before it starts (after its own
recognition at R) and refuses in words over a budget: "taking 404 fillet faces
off as fillets on a body of 810 faces would take about 20 s; Delete faces allows
1.4 s for taking fillets off as fillets" (API 9; before it, "would take too long
here (about 30 s)"). Below 10 s the time has one decimal, and a refused
prediction never reads at or under the allowance: 1.42 s reads "about 1.5 s",
not "about 1.4 s; ... allows 1.4 s" (`aboutTime` in `asi_ops.cpp`; the test op
`debug_budget_words` gives the words for any prediction). From 10 s it is to
5 s ("about 30 s"), from 92.5 s in minutes.

- Model (`asi_ops.cpp`, `costCounts` and `predictSuppressMs`; ms in Node):
  `7.6630e-6 x chains x W + 2.6603e-2 x chains x faces + 2.4951e-3 x picks x
  faces + 14.835 x free-form chains + 1.3371 x free-form picks`, with chains =
  the pick's chains at R, W = (w0 + w1 + sqrt(w0 w1)) / 3 for the graph's pair
  work w0 before and w1 after the picks are gone (per adjacent face pair e1 e2 +
  e1 + e2, e = the face's edges: asiAlgo_CheckDihedralAngle compares both faces'
  edges in a double loop), and free-form = a face other than a plane, cylinder,
  cone, sphere or torus (in a chain or next to it). The result reports the
  counts and the prediction as `cost`.
- Refitted 2026-11-02 on the kernel with the adjacency-graph speed hunk (the
  first fit, on the kernel before it, had 1.7893e-5, 2.7171e-2, 2.4577e-3, 13.92
  and 1.2587: the hunk cut the pair-work term to 0.43x and moved the others
  under 10 %). Least squares on the relative error over the 140 of 175 rows
  that took 20 ms or more, measured with a kernel built
  `-DMK_TEST_NO_SUPPRESS_BUDGET -DMK_TEST_COST_IN_WORDS` on a quiet machine
  (the scratch probe builds each body with kernel ops; the times are
  SuppressBlendsInc's own): combs of 5-100
  teeth rounded R0.4 on their lateral edges (24-404 one-face chains; 0.06-25 s)
  or on every edge (one chain of 120-1,220 faces; 0.07-5.1 s); plates with
  100-5,000 holes with 4 corner chains or one outer chain (0.02-6.8 s);
  3x3-11x11 pegs rounded on their vertical edges (36-484 chains) and 2x2-6x6
  pegs on every edge; B-spline copies of the Step 0 family and of the combs; the
  Step 0 family and part A; 10 NIST MBE PMI parts at 5 radii each (every one
  refused after the run); and parts built like real ones: pin-fin heat sinks of
  2x2-10x10 pins rounded R0.4 with R0.3 roots, plate-fin heat sinks of 5-20
  fins, a perforated plate with rounded hole rims, gears of 24 and 60 teeth
  with rounded tooth corners, an L bracket with rounded holes, and the rounded
  L-block with a 1,000-5,000-sided prism on it (1,039-5,039 faces). Above
  100 ms the model reads 0.7-1.5x the measured time on most of them (gears
  0.6-0.7x); it reads low on the rings of fillets round the pins of a pin-fin
  heat sink when only those come off (2.3-2.9x), on rounded hole rims (1.3-2.4x,
  refused after the run: rings) and on two NIST parts (CTC-02, CTC-05: up to
  3.6x).
- Budget 1,400 ms (`kSuppressBudgetMs`): the slowest accepted measured runs then
  took 3.0 s and 2.1 s (3.1 s and 2.2 s for the whole op; the root fillets of
  5x6 and 5x5 pin-fin heat sinks, read 2.7-2.8x low) and 2.0 s (2.2 s; CTC-02 at
  R10), every other accepted run under 1.6 s, and the refused ones measured
  1.4 s to 37 s. A run predicted just under the budget on a pin-fin's roots
  would take about 3.9 s. On large bodies the whole op takes longer than the run
  it predicts, mostly the result's validity check after it: the rounded L-block
  with a 3,000-sided prism (3,039 faces) runs 1.1 s in a 3.0 s op, and a plate
  with 1,900 holes and its 4 corners rounded 1.0 s in a 5.7 s op (1.5 s with
  `check: false`).
  A 1.5-2x slower laptop stays far under `OP_TIMEOUTS.suppress_blends` (60 s,
  `src/kernel/timeouts.ts`). A refusal costs the two recognitions before it.
  `budget_ms` in a call may only lower the budget.
- Without the budget (`-DMK_TEST_NO_SUPPRESS_BUDGET`), `kernel-api8-suppress`'s
  budget test fails: the 810-face comb runs 25 s and returns a body.

## defeature's time budget (API 9, 2026-11-02)

Why OCCT's heal never ended on the rounded T-block (a 60 x 40 x 10 bar on a
20 x 40 x 10 stem; Fillet 1 R2 on the 16 edges not along its length, Fillet 2
R1 on the 8 along it; Delete faces' "Fillets up to 1 mm" adds the 8 R1
rounds): `BRepAlgoAPI_Defeaturing` (`BOPAlgo_RemoveFeatures`) first grows every
face next to a removed round (`FillGap::ExtendAdjacentFaces`,
`BRepLib::ExtendFace`) by one length, the diagonal of the round's box (36 mm),
then trims the grown faces back. Each R1 round ends on two corner pieces of the
R2 fillets, B-spline patches about 2 mm across (a 3.5 mm box diagonal) of
degree 7 x 8 in one span.
Grown 36 mm, such a patch is extrapolated about 22 times past its own range
(8 x 9 poles become 20 x 23): a huge, wildly curved surface. Every
intersection against it crawls (edge-face intersections run thousands of
particle-swarm searches per edge, one p-curve projection takes 13 s), so the
heal returns after 568 s natively and fails anyway ("unable to remove the
feature", the body unchanged); in the app the 20 s watchdog stopped the
worker. Even a fast heal could not give the right body: the corner pieces
must go, and the heal only grows faces. The other build order (R1 first) runs
316 s. Every round whose ends carry another fillet's corner pieces behaves so
(T, L, U, plus and plain blocks measured).

- `budget_ms`: a progress indicator whose `UserBreak` trips after that long;
  the heal stops at OCCT's next poll and `defeature` answers `stopped:
  {budget_ms, after_ms, far_grown}` with no shape (the body is unchanged,
  nothing is stored). OCCT 7.9.3 polled only between its steps: patch 0002
  adds polls while each grown face is trimmed. The R1-first T-block with
  `budget_ms: 2000` stops at 2.01 s (8.8 s without 0002); one step it still
  does not poll (that 13 s projection on the app's order) remains.
- `far_budget_ms`, `far_skip`: the kept faces next to the pick that the heal
  would grow more than 4 times their own box diagonal, that are not planes,
  cylinders, cones, spheres or tori (those grow exactly), and that the growth
  turns more than half a turn (the growth times the face's largest curvature,
  sampled on a 6 x 6 grid inside it, over pi): a flat B-spline grows as a
  plane. The T-block has 16 (ratio 10.4, turned 36 radians); `far_budget_ms`
  is the budget for such a heal (the smaller of the two), and `far_skip` does
  not start it (`stopped.skipped`). Any budget looks them up: a stop and a
  result report them in `far_grown`. No body of the 127-case corpus, the unit
  tests or the e2e has such a face. Of 28 measured that have (blocks rounded
  twice; B-spline copies of rounded boxes, T, L, plus and comb blocks, some
  rounds picked), 20 heals ran past 20 s and 8 failed in 1.2-7.6 s ("unable to
  remove the feature"). Review 2026-11-02: without the turn, flat B-spline
  faces counted too (a rib's and a heat sink's fin ends grown 5.9-6 times
  their size, as exporters that write every face as a B-spline give them), and
  those heals finish in 0.4-7 s.
- Without any of them the heal runs to the end, as before. The 127-case
  defeature corpus (the round 1 gate corpus and its messy variants; the
  scratch probe builds each in code) gives the same BREP bytes, history,
  validity, volume and warnings on the shipped API 8 kernel and on this one
  without a budget, and with `budget_ms: 16000, far_budget_ms: 2500,
  far_skip: true` on 126 of 127; the one that differs is a comb whose every
  surface is a B-spline, whose heal takes 58 s (past the 20 s watchdog already),
  stopped at 16 s. The app sends `budget_ms` = the call's whole watchdog limit
  (20 s) and, first on a new Delete faces, `far_skip`; never `far_budget_ms`.
- Tests: `tests/kernel/kernel-api9-defeature.test.ts` (fails on the API 8
  kernel; the budget test fails without 0002), `e2e/cad-kernel-api8.spec.ts`
  in the Part's own worker.

## as_if_apart (API 10, 2026-11-06)

GitHub issue 15: a cut reported success while removing nothing. A 60 x 40 x 20
block with a 5.1054 mm hole at (15, 0), and a helical groove in the hole's wall
(a loft through a 1/4-20 thread's basic profile, 16 planes a turn, 1.27 mm a
turn, its inner edge 0.0254 mm inside the wall). Ending inside the block (15.3
turns, 92.06 mm³) the groove cuts 86.19 mm³; running out through the bottom face
(16.5 to 20 turns, 16.75: 100.78 mm³) OCCT 7.9.3 cuts nothing (the block back,
valid, no warning), its common is empty and its fuse keeps two solids, with
fuzzy 1e-4, 1e-3 and 0.01 too and without unify; the same groove cuts the box
without its hole (94.39 mm³). Without unify the cut has 40 faces: OCCT split
the block's faces where the groove crosses them, then kept every piece.

- Such an answer is the one for inputs apart: a cut that keeps every target
  face (itself or its pieces) and no tool face, a common with no face, a fuse
  that merges no solid. `facade.cpp`'s `answeredApart` reads that from the
  boolean's history and counts, so an ordinary boolean (one that cut, joined or
  kept something) runs no check and answers as before: on the probe set (cut,
  common and fuse of the drilled block with a box inside it, a box holding it,
  a cylinder through it and the 15.3-turn groove) the same BREP bytes, history
  and fields as the API 9 kernel, and no `as_if_apart`.
- Only then `apartCheck` asks whether the inputs overlap: a point of one
  side's boundary more than the tolerance (1e-4 mm, twice the fuzzy value or
  twice the largest face tolerance) inside the other side. The pieces of the
  faces the boolean split (its builder's images, same-domain pieces left out:
  a flush face) on the side with more faces are sampled on a grid (at most
  1,024 points, at most 1 s) and classified against the side with fewer faces;
  a solid whose box lies inside the other side's is tried at a few points of
  its boundary. Found: `as_if_apart: "wrong"`, `warnings: true` and
  `warning_text` naming the point ("the cut removed nothing although the tool
  overlaps the target (a point of the target at (15.867, 2.511, 20) mm lies
  inside the tool): OCCT took them for apart and gave the target back
  unchanged"); not found: `"right"` (apart, or only touching). Out of time
  (two large bodies) or sheets: no `as_if_apart`.
- Cost (Node, 2026-11-06, while other lanes ran tests): the issue's groove
  2-4 ms against a 1.3 s boolean. On a 5,000-face prism an ordinary cut runs no
  check; a box apart inside the prism's box answers "right" in 130-340 ms
  (cut, common; the fuse up to 760 ms) against booleans of 0.8-4.6 s, flush on
  its top 36-110 ms, touching one of its vertices 38-200 ms.
- Tests: `tests/kernel/kernel-api10-apart.test.ts` (the issue's case fails on
  the API 9 kernel), `tests/doc/apart-real-kernel.test.ts` (History's words).

## Flags

- Compile (OCCT and facade): `-O3 -fwasm-exceptions -msimd128`, plus
  `-ffile-prefix-map` so no build-machine path ends up in the binary (OCCT's
  `__FILE__` strings read `/cad-build/occt-7.9.3/src/...`).
- Analysis Situs: the same, plus `-ffile-prefix-map=<asi work>=/cad-asi`,
  `-include asi_occt79_compat.h`, the two defines above and
  `-Wno-deprecated-declarations` (the build record's `asi_flags`). The facade's
  `asi_ops.cpp`, the only facade source that sees Analysis Situs, is compiled
  the same way against the patched headers build-asi.sh leaves next to
  `libasi.a` (`compile_asi_ops`); `facade.cpp` never sees them.
  `libasi.a` is linked after `facade.o` and `asi_ops.o` and before the OCCT
  libraries.
- Link: `-sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node
  -sDYNAMIC_EXECUTION=0 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB
  -sINITIAL_MEMORY=64MB -sSTACK_SIZE=8MB -sFILESYSTEM=0
  -sEXPORT_NAME=createMagnusimKernel` (full list: `build-facade.sh`).
- Only wasm32 ships (P0 decision 4: it handled the 113 MB part with 1.24 of
  4 GiB; wasm64 was 12–110 % slower). `build.sh --variant wasm64` still builds
  it, outside the plugin, for bigger models later.

## Build

```
# Linux or WSL (git, cmake, ninja, python3 for emsdk)
bundled-plugins/cad/kernel-build/build.sh            # -> workspace/kernel/mk32.{mjs,wasm} + kernel-build/mk32.build.txt
bundled-plugins/cad/kernel-build/build.sh --clean    # the facade from nothing
CAD_BUILD_ROOT=/somewhere/else kernel-build/build.sh # work folder (default ~/cad-build)
kernel-build/build.sh --out /tmp/k                   # build elsewhere to compare
kernel-build/repro-check.sh --against-shipped        # two clean builds, compared with each other and with workspace/kernel
kernel-build/build-asi.sh wasm32                     # Analysis Situs' libasi.a alone (build.sh runs it when missing)
kernel-build/asi/closure.sh                          # the vendored Analysis Situs files: closure and licences

# Windows (the plugin's Node): the same build.sh in WSL, holding .cache/build.lock
node kernel-build/ship.mjs                           # queued with e2e runs; replaces workspace/kernel between them
```

- The work folder holds emsdk, the OCCT source, the OCCT builds and the
  facade objects. OCCT libraries go to `occt-<variant>-<key>/install`, where
  `<key>` hashes everything that shapes them (commit, Emscripten, flags,
  `build-occt.sh`, the patches): changing any of them builds OCCT again (about
  3–4 minutes with `JOBS=28` on 32 cores) instead of reusing stale libraries.
- Analysis Situs' `libasi.a` goes to `asi-<variant>-<key>/` the same way
  (`<key>` hashes the pin, `FILES.sha256`, the patch, the compat header,
  `sources.txt`, `build-asi.sh`, the flags, Emscripten and the OCCT key). It is
  built from a fresh patched copy each time, about 7 s with `JOBS=16`, and
  moved into place only when complete. `ASI_OBJ=<dir>` builds and uses it
  elsewhere (`repro-check.sh` does, from nothing in each run).
- `build.sh` writes `mk32.build.txt`, the build record: Emscripten, OCCT and
  Analysis Situs pins, patch hashes, flags, the OCCT and Analysis Situs keys,
  the hashes of Analysis Situs' file list, source list, compat header and
  `libasi.a`, a hash of the facade sources and the output hashes. Same record,
  same bytes.
- The shipped `mk32.*` are moved into `workspace/kernel/` as a pair (two
  renames), so a page that starts a worker meanwhile does not load halves of
  two builds.

## Reproducibility (measured 2026-09-30; API 3 build 2026-10-01; API 7 build 2026-10-30; Analysis Situs linked 2026-11-01; API 8 and API 9 builds 2026-11-02; API 10 build 2026-11-06)

- `repro-check.sh --against-shipped`: two facade builds from clean object
  folders are byte-identical to each other and to the shipped files. API 3
  (2026-10-01, 1m20s for both): `mk32.wasm` 21,262,262 bytes, sha256
  `030265d3a8cc6ebb…`; `mk32.mjs` sha256 `aad011be5d356a6a…` (unchanged). P1.5:
  `mk32.wasm` 20,821,079 bytes, sha256 `0fd2becb31458d22…`. API 7 (2026-10-30,
  volumes: `volumeOf` in the facade; built with `FACADE_OBJ` in a folder of its own, `--clean`):
  `mk32.wasm` 22,477,455 bytes, sha256 `aefc7a5ff4a1ed6e…`; `mk32.mjs` unchanged; both
  `repro-check.sh --against-shipped` builds identical to each other and to the shipped pair.
  API 7 centroid and offset-face fix (2026-10-30, same contract; `FACADE_OBJ` of its own,
  `--clean`): `mk32.wasm` 22,483,974 bytes, sha256 `69bb460d53a2510f…`; `mk32.mjs` unchanged;
  `repro-check.sh --against-shipped` (1m06s): both builds identical to each other and to the
  shipped pair.
- API 8 (2026-11-02, Analysis Situs' ops called; shipped with `node kernel-build/ship.mjs
  --clean`, `FACADE_OBJ` of its own): `mk32.wasm` 23,263,432 bytes, sha256
  `e1c42b60a14eb213…`; `mk32.mjs` unchanged (`aad011be5d356a6a…`); `libasi.a`
  unchanged (`102b2d769f72f28a…`). `repro-check.sh --against-shipped` (1m29s):
  both `libasi.a`, both kernels and both build records identical, the kernels
  and record identical to the shipped ones, no build-machine path in any.
  Size against API 7 (69bb460d): +779,458 bytes raw (+3.47 %), +217,409 bytes
  with `gzip -9` (7,005,166 -> 7,222,575, +3.10 %); the `.wasm` is served
  uncompressed over loopback. Start in Node through the worker's wrapper, 9
  fresh processes each: `init_ms` median 37.9 ms (37.6-42.5) for API 7 and 39.4
  ms (38.3-43.3) for API 8; the heap after start is 64 MiB on both and mallinfo's
  used bytes the same (4,237,000).
- API 9 (2026-11-02: defeature's time budget with OCCT patch 0002, recognize's two
  face limits, the adjacency graph's speed hunk and the refitted budget). OCCT was
  built again for 0002 (key `db14f4e021d2`, 3 minutes on 32 cores); the kernel was
  shipped with `node kernel-build/ship.mjs --clean`, `FACADE_OBJ` of its own:
  `mk32.wasm` 23,288,644 bytes, sha256 `5ca039450e62038c…` (+25,212 bytes against
  API 8's e1c42b60; +6,832 with `gzip -9`); `mk32.mjs` unchanged
  (`aad011be5d356a6a…`); `libasi.a` 4,133,036 bytes, sha256 `35f508e99510efae…`
  (the speed hunk; the same bytes against OCCT with and without 0002, which
  changes no header). `repro-check.sh --against-shipped` (93 s): both `libasi.a`,
  both kernels and both build records identical, the kernels and record identical
  to the shipped ones, no build-machine path in any.
- API 10 (2026-11-06: as_if_apart in boolean and combine; the facade only, OCCT and
  `libasi.a` reused): shipped with `node kernel-build/ship.mjs --clean`, `FACADE_OBJ` of
  its own: `mk32.wasm` 23,311,258 bytes, sha256 `99d3adfb94f60141…` (+20,375 bytes against
  API 9's c59b3a0f); `mk32.mjs` unchanged (`aad011be5d356a6a…`). `repro-check.sh
  --against-shipped` (2m46s, other lanes building meanwhile): both `libasi.a`, both
  kernels and both build records identical, the kernels and record identical to the
  shipped ones, no build-machine path in any.
- Analysis Situs linked, nothing calling it (2026-11-01, still API 7): `build.sh`
  with `libasi.a` (43 objects, 4,133,068 bytes, sha256 `102b2d769f72f28a…`) on
  the link line gives `mk32.wasm` 22,483,974 bytes, sha256 `69bb460d53a2510f…`,
  and `mk32.mjs` `aad011be5d356a6a…`: the shipped bytes, because wasm-ld takes
  no member of an archive that nothing references. The archive really is read:
  `-Wl,--trace-symbol` shows its symbols offered and not taken, and a
  whole-archive link of it gives other bytes (22,481,569). `repro-check.sh
  --against-shipped` (1m27s, `libasi.a` built from nothing in 6–7 s in each run):
  both `libasi.a`, both kernels and both build records identical, and the
  kernels and record identical to the shipped ones.
- OCCT rebuilt from nothing (230 s): all 27 static libraries identical to the
  first build, and the facade linked against them identical again.
- No `/home/...` or other build-machine path is left in `mk32.wasm`.
  `repro-check.sh` checks it on every run: the builder's home folder, the build
  root, the plugin and its own work folder appear nowhere in `mk32.wasm`,
  `mk32.mjs` or `libasi.a`, nor does any path into the folder of home folders
  in `mk32.wasm` and `libasi.a`.
- `build.sh` waits (bounded, `CAD_KERNEL_LOCK_WAIT`, default 900 s) while an e2e
  run holds `.cache/build.lock` before it replaces the shipped pair, so a running
  e2e suite never gets a new kernel mid-run; `CAD_KERNEL_IGNORE_BUILD_LOCK=1` for a
  lock left by a stopped run. With e2e runs queued the lock may never be free for
  long: `node kernel-build/ship.mjs` takes its turn in the queue (it holds the lock
  the way `scripts/e2e.mjs` does) and runs build.sh inside it.

## Tests

`npm run test:kernel` (in the plugin) runs `tests/kernel/kernel-*.test.ts`
against `workspace/kernel/` (or `CAD_KERNEL_DIR=<folder>` for another build).
`EXTRA_CXXFLAGS=-DMK_TEST_NO_WORK_COPY FACADE_OBJ=<tmp> build.sh --out <dir>`
makes a test-only kernel that runs ops on the stored shapes themselves; with it
the P0 hazard comes back (the vortex-finder cut removes 0.015 mm³ instead of
42,353 mm³), which is what `kernel-copies.test.ts` guards against.
`-DMK_TEST_NO_SUPPRESS_BUDGET` makes one whose `suppress_blends` never refuses
on its budget, and `-DMK_TEST_COST_IN_WORDS` adds SuppressBlendsInc's time to a
refusal that came after it ran: the kernel the budget's model was measured
with. The API 8, 9 and 10 tests (`kernel-api8-*.test.ts`, `kernel-api9-*.test.ts`, `kernel-api10-*.test.ts`) run against the shipped kernel;
`kernel-api8-nist.test.ts` also needs `ASI_CORPUS_DIR` (the NIST MBE PMI STEP
files, never committed). `tests/kernel/asi-licence.test.ts` checks
`LICENSES/AnalysisSitus-BSD-3-Clause.txt` against the vendored files' headers.

Commit `workspace/kernel/*.wasm` only on version bumps (decision 2026-09-30);
development builds stay out of git.
