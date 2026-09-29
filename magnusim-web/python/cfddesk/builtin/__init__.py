"""Built-in domain specs (Phase 2)."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


def register_builtins(hub: RegistryHub) -> None:
    """Register built-in specs into `hub`.

    The platform: jobs, meshers, BC types, materials, monitors and result
    filters. Simulation types (AnalysisType + their SolverApps) come from
    plugins; Incompressible Flow is the required bundled plugin
    (bundled-plugins/incompressible_flow).
    Idempotent under load_all retries (same-plugin re-register).
    Cross-ref validation (solver / bc / material / monitor bags) runs at end of
    load_all (after plugins).
    """
    from cfddesk.builtin.filters import register_filters
    from cfddesk.builtin.jobs import register_job_kinds
    from cfddesk.builtin.materials import register_materials
    from cfddesk.builtin.meshers import register_meshers
    from cfddesk.builtin.monitors import register_monitors
    from cfddesk.registry.bc import register_builtin_bcs

    # Jobs first so mesher.generate can resolve them after load_all.
    register_job_kinds(hub)
    register_meshers(hub)
    register_builtin_bcs(hub)
    register_materials(hub)
    register_monitors(hub)
    register_filters(hub)
