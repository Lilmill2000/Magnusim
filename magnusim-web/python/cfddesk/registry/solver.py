"""SolverApp registry spec (Phase 2 land3 / land3-fix)."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from cfddesk.registry.base import RegistryError
from cfddesk.registry.requirements import Requirement

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub

log = logging.getLogger(__name__)

TimeDependency = Literal["steady", "transient"]
ParallelMode = Literal["mpirun", "none"]
StopStrategy = Literal["stopAt_writeNow", "sigterm"]


@dataclass(frozen=True)
class SolverApp:
    """Registered OpenFOAM (or other) solver application."""

    key: str
    label: str
    application: str
    time_dependency: TimeDependency
    parallel: ParallelMode
    stop_strategy: StopStrategy
    # Built-ins delegate to solve_run / writer. None remains valid for a plugin
    # that has not filled a parser yet (soft-pass).
    residual_line: Callable[[str], dict[str, Any] | None] | None = None
    extra_lines: Callable[[str], dict[str, Any] | None] | None = None
    write_fv_solution: Callable[..., None] | None = None
    write_control_dict: Callable[..., None] | None = None
    # A solve JobKind (one whose tool is solve.sh). Anything else is ignored with
    # a note in Settings > Plugins (script_template_notes).
    script_template: str = "solve"
    requires: tuple[Requirement, ...] = ()


def _solve_job(hub: RegistryHub, key: str) -> bool:
    """Whether ``key`` names a solve job: a JobKind whose tool is solve.sh (the builtin ``solve``)."""
    from cfddesk.wsl.solve_run import solve_template_path

    jobs = hub.registry("job")
    if not key or key not in jobs.keys():
        return False
    spec = jobs.get(key)
    return jobs.owner(key) == "builtin" and str(getattr(spec, "tool", "")) == solve_template_path().name


# (plugin, solver key, value) already logged.
_TEMPLATE_SAID: set[tuple[str, str, str]] = set()


def script_template_notes(hub: RegistryHub, plugin_key: str) -> list[str]:
    """A note for each SolverApp of ``plugin_key`` whose ``script_template`` is not a
    solve job. The value is ignored (every solve runs solve.sh); the plugin still loads."""
    notes: list[str] = []
    reg = hub.registry("solver")
    for key in reg.keys():
        if reg.owner(key) != plugin_key:
            continue
        app = reg.get(key)
        value = str(getattr(app, "script_template", "") or "")
        if _solve_job(hub, value):
            continue
        label = str(getattr(app, "label", "") or key)
        notes.append(f'Solver {label}: script_template "{value}" is not a solve job, so it is ignored. Solves use solve.sh.')
        said = (str(plugin_key), str(key), value)
        if said not in _TEMPLATE_SAID:
            _TEMPLATE_SAID.add(said)
            log.warning("plugin %s solver %s: script_template %r is not a solve job; ignored", plugin_key, key, value)
    return notes


def validate_analysis_solver_refs(hub: RegistryHub) -> None:
    """Fail if any AnalysisType.solver_backends / default_solver is not registered.

    Keeps AnalysisType.solver_backends as tuple[str] (no third free-string list)
    by wiring keys to the solver registry after builtins + plugins register.
    Called at end of load_all (after plugin discovery), not only from builtins.
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
