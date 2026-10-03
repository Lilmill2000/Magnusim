"""API 1.4 contract shapes: BC families, BC type family/match, material records.

Uses its own test plugins (never the Incompressible Flow plugin's code).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from cfddesk.registry import (
    BcFamily,
    MaterialModel,
    RegistryError,
    load_all,
    reset_for_tests,
    validate_bc_families,
)
from cfddesk.registry.discovery import RegistryHub, get_hub

PLUGIN_HEAD = """
from dataclasses import replace

from cfddesk.registry import AnalysisType, BcFamily, MaterialModel, SchemaField
from cfddesk.registry.manifest import PluginManifest

KEY = "{key}"


def wall_variant(hub, key, family, match=()):
    base = hub.registry("bc").get("wall_noslip")
    return replace(base, key=key, family=family, match=match)
"""

GOOD_BODY = """
def register(hub):
    bcs = hub.registry("bc")
    bcs.register(wall_variant(hub, "fx_wall_noslip", "fx_wall", (("wall_type", "No slip"),)), plugin=KEY)
    bcs.register(wall_variant(hub, "fx_wall_slip", "fx_wall", (("wall_type", "Slip"),)), plugin=KEY)
    hub.registry("bc_family").register(
        BcFamily(
            key="fx_wall",
            label="Test wall",
            record_type="Test Wall",
            aliases=("TestWall",),
            color="wall",
            hint="No slip or slip",
            variants=("fx_wall_noslip", "fx_wall_slip"),
            defaults={"metric": {"wall_type": "No slip", "t": 20.0, "t_unit": "C"},
                      "imperial": {"wall_type": "No slip", "t": 68.0, "t_unit": "F"}},
            values=(("t", "t_unit", "temperature", {"thermal": "Fixed"}),),
            fields=(SchemaField("wall_type", "Wall type", "choice", default="No slip", choices=("No slip", "Slip")),),
            ui="TestWallSettings",
            resolve=lambda record: ("fx_wall_noslip", {}),
        ),
        plugin=KEY,
    )
    hub.registry("material").register(
        MaterialModel(
            key="fx_mat",
            label="Test material",
            properties_schema=(SchemaField("nu", "Kinematic viscosity", "float", default=1e-5, unit="m^2/s"),),
            library=({"key": "goo", "name": "Goo", "nu": 2e-5},),
            record_keys={"nu": ("kinematic_viscosity", "nu")},
            record_constants={"type": "Newtonian", "kinematic_viscosity_unit": "m2/s"},
        ),
        plugin=KEY,
    )
    hub.registry("analysis").register(
        AnalysisType(
            key="fx_analysis",
            label="Test analysis",
            category="test",
            time_dependency="steady",
            fields=("U", "p"),
            bc_types=("fx_wall_noslip", "fx_wall_slip"),
            material_models=("fx_mat",),
        ),
        plugin=KEY,
    )
    return PluginManifest(key=KEY, name="Test families", version="0.1.0")
"""

UNKNOWN_VARIANT_BODY = """
def register(hub):
    hub.registry("bc_family").register(
        BcFamily(key="fx_ghost", label="Ghost", record_type="Ghost", variants=("wall_noslip", "fx_no_such_bc")),
        plugin=KEY,
    )
    return PluginManifest(key=KEY, name="Ghost family", version="0.1.0")
"""

UNKNOWN_FAMILY_BODY = """
def register(hub):
    hub.registry("bc").register(wall_variant(hub, "fx_orphan", "fx_no_such_family"), plugin=KEY)
    return PluginManifest(key=KEY, name="Orphan variant", version="0.1.0")
"""


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    # A private off list, so a developer's own settings never leak in.
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(tmp_path / "local.json"))
    reset_for_tests()
    yield
    reset_for_tests()


def _load_with(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, plugins: dict[str, str]) -> RegistryHub:
    folder = tmp_path / "plugins"
    for key, body in plugins.items():
        d = folder / key
        d.mkdir(parents=True)
        manifest = {"key": key, "name": key, "version": "0.1.0", "api_version": "1.4"}
        (d / "manifest.toml").write_text(
            "".join(f"{k} = {json.dumps(v)}\n" for k, v in manifest.items()), encoding="utf-8"
        )
        (d / "plugin.py").write_text(PLUGIN_HEAD.format(key=key) + body, encoding="utf-8")
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(folder))
    return load_all(web_root=tmp_path, force=True)


def _rows(hub: RegistryHub, kind: str) -> dict[str, dict]:
    return {row["key"]: row for row in hub.registry(kind).describe()}


def test_bc_type_spec_keeps_every_import_path():
    import cfddesk.registry as registry
    from cfddesk.case import bc_registry
    from cfddesk.registry import bc

    assert bc_registry.BcTypeSpec is bc.BcTypeSpec is registry.BcTypeSpec
    spec = bc_registry.get_type("wall_noslip")
    assert isinstance(spec, bc.BcTypeSpec)
    assert (spec.family, spec.match) == ("wall", (("wall_type", "No-slip"),))


def test_the_core_registers_no_bc_types_or_families():
    hub = RegistryHub()
    from cfddesk.builtin import register_builtins

    register_builtins(hub)
    assert hub.registry("bc").keys() == []
    assert hub.registry("bc_family").keys() == []


def test_the_bc_family_kind_lists_the_plugins_families():
    hub = load_all(force=True)
    assert "bc_family" in hub.kinds()
    families = hub.registry("bc_family")
    assert families.keys() == ["velocity_inlet", "velocity_outlet", "pressure_outlet", "wall"]
    assert {families.owner(k) for k in families.keys()} == {"incompressible_flow"}
    from cfddesk.worker import methods

    rows = methods.registry_describe()["bc_family"]
    assert [row["key"] for row in rows] == families.keys()
    assert all("resolve" not in row for row in rows)


def test_a_good_plugin_publishes_families_variants_and_material_records(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    hub = _load_with(tmp_path, monkeypatch, {"fx-good": GOOD_BODY})
    assert [f for f in hub.failures if f["key"] == "fx-good"] == []

    bc = _rows(hub, "bc")
    assert bc["fx_wall_slip"]["family"] == "fx_wall"
    assert bc["fx_wall_slip"]["match"] == [["wall_type", "Slip"]]
    assert (bc["fx_wall_slip"]["semantic"], bc["fx_wall_slip"]["patch_type"]) == ("wall", "wall")
    # Incompressible Flow's BC types carry the keys too.
    assert (bc["velocity_inlet_fixed"]["semantic"], bc["velocity_inlet_fixed"]["family"]) == ("inlet", "velocity_inlet")
    assert bc["velocity_inlet_fixed"]["match"] == [["velocity_type", "Fixed"]]
    assert bc["velocity_outlet"]["match"] == []

    fam = _rows(hub, "bc_family")["fx_wall"]
    assert fam["plugin"] == "fx-good"
    assert fam["record_type"] == "Test Wall"
    assert fam["aliases"] == ["TestWall"]
    assert (fam["color"], fam["hint"], fam["ui"]) == ("wall", "No slip or slip", "TestWallSettings")
    assert fam["variants"] == ["fx_wall_noslip", "fx_wall_slip"]
    assert fam["defaults"]["imperial"]["t_unit"] == "F"
    assert fam["values"] == [{"field": "t", "unit_field": "t_unit", "quantity": "temperature", "when": {"thermal": "Fixed"}}]
    assert fam["fields"]["properties"]["wall_type"]["enum"] == ["No slip", "Slip"]
    assert "resolve" not in fam
    json.dumps(fam)  # published as plain JSON

    mat = _rows(hub, "material")["fx_mat"]
    assert mat["schema"]["properties"]["nu"]["default"] == 1e-5
    assert mat["library"] == [{"key": "goo", "name": "Goo", "nu": 2e-5}]
    assert mat["record_keys"] == {"nu": ["kinematic_viscosity", "nu"]}
    assert mat["record_constants"] == {"type": "Newtonian", "kinematic_viscosity_unit": "m2/s"}
    assert mat["custom_preset"] == "custom"

    analysis = _rows(hub, "analysis")["fx_analysis"]
    assert analysis["bc_types"] == ["fx_wall_noslip", "fx_wall_slip"]
    assert analysis["material_models"] == ["fx_mat"]


def test_a_family_with_an_unregistered_variant_unloads_its_plugin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    hub = _load_with(tmp_path, monkeypatch, {"fx-ghost": UNKNOWN_VARIANT_BODY, "fx-good": GOOD_BODY})
    failed = {row["key"]: row["error"] for row in hub.failures}
    assert "fx_no_such_bc" in failed["fx-ghost"] and "unknown bc variant" in failed["fx-ghost"]
    assert "fx-ghost" not in hub.manifests
    assert "fx_ghost" not in hub.registry("bc_family").keys()
    # The other plugins and the builtins keep loading.
    assert "fx-good" not in failed and "fx_wall" in hub.registry("bc_family").keys()
    assert "wall_noslip" in hub.registry("bc").keys()


def test_a_variant_naming_an_unknown_family_unloads_its_plugin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    hub = _load_with(tmp_path, monkeypatch, {"fx-orphan": UNKNOWN_FAMILY_BODY})
    failed = {row["key"]: row["error"] for row in hub.failures}
    assert "fx_no_such_family" in failed["fx-orphan"] and "unknown bc_family" in failed["fx-orphan"]
    assert "fx_orphan" not in hub.registry("bc").keys()
    assert "fx-orphan" not in hub.manifests


def test_validate_bc_families_rules():
    hub = RegistryHub()
    from cfddesk.builtin import register_builtins

    register_builtins(hub)
    validate_bc_families(hub)  # builtins alone pass
    from cfddesk.registry import BcTypeSpec

    hub.registry("bc").register(BcTypeSpec("t_wall", "Wall", "wall", "wall"), plugin="p0")
    validate_bc_families(hub)  # a BC type with no family passes
    fams = hub.registry("bc_family")
    fams.register(BcFamily(key="f_empty", label="E", record_type="E"), plugin="p")
    with pytest.raises(RegistryError, match="bc_family 'f_empty': lists no variants"):
        validate_bc_families(hub)
    fams.drop_plugin("p")
    fams.register(BcFamily(key="f_color", label="C", record_type="C", variants=("t_wall",), color="pink"), plugin="p")  # type: ignore[arg-type]
    with pytest.raises(RegistryError, match="bc_family 'f_color': color 'pink'"):
        validate_bc_families(hub)


def test_a_builtin_breaking_the_family_rules_still_raises():
    from dataclasses import replace

    hub = get_hub()
    load_all(force=True)
    base = hub.registry("bc").get("wall_slip")
    hub.registry("bc").register(replace(base, key="fx_builtin_orphan", family="fx_none"), plugin="builtin")
    from cfddesk.registry.discovery import _validate_cross_refs

    with pytest.raises(RegistryError, match="bc 'fx_builtin_orphan': unknown bc_family 'fx_none'"):
        _validate_cross_refs(hub)


def test_material_model_record_fields_default_empty():
    m = MaterialModel(key="m", label="M", properties_schema=())
    assert (m.record_keys, m.record_constants, m.custom_preset) == ({}, {}, "custom")
    hub = RegistryHub()
    hub.registry("material").register(m, plugin="p")
    [row] = hub.registry("material").describe()
    assert row["schema"]["properties"] == {}
    assert (row["library"], row["record_keys"], row["record_constants"]) == ([], {}, {})
