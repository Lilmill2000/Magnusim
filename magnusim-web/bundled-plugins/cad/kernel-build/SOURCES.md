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

- `asi/asi-occt79-wasm.patch` (13 files, +72/−14 lines, no algorithm
  changed). Analysis Situs targets OCCT 7.6, and OCCT 7.8 changed the hasher
  protocol of its NCollection maps: the old-style hashers get the new call
  operators. `ASI_NO_VIS_IO` compiles out the windowing, offscreen rendering
  and STL reading and writing in `asiAlgo_Utils.cpp`. `ASI_NO_EIGEN` compiles
  out its one use of Eigen (`InterpolatePoints`, which nothing compiled here
  calls), so the kernel build needs no Eigen. The hunks are under the licence
  of the files they change (BSD-3-Clause).
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

## suppress_blends' budget (measured 2026-11-02)

`asiAlgo_SuppressBlendsInc` builds a new adjacency graph and recognises the
fillets again after every chain it takes off, so its time grows faster than the
number of chains, and a running wasm call cannot be stopped: one past the
watchdog kills the worker and rebuilds the whole Part. `suppress_blends`
therefore predicts the run from counts it has before it starts (after its own
recognition at R) and refuses in words over a budget: "taking 404 fillet faces
off as fillets on a body of 810 faces would take too long here (about 35 s)".

- Model (`asi_ops.cpp`, `costCounts` and `predictSuppressMs`; ms in Node):
  `1.7893e-5 x chains x W + 2.7171e-2 x chains x faces + 2.4577e-3 x picks x
  faces + 13.92 x free-form chains + 1.2587 x free-form picks`, with chains = the
  pick's chains at R, W = (w0 + w1 + sqrt(w0 w1)) / 3 for the graph's pair work
  w0 before and w1 after the picks are gone (per adjacent face pair e1 e2 + e1 +
  e2, e = the face's edges: asiAlgo_CheckDihedralAngle copies both faces' edge
  maps and compares them in a double loop), and free-form = a face other than a
  plane, cylinder, cone, sphere or torus (in a chain or next to it). The result
  reports the counts and the prediction as `cost`.
- Fitted (least squares on the relative error) on 124 rows measured with a
  kernel built `-DMK_TEST_NO_SUPPRESS_BUDGET -DMK_TEST_COST_IN_WORDS` (the
  scratch probe builds each body with kernel ops; the times are
  SuppressBlendsInc's own): combs of 5-60 teeth rounded R0.4 on their lateral
  edges (24-244 one-face chains; 0.06-8.7 s) or on every edge (one chain of
  120-1,220 faces; 0.06-5.3 s); plates with 100-1,900 holes with 4 corner
  chains or one outer chain (0.02-1.9 s); 3x3-11x11 pegs rounded on their
  vertical edges (36-484 chains; 0.18-36 s) and 2x2-6x6 pegs on every edge;
  B-spline copies of the Step 0 family and of the combs (every chain refused
  after the run, 0.07-3.3 s); the Step 0 family and part A (5-55 ms); and 10
  NIST MBE PMI parts at 5 radii each (0-3.3 s, every one refused after the
  run). The model reads 0.8-1.3x the measured time on the built parts and the
  B-spline copies above 100 ms; on two NIST parts (CTC-02, CTC-05) it reads
  1.8-2.6x low (4.3x on a 90 ms run).
- Budget 1,400 ms (`kSuppressBudgetMs`): the slowest accepted measured run then
  took 2.0 s (2.25 s for the whole op; CTC-02 at R10, which the model reads
  1.8x low), every accepted built part under 1.5 s, and the refused ones
  measured 1.6 s to 36 s. A 1.5-2x slower laptop stays far under
  `OP_TIMEOUTS.suppress_blends` (60 s, `src/kernel/timeouts.ts`). A refusal costs
  the two recognitions before it (26 ms on the 250-face comb, 0.34 s on the
  1,210-face one). `budget_ms` in a call may only lower the budget.
- Without the budget (`-DMK_TEST_NO_SUPPRESS_BUDGET`), `kernel-api8-suppress`'s
  budget test fails: the 810-face comb runs 31 s and returns a body.

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

## Reproducibility (measured 2026-09-30; API 3 build 2026-10-01; API 7 build 2026-10-30; Analysis Situs linked 2026-11-01; API 8 build 2026-11-02)

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
with. The API 8 tests (`kernel-api8-*.test.ts`) run against the shipped kernel;
`kernel-api8-nist.test.ts` also needs `ASI_CORPUS_DIR` (the NIST MBE PMI STEP
files, never committed). `tests/kernel/asi-licence.test.ts` checks
`LICENSES/AnalysisSitus-BSD-3-Clause.txt` against the vendored files' headers.

Commit `workspace/kernel/*.wasm` only on version bumps (decision 2026-09-30);
development builds stay out of git.
