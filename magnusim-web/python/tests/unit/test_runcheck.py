"""The pre-run check's rules (run health, RH2, spec 4.2 and 4.6): magnusim_sdk.runcheck with
Run_2's inputs (a PISO run at Max Courant 100 on 625,221 cells, 15 ranks, a fixed 22.6 m/s
inflow, k-omega SST, still start, averaging from 0 s), and each row's rule, words and fix.

- Run_2: piso_high_co at warn (never error: Max Courant has no cap, A1), with the fix
  "3 outer correctors, Max Courant 5" and the alternative "Max Courant 1" and their costs;
  average_startup and long_run; long_run's fix is the cheapest that keeps the Courant checks
  clean and never raises Courant with 1 outer corrector.
- The what-if {n_outer: 3, max_co: 5} clears the Courant checks.
- No row blocks: there is no "block" level, and a Courant row is warn at 100 and at 10,000.
"""

from __future__ import annotations

import copy

import pytest
from magnusim_sdk.numerics_advice import rule
from magnusim_sdk.runcheck import check, counts, failed_words, steps_words, wall_words

# Run_2's convective rate: about 9.0e4 1/s at 22.6 m/s and 1.5x (spec 1).
RUN2_RATE = 9.0e4 / (22.6 * 1.5)
RUN2_RATES = {"v": 1, "n_cells": 625221, "n_rated": 625221, "p99_9": [RUN2_RATE, 1.0, 1.0], "max": [RUN2_RATE * 1.2, 1.0, 1.0], "top": []}
RUN2_MESH = {
    "v": 1,
    "quality": {"known": True, "ok": True, "n_failed": 0, "failed": [], "max_non_orthogonality": 55.0, "max_skewness": 2.1, "max_aspect_ratio": 12.0},
    "n_cells": 625221,
    "bbox_m": {"min": [0, 0, 0], "max": [4.0, 0.6, 0.6], "size": [4.0, 0.6, 0.6]},
    "surface_cell_m": None,
    "layers": {"asked": False, "applied": None, "first_m": None, "walls": []},
}
ANY_YPLUS = {"label": "k-omega SST", "key": "turbulence_model", "value": "kOmegaSST"}
SST = {"laminar": False, "label": "k-omega SST", "fields": "k and omega", "wall_functions": False, "any_yplus": ANY_YPLUS}
KE = {"laminar": False, "label": "k-epsilon", "fields": "k and epsilon", "wall_functions": True, "any_yplus": ANY_YPLUS}
LAMINAR = {"laminar": True, "label": "Laminar", "fields": "", "wall_functions": False, "any_yplus": ANY_YPLUS}
RUN2 = {
    "time_dependency": "transient",
    "settings": {
        "end_time": 10.0,
        "write_count": 60,
        "time_step_mode": "adjustable",
        "max_co": 100.0,
        "delta_t": None,
        "n_outer_correctors": 1,
        "n_correctors": 2,
        "n_non_orth_correctors": 0,
        "average_from": 0.0,
    },
    "mesh": RUN2_MESH,
    "mesh_ready": True,
    "rates": RUN2_RATES,
    "n_cells": 625221,
    "ranks": 15,
    "s_per_cell_step": 1.4e-5,
    "rate_source": "default",
    "speed": 22.6113,
    "direction": [1.0, 0.0, 0.0],
    "inlet": "Velocity inlet 1",
    "velocity_cap": 226.113,
    "fixed_inflow": True,
    "time_varying": False,
    "moving": False,
    # The analysis's words for its model (Incompressible Flow's for k-omega SST): the core names none.
    "turbulence": SST,
    "steady_algorithm": "SIMPLE",
    "nu": 1.5e-5,
    "d_hyd": 0.3,
    "initial_flow": "still",
    "potential_flow": False,
    "inlet_driven": True,
    "numerics": {},
    "steady_copy": True,
    "kept": [],
}


def run2(**settings):
    out = copy.deepcopy(RUN2)
    out["settings"].update(settings)
    return out


def rows_of(result):
    return {r["code"]: r for r in result["checks"]}


def values(fix):
    return {v["key"]: v["value"] for v in fix["values"]}


def test_run2_piso_high_co_is_a_warning_with_its_fix_and_alternative():
    out = check(RUN2)
    rows = rows_of(out)
    row = rows["piso_high_co"]
    assert row["level"] == "warn"
    assert row["text"] == (
        f"Max Courant 100 with 1 outer corrector. {rule('max_co')} "
        "At 100 expect the 226 m/s velocity limit to clip cells and k and omega to go negative."
    )
    assert row["short"] == "Max Courant 100 with PISO"
    assert row["fix"]["label"] == "3 outer correctors, Max Courant 5"
    assert row["fix"]["target"] == "run"
    assert values(row["fix"]) == {"transient.n_outer_correctors": 3, "transient.max_co": 5}
    # ~180,000 steps, about 4 days; the alternative about 900,000 steps, about 6 days.
    assert row["fix"]["cost"]["steps"] == pytest.approx(180_000, rel=0.02)
    assert wall_words(row["fix"]["cost"]["wall_s"]) == "about 4 days"
    assert row["alt"]["label"] == "Max Courant 1"
    assert values(row["alt"]) == {"transient.max_co": 1}
    assert row["alt"]["cost"]["steps"] == pytest.approx(900_000, rel=0.02)
    assert wall_words(row["alt"]["cost"]["wall_s"]) == "about 6 days"


def test_run2_average_startup_and_long_run():
    rows = rows_of(check(RUN2))
    # One flow-through: 4 m at 22.6 m/s ≈ 0.177 s; from rest 3 of them: averaging from 0.531 s.
    avg = rows["average_startup"]
    assert avg["level"] == "warn"
    assert avg["text"] == (
        "Mean velocity and Mean pressure average from 0 s, so they include the start-up. "
        "One flow-through ≈ 0.177 s; averaging from 0.531 s leaves it out."
    )
    # Rounded up to a frame (10 s / 60 frames).
    assert values(avg["fix"])["transient.average_from"] == pytest.approx(4 * 10 / 60)
    assert avg["fix"]["label"] == "Average from 0.6667 s"
    long = rows["long_run"]
    assert long["level"] == "warn"
    assert long["text"] == (
        "About 900,000 time steps, roughly 6 days on 15 cores (a typical speed: no run has finished on this PC yet)."
    )
    # The cheapest fix that keeps the Courant checks clean: a steady copy (15 minutes) beats
    # 3 outer correctors at Max Courant 5 (4 days); the end-time fix keeps Max Courant 100 with
    # PISO, which is not clean.
    assert long["fix"]["target"] == "steady_copy"
    assert long["fix"]["label"] == "Make a steady copy"


def test_run2_steady_for_mean_and_duration():
    rows = rows_of(check(RUN2))
    sfm = rows["steady_for_mean"]
    assert sfm["level"] == "warn"
    assert sfm["text"] == (
        "If you need the mean flow, a steady k-omega SST run solves for it directly: about 1,500 iterations, "
        "roughly 15 minutes here, against about 6 days for this run. Keep this run for shedding or a time history."
    )
    assert sfm["fix"] == {"label": "Make a steady copy", "target": "steady_copy", "values": [], "cost": {"steps": 1500, "wall_s": sfm["fix"]["cost"]["wall_s"]}}
    dur = rows["duration_vs_ftt"]
    assert dur["level"] == "info"
    assert dur["text"] == "10 s is about 57 flow-throughs; a mean usually settles within 10-20 after the start-up."
    # The start-up (3 flow-throughs) and 20 more, rounded up to 2 figures.
    assert values(dur["fix"])["transient.end_time"] == pytest.approx(4.1)


def test_run2_order_and_counts():
    out = check(RUN2)
    levels = [r["level"] for r in out["checks"]]
    assert levels == sorted(levels, key=lambda lv: {"error": 0, "warn": 1, "info": 2}[lv])
    assert {r["code"] for r in out["checks"]} == {
        "piso_high_co",
        "average_startup",
        "long_run",
        "steady_for_mean",
        "duration_vs_ftt",
        "still_start",
    }
    assert counts(out["checks"]) == {"error": 0, "warn": 4, "info": 2}


def test_run2_estimate_line():
    """Max Courant 100 with 1 outer corrector is counted at 1 (spec 4.2's line: a higher Max
    Courant is not a speed setting on its own): about 1.1e-5 s, 900,000 steps, 6 days."""
    est = check(RUN2)["estimate"]
    assert est["delta_t_s"] == pytest.approx(1.11e-5, rel=0.02)
    assert est["steps"] == pytest.approx(900_000, rel=0.02)
    assert (est["max_co"], est["co_used"]) == (100.0, 1.0)
    assert est["flow_through_s"] == pytest.approx(4.0 / 22.6113)
    assert est["line"] == (
        'Δt ≈ 1.1e-5 s at Max Courant 1, as 1 outer corrector allows (smallest cells at 22.6 m/s, inlet "Velocity inlet 1")'
        " · ~900,000 steps · ~6 days on 15 cores · one flow-through ≈ 0.177 s · Re ≈ 450,000"
    )


def test_what_if_three_outer_correctors_at_five_clears_the_courant_checks():
    out = check(run2(n_outer_correctors=3, max_co=5))
    codes = {r["code"] for r in out["checks"]}
    assert not codes & {"piso_high_co", "pimple_co_vs_outer", "fixed_step_co"}
    est = out["estimate"]
    assert est["steps"] == pytest.approx(180_000, rel=0.02)
    assert "~180,000 steps" in est["line"] and "~4 days on 15 cores" in est["line"]
    # The long run's fix now may be the shorter end time (its Courant numbers are clean).
    long = rows_of(out)["long_run"]
    assert long["fix"]["target"] == "steady_copy"


def test_courant_rows_warn_at_any_value_never_error():
    for co in (1.5, 100.0, 10_000.0):
        row = rows_of(check(run2(max_co=co)))["piso_high_co"]
        assert row["level"] == "warn"
    row = rows_of(check(run2(max_co=20, n_outer_correctors=3)))["pimple_co_vs_outer"]
    assert row["level"] == "warn"
    assert row["text"] == "Max Courant 20 with 3 outer correctors: above about 5 each step stops converging."
    assert values(row["fix"]) == {"transient.max_co": 5}
    assert rows_of(check(run2(max_co=1e6, n_outer_correctors=3)))["pimple_co_vs_outer"]["level"] == "warn"
    # PISO at Max Courant 1 and PIMPLE at 5: no Courant row.
    assert "piso_high_co" not in rows_of(check(run2(max_co=1)))
    assert "pimple_co_vs_outer" not in rows_of(check(run2(max_co=5, n_outer_correctors=2)))


def test_fixed_step_co_and_its_fix():
    # 1e-4 s at 22.6 m/s x 1.5 x the rate: Co ≈ 9.
    row = rows_of(check(run2(time_step_mode="fixed", delta_t=1e-4)))["fixed_step_co"]
    assert row["level"] == "warn"
    assert row["text"] == "A fixed step of 1e-4 s gives a Courant number of about 9 in the smallest cells."
    assert values(row["fix"]) == {"transient.time_step_mode": "adjustable", "transient.max_co": 1}
    # A blank fixed step: the Δt the case is written with.
    inputs = run2(time_step_mode="fixed", delta_t=None)
    inputs["delta_t_written"] = 1e-4
    assert "fixed_step_co" in rows_of(check(inputs))
    # Small enough: none.
    assert "fixed_step_co" not in rows_of(check(run2(time_step_mode="fixed", delta_t=1e-5)))


def test_outer_unneeded_and_piso_correctors():
    row = rows_of(check(run2(max_co=1, n_outer_correctors=2)))["outer_unneeded"]
    assert row["level"] == "info"
    assert row["text"] == "2 outer correctors at a Courant number of 1 or less nearly double each step's cost and change nothing."
    assert values(row["fix"]) == {"transient.n_outer_correctors": 1}
    row = rows_of(check(run2(max_co=1, n_correctors=1)))["piso_correctors"]
    assert row["level"] == "warn"
    assert row["text"] == "PISO needs at least 2 pressure correctors per step."
    assert values(row["fix"]) == {"transient.n_correctors": 2}


def test_long_run_never_raises_courant_with_one_outer_corrector():
    # PISO at Max Courant 0.5 on Run_2's mesh: long, and no Courant row; its fix is never a
    # higher Max Courant while it keeps 1 outer corrector.
    out = check(run2(max_co=0.5))
    long = rows_of(out)["long_run"]
    fix = long["fix"]
    if fix and fix["target"] == "run":
        v = values(fix)
        assert not (v.get("transient.n_outer_correctors", 1) <= 1 and v.get("transient.max_co", 0.5) > 0.5)
    # Without a steady sibling the steady copy is not offered; the end-time fix keeps Courant clean.
    inputs = run2(max_co=0.5)
    inputs["steady_copy"] = False
    long = rows_of(check(inputs))["long_run"]
    assert long["fix"]["target"] == "run"
    assert set(values(long["fix"])) == {"transient.end_time"}


def test_kept_rows_stay_with_kept_true():
    inputs = copy.deepcopy(RUN2)
    inputs["kept"] = ["piso_high_co"]
    out = check(inputs)
    assert rows_of(out)["piso_high_co"]["kept"] is True
    assert counts(out["checks"]) == {"error": 0, "warn": 3, "info": 2}
    assert counts(out["checks"], kept=True)["warn"] == 4


def test_mesh_rows():
    def with_quality(**q):
        inputs = copy.deepcopy(RUN2)
        inputs["mesh"]["quality"].update(q)
        return rows_of(check(inputs))

    rows = with_quality(ok=False, n_failed=2, failed=[{"check": "negative_volume", "count": 12, "unit": "cells", "accepted": False}, {"check": "skewness", "count": 22, "unit": "faces", "accepted": True}])
    assert rows["mesh_failed"]["level"] == "error"
    assert rows["mesh_failed"]["text"] == "checkMesh failed 1 check: 12 cells with a negative volume. The solve will likely fail."
    assert rows["mesh_failed"]["fix"]["target"] == "mesh"
    rows = with_quality(max_non_orthogonality=78.2)
    assert rows["non_ortho_correctors"]["text"] == "The worst cells are 78° non-orthogonal and the run uses no non-orthogonal correctors."
    assert values(rows["non_ortho_correctors"]["fix"]) == {"transient.n_non_orth_correctors": 1}
    rows = with_quality(max_skewness=4.6)
    assert rows["mesh_skew"]["text"] == "Skewness reaches 4.6; expect a less stable run near those cells."
    assert rows["mesh_skew"]["fix"]["label"] == "Open mesh"
    # No checkMesh report on a generated mesh: a note; no mesh at all: nothing.
    inputs = copy.deepcopy(RUN2)
    inputs["mesh"] = {"quality": {"known": False}}
    assert rows_of(check(inputs))["quality_unknown"]["text"] == "This mesh has no quality numbers."
    inputs["mesh_ready"] = False
    assert "quality_unknown" not in rows_of(check(inputs))
    assert failed_words({"check": "boundary_openness"}) == "the boundary is not closed"


def test_physics_rows():
    inputs = copy.deepcopy(RUN2)
    inputs["turbulence"] = LAMINAR
    row = rows_of(check(inputs))["laminar_turbulent"]
    assert row["text"].startswith("Re ≈ 450,000 is turbulent")
    assert values(row["fix"]) == {"turbulence_model": "kOmegaSST"}
    assert row["fix"]["target"] == "study"
    inputs = copy.deepcopy(RUN2)
    inputs["speed"] = 112.0
    assert rows_of(check(inputs))["mach"]["text"] == "112 m/s is above Mach 0.3; incompressible results will be off."
    inputs = copy.deepcopy(RUN2)
    inputs["turbulence"] = KE
    inputs["mesh"]["layers"] = {"asked": True, "applied": True, "first_m": 2e-5, "walls": []}
    row = rows_of(check(inputs))["yplus_model"]
    assert row["text"].startswith("Estimated y+ ≈ ")
    assert "(first cell 0.02 mm). k-epsilon's wall functions assume y+ above about 30; k-omega SST handles any y+." in row["text"]
    inputs = copy.deepcopy(RUN2)
    inputs["mesh"]["layers"] = {"asked": True, "applied": False, "first_m": None, "walls": []}
    inputs["mesh"]["surface_cell_m"] = 0.004
    row = rows_of(check(inputs))["layers_dropped"]
    assert row["text"].startswith("Boundary layers were asked for but the mesher dropped them; wall cells are 4 mm (y+ ≈ ")


def test_still_start_and_steady_rows():
    row = rows_of(check(RUN2))["still_start"]
    assert row["text"] == "The run starts from rest; starting from potential flow shortens the start-up."
    assert values(row["fix"]) == {"potential_flow": True}
    steady = {
        "time_dependency": "steady",
        "settings": {"end_time": 200},
        "n_cells": 625221,
        "ranks": 15,
        "numerics": {"relax_p": 0.8, "relax_u": 0.7, "simplec": False, "n_non_orthogonal": 3, "numerics_preset": "accurate"},
        "steady_algorithm": "SIMPLE",
        "mesh": RUN2_MESH,
        "mesh_ready": True,
    }
    rows = rows_of(check(steady))
    assert rows["steady_short"]["text"] == "200 iterations is rarely enough for 625k cells; the residual targets still stop it early."
    assert values(rows["steady_short"]["fix"]) == {"endTime": 1000}
    assert rows["steady_relax"]["text"] == "Relaxation p 0.8 often diverges with SIMPLE."
    assert values(rows["steady_relax"]["fix"]) == {"relax_p": 0.3, "relax_u": 0.7}
    # SIMPLEC uses its own relaxation: none.
    steady["numerics"]["simplec"] = True
    assert "steady_relax" not in rows_of(check(steady))


def test_words():
    assert steps_words(899_123) == "900,000"
    assert wall_words(900) == "about 15 minutes"
    assert wall_words(6 * 3600) == "about 6 hours"
    assert wall_words(6.1 * 86400) == "about 6 days"
