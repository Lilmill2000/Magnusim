# Kernel: sources, build and pins

`workspace/kernel/mk32.wasm` + `mk32.mjs` are Open CASCADE Technology 7.9.3
compiled to WebAssembly with a small C++ facade (`facade/`). JavaScript calls
the facade through a plain C ABI (`mk_call(json)`, `mk_alloc`, `mk_free`):
no embind, so nothing needs `eval` or `new Function` under the workspace
frame's Content-Security-Policy.

## Pins

| What | Version | Where |
|---|---|---|
| OCCT | tag `V7_9_3`, commit `a016080bf6738d6aeae020badee4e888ad1540a5` | github.com/Open-Cascade-SAS/OCCT |
| Emscripten | emsdk `6.0.10`: emcc 6.0.10 (`d6c521a7f05449857c76bd99e396895583cf2083`), upstream release `666337b525e673e769121856d175f6f52b8ead64`, emsdk checkout `e566f7bdcc7735f44037911c24b87a58a3c93145` | github.com/emscripten-core/emsdk |
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

## Flags

- Compile (OCCT and facade): `-O3 -fwasm-exceptions -msimd128`, plus
  `-ffile-prefix-map` so no build-machine path ends up in the binary (OCCT's
  `__FILE__` strings read `/cad-build/occt-7.9.3/src/...`).
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
```

- The work folder holds emsdk, the OCCT source, the OCCT builds and the
  facade objects. OCCT libraries go to `occt-<variant>-<key>/install`, where
  `<key>` hashes everything that shapes them (commit, Emscripten, flags,
  `build-occt.sh`, the patches): changing any of them builds OCCT again (about
  3–4 minutes with `JOBS=28` on 32 cores) instead of reusing stale libraries.
- `build.sh` writes `mk32.build.txt`, the build record: Emscripten and OCCT
  pins, patch hashes, flags, the OCCT key, a hash of the facade sources and the
  output hashes. Same record, same bytes.
- The shipped `mk32.*` are moved into `workspace/kernel/` as a pair (two
  renames), so a page that starts a worker meanwhile does not load halves of
  two builds.

## Reproducibility (measured 2026-09-30)

- `repro-check.sh --against-shipped`: two facade builds from clean object
  folders are byte-identical to each other and to the shipped files
  (`mk32.wasm` 20,821,079 bytes, sha256 `0fd2becb31458d22…`; `mk32.mjs` sha256
  `aad011be5d356a6a…`).
- OCCT rebuilt from nothing (230 s): all 27 static libraries identical to the
  first build, and the facade linked against them identical again.
- No `/home/...` or other build-machine path is left in `mk32.wasm`.

## Tests

`npm run test:kernel` (in the plugin) runs `tests/kernel/kernel-*.test.ts`
against `workspace/kernel/` (or `CAD_KERNEL_DIR=<folder>` for another build).
`EXTRA_CXXFLAGS=-DMK_TEST_NO_WORK_COPY FACADE_OBJ=<tmp> build.sh --out <dir>`
makes a test-only kernel that runs ops on the stored shapes themselves; with it
the P0 hazard comes back (the vortex-finder cut removes 0.015 mm³ instead of
42,353 mm³), which is what `kernel-copies.test.ts` guards against.

Commit `workspace/kernel/*.wasm` only on version bumps (decision 2026-09-30);
development builds stay out of git.
