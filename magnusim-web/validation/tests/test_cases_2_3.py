"""Cases 2 and 3: their plans (geometry, faces, requests, the shared mesh of case 2, the 2D mesh of
case 3 and its estimate) and their evaluation on synthetic runs with known answers."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest
from magnusim_validation import cases
from magnusim_validation.evaluate import evaluate_dir
from magnusim_validation.extract import rms
from magnusim_validation.plan import make_plan
from magnusim_validation.report import build_markdown
from magnusim_validation.site import build_site
from validation_fakes import cavity_flow, fake_cavity_run, fake_run

pytestmark = pytest.mark.occt


def test_case_3_plans_a_closed_2d_cavity(tmp_path: Path):
    c3 = cases.get("c3")
    a = make_plan(c3, "re1000", tmp_path / "a", cores=4)
    assert a == make_plan(c3, "re1000", tmp_path / "b", cores=4)
    labels = a["geometry"]["labels"]
    assert {k: len(v) for k, v in labels.items()} == {"lid": 1, "bottom": 1, "left": 1, "right": 1, "front": 1, "back": 1}
    bcs = {b["name"]: b for b in a["bcs"]}
    assert bcs["Lid"]["wall_type"] == "Moving" and bcs["Lid"]["wall_velocity"] == [1.0, 0.0, 0.0]
    assert bcs["Lid"]["faces"] == labels["lid"]
    assert bcs["Walls"]["wall_type"] == "No-slip" and len(bcs["Walls"]["faces"]) == 3
    assert bcs["Sides"]["bc_type"] == "Symmetry" and bcs["Sides"]["faces"] == labels["front"] + labels["back"]
    # Nothing flows in or out: no inlet, outlet or pressure boundary.
    assert {b["bc_type"] for b in a["bcs"]} == {"Wall", "Symmetry"}
    assert a["material"]["kinematic_viscosity"] == pytest.approx(1e-4)
    assert make_plan(c3, "re100", tmp_path / "c", cores=4)["material"]["kinematic_viscosity"] == pytest.approx(1e-3)
    mesh = a["mesh"]
    assert mesh["settings"]["mesher_settings"] == {"one_cell_across": True}
    assert mesh["expect"]["layers"] is False
    ref = mesh["refinements"][0]
    assert (ref["type"], ref["default_size"], ref["reach"], ref["reach_unit"]) == ("Surface custom sizing", 0.6, 50.0, "mm")
    assert len(ref["faces"]) == 4
    # The 2D mesh's estimate: one cell deep, the whole cavity at the custom size's level. Its
    # first real mesh (mesh probe, 2026-11-05) had 34 580 cells.
    est = mesh["estimate"]
    assert est["one_cell_across"] is True and est["block"] == [60, 60, 1]
    assert est["custom_sizes"][0]["level"] == 2 and est["custom_sizes"][0]["cell_mm"][:2] == [0.5542, 0.5542]
    assert 34_580 / 1.5 <= est["n_cells"] <= 34_580 * 1.5
    # Probes at Ghia et al.'s interior stations, at mid-depth; the lines the evaluation reads.
    rcs = {r["name"]: r for r in a["run"]["result_controls"]}
    assert len(rcs["Vertical centreline"]["points"]) == len(rcs["Horizontal centreline"]["points"]) == 15
    assert all(p[2] == pytest.approx(0.005) for p in rcs["Vertical centreline"]["points"])
    kinds = {e["key"]: e["kind"] for e in a["extract"]}
    assert kinds == {"u_vertical": "app_sampling", "v_horizontal": "app_sampling", "psi_lines": "app_sampling",
                     "p_vertical": "line"}
    assert a["run"]["endTime"] == 8000
    assert "mesh_from" not in a


def test_case_2s_k_epsilon_run_uses_the_sst_runs_mesh(tmp_path: Path):
    c2 = cases.get("c2")
    sst = make_plan(c2, "hexdominant_sst", tmp_path / "sst", cores=4)
    ke = make_plan(c2, "hexdominant_kepsilon", tmp_path / "ke", cores=4)
    assert ke["mesh_from"] == {"variant": "hexdominant_sst", "key": sst["mesh_key"]}
    assert ke["mesh_key"] == sst["mesh_key"] and "mesh_from" not in sst
    # Only the turbulence model and the run differ.
    assert sst["study"]["settings"]["turbulence_model"] == "kOmegaSST"
    assert ke["study"]["settings"]["turbulence_model"] == "kEpsilon"
    for k in ("geometry", "material", "bcs", "mesh"):
        assert ke[k] == sst[k], k
    std = make_plan(c2, "standard_kepsilon", tmp_path / "std", cores=4)
    assert std["mesh_from"]["variant"] == "standard_sst" and std["mesh_key"] != sst["mesh_key"]
    # The pipe: 30 D, Hex-dominant's one wall layer of 0.6 mm.
    assert sst["geometry"]["faces"][0]["area_mm2"] == pytest.approx(math.pi * 20.0 * 600.0, rel=1e-6)
    assert sst["mesh"]["refinements"][0]["n_layers"] == 1 and sst["mesh"]["refinements"][0]["total_thickness"] == 0.6
    assert sst["mesh"]["expect"]["layers"] is True and std["mesh"]["expect"]["layers"] is True
    assert std["mesh"]["settings"]["automatic_boundary_layers"] is True
    est = sst["mesh"]["estimate"]
    assert est["warnings"] == [] and est["layers"][0]["stack_over_smallest_cell"] < 3
    # A changed mesh changes the key: the driver then meshes again.
    other = make_plan(c2, "hexdominant_kepsilon", tmp_path / "o", cores=4, mesh_settings={"fineness": 5})
    assert other["mesh_key"] != sst["mesh_key"]


def _cavity_result(tmp_path: Path, variant: str) -> dict:
    c3 = cases.get("c3")
    run_dir = tmp_path / "run"
    make_plan(c3, variant, run_dir, cores=4)
    fake_cavity_run(run_dir, psi_min=c3.MARCHI.value(re=c3.RE[variant], quantity="psi_min"))
    return evaluate_dir(run_dir)


def test_case_3_reads_profiles_extrema_and_the_vortex_of_a_known_flow(tmp_path: Path):
    c3 = cases.get("c3")
    res = _cavity_result(tmp_path, "re100")
    assert res["status"] == "ok", res["status_detail"]
    q = {x["key"]: x for x in res["quantities"]}
    a = c3.MARCHI.value(re=100, quantity="psi_min")
    u, v = cavity_flow(a)
    # The profiles against Ghia et al. at their interior stations, as computed here directly.
    st, ghia = c3.stations(c3.GHIA_U, "y", "u_re100")
    want = u(0.5, st) - ghia
    assert q["u_rms"]["value"] == pytest.approx(rms(want), rel=1e-3)
    assert q["u_maxdiff"]["value"] == pytest.approx(np.max(np.abs(want)), rel=1e-3)
    assert q["u_rms"]["reference"]["value"] == 0.0 and q["u_rms"]["error"]["rel_pct"] is None
    assert q["u_rms"]["tolerance"]["abs_tol"] == 0.01
    # u along x = 0.5 is a pi sin(2 pi y): lowest at y = 0.25; v along y = 0.5 is -a pi sin(2 pi x).
    assert q["u_min"]["value"] == pytest.approx(a * math.pi, rel=1e-4)
    assert res["shown"]["u_min_at"] == pytest.approx(0.25, abs=1e-3)
    assert q["v_max"]["value"] == pytest.approx(-a * math.pi, rel=1e-4)
    assert q["v_min"]["value"] == pytest.approx(a * math.pi, rel=1e-4)
    # The vortex: psi's lowest value, at the centre.
    assert q["psi_min"]["value"] == pytest.approx(a, rel=1e-3)
    assert q["psi_min"]["within"] is True
    assert q["vortex_x"]["value"] == pytest.approx(0.5, abs=2e-3) and q["vortex_y"]["value"] == pytest.approx(0.5, abs=2e-3)
    assert res["shown"]["psi_at_lid_max_abs"] < 1e-4
    # The route and app_sampling read the same pressure; the probes read the flow at their points.
    assert res["shown"]["route_vs_app_sampling_p_max_abs"] == 0.0
    assert res["shown"]["probe_u_rms"] == pytest.approx(rms(want), rel=1e-6)
    assert {"u_profile", "v_profile", "u_stations", "v_stations", "u_probes", "v_probes"} <= set(res["series"])
    # Each reference names its table and file.
    assert "Table I" in q["u_rms"]["reference"]["where"] and "ghia_1982_table1_u.csv" in q["u_rms"]["reference"]["where"]
    assert q["u_min"]["reference"]["citation"].startswith("O. Botella, R. Peyret (1998)")
    assert q["psi_min"]["reference"]["confidence"] == "CONFIRMED"


def test_case_3_in_the_report_and_on_the_page(tmp_path: Path):
    res = _cavity_result(tmp_path, "re1000")
    text = build_markdown([res])
    assert "| Lid-driven cavity | Re = 1000, Hex-dominant (2D) | ok | u/U_lid on the vertical centreline, RMS difference" in text
    # A difference whose reference is zero: its error in its own unit, its band absolute.
    row = next(line for line in text.splitlines() if "RMS difference from Ghia et al. (Re 1000) |" in line and line.startswith("| Lid"))
    assert "U_lid | ±0.02 U_lid" in row
    assert "one cell across (2D) along z" in text
    page = build_site([res])["index.html"]
    assert "Ghia" in page and "Botella" in page and "Marchi" in page
    assert 'src="img/c3_lid_cavity-re1000-u_profile.png"' in page
    # Its figures draw from the result alone.
    from magnusim_validation.plots import render

    files = render(cases.get("c3"), res, tmp_path / "img")
    assert sorted(f.name for f in files) == ["c3_lid_cavity-re1000-residuals.png", "c3_lid_cavity-re1000-u_profile.png",
                                             "c3_lid_cavity-re1000-v_profile.png"]


def test_a_cavity_run_without_its_lines_says_what_is_missing(tmp_path: Path):
    c3 = cases.get("c3")
    run_dir = tmp_path / "run"
    make_plan(c3, "re100", run_dir, cores=4)
    fake_cavity_run(run_dir, psi_min=-0.1)
    (run_dir / "raw" / "sample_psi_lines.json").unlink()
    res = evaluate_dir(run_dir)
    assert res["status"] == "extract_failed"
    assert "psi_min" in res["status_detail"] and "no stream function" in res["status_detail"]


def _pipe_run(tmp_path: Path, variant: str, f: float) -> dict:
    """A case 2 run whose developed flow has Darcy friction factor ``f``: the pressure falls by
    f rho U² / (2 D) per metre and the wall shear stress is f rho U² / 8."""
    c2 = cases.get("c2")
    run_dir = tmp_path / variant
    make_plan(c2, variant, run_dir, cores=4)
    fake_run(run_dir, lines=False, samples=False)
    raw = run_dir / "raw"
    d, length, area = c2.D, c2.L, math.pi * c2.D**2 / 4
    g = f * 0.5 / d
    xs = [length * i / 300 for i in range(301)]
    pts = [[x, 0.0, 0.0] for x in xs]

    def w(name: str, doc: dict) -> None:
        (raw / f"{name}.json").write_text(json.dumps(doc), encoding="utf-8")

    w("line_p_axis", {"status": 200, "n_valid": 301, "values": [g * (length - x) for x in xs], "sample_points": pts})
    w("line_u_axis", {"status": 200, "n_valid": 301, "values": [1.2] * 301, "sample_points": pts})
    n = 30
    face_x = [0.4 + 0.1 * i / (n - 1) for i in range(n)]
    w("sample_wall_shear", {"source": "case_file:2500/wallShearStress", "n": n, "x": face_x, "area": [1e-5] * n,
                            "wallShearStress_x": [-f / 8] * n, "wallShearStress_y": [0.0] * n,
                            "wallShearStress_z": [0.0] * n})
    w("sample_y_plus", {"source": "case_file:2500/yPlus", "n": n, "x": face_x, "area": [1e-5] * n,
                        "yPlus": [30.0 + i for i in range(n)]})
    p_in = g * length
    w("monitors", {"monitors": [
        {"key": "mon_inlet", "patch": "inlet", "area_m2": area, "last": {"Q_m3s": -area, "p_Pa": p_in},
         "series": [{"t": i, "p_Pa": p_in} for i in range(1, 181)]},
        {"key": "mon_outlet", "patch": "outlet", "area_m2": area, "last": {"Q_m3s": area}},
    ], "custom": [{"key": f"probes_centreline_{i + 1}", "point": [x * d, 0, 0], "last": {"U": [1.2, 0, 0]},
                   "series": [{"t": k, "U": [1.2, 0, 0]} for k in range(1, 181)]} for i, x in enumerate(c2.PROBE_X_D)]})
    return evaluate_dir(run_dir)


def test_case_2_reads_the_friction_from_the_pressure_and_from_the_wall(tmp_path: Path):
    res = _pipe_run(tmp_path, "hexdominant_sst", 0.0211)
    assert res["status"] == "ok", res["status_detail"]
    q = {x["key"]: x for x in res["quantities"]}
    assert q["f"]["value"] == pytest.approx(0.0211, rel=1e-9)
    assert q["f_tau"]["value"] == pytest.approx(0.0211, rel=1e-9)
    assert q["f"]["tolerance"]["rel_pct"] == 10.0 and "McKeon" in q["f"]["reference"]["citation"]
    s = res["shown"]
    assert s["f_early_vs_f_pct"] == pytest.approx(0.0, abs=1e-6) and s["f_tau_vs_f_pct"] == pytest.approx(0.0, abs=1e-6)
    assert s["y_plus"]["min"] == 30.0 and s["y_plus"]["max"] == 59.0
    assert s["ucl_over_ub"] == pytest.approx(1.2)
    from magnusim_validation.plots import render

    assert len(render(cases.get("c2"), res, tmp_path / "img")) == 3
    ke = _pipe_run(tmp_path, "standard_kepsilon", 0.025)
    assert {x["key"]: x["value"] for x in ke["quantities"]}["f"] == pytest.approx(0.025, rel=1e-9)
    text = build_markdown([res, ke])
    assert "| Turbulent pipe, Re = 50 000 | Hex-dominant, k-omega SST | ok | Darcy friction factor from the pressure drop" in text
    assert "k-epsilon with wall functions" in text and "y+ over x/D 20 to 25 from 30 to 59" in text


def test_a_run_on_another_runs_mesh_says_so(tmp_path: Path):
    res = _pipe_run(tmp_path, "hexdominant_kepsilon", 0.0211)
    drv_path = tmp_path / "hexdominant_kepsilon" / "driver.json"
    drv = json.loads(drv_path.read_text(encoding="utf-8"))
    drv["mesh_shared"] = {"from": "hexdominant_sst", "project_id": "p"}
    drv_path.write_text(json.dumps(drv), encoding="utf-8")
    res = evaluate_dir(tmp_path / "hexdominant_kepsilon")
    assert res["mesh"]["shared_from"] == "hexdominant_sst"
    assert "Mesh: the same mesh as the Hex-dominant, k-omega SST run's" in build_markdown([res])
