"""Case 6, the sphere at Re 100: its plan (the box the reference data ask for, faces, BCs, the
study's reference values, the Forces monitor and probes, the mesh's three shells and layers) and
its evaluation on synthetic runs with known answers (the drag, the wake's closure and the
separation angle)."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest
from magnusim_validation import cases
from magnusim_validation.evaluate import evaluate_dir
from magnusim_validation.plan import make_plan
from magnusim_validation.plots import figures_of
from magnusim_validation.report import build_markdown, so_far_text, variant_facts
from magnusim_validation.site import build_site
from validation_fakes import fake_sphere_run

pytestmark = pytest.mark.occt

C6 = cases.get("c6")


def _face(plan: dict, name: str) -> dict:
    faces = {f["id"]: f for f in plan["geometry"]["faces"]}
    return faces[int(plan["geometry"]["labels"][name][0].split()[1].split("@")[0])]


def test_case_6_plans_the_reference_datas_box_and_the_apps_own_monitors(tmp_path: Path):
    plan = make_plan(C6, "re100", tmp_path / "re100", cores=4)
    assert plan == make_plan(C6, "re100", tmp_path / "again", cores=4)
    labels = plan["geometry"]["labels"]
    assert len(plan["geometry"]["faces"]) == 7
    assert {k: len(x) for k, x in labels.items()} == {k: 1 for k in
                                                     ("inlet", "outlet", "bottom", "top", "front", "back", "sphere")}
    # 8 D upstream (the design's), 15 D downstream and 15 D to each side (the reference data's).
    assert _face(plan, "inlet")["centroid_mm"][0] == pytest.approx(-80.0)
    assert _face(plan, "outlet")["centroid_mm"][0] == pytest.approx(150.0)
    assert _face(plan, "inlet")["area_mm2"] == pytest.approx(300.0 * 300.0)
    assert _face(plan, "top")["centroid_mm"][1] == pytest.approx(150.0) and _face(plan, "back")["centroid_mm"][2] == pytest.approx(150.0)
    sphere = _face(plan, "sphere")
    assert sphere["surface_type"] == "Sphere" and sphere["area_mm2"] == pytest.approx(math.pi * 100.0, rel=1e-6)
    bcs = {b["name"]: b for b in plan["bcs"]}
    assert set(bcs) == {"Far field", "Sphere"}
    far = bcs["Far field"]
    assert far["bc_type"] == "Freestream" and far["value"] == 1.0 and far["vector"] == [1.0, 0.0, 0.0]
    assert far["freestream_pressure"] == 0
    assert sorted(far["faces"]) == sorted(sum((labels[k] for k in ("inlet", "outlet", "bottom", "top", "front", "back")), []))
    assert bcs["Sphere"]["wall_type"] == "No-slip" and bcs["Sphere"]["faces"] == labels["sphere"]
    assert plan["material"]["kinematic_viscosity"] == pytest.approx(1e-4)
    s = plan["study"]["settings"]
    assert plan["study"]["analysis_type"] == "incompressible_steady" and s["turbulence_model"] == "laminar"
    assert (s["residual_u"], s["residual_p"], s["n_non_orthogonal"], s["numerics_preset"]) == (1e-6, 1e-6, 1, "accurate")
    # The study's reference values: speed 1 m/s, area pi D² / 4, length D, drag +x, lift +y, the centre.
    assert (s["ref_speed"], s["ref_area"], s["ref_length"]) == (1.0, pytest.approx(math.pi * 1e-4 / 4), 0.01)
    assert (s["ref_drag_dir"], s["ref_lift_dir"], s["ref_cofr"]) == ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 0.0])
    rcs = {rc["name"]: rc for rc in plan["run"]["result_controls"]}
    assert rcs["Sphere"]["monitor_type"] == "forces" and rcs["Sphere"]["boundaries"] == ["@bc:Sphere"]
    axis = rcs["Wake axis"]["points"]
    assert len(axis) == 30 <= 40 and all(p[1] == 0.0 and p[2] == 0.0 for p in axis)
    assert axis[0][0] == pytest.approx(0.0055) and axis[-1][0] == pytest.approx(0.03)
    assert plan["run"]["endTime"] == 2000 and "transient" not in plan["run"]
    # The mesh: Hex-dominant at fineness 4, three shells round the sphere (each with a Refine out
    # to) and 4 wall layers, 0.06 D in all, which the run asserts.
    mesh = plan["mesh"]
    assert mesh["settings"]["fineness"] == 4 and "mesher_settings" not in mesh["settings"]
    assert mesh["settings"]["advanced"]["mesh_engine"] == "snappy_hexdominant"
    customs = [r for r in mesh["refinements"] if r["type"] == "Surface custom sizing"]
    assert [(r["name"], r["default_size"], r["reach"]) for r in customs] == [
        ("Sphere", 0.3125, 2.5), ("Near wake", 0.625, 15.0), ("Wake", 1.25, 30.0)]
    layers = [r for r in mesh["refinements"] if r["type"] == "Inflate boundary layer"]
    assert layers == [{"name": "Sphere layers", "type": "Inflate boundary layer", "faces": labels["sphere"],
                       "n_layers": 4, "total_thickness": 0.6, "total_thickness_unit": "mm"}]
    assert all(r["faces"] == labels["sphere"] for r in mesh["refinements"])
    assert mesh["expect"]["layers"] is True
    est = mesh["estimate"]
    assert est["block"] == [20, 26, 26] and est["walls_level"] == 2
    assert [c["level"] for c in est["custom_sizes"]] == [6, 5, 4]
    lo, hi = mesh["expect"]["n_cells"]
    assert lo <= est["n_cells"] <= hi <= 2_000_000
    assert est["layers"][0]["stack_over_smallest_cell"] < 3 and not est["warnings"]
    kinds = {e["key"]: e["kind"] for e in plan["extract"]}
    assert kinds == {"wake_line": "app_sampling", "p_wake_line": "line", "sphere_shear": "patch"}
    # Coarse: every size doubled, the same layers and run.
    coarse = make_plan(C6, "re100", tmp_path / "coarse", coarse=True, cores=4)
    assert [r["default_size"] for r in coarse["mesh"]["refinements"] if r["type"] == "Surface custom sizing"] == [
        0.625, 1.25, 2.5]
    assert [c["level"] for c in coarse["mesh"]["estimate"]["custom_sizes"]] == [5, 4, 3]
    assert coarse["run"] == plan["run"]


def _evaluate(tmp_path: Path, **kw) -> dict:
    run_dir = tmp_path / "re100"
    make_plan(C6, "re100", run_dir, cores=4)
    fake_sphere_run(run_dir, **kw)
    return evaluate_dir(run_dir)


def test_case_6_reads_the_drag_the_wakes_closure_and_the_separation_angle(tmp_path: Path):
    res = _evaluate(tmp_path, cd=1.10, ld=0.89, theta_s=53.0)
    assert res["status"] == "ok", res["status_detail"]
    q = {x["key"]: x for x in res["quantities"]}
    assert set(q) == {"cd", "l_over_d"}
    assert q["cd"]["value"] == pytest.approx(1.10 * (1 + 0.5 * math.exp(-15)), rel=1e-9)
    assert q["cd"]["reference"]["value"] == 1.09 and q["cd"]["tolerance"]["rel_pct"] == 5.0 and q["cd"]["within"]
    assert q["cd"]["reference"]["kind"] == "correlation" and q["cd"]["reference"]["confidence"] == "SECONDARY"
    assert "Schiller" in q["cd"]["reference"]["citation"] and "Clift" in q["cd"]["reference"]["citation"]
    assert q["l_over_d"]["value"] == pytest.approx(0.89, abs=2e-3) and q["l_over_d"]["reference"]["value"] == 0.88
    assert q["l_over_d"]["tolerance"]["rel_pct"] == 7.0 and "Johnson" in q["l_over_d"]["reference"]["citation"]
    assert q["l_over_d"]["source"] == "app_sampling" and q["cd"]["source"] == "route:/api/run/monitors"
    # Locked (2026-11-07): inside their bands, they pass.
    assert all(x["verdict"] == "pass" and x["tolerance"]["locked"] for x in q.values())
    s = res["shown"]
    assert s["cd_from_fd"] == pytest.approx(q["cd"]["value"], rel=1e-9)
    assert s["cdp"] + s["cdv"] == pytest.approx(q["cd"]["value"], rel=1e-9)
    assert s["cross_force_over_drag"] == pytest.approx(1e-4, rel=1e-6)
    assert s["probes_l_over_d"] == pytest.approx(0.89, abs=0.03)
    # The separation angle, from the rear, within a bin of the synthetic one, the same in every sector.
    assert s["theta_s_deg"] == pytest.approx(53.0, abs=1.0) and s["sphere_faces"] == 3000
    assert len(s["theta_s_sectors_deg"]) == 8 and s["theta_s_spread_deg"] < 2.5
    assert s["route_vs_app_sampling_p_max_abs"] == 0.0
    assert res["mesh"]["layers"]["applied"] is True
    assert set(res["series"]) >= {"wake_line", "cd_history", "probes_wake", "shear_profile", "residuals"}
    assert [f["kind"] for f in figures_of(C6, res)] == ["wake", "cd_history", "shear", "residuals"]
    # Another separation angle moves with it.
    other = _evaluate(tmp_path / "b", theta_s=60.0, ld=0.8)
    assert other["shown"]["theta_s_deg"] == pytest.approx(60.0, abs=1.0)
    assert {x["key"]: x for x in other["quantities"]}["l_over_d"]["value"] == pytest.approx(0.8, abs=2e-3)


def test_case_6_with_its_layers_not_applied_fails(tmp_path: Path):
    res = _evaluate(tmp_path, layers=0.1)
    assert res["status"] == "layers_not_applied"
    assert "layers were asked and not applied" in res["status_detail"]


def test_case_6_separation_angle_is_none_when_the_shear_never_turns():
    import numpy as np

    n = 400
    k = np.arange(n) + 0.5
    phi = np.arccos(1.0 - 2.0 * k / n)
    az = np.pi * (1.0 + 5**0.5) * k
    r = 0.005
    tang = -np.sin(phi)  # attached all the way round
    e = np.stack([np.sin(phi), np.cos(phi) * np.cos(az), np.cos(phi) * np.sin(az)]) * tang
    sample = {"n": n, "x": (-r * np.cos(phi)).tolist(), "y": (r * np.sin(phi) * np.cos(az)).tolist(),
              "z": (r * np.sin(phi) * np.sin(az)).tolist(), "area": [1.0] * n, "wallShearStress_x": e[0].tolist(),
              "wallShearStress_y": e[1].tolist(), "wallShearStress_z": e[2].tolist()}
    assert C6.separation_angle(sample) is None
    assert C6.separation_angle(None) is None


def test_case_6_in_the_report_and_on_the_page(tmp_path: Path):
    res = _evaluate(tmp_path)
    md = build_markdown([res])
    assert "## Sphere" in md and "### Re = 100, steady, Hex-dominant" in md
    assert "Drag coefficient Cd (Re 100)" in md and "Recirculation length L/D (Re 100)" in md
    assert "Schiller-Naumann 1.0917" in md and "Clift, Grace & Weber 1.087" in md and "Johnson & Patel's computed Cd 1.08" in md
    assert "Taneda's measured 0.89" in md and "the separation angle 53" in md
    facts = variant_facts(C6, res)
    mesh = next(f for f in facts if f.startswith("Mesh:"))
    assert "applied (sphere 3.6 of 4)" in mesh
    page = build_site([res])
    assert "Sphere" in page["index.html"]
    doc = json.loads(page["results.json"])
    assert [r["case"] for r in doc["results"]] == ["c6_sphere"]
    # Every case built: the report names none still to come.
    assert "Then " not in so_far_text([res])
