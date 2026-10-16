"""The heat-sink sample (manifest ``[[samples]]``, host API 1.8): the manifest names it, and
its folder holds a project of inputs with placeholders only (no path of the PC it was made
on), no mesh case and no runs. Home opening it: e2e/ht6-sample.spec.js."""

from __future__ import annotations

import json
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]


def test_heat_transfer_ships_the_heat_sink_sample():
    from cfddesk.registry.discovery import _parse_toml, samples_from_meta

    meta, _err = _parse_toml((PLUGIN / "manifest.toml").read_text(encoding="utf-8"))
    assert meta is not None
    got, warnings = samples_from_meta(meta, PLUGIN)
    assert [(s.key, s.title, s.path) for s in got] == [("heat-sink", "Heat sink", "samples/heat-sink")]
    assert warnings == []
    folder = PLUGIN / "samples" / "heat-sink"
    texts = {p.relative_to(folder).as_posix(): p.read_text(encoding="utf-8") for p in folder.rglob("*.json")}
    assert texts and all("AppData" not in t and ":\\\\" not in t for t in texts.values())
    assert "{{project_dir}}" in texts["project.json"] and "{{project_id}}" in texts["project.json"]
    assert not [p for p in folder.rglob("*") if p.name in ("case", "simulation_runs")]


def test_the_sample_is_the_studied_case():
    """Air on Body1, aluminium 6061 with 10 W on Body2, an inlet at 0.5 m/s and 20 °C, a
    pressure outlet, gravity -Y, laminar, a Hex-dominant mesh at fineness 4."""
    study = next((PLUGIN / "samples" / "heat-sink" / "geometries").glob("*/simulations/*"))
    mats = json.loads((study / "materials.json").read_text(encoding="utf-8"))["materials"]
    assert sorted((m["name"], m["material_model"], tuple(m["assigned_volumes"]), m.get("heat_source_W")) for m in mats) == [
        ("Air", "thermo_fluid", ("Body1",), None),
        ("Aluminium 6061", "thermo_solid", ("Body2",), 10),
    ]
    bcs = json.loads((study / "boundary_conditions.json").read_text(encoding="utf-8"))["boundary_conditions"]
    inlet = next(b for b in bcs if b["bc_type"] == "Velocity inlet")
    assert (inlet["name"], float(inlet["value"]), inlet["unit"]) == ("Inlet", 0.5, "m/s")
    assert [b["name"] for b in bcs if b["bc_type"] == "Pressure"] == ["Outlet"]
    ident = json.loads((study / "id.json").read_text(encoding="utf-8"))
    assert ident["analysis_type"] == "heat_transfer_steady"
    sim = json.loads((PLUGIN / "samples" / "heat-sink" / "simulation.json").read_text(encoding="utf-8"))
    assert (sim["gravity"], sim["turbulence_model"]) == ("-y", "laminar")
    mesh = json.loads(next(study.glob("meshes/*/mesh.json")).read_text(encoding="utf-8"))
    assert (mesh["settings"]["advanced"]["mesh_engine"], mesh["settings"]["fineness"], mesh["live_mesh_result"]) == (
        "snappy_hexdominant", 4, None)
