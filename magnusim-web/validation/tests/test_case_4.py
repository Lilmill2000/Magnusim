"""Case 4, the laminar backward-facing step: its plans (the two geometries, faces, BCs, the 2D
mesh and its estimate, what is read) and its evaluation on synthetic runs with known answers."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from magnusim_validation import cases
from magnusim_validation.evaluate import evaluate_dir
from magnusim_validation.plan import make_plan
from magnusim_validation.refs import read
from magnusim_validation.report import build_markdown
from magnusim_validation.site import build_site
from validation_fakes import fake_step_run

pytestmark = pytest.mark.occt


def test_case_4_plans_both_steps_from_the_reference_data(tmp_path: Path):
    c4 = cases.get("c4")
    a = make_plan(c4, "re100", tmp_path / "a", cores=4)
    assert a == make_plan(c4, "re100", tmp_path / "a2", cores=4)
    b = make_plan(c4, "re800", tmp_path / "b", cores=4)
    for plan in (a, b):
        labels = plan["geometry"]["labels"]
        # Eight faces, one each: the two boxes fused and unified (one top wall, one front, one back).
        assert len(plan["geometry"]["faces"]) == 8
        assert {k: len(v) for k, v in labels.items()} == {k: 1 for k in
                                                         ("inlet", "outlet", "floor", "top", "inlet_floor", "step", "front", "back")}
        bcs = {x["name"]: x for x in plan["bcs"]}
        assert bcs["Inlet"]["bc_type"] == "Velocity inlet" and bcs["Inlet"]["value"] == 1.0
        assert bcs["Outlet"]["bc_type"] == "Pressure" and bcs["Outlet"]["value"] == 0
        assert bcs["Floor"]["faces"] == labels["floor"] and bcs["Top"]["faces"] == labels["top"]
        assert all(bcs[n]["wall_type"] == "No-slip" for n in ("Floor", "Top", "Step walls"))
        assert bcs["Step walls"]["faces"] == labels["inlet_floor"] + labels["step"]
        # The Symmetry on the two ends only (One cell across asks for that).
        assert bcs["Sides"]["bc_type"] == "Symmetry" and bcs["Sides"]["faces"] == labels["front"] + labels["back"]
        mesh = plan["mesh"]
        assert mesh["settings"]["mesher_settings"] == {"one_cell_across": True}
        assert mesh["settings"]["advanced"]["mesh_engine"] == "snappy_hexdominant"
        assert mesh["settings"]["fineness"] == 10 and mesh["expect"]["layers"] is False
        ref = mesh["refinements"][0]
        assert ref["type"] == "Surface custom sizing" and len(ref["faces"]) == 4 and ref["reach_unit"] == "mm"
        kinds = {e["key"]: e["kind"] for e in plan["extract"]}
        assert kinds == {"floor_shear": "patch", "top_shear": "patch", "floor_line": "app_sampling",
                         "top_line": "app_sampling", "inlet_profile": "app_sampling", "p_floor_line": "line"}
        ex = {e["key"]: e for e in plan["extract"]}
        assert ex["floor_shear"]["patch"] == "floor" and ex["top_shear"]["patch"] == "top"
        assert ex["p_floor_line"]["points_m"] == ex["floor_line"]["points_m"]
    # Armaly et al.'s expansion ratio 1.942 at Re_D 100; Gartling's ratio 2 at Re_D 800.
    fa = {f["id"]: f for f in a["geometry"]["faces"]}
    inlet_a = next(f for f in a["geometry"]["faces"] if f["normal"] == [-1.0, 0.0, 0.0] and f["centroid_mm"][0] < 0)
    assert inlet_a["area_mm2"] == pytest.approx(5.2 * 5.0) and len(fa) == 8
    assert a["material"]["kinematic_viscosity"] == pytest.approx(1.0 * 0.0104 / 100)
    assert b["material"]["kinematic_viscosity"] == pytest.approx(1.0 * 0.010 / 800)
    outlet_b = next(f for f in b["geometry"]["faces"] if f["normal"] == [1.0, 0.0, 0.0])
    assert outlet_b["centroid_mm"][0] == pytest.approx(300.0) and outlet_b["area_mm2"] == pytest.approx(50.0)
    # The outlet 30 H after the step; the upstream channel 10 h (Re 100) or 10 H (Re 800).
    assert c4.GEOM["re100"]["down"] == pytest.approx(30 * c4.GEOM["re100"]["H"])
    assert c4.GEOM["re800"]["down"] == pytest.approx(30 * c4.GEOM["re800"]["H"])
    assert c4.GEOM["re100"]["up"] == pytest.approx(10 * c4.GEOM["re100"]["h"])
    assert c4.GEOM["re800"]["up"] == pytest.approx(10 * c4.GEOM["re800"]["H"])
    # The 2D mesh's estimate: one cell deep, the whole channel at the custom size's level.
    for plan in (a, b):
        est = plan["mesh"]["estimate"]
        assert est["one_cell_across"] is True and est["block"][2] == 1 and est["block"][1] == 8
        cell = est["custom_sizes"][0]["cell_mm"]
        assert cell[0] / cell[1] < 2.0, "the background cells' aspect ratio at fineness 10"
    assert b["run"]["endTime"] == 6000 and a["run"]["endTime"] == 4000
    # SIMPLEC at Re_D 800 (SIMPLE never settled there), SIMPLE at Re_D 100.
    assert b["study"]["settings"]["simplec"] is True and "simplec" not in a["study"]["settings"]
    assert len(b["run"]["result_controls"][0]["points"]) == 2 and len(a["run"]["result_controls"][0]["points"]) == 1
    coarse = make_plan(c4, "re800", tmp_path / "c", cores=4, coarse=True)
    # Coarse: the custom size doubled (a level fewer), the fineness and the iteration limit kept.
    assert coarse["mesh"]["settings"]["fineness"] == 10 and coarse["run"]["endTime"] == 6000
    assert coarse["mesh"]["refinements"][0]["default_size"] == 2 * b["mesh"]["refinements"][0]["default_size"]
    assert coarse["mesh"]["estimate"]["custom_sizes"][0]["level"] == b["mesh"]["estimate"]["custom_sizes"][0]["level"] - 1


def test_case_4s_references_are_the_reference_datas():
    c4 = cases.get("c4")
    q100 = {q.key: q for q in c4.quantities("re100")}
    q800 = {q.key: q for q in c4.quantities("re800")}
    assert set(q100) == {"x1_over_s"} and set(q800) == {"xr_over_s", "xs_top_over_s", "xr_top_over_s"}
    x1 = q100["x1_over_s"]
    assert (x1.reference.value, x1.reference.kind, x1.reference.confidence) == (3.0, "experimental", "CONFIRMED")
    assert "Armaly" in x1.reference.citation and "Fig. 14" in x1.reference.where and x1.tolerance.rel_pct == 10.0
    assert q800["xr_over_s"].reference.value == 12.20 and q800["xr_over_s"].tolerance.rel_pct == 7.0
    assert q800["xs_top_over_s"].reference.value == 9.70 and q800["xr_top_over_s"].reference.value == 20.96
    assert all(q.tolerance.rel_pct == 10.0 for k, q in q800.items() if "top" in k)
    assert all(q.reference.confidence == "SECONDARY" and "Gartling" in q.reference.citation for q in q800.values())
    assert c4.SCATTER_RANGE == (11.48, 12.20)
    assert read("armaly_1983_fig14_x1.csv").row(re=100)["x1_over_s"] == 3.0


def test_case_4_reads_the_reattachment_and_the_top_bubble_of_a_known_flow(tmp_path: Path):
    c4 = cases.get("c4")
    run_dir = tmp_path / "re800"
    make_plan(c4, "re800", run_dir, cores=4)
    fake_step_run(run_dir, xr_s=12.0, corner_s=0.3, top=(9.5, 21.0), line_shift_s=0.05)
    res = evaluate_dir(run_dir)
    assert res["status"] == "ok", res["status_detail"]
    q = {x["key"]: x for x in res["quantities"]}
    assert q["xr_over_s"]["value"] == pytest.approx(12.0, abs=2e-3)
    assert q["xs_top_over_s"]["value"] == pytest.approx(9.5, abs=2e-3)
    assert q["xr_top_over_s"]["value"] == pytest.approx(21.0, abs=2e-3)
    assert q["xr_over_s"]["error"]["rel_pct"] == pytest.approx(100 * (q["xr_over_s"]["value"] - 12.2) / 12.2)
    assert q["xr_over_s"]["within"] is True and q["xr_over_s"]["verdict"] == "report_only"
    assert q["xr_over_s"]["source"] == "case_file:<latest>/wallShearStress"
    assert q["xr_over_s"]["uncertainty"]["kind"] == "pct" and q["xr_over_s"]["uncertainty"]["value"] < 0.2
    s = res["shown"]
    # The corner eddy at the step's foot is passed over, and said.
    assert s["corner_eddy_end_over_s"] == pytest.approx(0.3, abs=2e-3)
    # OpenFOAM's sign: forward flow negative on both walls.
    assert s["floor_tau_forward_sign"] == -1.0 and s["top_tau_forward_sign"] == -1.0
    assert s["top_bubble_over_s"] == pytest.approx(11.5, abs=4e-3)
    # The near-wall lines cross a little later, as the synthetic flow has them.
    assert s["line_floor_reattachment_over_s"] == pytest.approx(12.05, abs=2e-3)
    assert s["line_top_separation_over_s"] == pytest.approx(9.55, abs=2e-3)
    assert s["profile_u_max_over_ub"] == pytest.approx(1.5, abs=1e-3) and s["profile_max_dev"] < 1e-9
    assert s["route_vs_app_sampling_p_max_abs"] == 0.0
    assert s["ub_m_s"] == pytest.approx(1.0) and s["re_d_eff"] == pytest.approx(800.0)
    assert s["imbalance_pct"] == pytest.approx(1e-4, rel=1e-9)
    assert {"floor_cf", "top_cf", "floor_line", "inlet_profile", "residuals"} <= set(res["series"])
    # The plotted wall shear stress runs from the step to 32 S, forward positive.
    cf = res["series"]["floor_cf"]
    assert max(cf["x_over_s"]) <= 32.0 and cf["cf"][-1] > 0
    text = build_markdown([res])
    assert "| Backward-facing step | Re_D = 800 (Gartling), Hex-dominant (2D) | ok |" in text
    assert "a corner eddy at the step's foot" in text and "Gresho" not in text
    assert "the top wall's bubble 11.5 S long" in text
    # The cells a custom size sets, beside the walls' level's (here the custom size's are finer).
    assert "wall cells 0.391 × 0.208 × 5 mm (x × y × z), Channel's custom size cells 0.196 × 0.104 × 5 mm (level 4)" in text
    page = build_site([res])["index.html"]
    assert "Gartling" in page and 'src="img/c4_backward_step-re800-wall_shear.png"' in page
    from magnusim_validation.plots import render

    files = render(c4, res, tmp_path / "img")
    assert sorted(f.name for f in files) == [f"c4_backward_step-re800-{k}.png" for k in
                                             ("inlet_profile", "near_floor", "residuals", "wall_shear")]


def test_case_4_at_re_100_has_no_top_bubble_and_says_so(tmp_path: Path):
    c4 = cases.get("c4")
    run_dir = tmp_path / "re100"
    make_plan(c4, "re100", run_dir, cores=4)
    fake_step_run(run_dir, xr_s=3.1)
    res = evaluate_dir(run_dir)
    assert res["status"] == "ok", res["status_detail"]
    q = {x["key"]: x for x in res["quantities"]}
    assert list(q) == ["x1_over_s"] and q["x1_over_s"]["value"] == pytest.approx(3.1, abs=2e-3)
    assert q["x1_over_s"]["within"] is True
    s = res["shown"]
    assert s["top_reversed"] is False and "corner_eddy_end_over_s" not in s
    assert "no reversed flow on the top wall" in build_markdown([res])


def test_a_floor_that_never_reattaches_has_no_value_and_says_why(tmp_path: Path):
    c4 = cases.get("c4")
    run_dir = tmp_path / "re100"
    make_plan(c4, "re100", run_dir, cores=4)
    fake_step_run(run_dir, xr_s=3.0, reattaches=False)
    res = evaluate_dir(run_dir)
    assert res["status"] == "extract_failed"
    assert "x1_over_s" in res["status_detail"]
    assert "is not forward everywhere" in res["status_detail"]


def test_a_wall_profile_merges_faces_at_one_x_and_keeps_its_order():
    c4 = cases.get("c4")
    sample = {"n": 4, "x": [0.3, 0.1, 0.2, 0.2], "area": [1.0, 1.0, 1.0, 3.0],
              "wallShearStress_x": [3.0, 1.0, 1.0, 5.0]}
    x, t = c4.wall_profile(sample)
    assert x.tolist() == [0.1, 0.2, 0.3] and t.tolist() == [1.0, 4.0, 3.0]
    x, t = c4.wall_profile({**sample, "x": [0.3, -0.1, 0.2, 0.2], "n": 4}, x_min=0.0)
    assert x.tolist() == [0.2, 0.3]
    with pytest.raises(ValueError):
        c4.wall_profile({"n": 0})
    st = c4.reversed_stretches(np.array([0.0, 1.0, 2.0, 3.0, 4.0]), np.array([1.0, -1.0, -1.0, 1.0, 1.0]))
    assert (st["start"], st["end"], st["end_spacing"]) == (0.5, 2.5, 1.0)
    st = c4.reversed_stretches(np.array([0.0, 1.0, 2.0]), np.array([-1.0, 1.0, 1.0]))
    assert (st["start"], st["end"], st["reversed_at_first"]) == (None, 0.5, True)
    assert c4.reversed_stretches(np.array([0.0, 1.0]), np.array([1.0, 1.0]))["any_reversed"] is False
    # A wall's own zero in round-off is no sign: the line 0.02 S above the floor starts on the step face.
    x = np.arange(8.0)
    st = c4.reversed_stretches(x, np.array([-8e-19, 3e-6, -0.1, -0.5, -0.3, 0.2, 0.5, 1.5]))
    assert st["start"] == pytest.approx(1.0 + 3e-6 / (3e-6 + 0.1)) and st["end"] == pytest.approx(4.6)
    assert st["others"] == []
    # A small reversed eddy at the step's foot before the corner eddy: the primary is the longest stretch.
    st = c4.reversed_stretches(x, np.array([-0.01, 0.02, -0.5, -0.5, -0.5, -0.5, 0.5, 1.0]))
    assert st["end"] == pytest.approx(5.5) and st["start"] == pytest.approx(1.0 + 0.02 / 0.52)
    assert [(o["start"], o["end"]) for o in st["others"]] == [(None, pytest.approx(1.0 / 3.0))]
