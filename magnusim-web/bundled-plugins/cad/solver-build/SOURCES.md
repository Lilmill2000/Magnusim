# Solver: sources, build and licences

`workspace/solver/planegcs.wasm` + `planegcs.mjs` are FreeCAD's 2D constraint
solver (PlaneGCS), built to WebAssembly through the embind wrapper of
`salusoft89/planegcs`, with our patches. The LGPL requires that the source of
the library, including our changes, is available and that the library can be
rebuilt: `build.sh` does that from the pins below.

## Upstream sources

| What | Version | Where |
|---|---|---|
| salusoft89/planegcs (wrapper, binding generator, vendored FreeCAD sources) | commit `ee9b156da9827a91a56a888a53520f63d5cffaa6` (npm 1.2.0) | github.com/Salusoft89/planegcs |
| FreeCAD PlaneGCS (`GCS.*`, `Geo.*`, `Constraints.*`, `SubSystem.*`, `qp_eq.*`) | FreeCAD commit `5f8eac49f31626354ee69bf40616bac801ca5560`, vendored in the wrapper | github.com/FreeCAD/FreeCAD |
| Eigen | 3.4.0 | gitlab.com/libeigen/eigen |
| Boost (headers only) | 1.86.0 | archives.boost.io |
| Emscripten | emsdk 6.0.10 | github.com/emscripten-core/emsdk |
| Node | 20.18.1, build time only (the wrapper's tree-sitter binding generator) | nodejs.org |

## Our changes

- `planegcs.patch`: the full diff against the wrapper commit above (FreeCAD
  sources and the binding template). `build.sh` applies it with `git apply`.
- `bindings.generated.cpp`: the embind bindings the wrapper's generator makes
  from the patched template (`build.sh` regenerates and refreshes this copy).

What the patch does:
1. Diagnosis speed: the Gauss-Jordan elimination above the QR pivots becomes one
   blocked triangular solve (same result).
2. Diagnosis speed: when the Jacobian has full row rank, the second (transposed)
   sparse QR is skipped.
3. Diagnosis fix: temporary (tag < 0) drag constraints are kept out of the
   "redundant solving" pass (upstream turns redundant constraints into
   conflicting ones, and DOF 0 into -1, during a drag).
4. SQP fix: a rank-deficient but consistent constraint Jacobian no longer aborts
   the drag step.
5. DogLeg: a sparse least-norm Gauss-Newton step, falling back to the dense
   FullPivLU step when it does not solve J h = -f.
6. Jacobian assembly evaluates only adjacent (constraint, parameter) pairs.
7. A sparse SQP for point drags in large components; the dense SQP otherwise.
8. Binding additions: prepared solves (`init_solution`, `solve_prepared`),
   `diagnose_fresh`, `get_dependent_params`, `get_dependent_param_groups`, bulk
   parameter transfer through the WASM heap, `set_dl_gauss_step`,
   `set_sparse_sqp_min_params`.

## Flags

Compile: `-std=gnu++20 -O3 -flto -fwasm-exceptions -msimd128 -DEIGEN_MPL2_ONLY`.
Link: `-lembind -sEMBIND_AOT=1 -sDYNAMIC_EXECUTION=0 -sMODULARIZE=1
-sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1
-sMAXIMUM_MEMORY=1GB -sSTACK_SIZE=5MB -sFILESYSTEM=0 -sASSERTIONS=0
-sEXPORTED_RUNTIME_METHODS=HEAPF64`. `EMBIND_AOT` + `DYNAMIC_EXECUTION=0`: no
eval under the frame's CSP.

## Licence of every shipped file

| File | Licence |
|---|---|
| `planegcs.wasm` | LGPL-2.1-or-later as a whole: FreeCAD PlaneGCS LGPL-2.0-or-later; the wrapper LGPL-2.1-or-later; our patches under the licence of the file they change; Eigen MPL-2.0 only; Boost headers BSL-1.0; Emscripten system libraries MIT or UIUC/NCSA, musl MIT, libc++ / libc++abi / compiler-rt Apache-2.0 WITH LLVM-exception |
| `planegcs.mjs` | Emscripten-generated glue including the embind runtime: MIT or UIUC/NCSA |
| `planegcs.patch`, `bindings.generated.cpp` | LGPL-2.1-or-later (changes to, and code generated from, the LGPL sources) |
| `build.sh` | GPL-3.0-or-later |

The P3 sketcher's worker side lives in `src/solver-worker/` (`solver-api.mjs`,
`solver-worker.mjs`, GPL-3.0-or-later); it is not built into `workspace/` until
the sketcher lands.
