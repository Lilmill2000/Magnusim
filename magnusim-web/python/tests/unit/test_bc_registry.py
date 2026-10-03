"""BC registry + menu round-trips (the 1.x shims over the hub's BC kinds)."""
from __future__ import annotations

import pytest

from cfddesk.case.bc_menu import legacy_from_nested, menu_types, migrate_bc_dict, nested_from_legacy
from cfddesk.case.bc_registry import BC_TYPES, BcTypeSpec, default_settings, patch_type_for
from cfddesk.registry import BcFamily, load_all, reset_for_tests


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


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


def test_bc_menu_rpc_is_unchanged():
    """bc.menu stays a 1.x surface: the same keys and labels as before the BC
    types moved into Incompressible Flow, now read from its families."""
    from cfddesk.worker.methods import bc_menu

    def var(key, label, reg, subs=()):
        return {
            "key": key,
            "label": label,
            "registry_key": reg,
            "subvariants": [{"key": k, "label": lab, "registry_key": r} for k, lab, r in subs],
        }

    assert bc_menu() == {
        "ok": True,
        "menu": [
            {
                "key": "velocity_inlet",
                "label": "Velocity inlet",
                "variants": [
                    var("fixed_value", "Fixed value", "velocity_inlet_fixed"),
                    var(
                        "flow_rate",
                        "Flow rate",
                        "velocity_inlet_volumetric",
                        (
                            ("volumetric", "Volumetric flow", "velocity_inlet_volumetric"),
                            ("mass", "Mass flow", "velocity_inlet_mass"),
                        ),
                    ),
                ],
            },
            {"key": "velocity_outlet", "label": "Velocity outlet", "variants": [var("fixed_value", "Fixed value", "velocity_outlet")]},
            {"key": "pressure_outlet", "label": "Pressure", "variants": [var("fixed_gauge", "Fixed value", "pressure_outlet_gauge")]},
            {
                "key": "wall",
                "label": "Wall",
                "variants": [var("noslip", "No-slip", "wall_noslip"), var("slip", "Slip", "wall_slip")],
            },
        ],
    }


def test_a_plugin_family_joins_the_menu_with_keys_from_its_match():
    hub = load_all()
    hub.registry("bc").register(
        BcTypeSpec("fx_sym_plane", "Symmetry", "wall", "patch", family="fx_symmetry", match=(("kind", "Plane"),)),
        plugin="fx",
    )
    hub.registry("bc").register(
        BcTypeSpec("fx_sym_axis", "Symmetry", "wall", "patch", family="fx_symmetry", match=(("kind", "Axis"), ("axis", "Z axis"))),
        plugin="fx",
    )
    hub.registry("bc_family").register(
        BcFamily(key="fx_symmetry", label="Symmetry", record_type="Symmetry", variants=("fx_sym_plane", "fx_sym_axis")),
        plugin="fx",
    )
    [sym] = [m for m in menu_types() if m.key == "fx_symmetry"]
    assert sym.label == "Symmetry"
    assert [(v.key, v.label, v.registry_key) for v in sym.variants] == [
        ("plane", "Plane", "fx_sym_plane"),
        ("axis", "Axis", "fx_sym_axis"),
    ]
    assert sym.variants[1].subvariants == (("z_axis", "Z axis", "fx_sym_axis"),)
    assert nested_from_legacy("fx_sym_axis") == ("fx_symmetry", "axis", "z_axis")
    assert legacy_from_nested("fx_symmetry", "plane") == "fx_sym_plane"
    assert migrate_bc_dict({"type": "fx_sym_plane"})["type"] == "fx_symmetry"
