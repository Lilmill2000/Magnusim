"""Built-in domain specs (Phase 2). Land1 registers zero domain specs."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


def register_builtins(hub: "RegistryHub") -> None:
    """Register built-in specs into `hub`.

    Phase 2 land1: intentionally empty — AnalysisType / Solver / Mesh / etc.
    land in later Phase 2 steps. Ensures load_all() has a stable hook.
    """
    _ = hub  # hub kinds are created on demand by plugins / later lands
