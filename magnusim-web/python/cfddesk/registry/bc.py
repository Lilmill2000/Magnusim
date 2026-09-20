"""BC type registry wrap (Phase 2 land5).

Registers existing case.bc_registry.BcTypeSpec objects into RegistryHub.
Does NOT rewrite bc_registry call sites ? BC_TYPES / get_type / writers stay.

Note: do not import bc_registry at module top-level ? bc_registry imports
registry.schema, and loading cfddesk.registry.__init__ would otherwise cycle.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from cfddesk.registry.base import RegistryError

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


def register_builtin_bcs(hub: RegistryHub) -> None:
    """Register every BC_TYPES entry (idempotent same-plugin re-register)."""
    from cfddesk.case.bc_registry import BC_TYPES

    reg = hub.registry("bc")
    for spec in BC_TYPES.values():
        reg.register(spec, plugin="builtin")


def validate_analysis_bc_refs(hub: RegistryHub) -> None:
    """Fail if any AnalysisType.bc_types key is not registered.

    Soft-pass: keep bc_types as tuple[str] wired to the bc registry ? no third list.
    """
    bc_keys = set(hub.registry("bc").keys())
    for spec in hub.registry("analysis").items():
        bag = tuple(getattr(spec, "bc_types", ()) or ())
        unknown = [k for k in bag if k not in bc_keys]
        if unknown:
            key = getattr(spec, "key", "?")
            raise RegistryError(
                f"analysis {key!r}: unknown bc key(s) {unknown}; "
                f"registered bcs={sorted(bc_keys)}"
            )
