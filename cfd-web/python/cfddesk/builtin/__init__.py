"""Built-in domain specs (Phase 2)."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


def register_builtins(hub: "RegistryHub") -> None:
    """Register built-in specs into `hub`.

    Phase 2 land5: AnalysisType + SolverApps + MeshBackends + BC wrap +
    MaterialModel + MonitorType.
    Idempotent under load_all retries (same-plugin re-register).
    Cross-ref validation (solver / bc / material / monitor bags) runs at end of
    load_all (after plugins).
    """
    from cfddesk.builtin.incompressible import register_incompressible
    from cfddesk.builtin.materials import register_materials
    from cfddesk.builtin.meshers import register_meshers
    from cfddesk.builtin.monitors import register_monitors
    from cfddesk.builtin.solvers_openfoam import register_openfoam_solvers
    from cfddesk.registry.bc import register_builtin_bcs

    # Solvers / meshers / bc / material / monitor first so analysis bag keys resolve.
    register_openfoam_solvers(hub)
    register_meshers(hub)
    register_builtin_bcs(hub)
    register_materials(hub)
    register_monitors(hub)
    register_incompressible(hub)
