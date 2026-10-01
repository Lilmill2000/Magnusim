"""magnusim_sdk: the helpers a Magnusim plugin may use, with no dependencies.

Standard library only (numpy is imported lazily by ``msh22``). Importing this
package never pulls in OCP, pyvista, gmsh or numpy, so a plugin environment
can use it without the core's packages. The core re-imports these modules, so
each helper has one copy.

Modules: ``events`` (job event lines), ``units`` (unit conversion), ``foam``
(OpenFOAM dictionary and field writers), ``gmsh_helpers``, ``msh22`` (MSH 2.2
writer), ``proc`` (run a program with a timeout, killing its whole tree),
``data`` (a plugin's own folder in a project, and its studies) and ``service``
(a plugin's backend in its own environment: ``python -m magnusim_sdk.service``).
"""

SDK_VERSION = "1.2.0"

__all__ = ["SDK_VERSION"]
