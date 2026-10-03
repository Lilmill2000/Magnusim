"""Legacy (API 1.x) nested BC menu: type -> variant -> (sub-variant) over flat keys.

The menu is built from the hub's BC families (``bc_family``) and their variants
(the BC types they list), so the plugin that registers them names every type.
On-disk v8 project.json stores ``type`` (the family key) + ``variant`` (+ an
optional ``subvariant``); the flat BC type key stays what writers resolve.

Variant and sub-variant keys are stored data. The seven BC type keys projects
have always stored keep their menu keys and labels (``_LEGACY_MENU``), even
when the plugin that owns them is not loaded, so old projects keep loading. A
newer variant's menu keys come from its ``match`` values: the first value picks
the variant, the second the sub-variant.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
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


# BC type key -> (menu type, variant key, variant label, sub key, sub label):
# the menu keys v8 project.json files hold for the seven stored BC type keys.
_LEGACY_MENU: Mapping[str, tuple[str, str, str, str | None, str | None]] = MappingProxyType(
    {
        "velocity_inlet_fixed": ("velocity_inlet", "fixed_value", "Fixed value", None, None),
        "velocity_inlet_volumetric": ("velocity_inlet", "flow_rate", "Flow rate", "volumetric", "Volumetric flow"),
        "velocity_inlet_mass": ("velocity_inlet", "flow_rate", "Flow rate", "mass", "Mass flow"),
        "velocity_outlet": ("velocity_outlet", "fixed_value", "Fixed value", None, None),
        "pressure_outlet_gauge": ("pressure_outlet", "fixed_gauge", "Fixed value", None, None),
        "wall_noslip": ("wall", "noslip", "No-slip", None, None),
        "wall_slip": ("wall", "slip", "Slip", None, None),
    }
)

# Flat registry key -> (menu_type, variant, subvariant|None)
_LEGACY_MAP: dict[str, tuple[str, str, str | None]] = {}

MENU: list[MenuType] = []

_BUILT_FROM: tuple[Any, ...] | None = None


def _mv(key: str, label: str, reg: str, subs: tuple[tuple[str, str, str], ...] = ()) -> MenuVariant:
    return MenuVariant(key, label, reg, subs)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_") or "default"


def _menu_keys(spec: Any, fam_key: str) -> tuple[str, str, str | None, str | None]:
    """(variant key, variant label, sub key, sub label) of one family variant."""
    legacy = _LEGACY_MENU.get(str(spec.key))
    if legacy and legacy[0] == fam_key:
        return legacy[1], legacy[2], legacy[3], legacy[4]
    match = tuple(getattr(spec, "match", ()) or ())
    if not match:
        return "default", str(getattr(spec, "label", "") or spec.key), None, None
    var_label = str(match[0][1])
    if len(match) < 2:
        return _slug(var_label), var_label, None, None
    sub_label = str(match[1][1])
    return _slug(var_label), var_label, _slug(sub_label), sub_label


def _family_menu(fam: Any, bcs: Any) -> MenuType | None:
    variants: list[MenuVariant] = []
    subs_of: dict[str, list[tuple[str, str, str]]] = {}
    order: list[tuple[str, str, str]] = []  # (variant key, label, first registry key)
    for reg_key in getattr(fam, "variants", ()) or ():
        if reg_key not in bcs.keys():
            continue
        var_key, var_label, sub_key, sub_label = _menu_keys(bcs.get(reg_key), str(fam.key))
        if var_key not in {k for k, _l, _r in order}:
            order.append((var_key, var_label, reg_key))
        if sub_key:
            subs_of.setdefault(var_key, []).append((sub_key, str(sub_label), reg_key))
    for var_key, var_label, reg_key in order:
        variants.append(_mv(var_key, var_label, reg_key, tuple(subs_of.get(var_key, ()))))
    if not variants:
        return None
    return MenuType(str(fam.key), str(fam.label), tuple(variants))


def _legacy_menu_types(skip: set[str]) -> list[MenuType]:
    """Menu types for stored keys whose family is not registered (lookups only)."""
    out: dict[str, dict[str, Any]] = {}
    for reg_key, (mt, vk, vl, sk, sl) in _LEGACY_MENU.items():
        if mt in skip:
            continue
        variants = out.setdefault(mt, {})
        row = variants.setdefault(vk, {"label": vl, "reg": reg_key, "subs": []})
        if sk:
            row["subs"].append((sk, str(sl), reg_key))
    return [
        MenuType(mt, mt, tuple(_mv(vk, row["label"], row["reg"], tuple(row["subs"])) for vk, row in variants.items()))
        for mt, variants in out.items()
    ]


def _build() -> None:
    """(Re)build MENU and _LEGACY_MAP when the hub's BC kinds changed."""
    global MENU, _BUILT_FROM
    from cfddesk.case.bc_registry import _bc_registry
    from cfddesk.registry.discovery import get_hub

    bcs = _bc_registry()  # loads the registry once when it is still empty
    hub = get_hub()
    families = hub.registry("bc_family")
    stamp = (id(hub), tuple(bcs.keys()), tuple((k, id(families.get(k))) for k in families.keys()))
    if stamp == _BUILT_FROM:
        return
    menu = [m for m in (_family_menu(fam, bcs) for fam in families.items()) if m is not None]
    legacy_map: dict[str, tuple[str, str, str | None]] = {}
    for mt in menu + _legacy_menu_types({m.key for m in menu}):
        for var in mt.variants:
            if var.subvariants:
                for sk, _sl, reg in var.subvariants:
                    legacy_map.setdefault(reg, (mt.key, var.key, sk))
            else:
                legacy_map.setdefault(var.registry_key, (mt.key, var.key, None))
    MENU = menu
    _LEGACY_MAP.clear()
    _LEGACY_MAP.update(legacy_map)
    _BUILT_FROM = stamp


def _lookup_menu() -> list[MenuType]:
    """The menu plus the stored keys' menu types the hub lacks."""
    _build()
    return MENU + _legacy_menu_types({m.key for m in MENU})


def menu_types() -> list[MenuType]:
    _build()
    return list(MENU)


def legacy_from_nested(
    menu_type: str, variant: str, subvariant: str | None = None
) -> str:
    for mt in _lookup_menu():
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
    _build()
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
    for mt in menu_types():
        if mt.key == menu_type:
            return mt.supported
    return True


def unsupported_reason(menu_type: str) -> str:
    for mt in menu_types():
        if mt.key == menu_type:
            return mt.unsupported_reason
    return ""


def migrate_bc_dict(data: dict[str, Any]) -> dict[str, Any]:
    """Ensure v8 nested keys; rewrite flat legacy ``type`` if needed."""
    out = dict(data)
    t = str(out.get("type") or "")
    # Flat registry keys must nest even when variant defaulted to "default".
    if t in BC_TYPES:
        try:
            mt, var, sub = nested_from_legacy(t)
        except KeyError:  # a BC type no family lists stays flat
            return out
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
