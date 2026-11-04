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
    assert all(x["verdict"] == "report_only" for x in doc["quantities"])
    assert q["fRe"]["within"] and q["ucl"]["within"]
    assert doc["mesh"]["n_cells"] == 120000 and doc["mesh"]["layers"]["applied"] is True
    assert doc["mesh"]["background"] == {"block": [67, 8, 12]}
    assert doc["run"]["converged_at"] == 180 and doc["run"]["wall_s"] == 120.0
    assert doc["run"]["health"]["verdict"] == "healthy"
    assert doc["app"]["openfoam"] == "v2606 (build _481094f-20260618)"
    assert doc["precheck"]["rows"] == [{"code": "still_start", "level": "info", "text": "From rest."}]
    assert doc["shown"]["profile_rms_over_ub"] == pytest.approx(0.0, abs=1e-9)
    assert doc["shown"]["probe_ucl_over_ub"] == pytest.approx(2.0, abs=1e-3)
    assert set(doc["series"]) >= {"p_axis", "u_axis", "u_radial", "probes", "residuals"}
    assert len(doc["series"]["p_axis"]["x_m"]) <= 400
    on_disk = json.loads((run_dir / "result.json").read_text(encoding="utf-8"))
    assert on_disk == doc


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
