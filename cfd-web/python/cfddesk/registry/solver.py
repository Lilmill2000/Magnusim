"""SolverBackend registry spec (Phase 2 land3)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Literal

from cfddesk.registry.base import RegistryError
from cfddesk.registry.requirements import Requirement

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub

TimeDependency = Literal["steady", "transient"]
ParallelMode = Literal["mpirun", "none"]
StopStrategy = Literal["stopAt_writeNow", "sigterm"]


@dataclass(frozen=True)
class SolverBackend:
    """Registered OpenFOAM (or other) solver application backend."""

    key: str
    label: str
    application: str
    time_dependency: TimeDependency
    parallel: ParallelMode
    stop_strategy: StopStrategy
    # Optional stubs this land — residual/Courant parsers + writers stay in
    # Phase 1 paths until a later land moves them (soft-pass).
    residual_line: Callable[[str], dict[str, Any] | None] | None = None
    extra_lines: Callable[[str], dict[str, Any] | None] | None = None
    write_fv_solution: Callable[..., None] | None = None
    write_control_dict: Callable[..., None] | None = None
    script_template: str = "solve.sh"
    requires: tuple[Requirement, ...] = ()


def validate_analysis_solver_refs(hub: "RegistryHub") -> None:
    """Fail if any AnalysisType.solver_backends / default_solver is not registered.

    Keeps AnalysisType.solver_backends as tuple[str] (no third free-string list)
    by wiring keys to the solver registry after builtins register.
    """
    solver_keys = set(hub.registry("solver").keys())
    for spec in hub.registry("analysis").items():
        backends = tuple(getattr(spec, "solver_backends", ()) or ())
        default = getattr(spec, "default_solver", None)
        unknown: list[str] = [k for k in backends if k not in solver_keys]
        if isinstance(default, str) and default and default not in solver_keys:
            if default not in unknown:
                unknown.append(default)
        if unknown:
            key = getattr(spec, "key", "?")
            raise RegistryError(
                f"analysis {key!r}: unknown solver key(s) {unknown}; "
                f"registered solvers={sorted(solver_keys)}"
            )
