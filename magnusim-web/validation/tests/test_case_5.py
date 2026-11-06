"""Case 5, the circular cylinder: its plans (the domain the reference data ask for, faces, BCs, the
study's reference values, the Forces monitor and probes, the 2D mesh with its three rings, the
transient run's settings) and its evaluation on synthetic runs with known answers (a steady wake
and its drag; a shedding lift that settles, or does not)."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest
from magnusim_validation import cases
from magnusim_validation.evaluate import evaluate_dir
from magnusim_validation.plan import make_plan
from magnusim_validation.plots import figures_of
from magnusim_validation.report import build_markdown, variant_facts
from magnusim_validation.site import build_site
from validation_fakes import fake_cylinder_run

pytestmark = pytest.mark.occt

C5 = cases.get("c5")


def test_case_5_plans_the_reference_datas_domain_and_the_apps_own_monitors(tmp_path: Path):
    plans = {v: make_plan(C5, v, tmp_path / v, cores=4) for v in C5.VARIANTS}
    assert plans["re20"] == make_plan(C5, "re20", tmp_path / "again", cores=4)
    for v, plan in plans.items():
        labels = plan["geometry"]["labels"]
        assert len(plan["geometry"]["faces"]) == 7
        assert {k: len(x) for k, x in labels.items()} == {k: 1 for k in
                                                         ("inlet", "outlet", "bottom", "top", "front", "back", "cylinder")}
        faces = {f["id"]: f for f in plan["geometry"]["faces"]}
        inlet = faces[int(labels["inlet"][0].split()[1].split("@")[0])]
        top = faces[int(labels["top"][0].split()[1].split("@")[0])]
        cyl = faces[int(labels["cylinder"][0].split()[1].split("@")[0])]
        # 15 D upstream, 30 D downstream, 40 D wide (blockage 2.5 %), D = 10 mm, 5 mm deep.
        assert inlet["centroid_mm"][0] == pytest.approx(-150.0) and inlet["area_mm2"] == pytest.approx(400.0 * 5.0)
        assert top["centroid_mm"][1] == pytest.approx(200.0) and top["area_mm2"] == pytest.approx(450.0 * 5.0)
        assert cyl["surface_type"] == "Cylinder" and cyl["area_mm2"] == pytest.approx(math.pi * 10.0 * 5.0, rel=1e-6)
        bcs = {b["name"]: b for b in plan["bcs"]}
        assert bcs["Far field"]["bc_type"] == "Freestream" and bcs["Far field"]["value"] == 1.0
        assert bcs["Far field"]["vector"] == [1.0, 0.0, 0.0] and bcs["Far field"]["freestream_pressure"] == 0
        assert sorted(bcs["Far field"]["faces"]) == sorted(labels["inlet"] + labels["outlet"] + labels["bottom"] + labels["top"])
        assert bcs["Cylinder"]["wall_type"] == "No-slip" and bcs["Cylinder"]["faces"] == labels["cylinder"]
        assert bcs["Sides"]["bc_type"] == "Symmetry" and bcs["Sides"]["faces"] == labels["front"] + labels["back"]
        assert plan["material"]["kinematic_viscosity"] == pytest.approx(0.01 / C5.RE[v])
        # The study's reference values: speed, area D x depth, length D, drag +x, lift +y, mid-depth.
        s = plan["study"]["settings"]
        assert (s["ref_speed"], s["ref_area"], s["ref_length"]) == (1.0, pytest.approx(5e-5), 0.01)
        assert (s["ref_drag_dir"], s["ref_lift_dir"], s["ref_cofr"]) == ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 0.0025])
        # A Forces monitor on the Cylinder BC (its id filled in by the driver) and at most 40 probe points.
        rcs = {rc["name"]: rc for rc in plan["run"]["result_controls"]}
        assert rcs["Cylinder"]["monitor_type"] == "forces" and rcs["Cylinder"]["boundaries"] == ["@bc:Cylinder"]
        points = [p for rc in rcs.values() for p in rc.get("points") or []]
        assert len(rcs["Wake axis"]["points"]) == 30 and len(points) == 31 <= 40
        assert all(p[1] == 0.0 and p[2] == 0.0025 for p in rcs["Wake axis"]["points"])
        assert rcs["Wake axis"]["points"][0][0] == pytest.approx(0.0055) and rcs["Wake axis"]["points"][-1][0] == pytest.approx(0.06)
        assert rcs["Shedding"]["points"] == [[0.02, 0.005, 0.0025]]
        # The 2D mesh: One cell across, three rings round the cylinder, each with a Refine out to.
        mesh = plan["mesh"]
        assert mesh["settings"]["mesher_settings"] == {"one_cell_across": True} and mesh["settings"]["fineness"] == 6
        assert [(r["name"], r["default_size"], r["reach"]) for r in mesh["refinements"]] == [
            ("Cylinder", 0.2083, 5.0), ("Near wake", 0.4167, 30.0), ("Wake", 0.8333, 80.0)]
        assert all(r["faces"] == labels["cylinder"] for r in mesh["refinements"])
        est = mesh["estimate"]
        assert est["one_cell_across"] and [c["level"] for c in est["custom_sizes"]] == [6, 5, 4]
        lo, hi = mesh["expect"]["n_cells"]
        assert lo <= est["n_cells"] <= hi
        kinds = {e["key"]: e["kind"] for e in plan["extract"]}
        assert kinds["wake_line"] == "app_sampling" and kinds["p_wake_line"] == "line"
    steady, transient = plans["re40"], plans["re100"]
    assert steady["study"]["analysis_type"] == "incompressible_steady" and steady["study"]["settings"]["initial_flow"] == "inlet"
    assert steady["run"]["endTime"] == 3000 and "transient" not in steady["run"]
    assert {e["key"] for e in steady["extract"]} == {"wake_line", "p_wake_line", "cylinder_shear"}
    assert transient["study"]["analysis_type"] == "incompressible_transient"
    assert transient["study"]["time_dependency"] == "Transient" and "numerics_preset" not in transient["study"]["settings"]
    s = transient["study"]["settings"]
    assert (s["initial_flow"], s["initial_ux"], s["initial_uy"], s["initial_uz"]) == ("custom", 1.0, 0.05, 0.0)
    tr = transient["run"]["transient"]
    assert tr == {"end_time": 3.0, "write_count": 50, "time_step_mode": "adjustable", "max_co": 1.0,
                  "time_scheme": "backward", "n_outer_correctors": 1, "n_correctors": 2, "n_non_orth_correctors": 1,
                  "average_from": 1.5}
    # The monitors write at a fiftieth of the frame interval: at least 40 samples a period at St 0.164.
    period = 0.01 / 0.164
    assert period / (tr["end_time"] / tr["write_count"] / 50) >= 40
    # 20 periods after a transient of up to about 100 D/U fit in the run.
    assert (tr["end_time"] - 1.0) / period >= 20
    assert "umean_line" in {e["key"] for e in transient["extract"]} and "endTime" not in transient["run"]
    # Coarse: every size doubled, the same run.
    coarse = make_plan(C5, "re100", tmp_path / "coarse", coarse=True, cores=4)
    assert [r["default_size"] for r in coarse["mesh"]["refinements"]] == [0.4167, 0.8333, 1.6667]
    assert coarse["run"]["transient"] == tr
    assert [c["level"] for c in coarse["mesh"]["estimate"]["custom_sizes"]] == [5, 4, 3]


def _evaluate(tmp_path: Path, variant: str, **kw) -> dict:
    run_dir = tmp_path / variant
    make_plan(C5, variant, run_dir, cores=4)
    fake_cylinder_run(run_dir, **kw)
    return evaluate_dir(run_dir)


def test_case_5_steady_reads_the_drag_and_the_wake_length(tmp_path: Path):
    res = _evaluate(tmp_path, "re20", cd=2.05, ld=0.95, theta_s=44.0)
    assert res["status"] == "ok", res["status_detail"]
    q = {x["key"]: x for x in res["quantities"]}
    assert q["cd"]["value"] == pytest.approx(2.05 * (1 + 0.5 * math.exp(-15)), rel=1e-9)
    assert q["cd"]["reference"]["value"] == 2.02 and q["cd"]["tolerance"]["rel_pct"] == 5.0 and q["cd"]["within"]
    assert q["l_over_d"]["value"] == pytest.approx(0.95, abs=2e-3) and q["l_over_d"]["reference"]["value"] == 0.93
    assert q["l_over_d"]["source"] == "app_sampling" and q["cd"]["source"] == "route:/api/run/monitors"
    assert all(x["verdict"] == "report_only" for x in q.values())
    s = res["shown"]
    assert s["cd_from_fd"] == pytest.approx(q["cd"]["value"], rel=1e-9)
    assert s["cdp"] + s["cdv"] == pytest.approx(q["cd"]["value"], rel=1e-9)
    assert s["probes_l_over_d"] == pytest.approx(0.95, abs=0.02)
    assert s["theta_s_deg"] == pytest.approx(44.0, abs=0.6)
    assert s["route_vs_app_sampling_p_max_abs"] == 0.0
    assert set(res["series"]) >= {"wake_line", "cd_history", "probes_wake", "residuals"}
    assert [f["kind"] for f in figures_of(C5, res)] == ["wake", "cd_history", "residuals"]
    r40 = _evaluate(tmp_path, "re40", cd=1.52, ld=2.2)
    q40 = {x["key"]: x for x in r40["quantities"]}
    assert q40["cd"]["reference"]["value"] == 1.50 and q40["l_over_d"]["reference"]["value"] == 2.24
    assert q40["l_over_d"]["value"] == pytest.approx(2.2, abs=2e-3)


def test_case_5_re100_reads_the_shedding_over_whole_periods_after_the_transient(tmp_path: Path):
    res = _evaluate(tmp_path, "re100", st=0.165, cd_mean=1.34, cl_amp=0.33, ld_mean=1.42)
    assert res["status"] == "ok", res["status_detail"]
    q = {x["key"]: x for x in res["quantities"]}
    assert set(q) == {"st", "cd_mean", "cl_rms", "l_over_d_mean"}
    assert q["st"]["value"] == pytest.approx(0.165, rel=1e-3) and q["st"]["reference"]["value"] == 0.164
    assert q["cd_mean"]["value"] == pytest.approx(1.34, rel=1e-4) and q["cd_mean"]["reference"]["value"] == 1.33
    assert q["cl_rms"]["value"] == pytest.approx(0.33 / math.sqrt(2), rel=3e-3) and q["cl_rms"]["reference"]["value"] == 0.23
    assert q["l_over_d_mean"]["value"] == pytest.approx(1.42, abs=0.02)
    assert q["l_over_d_mean"]["tolerance"]["rel_pct"] == 10.0 and q["st"]["tolerance"]["rel_pct"] == 3.0
    assert q["cl_rms"]["tolerance"]["rel_pct"] == 15.0
    assert "Williamson (1988)" in q["st"]["reference"]["citation"] and "Park" in q["cd_mean"]["reference"]["citation"]
    assert "Qu" in q["cl_rms"]["reference"]["citation"] and q["st"]["reference"]["confidence"] == "SECONDARY"
    s = res["shown"]
    w = s["window"]
    # The lift grows in from 0.6 s: within 2 % of its amplitude from about 1.07 s on.
    assert 1.0 < w["t0"] < 1.15 and w["n_periods"] >= 20 and w["t1"] <= 3.0
    assert s["st_from_period"] == pytest.approx(0.165, rel=1e-3) and s["st_from_probe"] == pytest.approx(0.165, rel=2e-3)
    assert s["cdp_mean"] == pytest.approx(0.75 * 1.34, rel=1e-3) and s["cdv_mean"] == pytest.approx(0.25 * 1.34, rel=1e-3)
    assert s["cl_amplitude"] == pytest.approx(0.33, rel=3e-3) and s["cd_amplitude"] == pytest.approx(0.01, rel=0.05)
    assert s["samples_per_period"] > 40 and s["umean_l_over_d"] == pytest.approx(1.44, abs=0.01)
    assert s["cd_from_fd_mean"] == pytest.approx(1.34, rel=1e-4)
    assert res["run"]["transient"] and res["run"]["end_time_set"] == 3.0
    assert set(res["series"]) >= {"forces_history", "spectrum", "wake_mean", "window", "umean_line"}
    assert len(res["series"]["forces_history"]["t"]) <= 1500
    assert [f["kind"] for f in figures_of(C5, res)] == ["forces_history", "spectrum", "wake_mean"]
    # UMean averaged from 1.5 s: after the window starts, so no warning about the transient.
    assert not any("UMean averages" in x for x in res["warnings"])


def test_case_5_re100_that_never_settles_gives_no_values_and_says_why(tmp_path: Path):
    res = _evaluate(tmp_path, "re100", t_on=2.4, tau=0.05)
    assert res["status"] == "not_settled"
    assert "did not settle" in res["status_detail"] and "whole periods after the transient" in res["status_detail"]
    assert all(q["value"] is None and q["verdict"] == "missing" for q in res["quantities"])
    facts = variant_facts(C5, res)
    assert facts[0].startswith("Status: not_settled: the lift coefficient's shedding did not settle")


def test_case_5_in_the_report_and_on_the_page(tmp_path: Path):
    results = [_evaluate(tmp_path, v) for v in C5.VARIANTS]
    md = build_markdown(results)
    assert "## Circular cylinder" in md
    for label in C5.VARIANT_LABELS.values():
        assert f"### {label}" in md
    assert "Strouhal number St = f D / U (Re 100)" in md and "Williamson (1988)" in md
    assert "the shedding window t = " in md and "monitor samples a period" in md
    assert "the separation angle" in md and "Fornberg (1980)" in md
    assert "Re 100: transient" not in md
    # The transient run's run line says how far it ran in time, not iterations.
    facts = variant_facts(C5, results[2])
    run = next(f for f in facts if f.startswith("Run:"))
    assert "s of flow" in run and "iterations" not in run
    page = build_site(results)
    assert "Circular cylinder" in page["index.html"]
    doc = json.loads(page["results.json"])
    assert [r["variant"] for r in doc["results"] if r["case"] == "c5_cylinder"] == ["re20", "re40", "re100"]
