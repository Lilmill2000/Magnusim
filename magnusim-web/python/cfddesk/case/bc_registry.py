"""Legacy (API 1.x) view of the BC types: a shim over the hub's ``bc`` registry.

The BC types are registered by plugins (Incompressible Flow owns the product
ones). This module keeps the 1.x names working: ``BC_TYPES`` is a read-only
mapping over the hub (it loads the registry once when it is still empty), and
``get_type``/``default_settings``/``patch_type_for``/``type_labels`` keep their
signatures.

When the hub lacks one of the seven BC type keys projects have always stored
(the plugin that owns them failed to load), ``_LEGACY_SEMANTICS`` still says
what kind of patch it is, so meshing an old project still types its walls.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator, Mapping
from types import MappingProxyType
from typing import Any

# The spec class lives in the registry (API 1.4); these names stay importable here.
from cfddesk.registry.bc import BcTypeSpec as BcTypeSpec
from cfddesk.registry.bc import PatchType as PatchType
from cfddesk.registry.bc import SemanticClass as SemanticClass
from cfddesk.registry.bc import WriterFn as WriterFn
from cfddesk.registry.schema import SchemaField as SettingField  # noqa: F401  (1.x name)

# The BC type keys every project stored before BC types became plugin specs:
# key -> (semantic, patch_type). Read only when the hub lacks the key.
_LEGACY_SEMANTICS: Mapping[str, tuple[SemanticClass, PatchType]] = MappingProxyType(
    {
        "velocity_inlet_fixed": ("inlet", "patch"),
        "velocity_inlet_volumetric": ("inlet", "patch"),
        "velocity_inlet_mass": ("inlet", "patch"),
        "velocity_outlet": ("outlet", "patch"),
        "pressure_outlet_gauge": ("outlet", "patch"),
        "wall_noslip": ("wall", "wall"),
        "wall_slip": ("wall", "wall"),
    }
)

_LOAD_LOCK = threading.RLock()
_LOADING = threading.local()
# Set on a hub once this module has asked load_all to fill it.
_TRIED_ATTR = "_bc_shim_load_tried"


def _bc_registry() -> Any:
    """The hub's ``bc`` registry, loaded once per hub if it is still empty."""
    from cfddesk.registry.discovery import get_hub

    hub = get_hub()
    reg = hub.registry("bc")
    if reg.keys() or getattr(hub, _TRIED_ATTR, False) or getattr(_LOADING, "active", False):
        return reg
    with _LOAD_LOCK:
        if not getattr(hub, _TRIED_ATTR, False) and not reg.keys():
            setattr(hub, _TRIED_ATTR, True)
            _LOADING.active = True
            try:
                from cfddesk.registry.discovery import load_all

                load_all()
            except Exception:  # noqa: BLE001 - a broken load still leaves the legacy table
                pass
            finally:
                _LOADING.active = False
    return get_hub().registry("bc")


def _legacy_spec(key: str) -> BcTypeSpec:
    """A writer-less spec for a stored key whose plugin is not loaded."""
    semantic, patch_type = _LEGACY_SEMANTICS[key]
    return BcTypeSpec(key, key, semantic, patch_type, supported=False)


class _BcTypesView(Mapping[str, BcTypeSpec]):
    """Read-only ``{key: BcTypeSpec}`` over the hub's ``bc`` registry, plus a
    writer-less legacy spec for each stored key the hub lacks."""

    def _keys(self) -> list[str]:
        keys = list(_bc_registry().keys())
        have = set(keys)
        return keys + [k for k in _LEGACY_SEMANTICS if k not in have]

    def __getitem__(self, key: str) -> BcTypeSpec:
        reg = _bc_registry()
        if key in reg.keys():
            return reg.get(key)
        if key in _LEGACY_SEMANTICS:
            return _legacy_spec(key)
        raise KeyError(key)

    def __contains__(self, key: object) -> bool:
        if not isinstance(key, str):
            return False
        return key in _bc_registry().keys() or key in _LEGACY_SEMANTICS

    def __iter__(self) -> Iterator[str]:
        return iter(self._keys())

    def __len__(self) -> int:
        return len(self._keys())

    def __repr__(self) -> str:
        return f"BC_TYPES({self._keys()!r})"


BC_TYPES: Mapping[str, BcTypeSpec] = _BcTypesView()


def get_type(key: str) -> BcTypeSpec:
    if key not in BC_TYPES:
        raise KeyError(f"Unknown BC type {key!r}")
    return BC_TYPES[key]


def type_labels() -> list[tuple[str, str]]:
    return [(k, v.label) for k, v in BC_TYPES.items()]


def variant_has_extensive(spec: BcTypeSpec) -> bool:
    return any(f.rate_kind == "extensive" for f in spec.settings_schema)


def patch_type_for(bc_type: str, settings: dict | None = None) -> PatchType:
    spec = get_type(bc_type)
    return spec.patch_type


def default_settings(bc_type: str) -> dict[str, Any]:
    spec = get_type(bc_type)
    out: dict[str, Any] = {}
    for f in spec.settings_schema:
        out[f.key] = f.default
    return out


def sanitize_patch_name(label: str, existing: set[str]) -> str:
    import re

    base = re.sub(r"[^A-Za-z0-9_]+", "_", label.strip()).strip("_").lower() or "patch"
    if base[0].isdigit():
        base = "p_" + base
    name = base
    n = 2
    while name in existing:
        name = f"{base}_{n}"
        n += 1
    return name
