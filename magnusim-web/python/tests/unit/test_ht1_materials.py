"""Host API 1.8: several materials per study, their roles and the mesh regions they make.

A test plugin's analysis offers a fluid model and a solid model (the shape of a
heat-transfer analysis); Incompressible Flow's studies keep one fluid.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from cfddesk.project import web_writes as ww
from cfddesk.project.paths import (
    assemble_study_materials,
    create_geometry_folder,
    create_study_folder,
    find_study,
)
from cfddesk.project.regions import mesh_region_refusal, region_name, study_regions
from cfddesk.project.run_inputs import gather_run_inputs
from cfddesk.project.scope import build_project_tree
from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.discovery import RegistryHub

PLUGIN = """
from cfddesk.registry import AnalysisType, MaterialModel, SchemaField
from cfddesk.registry.manifest import PluginManifest

KEY = "{key}"


def register(hub):
    mats = hub.registry("material")
    mats.register(MaterialModel(
        key="fx_fluid", label="Fluid", role="fluid",
        properties_schema=(SchemaField("k", "Thermal conductivity", "float", default=0.026, quantity="thermal_conductivity"),),
        library=({{"key": "air", "name": "Air", "values": {{"k": 0.026}}, "codes": ["DEFAULT"]}},),
    ), plugin=KEY)
    mats.register(MaterialModel(
        key="fx_solid", label="Solid", role="{solid_role}",
        properties_schema=(SchemaField("k", "Thermal conductivity", "float", default=167.0, quantity="thermal_conductivity"),),
        library=({{"key": "al", "name": "Aluminium", "values": {{"k": 167.0}}}},),
    ), plugin=KEY)
    hub.registry("analysis").register(AnalysisType(
        key="fx_heat_steady", label="Heat", category="test", time_dependency="steady", fields=("T",),
        bc_types=("wall_noslip",), material_models=("fx_fluid", "fx_solid"),
    ), plugin=KEY)
    return PluginManifest(key=KEY, name="Heat materials", version="0.1.0")
"""


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(tmp_path / "local.json"))
    reset_for_tests()
    yield
    reset_for_tests()


def _load(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, solid_role: str = "solid") -> RegistryHub:
    d = tmp_path / "plugins" / "fx-ht"
    d.mkdir(parents=True)
    (d / "manifest.toml").write_text(
        'key = "fx-ht"\nname = "fx-ht"\nversion = "0.1.0"\napi_version = "1.8"\n', encoding="utf-8"
    )
    (d / "plugin.py").write_text(PLUGIN.format(key="fx-ht", solid_role=solid_role), encoding="utf-8")
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(tmp_path / "plugins"))
    return load_all(web_root=tmp_path, force=True)


def _project(tmp_path: Path, analysis: str) -> Path:
    project = tmp_path / "proj"
    project.mkdir()
    (project / "project.json").write_text(json.dumps({"id": "proj", "name": "proj"}) + "\n", encoding="utf-8")
    create_geometry_folder(project, {"id": "geo", "name": "Sink", "original_filename": "Sink"})
    create_study_folder(project, "geo", {"id": "s1", "name": "Heat"})
    ident = Path(find_study(project, "s1")["dir"]) / "id.json"  # type: ignore[index]
    doc = json.loads(ident.read_text(encoding="utf-8"))
    ident.write_text(json.dumps({**doc, "analysis_type": analysis}) + "\n", encoding="utf-8")
    return project


def _mat(mid: str, name: str, model: str, bodies: list[str]) -> dict:
    return {
        "id": mid, "name": name, "material_model": model, "assigned_volumes": bodies,
        "body_ids": bodies, "volume_ids": bodies, "simulation_id": "s1",
    }


def _save(project: Path, mats: list[dict], only: list[str]) -> dict:
    return ww.set_materials(
        project, {"simulation_id": "s1", "materials": mats, "only_id": only[0], "only_ids": only}, sim_id="s1"
    )


def test_material_models_publish_their_role(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    hub = _load(tmp_path, monkeypatch)
    rows = {r["key"]: r for r in hub.registry("material").describe()}
    assert (rows["fx_fluid"]["role"], rows["fx_solid"]["role"]) == ("fluid", "solid")
    assert rows["newtonian_incompressible"]["role"] == "fluid"


def test_a_role_that_is_neither_unloads_the_plugin(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    hub = _load(tmp_path, monkeypatch, solid_role="gas")
    [failure] = [f for f in hub.failures if f["key"] == "fx-ht"]
    assert "material 'fx_solid' has role 'gas'" in str(failure["error"])


def test_one_save_writes_every_record_it_names_and_the_regions_follow(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _load(tmp_path, monkeypatch)
    project = _project(tmp_path, "fx_heat_steady")
    _save(project, [_mat("m-air", "Air", "fx_fluid", ["Body1", "Body2"])], ["m-air"])
    # Body2 moves to the sink: one save writes both records' folders.
    _save(
        project,
        [_mat("m-air", "Air", "fx_fluid", ["Body1"]), _mat("m-al", "Aluminium 6061", "fx_solid", ["Body2"]),
         _mat("m-empty", "Copper", "fx_solid", [])],
        ["m-al", "m-air", "m-empty"],
    )
    folders = {r["id"]: r["assigned_volumes"] for r in assemble_study_materials(project, "s1")}
    assert folders == {"m-air": ["Body1"], "m-al": ["Body2"], "m-empty": []}
    regions = study_regions(project, "s1")
    assert [(r["name"], r["role"], r["bodies"]) for r in regions] == [
        ("air", "fluid", ["Body1"]),
        ("aluminium_6061", "solid", ["Body2"]),
    ]
    refusal = mesh_region_refusal(project, "s1", "standard")
    assert refusal is not None
    assert "this simulation has 2 materials: Air (fluid), Aluminium 6061 (solid)" in refusal
    # The tree lists every record, and the study's analysis.
    study = build_project_tree(project, "proj")["geometries"][0]["studies"][0]
    assert study["analysis_type"] == "fx_heat_steady"
    assert [(m["id"], m["model"], m["volumes"]) for m in study["materials"]] == [
        ("m-air", "fx_fluid", ["Body1"]),
        ("m-al", "fx_solid", ["Body2"]),
        ("m-empty", "fx_solid", []),
    ]


def test_a_generate_tool_process_loads_the_plugins_itself(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A Generate tool runs in a process of its own: nothing has loaded the plugins there."""
    _load(tmp_path, monkeypatch)
    project = _project(tmp_path, "fx_heat_steady")
    _save(project, [_mat("a", "Air", "fx_fluid", ["Body1"]), _mat("b", "Al", "fx_solid", ["Body2"])], ["a", "b"])
    reset_for_tests()  # a fresh process: an empty hub
    assert [r["role"] for r in study_regions(project, "s1")] == ["fluid", "solid"]
    assert mesh_region_refusal(project, "s1", "snappy_hexdominant") is not None


def test_a_save_naming_one_record_leaves_the_others_folders(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _load(tmp_path, monkeypatch)
    project = _project(tmp_path, "fx_heat_steady")
    _save(project, [_mat("a", "Air", "fx_fluid", ["Body1"]), _mat("b", "Al", "fx_solid", ["Body2"])], ["a", "b"])
    _save(project, [_mat("a", "Air", "fx_fluid", ["Body1", "Body2"]), _mat("b", "Al", "fx_solid", [])], ["a"])
    folders = {r["id"]: r["assigned_volumes"] for r in assemble_study_materials(project, "s1")}
    assert folders == {"a": ["Body1", "Body2"], "b": ["Body2"]}


def test_a_one_model_studys_records_are_never_regions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _load(tmp_path, monkeypatch)
    project = _project(tmp_path, "incompressible_steady")
    _save(project, [_mat("a", "Air", "newtonian_incompressible", ["Body1"]), _mat("w", "Water", "newtonian_incompressible", ["Body2"])], ["a", "w"])
    assert study_regions(project, "s1") == []
    assert mesh_region_refusal(project, "s1", "standard") is None


def test_run_inputs_hold_every_material_record(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The solve reads the folder records, as readiness does: the aggregate file may hold fewer."""
    _load(tmp_path, monkeypatch)
    project = _project(tmp_path, "fx_heat_steady")
    _save(project, [_mat("a", "Air", "fx_fluid", ["Body1"]), _mat("b", "Al", "fx_solid", ["Body2"])], ["a", "b"])
    study_dir = Path(find_study(project, "s1")["dir"])  # type: ignore[index]
    (study_dir / "materials.json").write_text(json.dumps({"materials": [_mat("a", "Air", "fx_fluid", ["Body1"])]}), encoding="utf-8")
    inputs = gather_run_inputs(project, simulation_id="s1", require_mesh=False)
    assert sorted(m["id"] for m in inputs.materials["materials"]) == ["a", "b"]


def test_the_heat_example_fixture_plugin_loads(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """e2e/ht1-several-materials.spec.js runs on it (python/tests/fixtures/heat-plugins)."""
    folder = Path(__file__).resolve().parents[1] / "fixtures" / "heat-plugins"
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(folder))
    hub = load_all(web_root=tmp_path, force=True)
    assert [f for f in hub.failures if f["key"] == "example-heat"] == []
    row = {r["key"]: r for r in hub.registry("analysis").describe()}["example_heat_steady"]
    assert row["material_models"] == ["example_heat_fluid", "example_heat_solid"]
    assert [g["key"] for g in row["bc_fields"]] == ["inlet_thermal", "wall_thermal"]
    roles = {r["key"]: r["role"] for r in hub.registry("material").describe()}
    assert (roles["example_heat_fluid"], roles["example_heat_solid"]) == ("fluid", "solid")


def test_region_names_are_openfoam_words_and_unique() -> None:
    taken: set[str] = set()
    assert [region_name(n, taken) for n in ("Air", "air", "6061-T6 Aluminium", "", "Air")] == [
        "air", "air_2", "r_6061_t6_aluminium", "region", "air_3",
    ]
