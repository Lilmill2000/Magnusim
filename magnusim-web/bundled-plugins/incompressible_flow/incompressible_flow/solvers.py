"""Built-in OpenFOAM SolverApp specs: the programs Incompressible Flow runs.

The case files are written by the analysis (write_case); a SolverApp only
names the program, how it runs in parallel and how it is stopped.
"""

from __future__ import annotations

from cfddesk.registry.requirements import Requirement
from cfddesk.registry.solver import SolverApp


def build_simple_foam() -> SolverApp:
    return SolverApp(
        key="simpleFoam",
        label="simpleFoam (SIMPLE steady)",
        application="simpleFoam",
        time_dependency="steady",
        parallel="mpirun",
        stop_strategy="stopAt_writeNow",
        script_template="solve",
        requires=(Requirement("wsl_tool", "simpleFoam"),),
    )


def build_pimple_foam() -> SolverApp:
    return SolverApp(
        key="pimpleFoam",
        label="pimpleFoam (PIMPLE transient)",
        application="pimpleFoam",
        time_dependency="transient",
        parallel="mpirun",
        stop_strategy="stopAt_writeNow",
        script_template="solve",
        requires=(Requirement("wsl_tool", "pimpleFoam"),),
    )
