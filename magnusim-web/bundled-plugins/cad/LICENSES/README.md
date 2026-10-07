# Licences of what the CAD plugin ships

The plugin itself (everything under `bundled-plugins/cad/` not listed below) is
**GPL-3.0-or-later**, like Magnusim: the full text is the repository's root
`LICENSE`, and the plugin's source files say so with
`SPDX-License-Identifier: GPL-3.0-or-later`. Every third-party component is
GPL-3.0-compatible. No code is copied from AGPL projects (Chili3D, xeokit) or
from jsketcher. The icons are the plugin's own drawings, and it ships no fonts:
the page uses the app's font.

| Component | Where it ships | Licence | Text in this folder |
|---|---|---|---|
| Open CASCADE Technology 7.9.3 (the modeling kernel) | `workspace/kernel/mk32.wasm` | LGPL-2.1 with the Open CASCADE exception | `OCCT-LGPL-2.1.txt`, `OCCT-LGPL-EXCEPTION.txt` |
| Code inside OCCT under other licences: DELABELLA (Marcin Sokalski), flex's `FlexLexer.h` (University of California), David M. Gay's `strtod` (Lucent Technologies), Unicode conversion tables (Unicode, Inc.) | inside `mk32.wasm` | MIT; BSD-3-Clause; Gay's permissive notice; the Unicode notice | `OCCT-third-party-notices.txt` |
| FreeCAD PlaneGCS (the sketch solver) and the Salusoft89 `planegcs` WebAssembly wrapper | `workspace/solver/planegcs.wasm` | LGPL-2.0-or-later (FreeCAD sources), LGPL-2.1-or-later (wrapper) | `PlaneGCS-LGPL-2.1.txt` |
| Eigen 3.4.0 (built with `EIGEN_MPL2_ONLY`) | inside `planegcs.wasm` | MPL-2.0 | `Eigen-MPL-2.0.txt` |
| Boost 1.86 headers | inside `planegcs.wasm` | BSL-1.0 | `Boost-BSL-1.0.txt` |
| Emscripten runtime, JavaScript glue and embind | `mk32.mjs`, `planegcs.mjs`, inside both `.wasm` | MIT or University of Illinois/NCSA | `Emscripten-MIT-NCSA.txt` |
| libc++, libc++abi, libunwind, compiler-rt (LLVM) | inside both `.wasm` | Apache-2.0 WITH LLVM-exception | `LLVM-libcxx-Apache-2.0-with-LLVM-exception.txt`, `LLVM-libcxxabi-Apache-2.0-with-LLVM-exception.txt` (the same licence covers libunwind and compiler-rt) |
| musl libc | inside both `.wasm` | MIT | `musl-MIT.txt` |
| three.js 0.186.1 | bundled in `workspace/app.js` and `workspace/pick/pick-worker.js` | MIT | `three.js-MIT.txt` |
| three-mesh-bvh 0.9.15 | bundled in `workspace/app.js` and `workspace/pick/pick-worker.js` | MIT | `three-mesh-bvh-MIT.txt` |
| React 19, the workspace bridge and the UI kit (`@magnusim/plugin-ui`) | not shipped here: the app's import map provides them | MIT (React), GPL-3.0-or-later (Magnusim) | (the app's notices) |

The build strips licence comments from the bundled JavaScript
(`legalComments: 'none'`), so this folder is where the three.js and
three-mesh-bvh notices live: keep it next to `workspace/` in every copy.

## Source and relinking (LGPL)

The LGPL asks that the library's source, with our changes, is available, and
that a user can rebuild the work with a changed library. Everything needed is in
this plugin, pinned to exact upstream versions:

- **OCCT** (`kernel-build/`): the upstream tag `V7_9_3`, commit
  `a016080bf6738d6aeae020badee4e888ad1540a5` of
  <https://github.com/Open-Cascade-SAS/OCCT> (`kernel-build/SOURCES.md`,
  `env.sh`); our one patch (`occt-patches/`); the facade that uses it
  (`facade/`, GPL-3.0-or-later source); and the scripts that build OCCT and the
  kernel (`build-occt.sh`, `build-facade.sh`, `build.sh`) with the pinned
  Emscripten 6.0.10. `build-occt.sh` refuses any OCCT source other than the
  pinned commit plus our patch, `mk32.build.txt` records the hashes of the build
  that ships, and `repro-check.sh` shows that these sources give the shipped
  bytes.
- **PlaneGCS** (`solver-build/`): the wrapper commit
  `ee9b156da9827a91a56a888a53520f63d5cffaa6` of
  <https://github.com/Salusoft89/planegcs> (it carries FreeCAD's PlaneGCS
  sources from FreeCAD commit `5f8eac49f31626354ee69bf40616bac801ca5560`), our
  full patch (`planegcs.patch`), the generated bindings and the build script
  (`build.sh`); `solver-build/SOURCES.md` lists every source with its version.
- **Relinking:** each library is its own pair of files (`mk32.wasm` with
  `mk32.mjs`, `planegcs.wasm` with `planegcs.mjs`) that the workspace's workers
  load at run time. To use a changed OCCT or PlaneGCS, change its source under
  `$CAD_BUILD_ROOT` (or add a patch), run `kernel-build/build.sh` or
  `solver-build/build.sh` on Linux or WSL, and the new pair replaces the old one
  in `workspace/kernel/` or `workspace/solver/`. Nothing else in the plugin has
  to change. The calls the page makes into each module are documented in
  `src/types/kernel-protocol.ts` and `src/solver-worker/solver-api.mjs`.

### Source archives attached to the release

The GitHub release of Magnusim CAD 0.1.0 attaches the exact upstream sources
the shipped modules were built from, so they can be had from the same place as
the plugin. Each is pristine upstream: our changes are the in-tree patches
above (`kernel-build/occt-patches/`, `solver-build/planegcs.patch`), and they
apply to these archives as they are.

| File | What | SHA-256 |
|---|---|---|
| `occt-V7_9_3-src.tar.gz` | OCCT: `git archive` of tag `V7_9_3` (commit `a016080b`) | `a9005c5dcc82edfa236583bc9195fef4c4cdaf297fd72a47cfa46cd98a68de13` |
| `planegcs-ee9b156d-src.tar.gz` | the Salusoft89 wrapper with FreeCAD's PlaneGCS sources (FreeCAD `5f8eac49`): `git archive` of commit `ee9b156d` | `0c88f73e7020f1503484543cc34823374e5c83d6e23d6a9014755831126a8dba` |
| `eigen-3.4.0-src.tar.gz` | Eigen 3.4.0: the upstream archive from gitlab.com/libeigen/eigen, unchanged | `8586084f71f9bde545ee7fa6d00288b264a2b7ac3607b974e54d13e7162c1c72` |
| `boost_1_86_0-src.tar.gz` | Boost 1.86.0: the upstream archive from archives.boost.io, unchanged (the build uses its `boost/` headers only) | `2575e74ffc3ef1cd0babac2c1ee8bdb5782a0ee672b1912da40e5b4b591ca01f` |

`SHA256SUMS-cad-sources.txt` beside them lists the same hashes
(`sha256sum -c SHA256SUMS-cad-sources.txt`). The two `git archive` files are
reproducible: `git archive --format=tar --prefix=occt-V7_9_3/ a016080b | gzip -n -9`
in an OCCT clone (and `--prefix=planegcs-ee9b156d/ ee9b156d` in the wrapper's)
gives the same bytes with the same git and gzip.

**Rebuilding.** `kernel-build/build.sh` and `solver-build/build.sh` (Linux or
WSL; see `kernel-build/SOURCES.md` and `solver-build/SOURCES.md`) fetch these
same sources themselves: OCCT by its tag, the wrapper by its commit, Eigen and
Boost from the URLs of the two archives above. They apply our patches, build,
and write the new module pair into `workspace/kernel/` or `workspace/solver/`.
The archives hold exactly that content for when upstream cannot be reached;
the scripts check the pinned commit through git, so for an offline build
unpack an archive and run the script's steps on it (OCCT: apply the patch, then
`build-occt.sh`'s CMake configuration; the solver: apply `planegcs.patch`,
regenerate the bindings, compile). The Emscripten system libraries (MIT,
UIUC/NCSA, Apache-2.0 WITH LLVM-exception) come with the pinned emsdk 6.0.10.

If you received Magnusim without these folders or archives, or cannot reach the
upstream repositories above, ask the Magnusim project for the corresponding
source.
