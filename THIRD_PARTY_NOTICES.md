# Third-party software and distribution

Magnusim's original source is offered under Apache-2.0 (see LICENSE). That license
does not replace the licenses of dependencies or third-party source, assets, or
executables. Setup downloads dependencies separately; this repository does not
grant permission to redistribute those dependencies under Apache-2.0.

## Gmsh and the mesher

Gmsh 4.15.2 is GPL version 2 or later, with its upstream linking exception.
Magnusim calls its Python API from the meshing backend, including
`cfd-web/python/cfddesk/mesh/gmsh_standard.py` and `standard_hexcore.py`.
The official license statement is at [Gmsh licensing](https://gmsh.info/#Licensing).
Retain Gmsh's complete license and exception when distributing Gmsh itself.

Changing the license header of one adapter file to GPL-3.0 does not establish
that the rest of a combined distribution is exempt from GPL obligations.
Apache-2.0 source can participate in a GPLv3 combined work, but the combined
distribution must satisfy the applicable GPL terms, including corresponding
source and notices. See [Apache's compatibility guidance](https://www.apache.org/licenses/GPL-compatibility)
and [GNU's GPLv3 guide](https://www.gnu.org/licenses/quick-guide-gplv3.html).
Before publishing an executable or environment bundle containing Gmsh, decide
the distribution boundary and complete its source/license package. This source
repository's Apache notice is not an Apache-only license for such a bundle.

## OpenFOAM and cfMesh

The setup uses OpenCFD OpenFOAM v2606 and its available cfMesh tools as external
WSL executables. OpenFOAM is [distributed under GPLv3](https://www.openfoam.com/documentation/licencing).
Preserve the license and source obligations of the exact cfMesh/OpenFOAM package
when redistributing it. Magnusim writes case inputs and invokes these executables;
it does not relicense their implementations.

## Other dependencies

The JavaScript dependency inventory is recorded in `cfd-web/package-lock.json`;
Python requirements are in `cfd-web/python/pyproject.toml` and its lockfile.
React, vtk.js, PyVista, NumPy, SciPy, and Open CASCADE/cadquery-ocp retain their
upstream licenses. An installed application bundle needs the notices for its
actual dependency versions, including transitive dependencies. The frozen
hexcore reference directory retains its existing contents and provenance.
