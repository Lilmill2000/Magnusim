"""Run health always says why (RH1): a verdict of "Watch closely" or "Unhealthy" has a finding at
its level (warn or error) in plain words, for the Run panel and the Assistant alike.

The bug (validation rerun of 2026-11-07, the turbulent pipe on Hex-dominant with k-omega SST):
the verdict turned "Watch closely" at iteration 551 and stayed there to the end with only info
findings. Not the bounding (k and omega bounded every iteration): omega's first residual
alternated 1.06e-3 / 0.90e-3 between odd and even iterations, so residuals_stalled, read one
iteration at a time, switched on and off every iteration; the verdict improves only after 5
better steps in a row, so it never eased, while the findings showed the current levels and the
last iteration's was off. Two fixes, both tested here:

- residuals_stalled reads the (arithmetic) mean of each field's last 50 first residuals
  (health.py STALL_SMOOTH, a calibration in spec 2.6's sense), so a residual that swings wide
  around the floor without falling still reads as a stall (3e-3 / 3e-4: mean 1.65e-3), and once
  stalled it stays so until its mean is under 0.9e-3 (STALL_OFF), so one that hovers at the floor
  does not switch the verdict on and off; its words name the field that stalled;
- while the debounce holds a verdict above what the checks now say, the checks that set it stay
  listed at its level, with their words from when they were on, when they cleared and that the
  verdict stays until 5 steps in a row are better (``held``); on an ended run, that it ended
  before the verdict could ease; on a failed one, only when it cleared. A check the verdict counts
  is never left out for want of words, and a level carried over an unread middle of the log says
  so, in its row and in its held row.

Logs: the calibration fixtures, Run_2's head and tail, and the synthetic steady logs of
health_steady_logs.py (the pipe's pattern, its bounding alone, a stall that ends inside the
hold, a residual that swings wide, one that hovers at the floor).
"""

from __future__ import annotations

import json
import random
import re
from pathlib import Path

import pytest
from magnusim_sdk import health
from magnusim_sdk.health import HealthTracker, check_log, iter_log_lines

from tests.unit import health_steady_logs as steady
from tests.unit.test_health_tracker import HEADER, HINTS, PISO_HINTS, feed, step_lines

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "health"
CALIB = FIX / "calib"
WEB = Path(__file__).resolve().parents[3]
WORDS_TS = WEB / "src" / "workbench" / "runHealthWords.ts"
# runHealthWords.ts OVERCLAIM: no health words say or imply that a run will be healthy.
OVERCLAIM = re.compile(r"\b(safe|fine|fixed)\b|will be healthy", re.I)
NEED = {"watch": ("warn", "error"), "unhealthy": ("error",)}


def _says_why(rec: dict) -> bool:
    """A non-healthy verdict has a finding at its level, with words."""
    need = NEED.get(rec["verdict"])
    return not need or any(f["level"] in need and f.get("text") for f in rec["findings"])


class Watcher:
    """Feeds lines and checks the record after every scored step (as the relay and the panel
    may read it at any step) and at the end."""

    def __init__(self, tracker: HealthTracker) -> None:
        self.tracker = tracker
        self.scored = 0
        self.bare: list[tuple[float | None, str]] = []
        self.verdicts: list[tuple[float | None, str]] = []

    def line(self, text: str, offset: int | None) -> None:
        tr = self.tracker
        tr.line(text, offset)
        if tr.scored != self.scored:
            self.scored = tr.scored
            rec = tr.report()
            self.verdicts.append((tr.last_closed.t if tr.last_closed else None, rec["verdict"]))
            if not _says_why(rec):
                self.bare.append((tr.last_closed.t if tr.last_closed else None, rec["verdict"]))

    def lines(self, lines: list[str]) -> None:
        off = 0
        for text in lines:
            self.line(text, off)
            off += len(text.encode("utf-8")) + 1

    def log(self, path: Path) -> None:
        for text, off in iter_log_lines(str(path)):
            self.line(text, off)

    def final(self) -> dict:
        rec = self.tracker.report(final=True)
        if not _says_why(rec):
            self.bare.append(("final", rec["verdict"]))
        return rec


def _steady(name: str) -> tuple[Watcher, dict]:
    w = Watcher(HealthTracker(steady.hints(name)))
    w.lines(steady.lines(name))
    return w, w.final()


# ---------------------------------------------------------------- the bug


def test_the_pipe_pattern_stays_healthy_with_its_two_info_findings():
    """The validation pipe's pattern: bounded k and omega in every iteration, omega's first
    residual 1.06e-3 / 0.90e-3 on odd / even iterations. It read "Watch closely" from iteration
    551 to the end with only info findings; it is Healthy throughout."""
    w, rec = _steady("c2_sst")
    late = [v for t, v in w.verdicts if t is not None and t >= 551]
    assert set(late) == {"healthy"}, sorted(set(late))
    assert rec["verdict"] == "healthy"
    assert [(f["code"], f["level"]) for f in rec["findings"]] == [("bounded_from_start", "info"), ("not_settled", "info")]
    assert rec["findings"][1]["text"] == "It ended without its residuals meeting their targets: its results may not have settled."
    # The bounding is as the run's: omega and k reset to stay positive in all of the last 50.
    rows = {r["field"]: r for r in rec["bounding"]}
    assert (rows["omega"]["min_last"], rows["omega"]["avg_last"], rows["omega"]["steps_hit"]) == (-764.3, 849.9, 50)
    assert (rows["k"]["min_last"], rows["k"]["avg_last"], rows["k"]["steps_hit"]) == (-0.0003917, 0.007116, 50)
    assert w.bare == []


def test_the_bounding_alone_was_never_the_reason():
    w, rec = _steady("c2_bounding_only")
    assert {v for _t, v in w.verdicts} == {"healthy"}
    assert rec["verdict"] == "healthy"


STALL_WORDS = "The omega residual has not halved in 500 iterations (about 0.0011, from 0.002); a steady run's residuals should keep falling."


def test_a_run_that_ends_inside_the_hold_says_why():
    """omega flat at 2e-3 (a real stall), then 1e-5 for the last iterations: it ends before the
    verdict can ease. The stall that set "Watch closely" stays listed at warn, saying when it
    cleared and, while the run solves, why the verdict stays; once the run has ended, that it
    ended before the verdict could ease (it can no longer change). Its onset is kept."""
    tracker = HealthTracker(steady.hints("stall_end"))
    w = Watcher(tracker)
    lines = steady.lines("stall_end")
    w.lines(lines[:-2])
    # While it solves: iteration 1,000 is read when the next line ("End") comes.
    live = tracker.report()
    assert (live["live"], live["verdict"]) == (True, "watch")
    f = live["findings"][0]
    assert (f["code"], f["level"]) == ("residuals_stalled", "warn")
    assert f["text"] == f"{STALL_WORDS} It cleared at iteration 998; Watch closely stays until 5 iterations in a row are better (2 so far)."
    w.lines(lines[-2:])
    rec = w.final()
    assert (rec["live"], rec["verdict"]) == (False, "watch")
    onset = rec["timeline"][-1]
    assert (onset["t"], onset["verdict"]) == (600.0, "watch")
    f = rec["findings"][0]
    assert (f["code"], f["level"], f["since_t"]) == ("residuals_stalled", "warn", onset["t"])
    assert f["text"] == f"{STALL_WORDS} It cleared at iteration 998; the run ended before 5 better iterations in a row could ease Watch closely."
    assert "stays until" not in f["text"] and len(f["text"]) <= 240
    assert f["evidence"]["text"].startswith("smoothSolver:  Solving for omega, Initial residual = 0.002")
    assert w.bare == []


def test_a_stall_names_the_field_that_stalled():
    """omega flat at 2e-3 while U falls 0.85 decade per 500 iterations from above it: the words
    named U (the largest residual of the last iteration); they name omega."""
    lines = list(steady.HEAD)
    for n in range(1, 1001):
        u = 0.2 * 10 ** (-1.7 * n / 1000)
        lines += steady._block(n, u=u, p=2.2e-4, om=2e-3, k=6.5e-4, bound_omega=False, bound_k=False)
    tr = HealthTracker(steady.hints("stall_end"))
    feed(tr, lines + ["End", ""])
    rec = tr.report(final=True)
    f = next(x for x in rec["findings"] if x["code"] == "residuals_stalled")
    assert f["level"] == "warn"
    assert f["text"] == "The omega residual has not halved in 500 iterations (about 0.002, from 0.002); a steady run's residuals should keep falling."


def _swing(hi: float, lo: float, period: int, end: int = 1500) -> list[str]:
    """omega's first residual at hi for period/2 iterations, then at lo for period/2, from
    iteration 26; the other fields settle under 1e-3."""
    out = list(steady.HEAD)
    half = max(1, period // 2)
    for n in range(1, end + 1):
        om = steady._decay(n, 0.032, 9e-4, rate=0.1)
        if n >= 26:
            om = hi if (n // half) % 2 else lo
        u, p, k = steady._decay(n, 0.64, 3.8e-4), steady._decay(n, 0.39, 2.2e-4), steady._decay(n, 0.22, 6.5e-4)
        out += steady._block(n, u=u, p=p, om=om, k=k, bound_omega=False, bound_k=False)
    return out + ["End", ""]


@pytest.mark.parametrize(
    "hi,lo,period,mean",
    [(3e-3, 3e-4, 2, "0.0016"), (5e-3, 1.5e-4, 2, "0.0026"), (1e-2, 1e-4, 2, "0.005"), (3e-3, 3e-4, 10, "0.0016"), (3e-3, 3e-4, 20, None)],
)
def test_a_residual_that_swings_wide_without_falling_reads_watch_closely(hi: float, lo: float, period: int, mean: str | None):
    """omega swinging 3-10x over the 1e-3 floor and as far under it, never falling: the mean of
    its log10s (about 1e-3 or under) read Healthy, with no stall row. The mean of its values
    (1.65e-3 for 3e-3 / 3e-4) keeps it a stall: Watch closely once, to the end, with the stall's
    warn row; a limit cycle of 10 or 20 iterations too (one of 20 switched every 10-13)."""
    w = Watcher(HealthTracker({**steady.HINTS, "end_time": 1500.0}))
    w.lines(_swing(hi, lo, period))
    rec = w.final()
    assert [e["verdict"] for e in rec["timeline"]] == ["healthy", "watch"], rec["timeline"]
    onset = rec["timeline"][1]["t"]
    assert 550 <= onset <= 650
    f = rec["findings"][0]
    assert (f["code"], f["level"], f["since_t"]) == ("residuals_stalled", "warn", onset)
    assert f["text"].startswith("The omega residual has not halved in 500 iterations (about ")
    if mean is not None:
        assert f["text"].startswith(f"The omega residual has not halved in 500 iterations (about {mean}, from {mean});")
    assert w.bare == []


def test_the_swing_log_reads_watch_closely_with_its_stall_row():
    """health_steady_logs.py ``swing`` (the e2e's log): 3e-3 / 3e-4 on odd / even iterations."""
    w, rec = _steady("swing")
    assert [(e["t"], e["verdict"]) for e in rec["timeline"]] == [(6.0, "healthy"), (600.0, "watch")]
    assert [(f["code"], f["level"], f["since_t"]) for f in rec["findings"]] == [("residuals_stalled", "warn", 600.0), ("not_settled", "info", None)]
    assert rec["findings"][0]["text"] == (
        "The omega residual has not halved in 500 iterations (about 0.0016, from 0.0016); a steady run's residuals should keep falling."
    )
    assert w.bare == []


def _near_floor(level: float, noise: float, seed: int = 7, end: int = 2500) -> list[str]:
    """The pipe's pattern (odd iterations 8 % over, even 8 % under) at ``level``, with uniform noise."""
    rnd = random.Random(seed)
    out = list(steady.HEAD)
    for n in range(1, end + 1):
        om = steady._decay(n, 0.032, 9e-4, rate=0.1)
        if n >= 26:
            om = level * (1.08 if n % 2 else 0.92) * (1 + rnd.uniform(-noise, noise))
        u, p, k = steady._decay(n, 0.64, 3.8e-4), steady._decay(n, 0.39, 2.2e-4), steady._decay(n, 0.22, 6.5e-4)
        out += steady._block(n, u=u, p=p, om=om, k=k, bound_omega=True, bound_k=n >= 4)
    return out + ["End", ""]


def _changes(w: Watcher) -> int:
    """How many times the verdict changed after its first one, step by step."""
    vs = [v for _t, v in w.verdicts if v != "pending"]
    return sum(1 for a, b in zip(vs, vs[1:], strict=False) if a != b)


@pytest.mark.parametrize("level,noise", [(0.98e-3, 0.15), (1.0e-3, 0.05), (1.0e-3, 0.15), (1.02e-3, 0.05), (1.02e-3, 0.15)])
def test_a_residual_hovering_at_the_floor_does_not_flicker(level: float, noise: float):
    """The pipe's pattern at about the floor, with noise: with one threshold the verdict switched
    between Healthy and Watch closely 98-139 times in 2,500 iterations, the timeline filled to its
    20 entries and each switch sent a health event. Once stalled, a residual stays so until its
    mean is under 0.9e-3: at most one switch."""
    w = Watcher(HealthTracker(steady.hints("c2_sst")))
    w.lines(_near_floor(level, noise))
    rec = w.final()
    assert _changes(w) <= 1, rec["timeline"]
    assert len(rec["timeline"]) <= 2
    assert w.bare == []


def test_the_near_floor_log_switches_once():
    """health_steady_logs.py ``near_floor``: 1.00e-3 with 5 % noise."""
    w, rec = _steady("near_floor")
    assert _changes(w) == 1
    assert [e["verdict"] for e in rec["timeline"]] == ["healthy", "watch"]
    assert (rec["findings"][0]["code"], rec["findings"][0]["level"]) == ("residuals_stalled", "warn")
    assert w.bare == []


def test_unhealthy_held_by_the_debounce_keeps_its_error_row():
    """pv_coupling Unhealthy for 3 steps, then good steps: the check clears at once and the
    verdict waits 5 steps. In between it showed Unhealthy with no error finding."""
    tracker = HealthTracker({**PISO_HINTS, "max_co": 1})
    w = Watcher(tracker)
    w.lines(HEADER)
    for i in range(1, 10):
        w.lines(step_lines(i * 1e-3))
    for i in range(10, 13):
        w.lines(step_lines(i * 1e-3, p_final=0.6))
    w.lines(["Time = 0.0135"])
    assert tracker.verdict == "unhealthy"
    onset = tracker.timeline[-1]["t"]
    held = []
    for i in range(14, 30):
        w.lines(step_lines(i * 1e-3))
        rec = tracker.report()
        if rec["verdict"] == "unhealthy" and tracker.level.get("pv_coupling", 0) < 2:
            held.append(next(f for f in rec["findings"] if f["code"] == "pv_coupling"))
    assert tracker.verdict == "healthy"
    assert held, "the verdict never waited"
    for f in held:
        assert f["level"] == "error"
        assert f["text"].startswith("Pressure and velocity do not settle within a step: the last pressure solve starts at 0.6")
        assert re.search(r"It cleared at t = 0\.0\d+ s; Unhealthy stays until 5 time steps in a row are better \([1-4] so far\)\.$", f["text"]), f["text"]
        assert f["since_t"] == onset
        assert not OVERCLAIM.search(f["text"])
    assert w.bare == []


def test_a_fatal_line_inside_an_unhealthy_hold_says_it_cleared_before_the_run_failed():
    """pv_coupling Unhealthy, cleared, the verdict held at Unhealthy, then a fatal line: Failed is
    final, so the held row no longer says "Failed stays until 5 time steps in a row are better"."""
    tracker = HealthTracker({**PISO_HINTS, "max_co": 1})
    feed(tracker, HEADER)
    for i in range(1, 10):
        feed(tracker, step_lines(i * 1e-3))
    for i in range(10, 13):
        feed(tracker, step_lines(i * 1e-3, p_final=0.6))
    for i in range(13, 16):
        feed(tracker, step_lines(i * 1e-3))
    feed(tracker, ["Time = 0.016"])
    assert tracker.verdict == "unhealthy" and list(tracker.held) == ["pv_coupling"]
    words = "Pressure and velocity do not settle within a step: the last pressure solve starts at 0.6 (healthy is below 0.1)."
    f = next(x for x in tracker.report()["findings"] if x["code"] == "pv_coupling")
    assert f["text"] == f"{words} It cleared at t = 0.015 s; Unhealthy stays until 5 time steps in a row are better (1 so far)."
    feed(tracker, ["", "--> FOAM FATAL ERROR: boom"])
    for rec in (tracker.report(), tracker.report(final=True)):
        assert rec["verdict"] == "failed"
        assert [(x["code"], x["level"]) for x in rec["findings"]] == [("failed", "error"), ("pv_coupling", "error")]
        f = rec["findings"][1]
        assert f["text"] == f"{words} It cleared at t = 0.015 s, before the run failed."
        assert f["since_t"] == 0.012
        assert not any("stays until" in x["text"] or "could ease" in x["text"] for x in rec["findings"])


GAP_WORDS = "The {label} check was at {word} before the unread middle of the log; the steps read after it do not show it yet."
HELD_GAP_WORDS = (
    "The {label} check was at {word} before the unread middle of the log; the steps read after it did not show it. "
    "It cleared at t = 0.502 s; {word} stays until 5 time steps in a row are better ({n} so far)."
)


def _across_a_gap(code: str, label: str, word: str, **bad) -> None:
    """A window check at ``word`` before an unread middle, not seen in the tail: while its level is
    carried over the gap (the tail's window under 3 steps) its row says so, then its held row
    keeps those words (the near-empty window's were empty or untrue), until the verdict eases."""
    tracker = HealthTracker({**PISO_HINTS, "max_co": 1})
    w = Watcher(tracker)
    w.lines(HEADER)
    for i in range(1, 41):
        w.lines(step_lines(i * 1e-3, **(bad if i > 20 else {})))
    verdict = tracker.verdict
    assert verdict == {"Watch closely": "watch", "Unhealthy": "unhealthy"}[word]
    level = "error" if verdict == "unhealthy" else "warn"
    assert [(f["code"], f["level"]) for f in tracker.report()["findings"] if f["level"] != "info"][0] == (code, level)
    since = tracker.since[code]
    tracker.gap()
    seen = []
    rec = tracker.report()
    for t in [0.5 + i * 1e-3 for i in range(12)]:
        f = next((x for x in rec["findings"] if x["code"] == code), None)
        seen.append((rec["verdict"], f and f["text"]))
        if rec["verdict"] != "healthy":
            assert f is not None and f["level"] == level and f["since_t"] == since, rec["findings"]
            assert "over the last" not in f["text"] and " 0 of the last" not in f["text"] and " is at " not in f["text"], f["text"]
        w.lines(step_lines(t))
        rec = tracker.report()
    texts = [x for _v, x in seen]
    carried = GAP_WORDS.format(label=label, word=word)
    held = [HELD_GAP_WORDS.format(label=label, word=word, n=n) for n in range(1, 5)]
    # Before the tail's first step, then its first 3 steps: carried; then held for 4 steps; then Healthy.
    assert texts[:4] == [carried] * 4, texts
    assert texts[4:8] == held, texts
    assert [v for v, _x in seen][8:] == ["healthy"] * 4
    assert w.bare == []


def test_a_level_carried_over_an_unread_middle_is_listed():
    """After an unread middle (check_log of a long log) a window check keeps its level for the
    tail's first steps; its words read the near-empty window and were empty, so it counted toward
    "Watch closely" with no finding, and once it cleared its held row said "is at Watch closely
    over the last 3 steps"."""
    _across_a_gap("turbulence_bounded", "turbulence bounding", "Watch closely", k_min=-0.2)


def test_velocity_clipping_carried_over_an_unread_middle_is_listed():
    """The same with velocity clipping at Unhealthy: its row read "Velocity clipped in 0 of the
    last 1 steps: the 50 m/s limit caught up to 0% of cells", and its held row kept that."""
    _across_a_gap("velocity_clipped", "velocity clipping", "Unhealthy", clip=2.5)


def _monitors(dp: float) -> list[str]:
    return ["surfaceFieldValue mon_in write:", f"    areaAverage(in) of p = {dp}", "", "surfaceFieldValue mon_out write:", "    areaAverage(out) of p = 0", ""]


def _drifting() -> tuple[HealthTracker, Watcher]:
    """A fixed inflow whose inlet-outlet pressure difference grows to 160x the inflow's dynamic
    pressure from t = 0.031 s: Unhealthy (monitor_drift), then an unread middle."""
    tracker = HealthTracker({**PISO_HINTS, "max_co": 1, "monitors": {"inlet": "mon_in", "outlet": "mon_out"}})
    w = Watcher(tracker)
    w.lines(HEADER)
    for i in range(1, 60):
        w.lines(step_lines(i * 1e-3)[:-1] + _monitors(10.0 if i < 30 else 2000.0) + [""])
    assert (tracker.verdict, tracker.level.get("monitor_drift"), tracker.since.get("monitor_drift")) == ("unhealthy", 2, 0.031)
    tracker.gap()
    return tracker, w


DRIFT_GAP = "The pressure-drop drift check was at Unhealthy before the unread middle of the log; the steps read after it do not show it yet."
DRIFT_WORDS = "The pressure difference between mon_in and mon_out is 160× the inflow's dynamic pressure, at a fixed inflow: the flow is not settling."


def test_pressure_drop_drift_is_carried_over_an_unread_middle_until_two_samples():
    """The monitors write every few steps of a transient run (write_interval/50), not every step.
    The drift was set to 0 once the tail's window had 3 steps: the run eased to Healthy, turned
    Unhealthy again at the second sample with a later onset, and a tail that ended before 2
    samples ended Healthy. It keeps its level and onset, with the gap's words, until 2 samples."""
    tracker, w = _drifting()
    rows = []
    for i in range(100, 160):
        extra = _monitors(2000.0) if i % 10 == 0 else []
        w.lines(step_lines(i * 1e-3)[:-1] + extra + [""])
        rec = tracker.report()
        assert rec["verdict"] == "unhealthy", (i, rec["timeline"])
        f = next(x for x in rec["findings"] if x["code"] == "monitor_drift")
        assert (f["level"], f["since_t"]) == ("error", 0.031)
        rows.append(f["text"])
    # The second sample is at t = 0.11 s (read when its step closes, at the next one).
    assert set(rows[:11]) == {DRIFT_GAP}, rows[:12]
    assert set(rows[11:]) == {DRIFT_WORDS}, rows[11:]
    rec = w.final()
    assert [(e["t"], e["verdict"]) for e in rec["timeline"]] == [(0.006, "healthy"), (0.031, "unhealthy")]
    assert w.bare == []


def test_pressure_drop_drift_with_no_samples_after_an_unread_middle_says_so():
    tracker, w = _drifting()
    for i in range(100, 120):
        w.lines(step_lines(i * 1e-3))
    rec = w.final()
    assert rec["verdict"] == "unhealthy"
    f = next(x for x in rec["findings"] if x["code"] == "monitor_drift")
    assert (f["level"], f["text"], f["since_t"]) == ("error", DRIFT_GAP, 0.031)
    assert w.bare == []


# ---------------------------------------------------------------- every log the repo has


def _calib(name: str) -> tuple[dict, Path]:
    return json.loads((CALIB / f"{name}.hints.json").read_text(encoding="utf-8")), CALIB / f"{name}.log.gz"


CALIB_CASES = sorted(p.name[: -len(".log.gz")] for p in CALIB.glob("*.log.gz"))


@pytest.mark.parametrize("name", CALIB_CASES)
def test_every_calibration_run_says_why_at_every_step(name: str):
    hints, log = _calib(name)
    w = Watcher(HealthTracker(hints))
    w.log(log)
    rec = w.final()
    assert w.bare == [], (name, w.bare[:5], len(w.bare))
    assert rec["verdict"] == "healthy"


def test_run2_head_and_tail_say_why_at_every_step():
    w = Watcher(HealthTracker(HINTS))
    w.log(FIX / "run2-head.log.gz")
    assert w.bare == []
    w.tracker.gap()
    w.log(FIX / "run2-tail.log.gz")
    rec = w.final()
    assert rec["verdict"] == "unhealthy"
    assert w.bare == [], w.bare[:5]


@pytest.mark.parametrize("head,tail", [(120_000, 150_000), (20_000, 150_000), (60_000, 30_000)])
def test_an_old_runs_check_says_why(tmp_path: Path, head: int, tail: int):
    import gzip

    p1 = tmp_path / "log.pimpleFoam.1"
    p1.write_bytes(gzip.decompress((FIX / "run2-head.log.gz").read_bytes()))
    p2 = tmp_path / "log.pimpleFoam"
    p2.write_bytes(gzip.decompress((FIX / "run2-tail.log.gz").read_bytes()))
    rec = check_log([str(p1), str(p2)], HINTS, head_bytes=head, tail_bytes=tail)
    assert _says_why(rec), [(f["code"], f["level"]) for f in rec["findings"]]


def test_the_cht_case_and_the_synthetic_logs_say_why():
    cht = FIX.parent / "cht-case" / "log.chtMultiRegionSimpleFoam"
    w = Watcher(HealthTracker({"app": "chtMultiRegionSimpleFoam", "mode": "SIMPLE", "turbulence": "laminar"}))
    w.lines(cht.read_text(encoding="utf-8").splitlines())
    w.final()
    assert w.bare == []
    for name in steady.NAMES:
        w2, _rec = _steady(name)
        assert w2.bare == [], (name, w2.bare[:5])


# ---------------------------------------------------------------- the words


def _ts_record(name: str) -> dict[str, str]:
    text = WORDS_TS.read_text(encoding="utf-8")
    m = re.search(rf"export const {name}[^=]*= \{{(.*?)\n\}};", text, re.S)
    assert m, name
    return dict(re.findall(r"^\s*(\w+): '([^']*)',", m.group(1), re.M))


def test_the_verdict_and_check_words_are_the_panels():
    assert _ts_record("VERDICT_WORDS") == health.VERDICT_WORDS
    assert _ts_record("CHECK_NAMES") == health.CHECK_LABEL


def test_held_words_never_overclaim():
    _w, rec = _steady("stall_end")
    for f in rec["findings"]:
        assert not OVERCLAIM.search(f["text"]), f["text"]
        assert len(f["text"]) <= 240
