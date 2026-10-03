"""Built-in JobKind specs. Mesh and solve scripts stay the existing tool names."""

from __future__ import annotations

from typing import TYPE_CHECKING

from cfddesk.registry.jobs import JobKind

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


def register_job_kinds(hub: RegistryHub) -> None:
    """Register mesh, solve, solve.prepare and cad_import (idempotent same-plugin)."""
    reg = hub.registry("job")
    reg.register(
        JobKind(
            key="mesh",
            tool="generate_standard.py",
            scope="study",
            args_from_params=("project_id", "simulation_id", "mesh_id"),
        ),
        plugin="builtin",
    )
    reg.register(
        JobKind(
            key="solve",
            tool="solve.sh",
            scope="study",
            args_from_params=("project_id", "simulation_id", "run_id"),
        ),
        plugin="builtin",
    )
    # API 1.5: writes a run's case for an analysis that names no
    # LaunchSpec.prepare_job (contract.BUILTIN_PREPARE_JOB): prepare_run.py, which
    # calls the analysis's write_case into MAGNUSIM_CASE_DIR.
    reg.register(
        JobKind(
            key="solve.prepare",
            tool="prepare_run.py",
            scope="study",
            args_from_params=("run_id", "mesh_id", "simulation_id", "time_dependency", "n_procs", "transient"),
        ),
        plugin="builtin",
    )
    reg.register(
        JobKind(
            key="cad_import",
            tool="convert_step_to_stl.py",
            scope="geometry",
            args_from_params=("project_id", "geometry_id"),
        ),
        plugin="builtin",
    )
