"""``evaluate`` on synthetic route answers with known answers: an exact Hagen-Poiseuille pipe
gives f·Re 64 and U_cl/U_b 2, and each way a run can stop gives its status."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest
from magnusim_validation.evaluate import (
    background_block,
    converged_at,
    evaluate_dir,
    last_initial_residuals,
    openfoam_version,
    residual_series,
)
from validation_fakes import LAMBDA, D, fake_run, plan_run

pytestmark = pytest.mark.occt

def test_an_exact_pipe_gives_the_exact_numbers(tmp_path: Path):
    run_dir = plan_run(tmp_path)
    fake_run(run_dir)
    doc = evaluate_dir(run_dir)
    assert doc["status"] == "ok", doc["status_detail"]
    q = {x["key"]: x for x in doc["quantities"]}
    assert q["fRe"]["value"] == pytest.approx(64.0, rel=1e-9)
    assert q["ucl"]["value"] == pytest.approx(2.0, rel=1e-6)
    # 2 - exp(-x/lambda) reaches 99 % of its plateau (2, to 1e-7) where exp(-x/lambda) = 0.02.
    assert q["le"]["value"] == pytest.approx(LAMBDA * math.log(50) / D, rel=2e-3)
    # Locked (2026-11-07): f·Re and U_cl / U_b inside their bands pass; the synthetic centreline
    # develops in 2.35 D, far outside 5.77 D ± 15 %, so its development length fails.
    assert {k: x["verdict"] for k, x in q.items()} == {"fRe": "pass", "ucl": "pass", "le": "fail"}
    assert q["fRe"]["within"] and q["ucl"]["within"]
    assert doc["mesh"]["n_cells"] == 120000 and doc["mesh"]["layers"]["applied"] is True
    assert doc["mesh"]["background"] == {"block": [67, 8, 12]}
    assert doc["run"]["converged_at"] == 180 and doc["run"]["wall_s"] == 120.0
    assert doc["run"]["health"]["verdict"] == "healthy"
    assert doc["app"]["openfoam"] == "v2606 (build _481094f-20260618)"
    assert doc["precheck"]["rows"] == [{"code": "still_start", "level": "info", "text": "From rest."}]
    assert doc["shown"]["profile_rms_line_over_ub"] == pytest.approx(0.0, abs=1e-9)
    assert doc["shown"]["profile_rms_cells_over_ub"] == pytest.approx(0.0, abs=1e-9)
    assert doc["shown"]["probe_ucl_over_ub"] == pytest.approx(2.0, abs=1e-3)
    assert doc["shown"]["ucl_line_over_ub"] == pytest.approx(2.0, abs=1e-6)
    # The compared centreline speed is the cell values' fit, not the line's reading.
    assert q["ucl"]["source"] == "app_sampling (cell values)"
    assert doc["shown"]["ucl_cells"]["n"] == 7 * 3 * 8  # the radii within R/2
    # The wall shear stress the run saved balances the pressure gradient.
    assert doc["shown"]["tau_w"]["vs_exact_pct"] == pytest.approx(0.0, abs=1e-9)
    assert doc["shown"]["tau_w"]["dpdx_balanced_Pa_m"] == pytest.approx(doc["shown"]["dpdx_Pa_m"], rel=1e-9)
    assert doc["run"]["settle"]["settled"] is True
    assert set(doc["series"]) >= {"p_axis", "u_axis", "u_radial", "probes", "residuals", "cells_profile"}
    assert len(doc["series"]["p_axis"]["x_m"]) <= 400
    on_disk = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
    assert on_disk == doc


def test_the_flow_imbalance_is_the_fraction_the_route_gives_as_a_per_cent(tmp_path: Path):
    """The monitors' balance carries (out - in) / in, a fraction (the Results panel shows it times
    100): the pipe's shown imbalance is that times 100, not divided by the flow again."""
    run_dir = plan_run(tmp_path)
    fake_run(run_dir)
    mon_path = run_dir / "raw" / "monitors.json"
    mon = json.loads(mon_path.read_text(encoding="utf-8"))
    q = math.pi * D * D / 4
    mon["balance"] = {"in_m3s": q, "out_m3s": q * (1 + 2e-6), "imbalance": 2e-6}
    mon_path.write_text(json.dumps(mon), encoding="utf-8")
    doc = evaluate_dir(run_dir)
    assert doc["shown"]["imbalance_pct"] == pytest.approx(2e-4, rel=1e-9)


def test_a_line_that_reads_the_peak_low_does_not_move_the_compared_centreline(tmp_path: Path):
    run_dir = plan_run(tmp_path)
    fake_run(run_dir)
    line = json.loads((run_dir / "raw" / "line_u_axis.json").read_text(encoding="utf-8"))
    line["values"] = [0.97 * v for v in line["values"]]
    (run_dir / "raw" / "line_u_axis.json").write_text(json.dumps(line), encoding="utf-8")
    doc = evaluate_dir(run_dir)
    q = {x["key"]: x for x in doc["quantities"]}
    assert q["ucl"]["value"] == pytest.approx(2.0, rel=1e-9)
    assert doc["shown"]["ucl_line_over_ub"] == pytest.approx(1.94, rel=1e-6)


def test_without_its_cell_values_the_centreline_is_missing_and_says_why(tmp_path: Path):
    run_dir = plan_run(tmp_path)
    fake_run(run_dir, samples=False)
    doc = evaluate_dir(run_dir)
    assert doc["status"] == "extract_failed"
    assert "no value for ucl" in doc["status_detail"]
    assert "the run's case folder is gone" in doc["status_detail"]


def test_a_steady_run_that_stops_at_its_limit_still_moving_is_not_settled(tmp_path: Path):
    run_dir = plan_run(tmp_path)
    fake_run(run_dir, converged=False, drift=0.01)
    doc = evaluate_dir(run_dir)
    assert doc["status"] == "not_settled"
    assert "the inlet's area-averaged pressure 0.99 %" in doc["status_detail"]
    assert doc["run"]["settle"]["settled"] is False
    # Its numbers are still shown, as they are.
    assert all(x["value"] is not None for x in doc["quantities"])


def test_a_steady_run_that_stops_at_its_limit_but_has_settled_is_ok_with_a_warning(tmp_path: Path):
    run_dir = plan_run(tmp_path)
    fake_run(run_dir, converged=False, drift=1e-5)
    doc = evaluate_dir(run_dir)
    assert doc["status"] == "ok", doc["status_detail"]
    assert doc["run"]["settle"]["settled"] is True
    assert any("stopped at its iteration limit" in w for w in doc["warnings"])


def test_a_custom_sizes_band_from_the_mesh_facts_is_kept(tmp_path: Path):
    """Each custom size's band as the mesher wrote it (a Refine out to's reach too) goes into
    result.json's mesh; a mesh with none keeps the mesh section as it was."""
    run_dir = plan_run(tmp_path)
    fake_run(run_dir)
    assert "refined" not in evaluate_dir(run_dir)["mesh"]
    facts_path = run_dir / "raw" / "mesh-facts.json"
    facts = json.loads(facts_path.read_text(encoding="utf-8"))
    band = [{"level": 3, "cell_m": 0.0005, "distance_m": 0.03, "reach_m": 0.03}]
    facts_path.write_text(json.dumps({**facts, "refined": band}), encoding="utf-8")
    assert evaluate_dir(run_dir)["mesh"]["refined"] == band


def test_layers_asked_and_not_applied_fail_the_run(tmp_path: Path):
    run_dir = plan_run(tmp_path)
    fake_run(run_dir, layers_applied=False)
    doc = evaluate_dir(run_dir)
    assert doc["status"] == "layers_not_applied"
    assert "not applied" in doc["status_detail"]


def test_a_run_stopped_by_the_app_says_where(tmp_path: Path):
    run_dir = plan_run(tmp_path)
    fake_run(run_dir, lines=False, driver={"outcome": "failed", "failed_step": "mesh", "error": "the mesh failed: boom",
                                           "ids": {}, "app": {}})
    doc = evaluate_dir(run_dir)
    assert doc["status"] == "mesh_failed" and doc["status_detail"] == "the mesh failed: boom"
    assert [x["verdict"] for x in doc["quantities"]] == ["missing", "missing", "missing"]


def test_a_run_without_its_lines_is_an_extraction_failure(tmp_path: Path):
    run_dir = plan_run(tmp_path)
    fake_run(run_dir, lines=False)
    doc = evaluate_dir(run_dir)
    assert doc["status"] == "extract_failed"
    assert "no value for fRe" in doc["status_detail"]


def test_the_log_readers():
    assert openfoam_version({"lines": ["Version: v2412"]}) == "v2412"
    assert openfoam_version({}) is None
    assert converged_at({"lines": ["SIMPLE solution converged in 42 iterations"]}) == 42
    assert converged_at({"lines": ["End"]}) is None
    assert background_block("nothing") is None
    hist = [{"t": i, "U": 1.0 / i, "p": 2.0 / i} for i in range(1, 1001)]
    s = residual_series(hist, n_max=100)
    assert len(s["t"]) <= 101 and s["t"][-1] == 1000.0 and s["U"][-1] == pytest.approx(1e-3)
    # Each field's initial residual in the log's last iteration (a pressure solved twice: its first).
    log = {"lines": ["Time = 2999", "smoothSolver:  Solving for Ux, Initial residual = 0.5, Final residual = 1",
                     "Time = 3000", "smoothSolver:  Solving for Ux, Initial residual = 1.6e-05, Final residual = 7e-07",
                     "smoothSolver:  Solving for Uz, Initial residual = 0.0132, Final residual = 0.0005",
                     "GAMG:  Solving for p, Initial residual = 1.04e-05, Final residual = 9e-08",
                     "GAMG:  Solving for p, Initial residual = 5.7e-07, Final residual = 8e-08", "End"]}
    assert last_initial_residuals(log) == {"Ux": 1.6e-05, "Uz": 0.0132, "p": 1.04e-05}
    assert last_initial_residuals({}) == {}
