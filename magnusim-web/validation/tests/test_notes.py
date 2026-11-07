"""The case notes say what the reported runs gave: every figure of those runs is worked out from
their results (``report.case_notes``), so a rerun's cells, values, iterations and times are the
notes' too. They were typed, and the sphere's note kept an overwritten run's 549 iterations and
235 s beside the result's 548 and 236 s."""

from __future__ import annotations

import copy

import pytest
from magnusim_validation import cases
from magnusim_validation.notes import and_list, run_words
from magnusim_validation.report import case_notes, load_results

CASES = ("c4_backward_step", "c5_cylinder", "c6_sphere")


def _rerun(res: dict) -> dict:
    """The same result as if a rerun had given other figures: cells, iterations, time, values."""
    out = copy.deepcopy(res)
    out["mesh"]["n_cells"] = 123_457
    (out["mesh"].setdefault("quality", {}))["max_non_orthogonality"] = 33.3
    run = out["run"]
    run["wall_s"] = 987.0
    if not run.get("transient"):
        run["iterations"] = 777
        if run.get("converged"):
            run["converged_at"] = 777
    est = (out.get("precheck") or {}).get("estimate") or {}
    if est.get("wall_s") is not None:
        est["wall_s"] = 4321.0
    for q in out["quantities"]:
        if q.get("value") is not None:
            q["value"] = q["value"] * 1.0101
            ref = q["reference"]["value"]
            q["error"] = {"abs": q["value"] - ref, "rel_pct": 100.0 * (q["value"] - ref) / ref if ref else None}
    return out


@pytest.mark.parametrize("cid", CASES)
def test_the_notes_quote_the_reported_runs_as_their_results_give_them(cid: str):
    case = cases.get(cid)
    mine = [r for r in load_results() if r["case"] == cid]
    assert mine, f"no committed results of {cid}"
    before = " ".join(case_notes(case, mine))
    after = " ".join(case_notes(case, [_rerun(r) for r in mine]))
    # The reported runs' own cell counts are nowhere in the notes once the runs say otherwise.
    for r in mine:
        cells = f"{r['mesh']['n_cells']:,}".replace(",", " ")
        assert cells in before, f"{cid}: the notes do not name the reported {cells} cells"
        assert cells not in after, f"{cid}: the notes still say {cells} cells after a rerun gave 123 457"
    assert "123 457" in after
    # What the pre-run check estimated, against what the solve took.
    if any(((r.get("precheck") or {}).get("estimate") or {}).get("wall_s") is not None for r in mine):
        assert "about 72 minutes, the solve 987 s" in after


def test_the_sphere_note_takes_its_iterations_from_the_result():
    case = cases.get("c6_sphere")
    mine = [r for r in load_results() if r["case"] == "c6_sphere"]
    text = " ".join(case_notes(case, [_rerun(r) for r in mine]))
    assert "the reported run" in text and "after 777 iterations (its worst face 33.3°)" in text
    # The typed runs are the earlier ones, dated, never the reported one's.
    assert "235 s" not in text


def test_the_cavity_notes_take_their_iterations_and_extrema_from_the_results():
    """The cavity's notes said "Re 100 at 6499 iterations, Re 1000 at 6056" and quoted the 1e-6 run's
    extrema, typed from the run of 2026-11-05; the full run of all six cases took 6507 and 6055."""
    case = cases.get("c3_lid_cavity")
    mine = [r for r in load_results() if r["case"] == "c3_lid_cavity"]
    assert len(mine) == 2
    before = " ".join(case_notes(case, mine))
    for r in mine:
        assert f"at {r['run']['converged_at']} iterations" in before
    again = [_rerun(r) for r in mine]
    after = " ".join(case_notes(case, again))
    assert "Re 100 at 777 iterations" in after and "Re 1000 at 777 iterations" in after
    for r in mine:
        assert f"at {r['run']['converged_at']} iterations" not in after
    psi = next(q for q in again[[r["variant"] for r in again].index("re100")]["quantities"] if q["key"] == "psi_min")["value"]
    assert f"{psi:.5g}" in after
    # A run that stopped at its limit is not said to have met its targets.
    for r in again:
        r["run"].update({"converged": False, "iterations": 12000})
    short = " ".join(case_notes(case, again))
    assert "Each run stops on its residual targets" not in short and "at its limit of 12000 iterations, short of them" in short


def test_the_pipe_notes_say_the_probes_read_the_value_at_each_point():
    """Case 1's runs are made after gap G3's fix: its probes read the value at the point (they said the
    runs were made before it and took the value of the cell holding each point)."""
    text = " ".join(case_notes(cases.get("c1_laminar_pipe"), [r for r in load_results() if r["case"] == "c1_laminar_pipe"]))
    assert "the cell holding each point" not in text and "made before the probes" not in text
    assert "read the value at each point" in text


def test_a_case_without_results_has_only_its_fixed_notes():
    case = cases.get("c6_sphere")
    notes = case_notes(case, [])
    assert notes and all("reported run" not in n for n in notes)
    assert len(notes) == sum(1 for n in case.NOTES if not callable(n))


def test_run_words_for_a_steady_run_that_stops_at_its_limit():
    res = {
        "run": {
            "iterations": 1000, "end_time_set": 1000, "converged": False, "wall_s": 12.0,
            "settle": {"settled": True, "histories": [{"label": "the drag", "drift": 2e-6}]},
        },
        "series": {"residuals": {"t": [100, 500, 900, 950, 1000], "U": [1e-2, 1e-7, 3e-6, 5e-6, 4e-6]}},
    }
    words = run_words(res)
    assert words.startswith("stopped at its limit of 1000 iterations without meeting its residual targets (12 s of solve)")
    assert "its lowest U residual was 1 × 10^-7, at iteration 500" in words
    assert "over its last 10 % of iterations it stayed between 3 × 10^-6 and 5 × 10^-6" in words
    assert words.endswith("the drag moved by at most 2 × 10^-6 of their values over those iterations: settled, by "
                          "this harness's rule, without meeting its targets")
    res["run"].update({"converged": True, "converged_at": 640})
    assert run_words(res) == "met its residual targets at iteration 640, in 12 s of solve"


def test_and_list():
    assert [and_list([]), and_list(["a"]), and_list(["a", "b"]), and_list(["a", "b", "c"])] == ["", "a", "a and b", "a, b and c"]


def _ke_run(errs: tuple[float, float], y_plus: tuple[float, float, float]) -> dict:
    lo, mean, hi = y_plus
    return {
        "variant": "standard_kepsilon",
        "shown": {"y_plus": {"min": lo, "mean": mean, "max": hi, "n_faces": 10}},
        "precheck": {"estimate": {"yplus": 9.72}},
        "quantities": [{"key": k, "error": {"rel_pct": e}} for k, e in zip(("f", "f_tau"), errs, strict=True)],
    }


def test_standard_k_epsilons_small_error_is_read_against_its_walls_own_error():
    """Case 2's Standard k-epsilon read -0.96 / +0.34 % on the probe after the fixes: its wall cells sit
    just above its wall function's switch (y+ 11.53), where the clean wedge reads about 4.8 % low,
    so that small error is errors that cancel, not the best variant. The note works it out from the
    reported run (its y+ and errors), and says nothing without it."""
    note = cases.get("c2_turbulent_pipe")._note_standard_kepsilon
    assert note({}) is None
    above = note({"standard_kepsilon": _ke_run((-3.79, -2.98), (11.6, 11.9, 12.3))})
    assert "y+ 11.6 to 12.3 on the reported run (the pre-run check estimated 9.7), all above its wall function's switch at y+ 11.53" in above
    assert "its f -3.79 % and f_tau -2.98 % mean the rest" in above and "reads it 1.0 to 1.8 points high" in above
    assert "most likely errors that cancel, not a sign that it is the best variant" in above
    # The reported run is after the fixes: no probe of them beside it.
    assert "4-core probe" not in above and "-0.96 %" not in above
    both = note({"standard_kepsilon": _ke_run((-3.79, -2.98), (11.4, 11.9, 12.3))})
    assert "on both sides of its wall function's switch at y+ 11.53 (their area-weighted mean 11.9)" in both
    below = note({"standard_kepsilon": _ke_run((4.0, 5.0), (9.6, 10.0, 10.9))})
    assert "all below its wall function's switch" in below and "points high" not in below
    committed = [r for r in load_results() if r["case"] == "c2_turbulent_pipe"]
    assert any("errors that cancel" in n for n in case_notes(cases.get("c2_turbulent_pipe"), committed))


def test_the_laminar_pipe_note_quotes_the_reported_runs_friction():
    """Case 1's note on Standard's friction quoted 4-core probes (f·Re 64.13 and 63.21) and said the
    gradient limiter was on the convection gradient only; the limiter is inside grad(U) again (94d15ce6),
    and the reported runs' own f·Re is what the note gives."""
    case = cases.get("c1_laminar_pipe")
    mine = [r for r in load_results() if r["case"] == "c1_laminar_pipe"]
    text = " ".join(case_notes(case, mine))
    for r in mine:
        q = next(q for q in r["quantities"] if q["key"] == "fRe")
        assert f"f·Re {q['value']:.2f} ({q['error']['rel_pct']:+.2f} %)" in text
    assert "the convection gradient only" not in text and "64.13" not in text
    assert "grad(U) the study's gradient limiter on Gauss skewCorrected linear" in text
    assert "first full run (commit aaabb531)" in text and "f·Re 74.23" in text
    again = " ".join(case_notes(case, [_rerun(r) for r in mine]))
    for r in mine:
        q = next(q for q in r["quantities"] if q["key"] == "fRe")
        assert f"f·Re {q['value']:.2f} (" not in again


def _sst_run(errs: tuple[float, float], within: tuple[bool, bool], *, written: str | None = None) -> dict:
    run: dict = {"numerics_used": {"written": [{"label": "Velocity gradient", "value": written}]}} if written else {}
    return {
        "variant": "standard_sst",
        "shown": {"y_plus": {"min": 9.99, "mean": 11.0, "max": 11.7, "n_faces": 10}},
        "run": run,
        "quantities": [{"key": k, "error": {"rel_pct": e}, "within": w, "tolerance": {"rel_pct": 10.0}}
                       for k, e, w in zip(("f", "f_tau"), errs, within, strict=True)],
    }


def test_the_standard_sst_note_reads_the_reported_run():
    """k-omega SST on Standard is the case's two values outside their bands: the note gives the reported
    run's errors, y+ and the velocity gradient its case was written with, and calls it a limitation."""
    note = cases.get("c2_turbulent_pipe")._note_standard_sst
    assert note({}) is None
    plain = ("grad(U) Gauss linear inside the gradient limiter, not skew-corrected: k-omega SST on a Standard mesh; "
             "linearUpwind, the viscous terms and turbulence production read it")
    text = note({"standard_sst": _sst_run((-14.25, -17.05), (False, False), written=plain),
                 "hexdominant_sst": {"quantities": [{"key": "f", "error": {"rel_pct": -4.14}},
                                                     {"key": "f_tau", "error": {"rel_pct": -3.06}}]}})
    assert text.startswith("On Standard, k-omega SST read f -14.25 % and f_tau -17.05 % on the reported run "
                           "(its wall faces where f is read at y+ 9.99 to 11.7), both outside the ±10 % band.")
    assert ("(its \"Numerics as written\": grad(U) Gauss linear inside the gradient limiter, not skew-corrected: "
            "k-omega SST on a Standard mesh).") in text
    assert "This is a limitation, not fixed" in text
    assert "On Hex-dominant the same model and walls read f -4.14 % and f_tau -3.06 %" in text
    one = note({"standard_sst": _sst_run((-9.0, -11.0), (True, False))})
    assert "f_tau outside the ±10 % band" in one and "Numerics as written" not in one and "Hex-dominant the same" not in one
    inside = note({"standard_sst": _sst_run((-5.0, -6.0), (True, True))})
    assert "outside" not in inside
    committed = [r for r in load_results() if r["case"] == "c2_turbulent_pipe"]
    std = next(r for r in committed if r["variant"] == "standard_sst")
    words = " ".join(case_notes(cases.get("c2_turbulent_pipe"), committed))
    f = next(q for q in std["quantities"] if q["key"] == "f")
    assert f"On Standard, k-omega SST read f {f['error']['rel_pct']:+.2f} %" in words
