# Licences of what the 2D Wind Tunnel plugin ships

The plugin itself (everything under `bundled-plugins/tunnel2d/` not listed below)
is **GPL-3.0-or-later**, like Magnusim: the full text is the repository's root
`LICENSE`, and its source files say so with `SPDX-License-Identifier:
GPL-3.0-or-later`. Every third-party component is GPL-3.0-compatible.

| Component | Where it ships | Licence | Text in this folder |
|---|---|---|---|
| The CAD plugin's sketch model, solver client and geometry (Magnusim's own) | bundled in `workspace/app.js` from `bundled-plugins/cad/src/` | GPL-3.0-or-later | the root `LICENSE` |
| FreeCAD PlaneGCS (the sketch solver) and the Salusoft89 `planegcs` WebAssembly wrapper | `workspace/solver/planegcs.wasm` (a copy of the CAD plugin's) | LGPL-2.0-or-later (FreeCAD sources), LGPL-2.1-or-later (wrapper) | `PlaneGCS-LGPL-2.1.txt` |
| Eigen 3.4.0 (built with `EIGEN_MPL2_ONLY`) | inside `planegcs.wasm` | MPL-2.0 | `Eigen-MPL-2.0.txt` |
| Boost 1.86 headers | inside `planegcs.wasm` | BSL-1.0 | `Boost-BSL-1.0.txt` |
| Emscripten runtime and JavaScript glue | `workspace/solver/planegcs.mjs`, inside `planegcs.wasm` | MIT or University of Illinois/NCSA | `Emscripten-MIT-NCSA.txt` |
| libc++, libc++abi, libunwind, compiler-rt (LLVM) | inside `planegcs.wasm` | Apache-2.0 WITH LLVM-exception | `LLVM-libcxx-Apache-2.0-with-LLVM-exception.txt`, `LLVM-libcxxabi-Apache-2.0-with-LLVM-exception.txt` |
| musl libc | inside `planegcs.wasm` | MIT | `musl-MIT.txt` |
| The inferno colour map (matplotlib, Smith and van der Walt) | `workspace/app.js` (`src/render/inferno.ts`) | CC0-1.0 | (public domain dedication; no text needed) |
| React 19, the workspace bridge and the UI kit | not shipped here: the app's import map provides them | MIT (React), GPL-3.0-or-later (Magnusim) | (the app's notices) |

## Source and relinking (LGPL)

`workspace/solver/` (`planegcs.wasm`, `planegcs.mjs`, `solver-worker.js`) is a
copy of the CAD plugin's `workspace/solver/`, made by this plugin's build
(`vite.config.ts`). The PlaneGCS source with our changes, its pinned versions
and the build script are in the CAD plugin's `solver-build/` (see
`bundled-plugins/cad/LICENSES/README.md`, "Source and relinking"). To use a
changed PlaneGCS, rebuild it there and run this plugin's build: the new pair
replaces the copy here, and nothing else changes. The calls the page makes into
the solver are documented in `bundled-plugins/cad/src/solver-worker/solver-api.mjs`.
