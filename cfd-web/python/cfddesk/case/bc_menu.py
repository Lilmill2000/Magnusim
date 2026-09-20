"""Nested BC type → variant → (sub-variant) menu over flat registry keys.

Product menu: Velocity inlet, Velocity outlet, Pressure, Wall.
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
                _mv(
                    "flow_rate",
                    "Flow rate",
                    "velocity_inlet_volumetric",
                    (
                        ("volumetric", "Volumetric flow", "velocity_inlet_volumetric"),
                        ("mass", "Mass flow", "velocity_inlet_mass"),
                    ),
                ),
            ),
        ),
        MenuType(
            "velocity_outlet",
            "Velocity outlet",
            (_mv("fixed_value", "Fixed value", "velocity_outlet"),),
        ),
        MenuType(
            "pressure_outlet",
            "Pressure",
            (_mv("fixed_gauge", "Fixed value", "pressure_outlet_gauge"),),
        ),
        MenuType(
            "wall",
            "Wall",
            (
                _mv("noslip", "No-slip", "wall_noslip"),
                _mv("slip", "Slip", "wall_slip"),
            ),
        ),
    ]
    _LEGACY_MAP.clear()
    for mt in MENU:
        for var in mt.variants:
            if var.subvariants:
                for sk, _sl, reg in var.subvariants:
                    _LEGACY_MAP[reg] = (mt.key, var.key, sk)
            else:
                _LEGACY_MAP[var.registry_key] = (mt.key, var.key, None)


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
    raise KeyError(f"Unknown BC registry key {registry_key!r}")


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
