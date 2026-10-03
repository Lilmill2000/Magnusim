# Third-party software and distribution

Magnusim's original source is offered under GPL-3.0-or-later (see LICENSE).
Releases published before that change remain available under Apache-2.0. The
Magnusim license does not replace the licenses of dependencies or third-party
source, assets, or executables. Setup downloads dependencies separately.

## Gmsh and the mesher

Gmsh 4.15.2 is GPL version 2 or later, with its upstream linking exception.
Magnusim calls its Python API from the meshing backend, including
`magnusim-web/python/cfddesk/mesh/gmsh_standard.py` and `standard_hexcore.py`.
The official license statement is at [Gmsh licensing](https://gmsh.info/#Licensing).
Retain Gmsh's complete license and exception when distributing Gmsh itself.

Gmsh's "version 2 or later" terms are compatible with Magnusim's
GPL-3.0-or-later license, so Magnusim and Gmsh combine as a GPLv3 work. See
[GNU's GPLv3 guide](https://www.gnu.org/licenses/quick-guide-gplv3.html).
An executable or environment bundle containing Gmsh must still ship Gmsh's
license text and its corresponding source, or a written offer for it.

## OpenFOAM and cfMesh

The setup uses OpenCFD OpenFOAM v2606 and its available cfMesh tools as external
WSL executables. OpenFOAM is [distributed under GPLv3](https://www.openfoam.com/documentation/licencing).
Preserve the license and source obligations of the exact cfMesh/OpenFOAM package
when redistributing it. Magnusim writes case inputs and invokes these executables;
it does not relicense their implementations.

## Magnusim CAD plugin

The optional CAD plugin (`magnusim-web/bundled-plugins/cad`) ships Open CASCADE
Technology 7.9.3 (LGPL-2.1 with the Open CASCADE exception) and FreeCAD's
PlaneGCS sketch solver (LGPL) as WebAssembly modules, with Eigen (MPL-2.0),
Boost headers (BSL-1.0), the Emscripten and LLVM runtimes, musl, three.js and
three-mesh-bvh (MIT). Their license texts, the pinned sources, our patches and
the build scripts that rebuild both modules are in the plugin's `LICENSES/`,
`kernel-build/` and `solver-build/` folders (see `LICENSES/README.md`).

## XFOIL and the Airfoil plugin

The optional Airfoil plugin (`magnusim-web/bundled-plugins/airfoil`) runs XFOIL
6.99 (Mark Drela and Harold Youngren, MIT) as a separate program,
`xfoil/bin/xfoil.exe`, driven through its standard input; nothing of XFOIL is
linked into Magnusim. XFOIL's sources are GPL version 2 or (at your option) any
later version, and its plot library (`plotlib`) is GNU Library GPL version 2 or
later; both are distributed here under GPL-3.0-or-later. The official licence
statement is on the [XFOIL page](https://web.mit.edu/drela/Public/web/xfoil/).

`xfoil/bin/xfoil.exe` is MIT's own Windows build of XFOIL 6.99, unmodified, from
<https://web.mit.edu/drela/Public/web/xfoil/XFOIL6.99.zip> (SHA-256
`e13e8fe5cc38d8ac2626e9d3b17643bdcfaa63791619f042afdaa7cd103bcb08`). It ships in
the plugin's `xfoil/` folder with:

- its source, `xfoil/source/Xfoil699src.zip`, as MIT ships it inside the same zip;
- MIT's 6.99 source tarball, `xfoil/source/xfoil6.99.tgz`, from
  <https://web.mit.edu/drela/Public/web/xfoil/xfoil6.99.tgz>;
- the licence texts in `xfoil/LICENSES/`: GPL version 2 (MIT's
  [`gpl.txt`](https://web.mit.edu/drela/Public/web/gpl.txt)), the plot library's
  LGPL version 2 (`plotlib/GPL-library` from the tarball), GPL version 3, and the
  GCC Runtime Library Exception 3.1 for the GNU Fortran runtime (GCC 4.5.2, MinGW)
  linked into the program;
- `xfoil/README.md`, which says how the files were obtained and that none was
  changed.

| File | SHA-256 |
|---|---|
| `xfoil/bin/xfoil.exe` | `c17342f84ae260c2b11a74cd0e2fb8189a5f8954c6bb7a8467a0f27055c7faea` |
| `xfoil/source/Xfoil699src.zip` | `940bdb5be4d0345a5062cfb430c90d1d9411f4db00ca283a48e5a1de940d08c7` |
| `xfoil/source/xfoil6.99.tgz` | `5c0250643f52ce0e75d7338ae2504ce7907f2d49a30f921826717b8ac12ebe40` |
| `xfoil/LICENSES/GPL-2.0.txt` | `e6d6a009505e345fe949e1310334fcb0747f28dae2856759de102ab66b722cb4` |

The plugin's own Python environment, installed on demand from its pinned
`requirements.lock`, holds NeuralFoil and AeroSandbox (MIT), NumPy, SciPy,
pandas, seaborn and dill (BSD), Matplotlib (its PSF-style licence), CasADi
(LGPL-3.0), Gmsh (GPL-2.0-or-later), tqdm (MPL-2.0 and MIT), Pillow (MIT-CMU)
and their dependencies; none of them is shipped in the repository. The plugin's
OpenFOAM 2D engine meshes with that Gmsh and runs its cases in the WSL OpenFOAM
described above (gmshToFoam, extrudeMesh, createPatch, checkMesh, simpleFoam); the
plugin ships no part of OpenFOAM, only the case dictionaries it writes.

## Other dependencies

The JavaScript dependency inventory is recorded in `magnusim-web/package-lock.json`;
Python requirements are in `magnusim-web/python/pyproject.toml` and its lockfile.
React, vtk.js, PyVista, NumPy, SciPy, and Open CASCADE/cadquery-ocp retain their
upstream licenses. An installed application bundle needs the notices for its
actual dependency versions, including transitive dependencies. The frozen
hexcore reference directory retains its existing contents and provenance.

## Colour maps

The results colour maps in `magnusim-web/src/plugin-ui/colormaps/` are data
tables from viridis (mpl-colormaps, Nathaniel Smith and Stefan van der Walt,
CC0 1.0) and cmocean balance and curl (Kristen M. Thyng, MIT). Their license
texts are in that folder's `LICENSES/`.
