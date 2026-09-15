"""Built-in domain specs (Phase 2)."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


def register_builtins(hub: "RegistryHub") -> None:
    """Register built-in specs into `hub`.

    Phase 2 land4: AnalysisType + SolverApps + MeshBackends.
    Later lands add Material / Monitor / Filter / BC wrap.
    Idempotent under load_all retries (same-plugin re-register).
    Cross-ref validation (solver bags) runs at end of load_all (after plugins).
    """
    from cfddesk.builtin.incompressible import register_incompressible
    from cfddesk.builtin.meshers import register_meshers
    from cfddesk.builtin.solvers_openfoam import register_openfoam_solvers

    # Solvers first so analysis bag keys can resolve against the registry.
    register_openfoam_solvers(hub)
    register_meshers(hub)
    register_incompressible(hub)
