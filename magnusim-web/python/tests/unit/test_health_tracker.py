"""Run health (RH1): the tracker on Run_2's log and on the parsing, mode and size rules.

Fixtures (python/tests/fixtures/health/, scrubbed: host cfdbox-17, user cfduser):
run2-head.log.gz and run2-tail.log.gz are the first 3,000 and last 4,000 lines of
Daniel's unstable Run_2 (pimpleFoam in PISO mode, Max Courant 100, 625k cells, 15
ranks); run2.hints.json are the health hints its case would carry (from its
system/ dictionaries, kept in run2-system/).
"""

from __future__ import annotations

import gzip
import json
import time
import tracemalloc
from pathlib import Path

import pytest
from magnusim_sdk.health import (
    RECORD_MAX,
    HealthEmitter,
    HealthTracker,
    iter_log_lines,
    line_key,
    record_size,
    restart_of,
    shrink,
)
from magnusim_sdk.numerics_advice import ADVICE

HERE = Path(__file__).resolve().parents[1]
FIX = HERE / "fixtures" / "health"
WEB = HERE.parents[1]
HEAD = FIX / "run2-head.log.gz"
TAIL = FIX / "run2-tail.log.gz"
HINTS = json.loads((FIX / "run2.hints.json").read_text(encoding="utf-8"))
SYMPTOMS_RUN2 = {
    "velocity_clipped",
    "pv_coupling",
    "residuals_high",
    "solver_at_limit",
    "turbulence_bounded",
    "speed_growth",
    "monitor_drift",
}


def verdicts_by_step(tracker: HealthTracker, path: Path) -> dict[int, tuple[str, list[str]]]:
    """Each closed step's verdict and codes (a step closes when the next one starts)."""
    out: dict[int, tuple[str, list[str]]] = {}
    for text, off in iter_log_lines(str(path)):
        before = tracker.steps
        tracker.line(text, off)
        if tracker.steps != before and before >= 1:
            out[before] = (tracker.verdict, tracker.codes())
    return out


def feed(tracker: HealthTracker, lines: list[str]) -> None:
    off = 0
    for line in lines:
        tracker.line(line, off)
        off += len(line.encode("utf-8")) + 1


def step_lines(t: float, *, co: tuple[float, float] | None = (0.3, 0.9), dt: float | None = 1e-3, p_final: float = 0.01, ux: float = 0.01, k_min: float | None = None, clip: float = 0.0, nan: bool = False) -> list[str]:
    """One healthy-looking PISO time step (2 pressure correctors)."""
    lines = []
    if co is not None:
        lines.append(f"Courant Number mean: {co[0]} max: {co[1]}")
    if dt is not None:
        lines.append(f"deltaT = {dt}")
    lines += [
        f"Time = {t}",
        "",
        "PIMPLE: iteration 1",
        f"smoothSolver:  Solving for Ux, Initial residual = {'nan' if nan else ux}, Final residual = 1e-09, No Iterations 3",
        f"smoothSolver:  Solving for Uy, Initial residual = {ux}, Final residual = 1e-09, No Iterations 3",
        f"limitVelocity limitU Limited 0 ({clip}%) of cells, 0 (0%) of faces, with max limit 50",
        "GAMG:  Solving for p, Initial residual = 0.05, Final residual = 0.0004, No Iterations 4",
        "time step continuity errors : sum local = 1e-07, global = 1e-10, cumulative = 1e-10",
        f"limitVelocity limitU Limited 0 ({clip}%) of cells, 0 (0%) of faces, with max limit 50",
        f"GAMG:  Solving for p, Initial residual = {p_final}, Final residual = 9e-08, No Iterations 20",
        "time step continuity errors : sum local = 1e-09, global = 1e-11, cumulative = 1e-10",
        "smoothSolver:  Solving for k, Initial residual = 0.01, Final residual = 1e-09, No Iterations 3",
    ]
    if k_min is not None:
        lines.append(f"bounding k, min: {k_min} max: 2 average: 0.5")
    lines.append("ExecutionTime = 1 s  ClockTime = 1 s")
    lines.append("")
    return lines


HEADER = [
    "Host   : cfdbox-17",
    "trapFpe: Floating point exception trapping enabled (FOAM_SIGFPE).",
    "",
    "Starting time loop",
    "",
]

PISO_HINTS = {
    "app": "pimpleFoam",
    "mode": "PISO",
    "n_outer": 1,
    "n_correctors": 2,
    "max_co": 1,
    "end_time": 1,
    "average_from": 0,
    "uref": 5.0,
    "fixed_inflow": True,
    "turbulence": "kOmegaSST",
    "limiter": {"name": "limitU", "cap": 50, "factor": 10, "floor": 50},
    "linsolve": {"p": {"max_iter": 200, "tol": 1e-7, "rel_tol": 0.01, "final_rel_tol": 0}},
    "monitors": None,
}


# ---------------------------------------------------------------- Run_2


def test_run2_head_pending_watch_then_unhealthy_at_step_25():
    tracker = HealthTracker(HINTS)
    seen: list[tuple[int, str, list[str]]] = []
    for text, off in iter_log_lines(str(HEAD)):
        before = tracker.steps
        tracker.line(text, off)
        if tracker.steps != before and tracker.steps <= 6:
            # Step `tracker.steps` just began: what the record says while it runs.
            rec = tracker.report()
            seen.append((tracker.steps, rec["verdict"], [f["code"] for f in rec["findings"]]))
    # Steps 1-5 are pending, with courant_mode already listed (from the hints).
    for step, verdict, codes in seen[:5]:
        assert verdict == "pending", (step, verdict)
        assert "courant_mode" in codes, step
    tracker = HealthTracker(HINTS)
    by_step = verdicts_by_step(tracker, HEAD)
    assert all(by_step[n][0] == "pending" for n in range(1, 6))
    assert by_step[6][0] == "watch"
    assert all(by_step[n][0] == "watch" for n in range(6, 25)), {n: by_step[n][0] for n in range(6, 26)}
    assert by_step[25][0] == "unhealthy"
    fu = tracker.first_unhealthy
    assert fu is not None and fu["step"] == 25 and fu["t"] == pytest.approx(0.0069061069)
    rec = tracker.report()
    assert rec["first_unhealthy"]["t"] == pytest.approx(0.0069061069)
    assert rec["timeline"][0]["verdict"] == "watch"


def test_run2_tail_unhealthy_with_the_seven_symptoms_and_from_zero():
    tracker = HealthTracker(HINTS)
    for text, off in iter_log_lines(str(HEAD)):
        tracker.line(text, off)
    tracker.gap()
    for text, off in iter_log_lines(str(TAIL)):
        tracker.line(text, off)
    rec = tracker.report(final=True, latest_saved=0.16666667)
    assert rec["verdict"] == "unhealthy"
    unhealthy = {c for c, lv in tracker.level.items() if lv >= 2}
    assert SYMPTOMS_RUN2 <= unhealthy, unhealthy
    assert rec["restart"] == "from_zero"
    assert rec["first_unhealthy"]["t"] == pytest.approx(0.0069061069)
    texts = {f["code"]: f["text"] for f in rec["findings"]}
    assert texts["velocity_clipped"].startswith("Velocity clipped in 100% of steps: the 226 m/s limit caught")
    assert "the last pressure solve starts at 0.95" in texts["pv_coupling"]
    assert texts["courant_mode"].startswith("Likely cause: Max Courant 100 with 1 outer corrector (PISO). ")
    assert texts["courant_mode"].endswith(ADVICE["max_co"]["rule"])
    assert "Raising the limit will not fix this." in texts["solver_at_limit"]
    assert len(rec["findings"]) <= 6
    assert record_size(shrink(rec)) <= RECORD_MAX


def test_run2_fix_cost_is_near_180000_steps():
    tracker = HealthTracker(HINTS)
    for text, off in iter_log_lines(str(HEAD)):
        tracker.line(text, off)
    rec = tracker.report()
    assert rec["rates"]["co_max_per_s"] == pytest.approx(9.0e4, rel=0.1)
    fixes = next(f["fix"] for f in rec["findings"] if f.get("fix"))
    first = fixes[0]
    assert first["label"] == "New run: 3 outer correctors, Max Courant 5"
    assert first["target"] == "new_run"
    assert {v["key"]: v["value"] for v in first["values"]} == {
        "transient.n_outer_correctors": 3,
        "transient.max_co": 5,
    }
    assert 180_000 * 0.75 <= first["cost"]["steps"] <= 180_000 * 1.25
    assert fixes[1]["label"] == "New run: Max Courant 1"


# ---------------------------------------------------------------- parsing


def test_trap_fpe_header_is_not_fatal_and_words_are_not_nan():
    tracker = HealthTracker(PISO_HINTS)
    feed(
        tracker,
        [
            "trapFpe: Floating point exception trapping enabled (FOAM_SIGFPE).",
            "    kInf            0;",
            "    omegaInf        0;",
            "Reading inflow velocity: Info only",
            "--> FOAM FATAL ERROR: before the loop",
            *HEADER,
        ],
    )
    for i in range(1, 12):
        feed(tracker, step_lines(i * 1e-3))
    feed(tracker, ["sigFpe in a comment line", "Floating point exception (core dumped) mentioned later"])
    assert tracker.verdict not in ("failed",)
    assert tracker.verdict == "healthy"


def test_fatal_before_the_time_loop_is_not_the_trackers():
    tracker = HealthTracker(PISO_HINTS)
    feed(tracker, ["--> FOAM FATAL ERROR: (openfoam-2606)", "    cannot find file", "#0  Foam::sigFpe::sigHandler(int) at ??:?"])
    assert tracker.verdict == "pending"
    assert tracker.report()["verdict"] == "pending"


def test_nan_residual_and_fatal_after_the_loop_fail():
    tracker = HealthTracker(PISO_HINTS)
    feed(tracker, HEADER)
    for i in range(1, 8):
        feed(tracker, step_lines(i * 1e-3))
    feed(tracker, step_lines(8e-3, nan=True))
    assert tracker.verdict == "failed"
    rec = tracker.report()
    assert rec["verdict"] == "failed"
    assert rec["findings"][0]["code"] == "failed"
    # Final: nothing brings it back.
    for i in range(9, 30):
        feed(tracker, step_lines(i * 1e-3))
    assert tracker.verdict == "failed"
    t2 = HealthTracker(PISO_HINTS)
    feed(t2, HEADER)
    feed(t2, step_lines(1e-3))
    feed(t2, ["#1  Foam::sigFpe::sigHandler(int) at ??:?"])
    assert t2.verdict == "failed"
    t3 = HealthTracker(PISO_HINTS)
    feed(t3, HEADER)
    feed(t3, step_lines(1e-3))
    feed(t3, ["MPI_ABORT was invoked on rank 3 in communicator MPI_COMM_WORLD"])
    assert t3.verdict == "failed"


def test_partial_first_and_last_steps_parse():
    tracker = HealthTracker(PISO_HINTS)
    # A cut-off start: lines of a step whose Time line is not there.
    feed(tracker, ["GAMG:  Solving for p, Initial residual = 0.2, Final residual = 1e-8, No Iterations 4", "ExecutionTime = 1 s  ClockTime = 1 s"])
    for i in range(1, 30):
        feed(tracker, step_lines(i * 1e-3))
    # A cut-off end.
    feed(tracker, ["Courant Number mean: 0.3 max: 0.9", "deltaT = 0.001", "Time = 0.03", "PIMPLE: iteration 1"])
    rec = tracker.report(final=True)
    assert rec["verdict"] == "healthy"
    assert rec["step"] == 30


# ---------------------------------------------------------------- modes and hints


def test_simple_has_no_pv_coupling_and_skips_courant():
    hints = {**PISO_HINTS, "app": "simpleFoam", "mode": "SIMPLE"}
    tracker = HealthTracker(hints)
    feed(tracker, HEADER)
    for i in range(1, 40):
        feed(
            tracker,
            [
                f"Time = {i}",
                f"smoothSolver:  Solving for Ux, Initial residual = {0.5 / i}, Final residual = 1e-3, No Iterations 3",
                f"GAMG:  Solving for p, Initial residual = {0.9 / i}, Final residual = 1e-3, No Iterations 10",
                "time step continuity errors : sum local = 1e-05, global = 1e-08, cumulative = 1e-08",
                "ExecutionTime = 1 s  ClockTime = 1 s",
            ],
        )
    rec = tracker.report()
    assert rec["unit"] == "iteration"
    assert "pv_coupling" not in rec["checked"]
    assert "residuals_stalled" in rec["checked"]
    assert {"code": "courant_mode", "why": "steady run"} in rec["skipped"]
    assert rec["verdict"] == "healthy"


def test_no_fixed_inflow_skips_speed_growth_and_monitor_drift():
    tracker = HealthTracker({**PISO_HINTS, "fixed_inflow": False})
    feed(tracker, HEADER)
    feed(tracker, step_lines(1e-3))
    rec = tracker.report()
    skipped = {s["code"]: s["why"] for s in rec["skipped"]}
    assert skipped["speed_growth"] == "no fixed inflow"
    assert skipped["monitor_drift"] == "no fixed inflow"
    assert "speed_growth" not in rec["checked"]
    bare = HealthTracker(None)
    feed(bare, HEADER)
    feed(bare, step_lines(1e-3))
    no_hints = bare.report()
    assert {s["why"] for s in no_hints["skipped"]} == {"no health hints from this analysis"}


def test_cht_region_keys():
    log = HERE / "fixtures" / "cht-case" / "log.chtMultiRegionSimpleFoam"
    tracker = HealthTracker({"app": "chtMultiRegionSimpleFoam", "mode": "SIMPLE", "turbulence": "laminar"})
    lines = log.read_text(encoding="utf-8").splitlines()
    feed(tracker, lines)
    rec = tracker.report(final=True)
    assert rec["unit"] == "iteration"
    keys = set(rec["residuals_last"])
    assert {"air:U", "air:h", "air:p_rgh", "aluminium_6061:h"} <= keys, keys


# ---------------------------------------------------------------- bounds


def test_memory_is_bounded_after_200k_steps():
    tracker = HealthTracker(PISO_HINTS)
    feed(tracker, HEADER)
    block = step_lines(1e-3)
    tracemalloc.start()
    for i in range(1, 2001):
        for line in block:
            tracker.line(line.replace("Time = 0.001", f"Time = {i * 1e-3}"), None)
    first, _ = tracemalloc.get_traced_memory()
    for i in range(2001, 200_001):
        for line in block:
            tracker.line(line if not line.startswith("Time") else f"Time = {i * 1e-3}", None)
    second, _ = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert tracker.steps == 200_000
    assert len(tracker.win) == 50
    assert second - first < 512 * 1024, (first, second)


def test_a_million_lines_take_under_3_s():
    block = step_lines(1e-3)
    t2 = HealthTracker(PISO_HINTS)
    feed(t2, HEADER)
    lines = []
    i = 0
    while len(lines) < 1_000_000:
        i += 1
        lines += [x if not x.startswith("Time") else f"Time = {i * 1e-3}" for x in block]
    lines = lines[:1_000_000]
    t0 = time.perf_counter()
    for line in lines:
        t2.line(line, None)
    took = time.perf_counter() - t0
    assert took < 3.0, took


def test_full_lists_shrink_in_order_within_4kb():
    tracker = HealthTracker(HINTS)
    for text, off in iter_log_lines(str(HEAD)):
        tracker.line(text, off)
    tracker.gap()
    for text, off in iter_log_lines(str(TAIL)):
        tracker.line(text, off)
    rec = tracker.report(final=True)
    # Fill every list to its cap with long words.
    rec["warnings"] = [{"text": "w" * 160, "count": 3}] * 3
    rec["timeline"] = [{"t": i * 0.1, "verdict": "watch" if i % 2 else "unhealthy"} for i in range(20)]
    rec["findings"] = [
        {
            "code": code,
            "level": "error" if i < 4 else "info",
            "text": "x" * 240,
            "evidence": {"line": 10 + i, "text": "y" * 200, "log_at": 1000 * i, "key": "abcdef012345"},
            "since_t": 0.01,
            "fix": [{"label": "l" * 60, "target": "new_run", "values": [{"key": "transient.max_co", "value": 5}] * 4, "cost": None}] * 2,
        }
        for i, code in enumerate(["velocity_clipped", "pv_coupling", "turbulence_bounded", "speed_growth", "courant_spread", "bounded_from_start"])
    ]
    assert record_size(rec) > RECORD_MAX
    out = shrink(rec)
    assert out["trimmed"] is True
    assert record_size(out) <= RECORD_MAX
    # Step 1 first: the evidence words go, each finding keeps where its line is.
    for f in out["findings"]:
        assert "text" not in (f.get("evidence") or {})
        assert f["evidence"]["key"] == "abcdef012345"
    assert out["window"] == rec["window"]
    # The last step keeps the core and each finding's place in the log.
    tiny = shrink(rec, limit=900)
    assert set(tiny) >= {"v", "verdict", "at", "step", "t", "unit", "window", "checked", "skipped", "first_unhealthy", "restart", "trimmed"}
    assert all(set(f) == {"code", "level", "evidence"} for f in tiny["findings"])


def test_every_fix_key_is_a_run_field_of_the_registry():
    registry = json.loads((WEB / "scripts" / "generated" / "registry.json").read_text(encoding="utf-8"))
    fields = set()
    for a in registry["analysis"]:
        for k in ((a.get("control_schema") or {}).get("properties") or {}):
            fields.add("transient." + k)
    tracker = HealthTracker(HINTS)
    for text, off in iter_log_lines(str(HEAD)):
        tracker.line(text, off)
    keys = {v["key"] for fx in tracker._fixes() for v in fx["values"]}
    pimple = HealthTracker({**HINTS, "mode": "PIMPLE", "n_outer": 3, "max_co": 20})
    keys |= {v["key"] for fx in pimple._fixes() for v in fx["values"]}
    assert keys and keys <= fields, keys - fields


def test_not_settled_steady_and_transient():
    steady = HealthTracker({**PISO_HINTS, "mode": "SIMPLE", "app": "simpleFoam"})
    feed(steady, HEADER)
    for i in range(1, 40):
        feed(steady, [f"Time = {i}", f"GAMG:  Solving for p, Initial residual = {0.5 / i}, Final residual = 1e-3, No Iterations 4", "ExecutionTime = 1 s  ClockTime = 1 s"])
    rec = steady.report(final=True)
    assert "not_settled" in [f["code"] for f in rec["findings"]]
    conv = HealthTracker({**PISO_HINTS, "mode": "SIMPLE", "app": "simpleFoam"})
    feed(conv, HEADER)
    for i in range(1, 40):
        feed(conv, [f"Time = {i}", f"GAMG:  Solving for p, Initial residual = {0.5 / i}, Final residual = 1e-3, No Iterations 4"])
    conv.converged()
    assert "not_settled" not in [f["code"] for f in conv.report(final=True)["findings"]]
    # Transient: a monitor whose mean drifts over the averaging window.
    hints = {**PISO_HINTS, "end_time": 0.3, "average_from": 0.0}
    tr = HealthTracker(hints)
    feed(tr, HEADER)
    for i in range(1, 301):
        t = i * 1e-3
        feed(tr, step_lines(t))
        feed(tr, ["surfaceFieldValue mon_outlet write:", f"    areaAverage(outlet) of p = {10.0 + 100.0 * t}", ""])
    rec = tr.report(final=True)
    assert "not_settled" in [f["code"] for f in rec["findings"]]


def test_window_counts_the_scored_steps():
    tracker = HealthTracker(PISO_HINTS)
    feed(tracker, HEADER)
    for i in range(1, 18):
        feed(tracker, step_lines(i * 1e-3))
    feed(tracker, ["Courant Number mean: 0.3 max: 0.9", "deltaT = 0.001", "Time = 0.018"])
    assert tracker.report()["window"] == 12
    for i in range(19, 62):
        feed(tracker, step_lines(i * 1e-3))
    assert tracker.report()["window"] == 50


def test_host_header_name_never_leaves_in_words():
    tracker = HealthTracker(PISO_HINTS)
    feed(tracker, ['Host   : "wslbox"', "Starting time loop", "--> FOAM Warning : on wslbox the file is old"])
    for i in range(1, 40):
        lines = step_lines(i * 1e-3, clip=2.0 if i > 10 else 0.0)
        lines = [x.replace("Limited 0 (2.0%)", "Limited 40 (2.0%)") + (" wslbox" if x.startswith("limitVelocity") else "") for x in lines]
        feed(tracker, lines)
    em = HealthEmitter(tracker, clock=lambda: 0.0)
    payloads = [tracker.report(), em.final()]
    for p in payloads:
        text = json.dumps(p)
        assert "wslbox" not in text, text
    assert any(f["code"] == "velocity_clipped" for f in payloads[0]["findings"])


def test_evidence_key_and_offset_name_the_line():
    tracker = HealthTracker(HINTS)
    raw_lines = gzip.decompress(HEAD.read_bytes()).split(b"\n")
    for text, off in iter_log_lines(str(HEAD)):
        tracker.line(text, off)
    rec = tracker.report()
    for f in rec["findings"]:
        ev = f.get("evidence")
        if not ev:
            continue
        line = raw_lines[ev["line"] - 1]
        assert ev["key"] == line_key(line.decode("utf-8"))
        assert gzip.decompress(HEAD.read_bytes())[ev["log_at"] : ev["log_at"] + len(line)] == line


def test_restart_rules():
    fu = {"t": 0.0069, "step": 25}
    tl = [{"t": 0.0002, "verdict": "watch"}, {"t": 0.0069, "verdict": "unhealthy"}]
    assert restart_of(fu, tl, 0.1667) == "from_zero"
    assert restart_of(fu, tl, 0.005) == "continue_after_fix"
    tl2 = tl + [{"t": 0.05, "verdict": "healthy"}]
    assert restart_of(fu, tl2, 0.1) == "continue_after_fix"
    assert restart_of(None, tl, 0.1) is None
    assert restart_of(fu, tl, 0.1, head_missing=True) is None


def test_debounce_improves_only_after_five_steps():
    tracker = HealthTracker({**PISO_HINTS, "max_co": 1})
    feed(tracker, HEADER)
    for i in range(1, 10):
        feed(tracker, step_lines(i * 1e-3))
    assert tracker.verdict == "healthy"
    # Three steps whose last pressure solve starts at 0.6: pv_coupling unhealthy at once.
    for i in range(10, 13):
        feed(tracker, step_lines(i * 1e-3, p_final=0.6))
    feed(tracker, ["Time = 0.0135"])
    assert tracker.verdict == "unhealthy"
    seen = []
    for i in range(14, 30):
        feed(tracker, step_lines(i * 1e-3))
        seen.append(tracker.verdict)
    # The check itself clears after 3 good steps; the verdict waits 5 more.
    assert "unhealthy" in seen[:5]
    assert seen[-1] == "healthy"
