"""Run health's calibration gate (RH1, spec 2.6): healthy runs never reach Unhealthy at any
point of their replay, and end Healthy. A threshold that trips one is changed in
magnusim_sdk/health.py, with the reason in a comment there.

The fixtures (python/tests/fixtures/health/calib/, scrubbed: host cfdbox-17, user cfduser)
were solved on 2026-11-03 with OpenFOAM v2606 in WSL, at most 4 ranks:

- ``bfs-*``: the backward-facing step of OpenFOAM's pitzDaily tutorial (12,225 cells, its
  0/ fields, k-omega SST), with the system/ dictionaries Incompressible Flow writes
  (``write_fv_solution_pimple``, ``write_fv_schemes_transient``, ``write_control_dict_transient``,
  ``write_fv_options_limit_u``, the steady ``_steady_*_body`` ones):
  ``bfs-piso-co1`` PISO at Max Courant 1 and ``bfs-pimple3-co5`` 3 outer correctors at Max
  Courant 5 (the fix the Health block offers; Run_2's own case and mesh were not available,
  so these stand in for spec 2.6's run2-fixed), both at a fixed 10 m/s inflow from rest;
  ``bfs-dp-transient`` a total-pressure inlet (pressure-driven: no fixed inflow);
  ``bfs-table-transient`` an inlet ramped 0 to 10 m/s over 5 ms (a "Varies with time" table);
  ``bfs-steady`` simpleFoam to its residual targets (steady separated flow).
- ``ht-hotroom``: OpenFOAM's buoyantPimpleFoam hotRoom tutorial as it is (natural convection,
  p_rgh, no velocity limit, no fixed inflow).
- ``cht``: the app-written conjugate case of python/tests/fixtures/cht-case
  (chtMultiRegionSimpleFoam), run to 400 iterations.

Each ``<name>.hints.json`` is the health hints such a case carries.
"""

from __future__ import annotations

import itertools
import json
from pathlib import Path

import pytest
from magnusim_sdk.health import HealthTracker, iter_log_lines

CALIB = Path(__file__).resolve().parents[1] / "fixtures" / "health" / "calib"
CASES = sorted(p.name[: -len(".log.gz")] for p in CALIB.glob("*.log.gz"))


def test_the_gate_has_its_cases():
    assert set(CASES) >= {
        "bfs-piso-co1",
        "bfs-pimple3-co5",
        "bfs-dp-transient",
        "bfs-table-transient",
        "bfs-steady",
        "ht-hotroom",
        "cht",
    }


@pytest.mark.parametrize("name", CASES)
def test_a_healthy_run_is_never_unhealthy_and_ends_healthy(name: str):
    hints = json.loads((CALIB / f"{name}.hints.json").read_text(encoding="utf-8"))
    tracker = HealthTracker(hints)
    worst = "healthy"
    steps = 0
    for text, off in iter_log_lines(str(CALIB / f"{name}.log.gz")):
        tracker.line(text, off)
        if tracker.verdict in ("unhealthy", "failed"):
            worst = tracker.verdict
            break
        steps = tracker.steps
    assert worst == "healthy", f"{name}: {worst} at step {tracker.steps}, levels {tracker.level}"
    rec = tracker.report(final=True)
    assert rec["verdict"] == "healthy", (name, rec["verdict"], [f["code"] for f in rec["findings"]])
    assert steps >= 240, (name, steps)
    # Every Host header is the synthetic one, and no path names a real user.
    head = "\n".join(t for t, _o in itertools.islice(iter_log_lines(str(CALIB / f"{name}.log.gz")), 40))
    assert "Host   : cfdbox-17" in head
    assert "/home/" not in head.replace("/home/cfduser/", "")
