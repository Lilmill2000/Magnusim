"""Nested BC type → variant → (sub-variant) menu over flat registry keys.

Legacy flat keys (``velocity_inlet_fixed``, …) remain the resolved writer keys.
On-disk v8 stores ``type`` (menu) + ``variant`` (+ optional ``subvariant``).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from cfddesk.case.bc_registry import BC_TYPES, BcTypeSpec, get_type


@dataclass(frozen=True)
class MenuVariant:
    key: str
    label: str
    registry_key: str  # key into BC_TYPES
    subvariants: tuple[tuple[str, str, str], ...] = ()  # (key, label, registry_key)


@dataclass(frozen=True)
class MenuType:
    key: str
    label: str
    variants: tuple[MenuVariant, ...]
    supported: bool = True
    unsupported_reason: str = ""


# Flat legacy key → (menu_type, variant, subvariant|None)
_LEGACY_MAP: dict[str, tuple[str, str, str | None]] = {}

MENU: list[MenuType] = []


def _mv(key: str, label: str, reg: str, subs: tuple[tuple[str, str, str], ...] = ()) -> MenuVariant:
    return MenuVariant(key, label, reg, subs)


def _build() -> None:
    global MENU
    MENU = [
        MenuType(
            "velocity_inlet",
            "Velocity inlet",
            (
                _mv("fixed_value", "Fixed value", "velocity_inlet_fixed"),
                _mv("mean_value", "Mean value", "velocity_inlet_mean"),
                _mv(
                    "flow_rate",
                    "Flow rate",
                    "velocity_inlet_volumetric",
                    (
                        ("volumetric", "Volumetric flow", "velocity_inlet_volumetric"),
                        ("mass", "Mass flow", "velocity_inlet_mass"),
                    ),
                ),
                _mv("freestream", "Freestream", "velocity_inlet_freestream"),
            ),
        ),
        MenuType(
            "velocity_outlet",
            "Velocity outlet",
            (_mv("fixed_value", "Fixed value", "velocity_outlet"),),
        ),
        MenuType(
            "pressure_inlet",
            "Pressure inlet",
            (
                _mv("fixed_gauge", "Fixed gauge", "pressure_inlet_gauge"),
                _mv("total_pressure", "Total pressure", "pressure_inlet_total"),
            ),
        ),
        MenuType(
            "pressure_outlet",
            "Pressure outlet",
            (
                _mv("fixed_gauge", "Fixed gauge", "pressure_outlet_gauge"),
                _mv("total_pressure", "Total pressure", "pressure_outlet_total"),
                _mv("mean_value", "Mean value", "pressure_outlet_mean"),
            ),
        ),
        MenuType(
            "wall",
            "Wall",
            (
                _mv("noslip", "No-slip", "wall_noslip"),
                _mv("slip", "Slip", "wall_slip"),
                _mv("moving", "Moving", "wall_moving"),
                _mv("rotating", "Rotating", "wall_rotating"),
            ),
        ),
        MenuType("fan", "Fan", (_mv("default", "Fan", "fan"),)),
        MenuType("symmetry", "Symmetry", (_mv("default", "Symmetry", "symmetry"),)),
        MenuType(
            "periodic",
            "Periodic",
            (_mv("default", "Periodic", "periodic"),),
            supported=False,
            unsupported_reason=(
                "Periodic requires conformal opposite faces for createPatch cyclic "
                "matching. The app meshes STEP geometry with snappyHexMesh, whose "
                "opposite faces are not point-matched. Not supported until a "
                "conformal mesh path exists."
            ),
        ),
        MenuType(
            "wedge",
            "Wedge",
            (_mv("default", "Wedge", "wedge"),),
            supported=False,
            unsupported_reason=(
                "Wedge requires two patches at a small angle about an axis on an "
                "axisymmetric mesh. Not supported in this release."
            ),
        ),
        MenuType(
            "empty",
            "Empty 2D",
            (_mv("default", "Empty", "empty"),),
            supported=False,
            unsupported_reason=(
                "Empty requires a front/back patch pair on a one-cell-thick 2D mesh. "
                "Not supported in this release."
            ),
        ),
        MenuType("custom", "Custom", (_mv("default", "Custom (raw OpenFOAM)", "custom"),)),
    ]
    _LEGACY_MAP.clear()
    for mt in MENU:
        for var in mt.variants:
            if var.subvariants:
                for sk, _sl, reg in var.subvariants:
                    _LEGACY_MAP[reg] = (mt.key, var.key, sk)
            else:
                _LEGACY_MAP[var.registry_key] = (mt.key, var.key, None)
    # Keep natural_convection as legacy-only (not in SimScale menu)
    _LEGACY_MAP["natural_convection"] = ("custom", "default", None)


_build()


def menu_types() -> list[MenuType]:
    return list(MENU)


def legacy_from_nested(
    menu_type: str, variant: str, subvariant: str | None = None
) -> str:
    for mt in MENU:
        if mt.key != menu_type:
            continue
        for var in mt.variants:
            if var.key != variant:
                continue
            if var.subvariants:
                if not subvariant:
                    # default first sub
                    return var.subvariants[0][2]
                for sk, _sl, reg in var.subvariants:
                    if sk == subvariant:
                        return reg
                raise KeyError(f"Unknown subvariant {subvariant!r}")
            return var.registry_key
    raise KeyError(f"Unknown type/variant {menu_type!r}/{variant!r}")


def nested_from_legacy(registry_key: str) -> tuple[str, str, str | None]:
    if registry_key in _LEGACY_MAP:
        return _LEGACY_MAP[registry_key]
    # Unknown → treat as custom
    return ("custom", "default", None)


def resolve_spec(
    menu_type: str | None,
    variant: str | None,
    subvariant: str | None,
    *,
    legacy_type: str | None = None,
) -> BcTypeSpec:
    if menu_type and variant:
        key = legacy_from_nested(menu_type, variant, subvariant)
        return get_type(key)
    if legacy_type:
        return get_type(legacy_type)
    raise KeyError("Cannot resolve BC type")


def is_menu_supported(menu_type: str) -> bool:
    for mt in MENU:
        if mt.key == menu_type:
            return mt.supported
    return True


def unsupported_reason(menu_type: str) -> str:
    for mt in MENU:
        if mt.key == menu_type:
            return mt.unsupported_reason
    return ""


def migrate_bc_dict(data: dict[str, Any]) -> dict[str, Any]:
    """Ensure v8 nested keys; rewrite flat legacy ``type`` if needed."""
    out = dict(data)
    t = str(out.get("type") or "")
    # Flat registry keys must nest even when variant defaulted to "default".
    if t in BC_TYPES:
        mt, var, sub = nested_from_legacy(t)
        out["type"] = mt
        out["variant"] = var
        if sub:
            out["subvariant"] = sub
        out["registry_key"] = t
        return out
    if out.get("variant"):
        return out
    return out


def registry_key_for_bc(bc: Any) -> str:
    """Resolved flat registry key for writers / emit."""
    rk = getattr(bc, "registry_key", None)
    if rk:
        return str(rk)
    settings = getattr(bc, "settings", None) or {}
    if isinstance(settings, dict) and settings.get("registry_key"):
        return str(settings["registry_key"])
    t = str(getattr(bc, "type", ""))
    if t in BC_TYPES:
        return t
    variant = getattr(bc, "variant", None)
    sub = getattr(bc, "subvariant", None)
    if variant:
        return legacy_from_nested(t, str(variant), str(sub) if sub else None)
    return t
