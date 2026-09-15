"""Built-in domain specs (Phase 2)."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


def register_builtins(hub: "RegistryHub") -> None:
    """Register built-in specs into `hub`.

    Phase 2 land3: AnalysisType incompressible_* + OpenFOAM SolverBackends.
    Later lands add Mesh / Material / Monitor / Filter.
    Idempotent under load_all retries (same-plugin re-register).
    """
    from cfddesk.builtin.incompressible import register_incompressible
    from cfddesk.builtin.solvers_openfoam import register_openfoam_solvers
    from cfddesk.registry.solver import validate_analysis_solver_refs

    # Solvers first so analysis bag keys can resolve against the registry.
    register_openfoam_solvers(hub)
    register_incompressible(hub)
    validate_analysis_solver_refs(hub)
