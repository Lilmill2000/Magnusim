"""Built-in OpenFOAM SolverBackend specs (Phase 2 land3)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from cfddesk.registry.requirements import Requirement
from cfddesk.registry.solver import SolverBackend

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


def build_simple_foam() -> SolverBackend:
    return SolverBackend(
        key="simpleFoam",
        label="simpleFoam (SIMPLE steady)",
        application="simpleFoam",
        time_dependency="steady",
        parallel="mpirun",
        stop_strategy="stopAt_writeNow",
        residual_line=None,  # NOT_yet_done: still in wsl/solve_run Phase 1 parsers
        extra_lines=None,
        write_fv_solution=None,  # NOT_yet_done: case/writer + web_case remain authoritative
        write_control_dict=None,
        script_template="solve.sh",
        requires=(Requirement("wsl_tool", "simpleFoam"),),
    )


def build_pimple_foam() -> SolverBackend:
    return SolverBackend(
        key="pimpleFoam",
        label="pimpleFoam (PIMPLE transient)",
        application="pimpleFoam",
        time_dependency="transient",
        parallel="mpirun",
        stop_strategy="stopAt_writeNow",
        residual_line=None,
        extra_lines=None,
        write_fv_solution=None,
        write_control_dict=None,
        script_template="solve.sh",
        requires=(Requirement("wsl_tool", "pimpleFoam"),),
    )


def build_simple_foam_amgx() -> SolverBackend:
    """AmgX-on-p variant of simpleFoam (serial-only; same binary application)."""
    return SolverBackend(
        key="simpleFoam_amgx",
        label="simpleFoam + AmgX (p)",
        application="simpleFoam",
        time_dependency="steady",
        parallel="none",  # AmgX path is serial-only (N=1) in runner/parallel.py
        stop_strategy="stopAt_writeNow",
        residual_line=None,
        extra_lines=None,
        write_fv_solution=None,
        write_control_dict=None,
        script_template="solve.sh",
        requires=(
            Requirement("wsl_tool", "simpleFoam"),
            Requirement("gpu", "cuda"),
        ),
    )


def register_openfoam_solvers(hub: "RegistryHub") -> None:
    """Register simpleFoam / pimpleFoam / simpleFoam_amgx (idempotent same-plugin)."""
    reg = hub.registry("solver")
    reg.register(build_simple_foam(), plugin="builtin")
    reg.register(build_pimple_foam(), plugin="builtin")
    reg.register(build_simple_foam_amgx(), plugin="builtin")
