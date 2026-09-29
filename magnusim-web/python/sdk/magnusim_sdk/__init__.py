"""magnusim_sdk: the helpers a Magnusim plugin may use, with no dependencies.

Standard library only (numpy is imported lazily by ``msh22``). Importing this
package never pulls in OCP, pyvista, gmsh or numpy, so a plugin environment
can use it without the core's packages. The core re-imports these modules, so
each helper has one copy.

Modules: ``events`` (job event lines), ``units`` (unit conversion), ``foam``
(OpenFOAM dictionary and field writers), ``gmsh_helpers``, ``msh22`` (MSH 2.2
writer) and ``proc`` (run a program with a timeout, killing its whole tree).
"""

SDK_VERSION = "1.1.0"

__all__ = ["SDK_VERSION"]
