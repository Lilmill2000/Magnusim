"""Built-in domain specs (Phase 2)."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


def register_builtins(hub: RegistryHub) -> None:
    """Register built-in specs into `hub`.

    The platform: jobs, meshers and result filters. Simulation types
    (AnalysisType + their SolverApps) and the BC types, materials and monitors
    they use come from plugins; Incompressible Flow is the required bundled plugin
    (bundled-plugins/incompressible_flow).
    Idempotent under load_all retries (same-plugin re-register).
    Cross-ref validation (solver / bc / material / monitor bags) runs at end of
    load_all (after plugins).
    """
    from cfddesk.builtin.filters import register_filters
    from cfddesk.builtin.jobs import register_job_kinds
    from cfddesk.builtin.meshers import register_meshers

    # Jobs first so mesher.generate can resolve them after load_all.
    register_job_kinds(hub)
    register_meshers(hub)
    register_filters(hub)
    # The BC kinds exist (empty) even when no plugin registers into them.
    hub.registry("bc")
    hub.registry("bc_family")
