"""BC registry + menu round-trips."""
from __future__ import annotations

from cfddesk.case.bc_menu import legacy_from_nested, nested_from_legacy
from cfddesk.case.bc_registry import BC_TYPES, default_settings, patch_type_for


def test_every_type_has_patch_and_defaults():
    for key in BC_TYPES:
        settings = default_settings(key)
        assert isinstance(settings, dict)
        pt = patch_type_for(key, settings)
        assert pt is not None


def test_legacy_nested_roundtrip():
    for key in BC_TYPES:
        menu_type, variant, subvariant = nested_from_legacy(key)
        back = legacy_from_nested(menu_type, variant, subvariant)
        assert back == key
