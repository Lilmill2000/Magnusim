"""Intensive / extensive OpenFOAM patch emission from boundary conditions.

Intensive BCs (velocity, pressure, …) merge all faces into one patch.
Extensive BCs (volumetric/mass flow, heat flux, …) emit one patch per face
named ``<patch>_1`` … ``<patch>_N`` (1-based).

Periodic halves are always intensive-merged and use ``patch_type='patch'`` at
the snappy stage; conversion to ``cyclic`` happens post-mesh via createPatch.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class EmittedPatch:
    name: str
    patch_type: str  # patch|wall|symmetry (never cyclic at snappy stage for Periodic)
    face_ids: tuple[int, ...]
    bc_id: str
    refinement_level: int


def _is_periodic(bc: Any, variant_spec: Any) -> bool:
    if str(getattr(bc, "type", "")).lower() == "periodic":
        return True
    from cfddesk.case.bc_menu import registry_key_for_bc

    if registry_key_for_bc(bc) == "periodic":
        return True
    semantic = getattr(variant_spec, "semantic", None)
    return semantic is not None and str(semantic).lower() == "periodic"


def emission_is_extensive(bc: Any, settings: dict, variant_spec) -> bool:
    """True when the *active* settings make an extensive rate field apply.

    Schema alone is not enough: wall thermal schemas always list
    ``heat_flux_W_m2`` with ``rate_kind=extensive``, but adiabatic / no-energy
    walls must stay intensive (one ``walls`` patch), not ``walls_1…N``.
    """
    if _is_periodic(bc, variant_spec):
        return False
    schema = getattr(variant_spec, "settings_schema", ()) or ()
    settings = settings if isinstance(settings, dict) else {}
    for field in schema:
        if getattr(field, "rate_kind", "none") != "extensive":
            continue
        if getattr(field, "energy_only", False):
            mode = str(settings.get("thermal_mode", "adiabatic"))
            if field.key == "heat_flux_W_m2" and mode == "fixed_heat_flux":
                return True
            continue
        return True
    return False


def emit_patches_for_bc(
    bc,
    *,
    get_variant_spec: Callable[[Any], Any],
    patch_type_for: Callable[..., str],
) -> list[EmittedPatch]:
    """
    intensive: one EmittedPatch with all face_ids under bc.patch_name
    extensive: one per face named f"{bc.patch_name}_{i}" (1-based), single face_id each
    Skip BCs with empty face_ids.
    For Periodic (semantic or type): always intensive merge, patch_type='patch' at snappy stage.
    """
    face_ids = tuple(int(f) for f in (bc.face_ids or ()))
    if not face_ids:
        return []

    variant_spec = get_variant_spec(bc)
    level = int(getattr(bc, "refinement_level", 1))
    bc_id = str(bc.id)

    from cfddesk.case.bc_menu import registry_key_for_bc

    reg_key = registry_key_for_bc(bc)
    settings = getattr(bc, "settings", None) or {}

    if _is_periodic(bc, variant_spec):
        return [
            EmittedPatch(
                name=str(bc.patch_name),
                patch_type="patch",
                face_ids=face_ids,
                bc_id=bc_id,
                refinement_level=level,
            )
        ]

    ptype = str(patch_type_for(reg_key, settings))
    if emission_is_extensive(bc, settings, variant_spec):
        return [
            EmittedPatch(
                name=f"{bc.patch_name}_{i}",
                patch_type=ptype,
                face_ids=(fid,),
                bc_id=bc_id,
                refinement_level=level,
            )
            for i, fid in enumerate(face_ids, start=1)
        ]

    return [
        EmittedPatch(
            name=str(bc.patch_name),
            patch_type=ptype,
            face_ids=face_ids,
            bc_id=bc_id,
            refinement_level=level,
        )
    ]


def emit_all_patches(project) -> list[EmittedPatch]:
    """All BCs with faces, sorted by name."""
    from cfddesk.case.bc_menu import registry_key_for_bc
    from cfddesk.case.bc_registry import get_type, patch_type_for

    def get_variant_spec(bc: Any) -> Any:
        return get_type(registry_key_for_bc(bc))

    out: list[EmittedPatch] = []
    for bc in project.boundary_conditions:
        out.extend(
            emit_patches_for_bc(
                bc,
                get_variant_spec=get_variant_spec,
                patch_type_for=patch_type_for,
            )
        )
    return sorted(out, key=lambda p: p.name)
