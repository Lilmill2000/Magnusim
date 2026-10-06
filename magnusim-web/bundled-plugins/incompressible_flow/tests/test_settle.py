"""Convergence (F5): "Stop when a monitor settles" (runTimeControl) and a run's converged end.

The log lines are OpenFOAM ESI v2606's own, from the WSL proof (pitzDaily, 2026-10-05):
simpleFoam with residualControl met at 215 iterations, simpleFoam stopped by a Cd
settle at 140, pimpleFoam stopped by an inlet area-average settle at t = 0.0817949 s.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from types import SimpleNamespace

from conftest import JS_PROJECT
from conftest import run_spec as load_run_spec

from incompressible_flow.analyses import _decision
from incompressible_flow.contract import _steady_normalize, _transient_normalize
from incompressible_flow.parser import IncompressibleParser
from incompressible_flow.settle import (
    clean_settle,
    plan_settle,
    settle_functions_text,
    settle_target,
)
from incompressible_flow.transient import resolve_transient_control
from incompressible_flow.writer import write_solve_case

# simpleFoam, residualControl met (the end of the log).
LOG_RESIDUALS = """\
Time = 215

smoothSolver:  Solving for Ux, Initial residual = 0.00125524, Final residual = 8.40018e-05, No Iterations 6
smoothSolver:  Solving for Uy, Initial residual = 0.00981815, Final residual = 0.000662496, No Iterations 6
GAMG:  Solving for p, Initial residual = 0.00664303, Final residual = 0.000596328, No Iterations 6
time step continuity errors : sum local = 0.029276, global = 0.00325246, cumulative = 0.978149
smoothSolver:  Solving for epsilon, Initial residual = 0.000806236, Final residual = 5.0595e-05, No Iterations 3
smoothSolver:  Solving for k, Initial residual = 0.0020052, Final residual = 0.000116645, No Iterations 4
ExecutionTime = 2.62 s  ClockTime = 3 s


SIMPLE solution converged in 215 iterations

End
"""

# simpleFoam, the settle stop on coeffs_walls Cd (a step before it, then the stop).
LOG_SETTLE_STEADY = """\
runTimeControl settleStop output:
    Conditions not met

Time = 140

smoothSolver:  Solving for Ux, Initial residual = 0.00304659, Final residual = 0.000209553, No Iterations 6
GAMG:  Solving for p, Initial residual = 0.0130841, Final residual = 0.001186, No Iterations 4
ExecutionTime = 2.04 s  ClockTime = 3 s

surfaceFieldValue mon_inlet write:
    areaAverage(inlet) of U = (10 0 0)
    areaAverage(inlet) of p = -6.02844

runTimeControl settleStop output:
    average: settle condition satisfied
    Stopping calculation
    Writing fields

surfaceFieldValue mon_inlet write:
    areaAverage(inlet) of U = (10 0 0)
    areaAverage(inlet) of p = -6.02844


End
"""

# pimpleFoam: the first steps (the monitor has not written yet) and the settle stop.
LOG_SETTLE_TRANSIENT_START = """\
runTimeControl settleStop output:
--> FOAM Warning :
    From virtual bool Foam::functionObjects::valueAverageBase::calculate(Foam::dictionary&)
    in file db/functionObjects/valueAverageBase/valueAverageBase.C at line 218
    From function object: mon_inlet
Unprocessed fields:
    Conditions not met
"""
LOG_SETTLE_TRANSIENT = """\
Courant Number mean: 1.1865 max: 5.05808
deltaT = 0.00025641
Time = 0.0817949

PIMPLE: iteration 1
smoothSolver:  Solving for Ux, Initial residual = 0.00228943, Final residual = 8.91635e-06, No Iterations 5
GAMG:  Solving for p, Initial residual = 0.0128698, Final residual = 9.54114e-05, No Iterations 5
ExecutionTime = 11 s  ClockTime = 12 s

surfaceFieldValue mon_inlet write:
    areaAverage(inlet) of U = (10 0 0)
    areaAverage(inlet) of p = -5.78174

runTimeControl settleStop output:
    average: settle condition satisfied
    Stopping calculation
    Writing fields


End
"""


def _feed(text: str, parser: IncompressibleParser | None = None) -> tuple[IncompressibleParser, list]:
    p = parser or IncompressibleParser()
    p.stage = "solve"
    events = []
    for line in text.splitlines():
        events += p.feed(line)
    return p, events


def _converged(events: list) -> list[dict]:
    return [dict(e.fields) for e in events if e.event == "converged"]


# ---- the log ----


def test_residual_control_met_is_a_converged_end_at_its_iteration():
    p, events = _feed(LOG_RESIDUALS)
    assert _converged(events) == [{"by": "residuals", "time": 215.0}]
    assert p.snapshot()["converged"] == {"by": "residuals", "time": 215.0}
    # The line stays in the log too.
    assert any(e.event == "log" and "solution converged" in e.fields["line"] for e in events)


def test_a_settled_monitor_is_a_converged_end_at_the_step_it_settled():
    _, events = _feed(LOG_SETTLE_STEADY)
    assert _converged(events) == [{"by": "monitor", "time": 140.0}]


def test_a_transient_settle_is_converged_at_its_time_and_the_start_up_warning_is_not():
    p, events = _feed(LOG_SETTLE_TRANSIENT_START)
    assert _converged(events) == []
    _, events = _feed(LOG_SETTLE_TRANSIENT, p)
    assert _converged(events) == [{"by": "monitor", "time": 0.0817949}]


def test_pimple_outer_loop_convergence_and_unmet_conditions_are_not_an_end():
    lines = "Time = 0.1\nPIMPLE: converged in 3 iterations\nrunTimeControl settleStop output:\n    Conditions not met\n"
    _, events = _feed(lines)
    assert _converged(events) == []


def test_another_condition_then_stopping_is_not_the_settle_stop():
    _, events = _feed("Time = 3\n    average: other condition satisfied\n    Stopping calculation\n")
    assert _converged(events) == []


def test_mpi_ranks_prefix_and_one_event_per_run():
    _, events = _feed("Time = 9\n[0] SIMPLE solution converged in 9 iterations\nSIMPLE solution converged in 9 iterations\n")
    assert _converged(events) == [{"by": "residuals", "time": 9.0}]


# ---- the setting ----


def test_clean_settle_keeps_a_usable_setting_and_drops_the_rest():
    raw = {"source": "monitor", "id": "rc-f", "quantity": "Cd", "tolerance": "0.001", "window": 99.6}
    assert clean_settle(raw, transient=False) == {
        "source": "monitor", "id": "rc-f", "quantity": "Cd", "tolerance": 0.001, "window": 100,
    }
    assert clean_settle({**raw, "window": 0.25}, transient=True)["window"] == 0.25
    assert clean_settle({**raw, "window": 0.2}, transient=False)["window"] == 1
    assert clean_settle({**raw, "source": "boundary"}, transient=False)["source"] == "boundary"
    for bad in (None, {}, {**raw, "tolerance": 0}, {**raw, "window": -1}, {**raw, "id": ""}, {**raw, "tolerance": "x"}):
        assert clean_settle(bad, transient=False) is None


def test_the_run_models_clean_settle_only_when_it_is_edited():
    assert "settle" not in _steady_normalize({"end_time": 300})
    assert "settle" not in _transient_normalize({"end_time": 2})
    raw = {"source": "monitor", "id": "rc-1", "quantity": "p", "tolerance": 2, "window": 50}
    assert _steady_normalize({"settle": raw})["settle"]["window"] == 50
    assert _steady_normalize({"settle": None})["settle"] is None
    out = _transient_normalize({"settle": {**raw, "window": 0.5}, "end_time": 2})
    assert out["settle"]["window"] == 0.5 and out["end_time"] == 2


# ---- the writer ----

BLOCK = """\
    settleStop
    {
        type            runTimeControl;
        libs            (utilityFunctionObjects);
        conditions
        {
            settle
            {
                type            average;
                functionObject  coeffs_walls;
                fields          ( Cd );
                tolerance       0.0001;
                window          50;
                windowType      approximate;
                log             false;
            }
        }
        satisfiedAction end;
    }"""


def test_the_block_is_the_one_the_wsl_proof_ran():
    assert settle_functions_text({"object": "coeffs_walls", "field": "Cd", "tolerance": 1e-4, "window": 50}) == BLOCK
    assert settle_functions_text(None) == "" and settle_functions_text({"error": "x"}) == ""


def _spec(**kw):
    base = dict(
        mapped=[
            {"bc": {"id": "bc-in", "name": "Inlet", "bc_type": "Velocity Inlet"}, "patch": "inlet"},
            {"bc": {"id": "bc-w", "name": "Wall", "bc_type": "Wall"}, "patch": "wall"},
        ],
        monitor_patches=["inlet"],
        result_controls=[
            {"id": "rc-a", "name": "Area average 1", "monitor_type": "area_average", "faces": ["f1"]},
            {"id": "rc-old", "name": "Old", "kind": "Area average", "faces": ["f2"]},
            {"id": "rc-f", "name": "Forces 1", "monitor_type": "forces", "boundaries": ["bc-w"]},
            {"id": "rc-p", "name": "Point probe 1", "monitor_type": "probe", "points": [[0, 0, 0]]},
        ],
        rho=1000.0,
        transient=None,
        time_dependency="steady",
    )
    base.update(kw)
    return SimpleNamespace(**base)


def _settle(ident, quantity, source="monitor", tolerance=1.0, window=100):
    return {"source": source, "id": ident, "quantity": quantity, "tolerance": tolerance, "window": window}


FORCES = [{"id": "rc-f", "key": "forces_forces_1", "coeffs_key": "coeffs_forces_1", "moment_coefficient": False}]
CUSTOM = [{"id": "rc-a", "key": "rc_area_average_1"}, {"id": "rc-old", "key": "rc_old"}]
PROBES = [{"id": "rc-p", "key": "probes_point_probe_1"}]


def _plan(spec):
    return plan_settle(spec, custom_meta=CUSTOM, forces_plans=FORCES, probe_plans=PROBES)


def test_each_monitor_kind_watches_the_result_its_function_object_publishes():
    cases = [
        (_settle("bc-in", "p", "boundary", 500.0), "mon_inlet", "areaAverage(inlet,p)", 0.5),
        (_settle("bc-in", "U", "boundary", 0.01), "mon_inlet", "areaAverage(inlet,U)", 0.01),
        (_settle("bc-in", "Q", "boundary", 1e-6), "flow_inlet", "sum(inlet,phi)", 1e-6),
        (_settle("rc-a", "p", tolerance=10.0), "rc_area_average_1", "areaAverage(rc_area_average_1,p)", 0.01),
        (_settle("rc-old", "U", tolerance=0.1), "rc_old", "areaAverage(rc_old,U)", 0.1),
        (_settle("rc-f", "Cd", tolerance=0.001), "coeffs_forces_1", "Cd", 0.001),
        (_settle("rc-f", "Cl", tolerance=0.001), "coeffs_forces_1", "Cl", 0.001),
        (_settle("rc-p", "p", tolerance=2.0), "probes_point_probe_1", "average(p)", 0.002),
        (_settle("rc-p", "U", tolerance=0.2), "probes_point_probe_1", "average(U)", 0.2),
    ]
    for settle, obj, field, tol in cases:
        plan = _plan(_spec(settle=settle))
        assert (plan["object"], plan["field"]) == (obj, field), settle
        # Pressures are kinematic in the case: the tolerance in Pa is divided by the density.
        assert abs(plan["tolerance"] - tol) < 1e-12, settle
        assert plan["window"] == 100


def test_the_sentence_names_the_monitor_quantity_amount_and_window():
    plan = _plan(_spec(settle=_settle("rc-f", "Cd", tolerance=0.001)))
    assert plan["label"] == "Forces 1 · Cd"
    assert plan["text"] == "Forces 1 · Cd stayed within 0.001 of its average over 100 iterations"
    plan = _plan(_spec(settle=_settle("bc-in", "p", "boundary", 0.5, 1)))
    assert plan["text"] == "Inlet · Pressure stayed within 0.5 Pa of its average over 1 iteration"


def test_what_cannot_be_watched_is_not_written_and_says_why():
    errors = {
        "gone": (_settle("rc-x", "p"), "the monitor it watches was deleted"),
        "bc gone": (_settle("bc-x", "p", "boundary"), "the boundary it watches has no faces or was deleted"),
        "wall": (_settle("bc-w", "p", "boundary"), "Wall is not an opening the case monitors"),
        "bad quantity": (_settle("rc-a", "Cd"), "Area average 1 has no quantity the stop can watch"),
        "no Cm": (_settle("rc-f", "Cm"), "the moment coefficient needs the study's reference length"),
    }
    for name, (settle, error) in errors.items():
        plan = _plan(_spec(settle=settle))
        assert plan["error"] == error, name
        assert settle_functions_text(plan) == ""
    no_area = plan_settle(
        _spec(settle=_settle("rc-f", "Cd")), forces_plans=[{**FORCES[0], "coeffs_key": None}]
    )
    assert no_area["error"] == "force coefficients need the study's reference area"
    assert plan_settle(_spec(settle=None)) is None
    assert settle_target(_spec(), None) is None


def test_a_transient_window_spans_at_least_ten_monitor_samples():
    ctrl = SimpleNamespace(write_interval=0.1)  # samples every 0.002 s: at least 0.02 s
    short = _plan(_spec(settle=_settle("bc-in", "p", "boundary", 1.0, 0.005), transient=ctrl, time_dependency="transient"))
    assert short["window"] == 0.02
    assert short["text"] == "Inlet · Pressure stayed within 1 Pa of its average over 0.02 s"
    assert "note" in short
    long = _plan(_spec(settle=_settle("bc-in", "p", "boundary", 1.0, 0.5), transient=ctrl, time_dependency="transient"))
    assert long["window"] == 0.5 and "note" not in long
    # A forces coefficient is computed every time step: no floor.
    coeff = _plan(_spec(settle=_settle("rc-f", "Cd", window=0.005), transient=ctrl, time_dependency="transient"))
    assert coeff["window"] == 0.005


def test_the_writer_adds_the_stop_after_the_monitors_and_records_it(tmp_path: Path):
    spec = load_run_spec(JS_PROJECT, run_id="run-settle", require_mesh=False, n_procs=1)
    spec = dataclasses.replace(
        spec,
        reference={"ref_area": 0.5},
        forces_monitors=[{"id": "rc-f", "name": "Forces 1", "boundaries": ["@walls"]}],
        result_controls=[{"id": "rc-f", "name": "Forces 1", "monitor_type": "forces", "boundaries": ["@walls"]}],
        settle=_settle("rc-f", "Cd", tolerance=0.002, window=80),
    )
    write_solve_case(spec, tmp_path / "case")
    control = (tmp_path / "case" / "system" / "controlDict").read_text(encoding="utf-8")
    assert control.index("coeffs_forces_1") < control.index("settleStop")
    assert "functionObject  coeffs_forces_1;" in control and "fields          ( Cd );" in control
    assert "tolerance       0.002;" in control and "window          80;" in control
    side = json.loads((tmp_path / "case" / "w27-case.json").read_text(encoding="utf-8"))
    assert side["settle"]["text"] == "Forces 1 · Cd stayed within 0.002 of its average over 80 iterations"


def test_a_run_without_one_writes_the_case_as_before(tmp_path: Path):
    spec = load_run_spec(JS_PROJECT, run_id="run-plain", require_mesh=False, n_procs=1)
    write_solve_case(spec, tmp_path / "case")
    assert "runTimeControl" not in (tmp_path / "case" / "system" / "controlDict").read_text(encoding="utf-8")
    assert "settle" not in json.loads((tmp_path / "case" / "w27-case.json").read_text(encoding="utf-8"))


def test_the_plan_report_says_how_the_run_can_converge():
    spec = load_run_spec(JS_PROJECT, run_id="r", require_mesh=False, n_procs=1)
    ctx = SimpleNamespace(inputs=None)
    report = _decision(spec, ctx)
    assert report["residual_control"] is True and "stop_when" not in report
    forces = {"id": "rc-f", "name": "Forces 1", "monitor_type": "forces", "boundaries": ["pressure_1"]}
    with_stop = dataclasses.replace(
        spec,
        result_controls=[forces],
        forces_monitors=[{"id": "rc-f", "name": "Forces 1", "boundaries": ["pressure_1"]}],
        settle=_settle("rc-f", "Cd", tolerance=0.001),
    )
    # The writer's own check: no reference area, no coefficients to watch.
    assert _decision(with_stop, ctx)["stop_when"] == {
        "label": "Forces 1 · Cd",
        "error": "force coefficients need the study's reference area",
    }
    with_area = dataclasses.replace(with_stop, reference={"ref_area": 0.5})
    assert _decision(with_area, ctx)["stop_when"] == {
        "label": "Forces 1 · Cd",
        "text": "Forces 1 · Cd stayed within 0.001 of its average over 100 iterations",
    }
    cm = dataclasses.replace(with_area, settle=_settle("rc-f", "Cm", tolerance=0.001))
    assert _decision(cm, ctx)["stop_when"]["error"] == "the moment coefficient needs the study's reference length"
    unplaced = dataclasses.replace(with_area, forces_monitors=[{"id": "rc-f", "name": "Forces 1", "boundaries": []}])
    assert _decision(unplaced, ctx)["stop_when"]["error"] == "Forces 1 measures no walls on this mesh"
    area = dataclasses.replace(
        spec,
        result_controls=[{"id": "rc-a", "name": "Area 1", "monitor_type": "area_average", "faces": []}],
        settle=_settle("rc-a", "p"),
    )
    assert _decision(area, ctx)["stop_when"]["error"] == "Area 1 is not placed on any faces of this geometry"
    gone = dataclasses.replace(spec, settle=_settle("rc-x", "p"))
    assert _decision(gone, ctx)["stop_when"] == {"error": "the monitor it watches was deleted"}
    transient = dataclasses.replace(spec, transient=resolve_transient_control({}, {}))
    assert "residual_control" not in _decision(transient, ctx)


def test_load_run_spec_reads_the_runs_settle_and_monitors():
    from cfddesk.project.run_inputs import gather_run_inputs

    from incompressible_flow.runspec import load_run_spec as plugin_load

    inputs = gather_run_inputs(JS_PROJECT, run_id="r", require_mesh=False, n_procs=1)
    assert plugin_load(inputs).settle is None
    rcs = [{"id": "rc-f", "name": "Drag", "monitor_type": "forces"}]
    inputs = dataclasses.replace(
        inputs,
        run={**inputs.run, "result_controls": rcs, "settle": {**_settle("rc-f", "Cd", tolerance=0.01), "window": 12.4}},
    )
    spec = plugin_load(inputs)
    assert spec.settle == {"source": "monitor", "id": "rc-f", "quantity": "Cd", "tolerance": 0.01, "window": 12}
    assert spec.result_controls == rcs
