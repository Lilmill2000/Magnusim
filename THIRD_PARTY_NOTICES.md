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

## Other dependencies

The JavaScript dependency inventory is recorded in `magnusim-web/package-lock.json`;
Python requirements are in `magnusim-web/python/pyproject.toml` and its lockfile.
React, vtk.js, PyVista, NumPy, SciPy, and Open CASCADE/cadquery-ocp retain their
upstream licenses. An installed application bundle needs the notices for its
actual dependency versions, including transitive dependencies. The frozen
hexcore reference directory retains its existing contents and provenance.
