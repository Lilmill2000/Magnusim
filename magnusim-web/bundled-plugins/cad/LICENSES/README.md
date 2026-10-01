# Licences of what the CAD plugin ships

The plugin itself (everything under `bundled-plugins/cad/` not listed below) is
**GPL-3.0-or-later**, like Magnusim (the repository's `LICENSE`). Every
third-party component is GPL-3.0-compatible. No code is copied from AGPL
projects (Chili3D, xeokit) or from jsketcher.

| Component | Where it ships | Licence | Text |
|---|---|---|---|
| Open CASCADE Technology 7.9.3 (the modeling kernel) | `workspace/kernel/mk32.wasm` | LGPL-2.1 with the Open CASCADE exception | `OCCT-LGPL-2.1.txt`, `OCCT-LGPL-EXCEPTION.txt` |
| FreeCAD PlaneGCS (the sketch solver) and the salusoft89/planegcs wrapper | `workspace/solver/planegcs.wasm` | LGPL-2.0-or-later (FreeCAD sources), LGPL-2.1-or-later (wrapper) | `PlaneGCS-LGPL-2.1.txt` |
| Eigen 3.4.0 (built with `EIGEN_MPL2_ONLY`) | inside `planegcs.wasm` | MPL-2.0 | `Eigen-MPL-2.0.txt` |
| Boost 1.86 headers | inside `planegcs.wasm` | BSL-1.0 | `Boost-BSL-1.0.txt` |
| Emscripten runtime and JavaScript glue | `mk32.mjs`, `planegcs.mjs`, inside both `.wasm` | MIT or University of Illinois/NCSA | `Emscripten-MIT-NCSA.txt` |
| libc++, libc++abi, compiler-rt (LLVM) | inside both `.wasm` | Apache-2.0 WITH LLVM-exception | `LLVM-libcxx-Apache-2.0-with-LLVM-exception.txt`, `LLVM-libcxxabi-Apache-2.0-with-LLVM-exception.txt` |
| musl libc | inside both `.wasm` | MIT | `musl-MIT.txt` |
| three.js 0.186.1 | bundled in `workspace/app.js` | MIT | `three.js-MIT.txt` |
| three-mesh-bvh 0.9.15 | bundled in `workspace/app.js` (and the picking worker) | MIT | `three-mesh-bvh-MIT.txt` |
| React 19 | not shipped: the host's import map provides it | MIT | (host) |

## LGPL obligations

The LGPL requires that the source of the library, including our changes, is
available and that the library can be rebuilt:

- OCCT: `kernel-build/` holds the pinned source reference (tag `V7_9_3`, commit
  in `kernel-build/SOURCES.md`), our patch (`kernel-build/occt-patches/`), the
  facade source and the build scripts (`kernel-build/build.sh`).
- PlaneGCS: `solver-build/` holds the pinned upstream commit, our full patch
  (`solver-build/planegcs.patch`), the generated bindings and the build script
  (`solver-build/build.sh`); `solver-build/SOURCES.md` lists every source.

Both modules are loaded as separate files at run time, so a user can replace
them with their own builds.
