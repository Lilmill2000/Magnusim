"""Built-in domain specs (Phase 2)."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


def register_builtins(hub: "RegistryHub") -> None:
    """Register built-in specs into `hub`.

    Phase 2 land2: AnalysisType incompressible_steady / incompressible_transient.
    Later lands add Solver / Mesh / Material / Monitor / Filter.
    Idempotent under load_all retries (same-plugin re-register).
    """
    from cfddesk.builtin.incompressible import register_incompressible

    register_incompressible(hub)
