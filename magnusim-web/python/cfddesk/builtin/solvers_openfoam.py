"""Built-in OpenFOAM SolverApp specs (Phase 2 land3)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from cfddesk.registry.requirements import Requirement
from cfddesk.registry.solver import SolverApp

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


def _residual_line(line: str) -> dict[str, Any] | None:
    from cfddesk.wsl.solve_run import parse_residual_line

    return parse_residual_line(line)


def _extra_lines(line: str) -> dict[str, Any] | None:
    from cfddesk.wsl.solve_run import parse_extra_line

    return parse_extra_line(line)


def _write_fv_cpu(*args: Any, **kwargs: Any) -> None:
    from cfddesk.case.writer import write_fv_solution_cpu

    write_fv_solution_cpu(*args, **kwargs)


def _write_fv_amgx(*args: Any, **kwargs: Any) -> None:
    from cfddesk.case.writer import write_fv_solution_amgx

    write_fv_solution_amgx(*args, **kwargs)


def _write_fv_pimple(*args: Any, **kwargs: Any) -> None:
    from cfddesk.case.writer import write_fv_solution_pimple

    write_fv_solution_pimple(*args, **kwargs)


def _write_control(*args: Any, **kwargs: Any) -> None:
    from cfddesk.case.writer import write_control_dict

    write_control_dict(*args, **kwargs)


def _write_control_transient(*args: Any, **kwargs: Any) -> None:
    from cfddesk.case.writer import write_control_dict_transient

    write_control_dict_transient(*args, **kwargs)


def build_simple_foam() -> SolverApp:
    return SolverApp(
        key="simpleFoam",
        label="simpleFoam (SIMPLE steady)",
        application="simpleFoam",
        time_dependency="steady",
        parallel="mpirun",
        stop_strategy="stopAt_writeNow",
        residual_line=_residual_line,
        extra_lines=_extra_lines,
        write_fv_solution=_write_fv_cpu,
        write_control_dict=_write_control,
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
        residual_line=_residual_line,
        extra_lines=_extra_lines,
        write_fv_solution=_write_fv_pimple,
        write_control_dict=_write_control_transient,
        script_template="solve",
        requires=(Requirement("wsl_tool", "pimpleFoam"),),
    )


def build_simple_foam_amgx() -> SolverApp:
    """AmgX-on-p variant of simpleFoam (serial-only; same binary application)."""
    return SolverApp(
        key="simpleFoam_amgx",
        label="simpleFoam + AmgX (p)",
        application="simpleFoam",
        time_dependency="steady",
        parallel="none",  # AmgX path is serial-only (N=1) in runner/parallel.py
        stop_strategy="stopAt_writeNow",
        residual_line=_residual_line,
        extra_lines=_extra_lines,
        write_fv_solution=_write_fv_amgx,
        write_control_dict=_write_control,
        script_template="solve",
        requires=(
            Requirement("wsl_tool", "simpleFoam"),
            Requirement("gpu", "cuda"),
        ),
    )


def register_openfoam_solvers(hub: RegistryHub) -> None:
    """Register simpleFoam / pimpleFoam / simpleFoam_amgx (idempotent same-plugin)."""
    reg = hub.registry("solver")
    reg.register(build_simple_foam(), plugin="builtin")
    reg.register(build_pimple_foam(), plugin="builtin")
    reg.register(build_simple_foam_amgx(), plugin="builtin")
