"""Run health always says why (RH1): a verdict of "Watch closely" or "Unhealthy" has a finding at
its level (warn or error) in plain words, for the Run panel and the Assistant alike.

The bug (validation rerun of 2026-11-07, the turbulent pipe on Hex-dominant with k-omega SST):
the verdict turned "Watch closely" at iteration 551 and stayed there to the end with only info
findings. Not the bounding (k and omega bounded every iteration): omega's first residual
alternated 1.06e-3 / 0.90e-3 between odd and even iterations, so residuals_stalled, read one
iteration at a time, switched on and off every iteration; the verdict improves only after 5
better steps in a row, so it never eased, while the findings showed the current levels and the
last iteration's was off. Two fixes, both tested here:

- residuals_stalled reads the mean of each field's last 10 first residuals (health.py
  STALL_SMOOTH, a calibration in spec 2.6's sense), and its words name the field that stalled;
- while the debounce holds a verdict above what the checks now say, the checks that set it stay
  listed at its level, with their words from when they were on, when they cleared and that the
  verdict stays until 5 steps in a row are better (``held``); a check the verdict counts is never
  left out for want of words (after an unread middle of the log too).

Logs: the calibration fixtures, Run_2's head and tail, and the synthetic steady logs of
health_steady_logs.py (the pipe's pattern, its bounding alone, and a stall that ends inside the
hold).
"""

from __future__ import annotations

import json
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


def test_a_run_that_ends_inside_the_hold_says_why():
    """omega flat at 2e-3 (a real stall), then 1e-5 for the last iterations: it ends before the
    verdict can ease. The stall that set "Watch closely" stays listed at warn, saying when it
    cleared and why the verdict stays, with its onset."""
    w, rec = _steady("stall_end")
    assert rec["verdict"] == "watch"
    onset = rec["timeline"][-1]
    assert onset["verdict"] == "watch"
    f = rec["findings"][0]
    assert (f["code"], f["level"], f["since_t"]) == ("residuals_stalled", "warn", onset["t"])
    assert f["text"] == (
        "The omega residual has stopped falling at about 0.002 (0.002 about 500 iterations before); a steady run's "
        "residuals should keep falling. It cleared at iteration 998; Watch closely stays until 5 iterations in a row "
        "are better (3 so far)."
    )
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
    assert f["text"].startswith("The omega residual has stopped falling at about 0.002 (0.002 about 500 iterations before)")


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


def test_a_level_carried_over_an_unread_middle_is_listed():
    """After an unread middle (check_log of a long log) a window check keeps its level for the
    tail's first steps; its words read the near-empty window and were empty, so it counted
    toward "Watch closely" with no finding."""
    tracker = HealthTracker({**PISO_HINTS, "max_co": 1})
    feed(tracker, HEADER)
    for i in range(1, 41):
        feed(tracker, step_lines(i * 1e-3, k_min=-0.2))
    assert tracker.verdict == "watch"
    assert [f["code"] for f in tracker.report()["findings"] if f["level"] == "warn"] == ["turbulence_bounded"]
    tracker.gap()
    feed(tracker, step_lines(0.5))
    feed(tracker, ["Time = 0.501"])
    rec = tracker.report()
    assert rec["verdict"] == "watch"
    f = next(x for x in rec["findings"] if x["code"] == "turbulence_bounded")
    assert f["level"] == "warn"
    assert f["text"] == (
        "The turbulence bounding check was at Watch closely before the unread middle of the log; "
        "the steps read after it do not show it yet."
    )


def test_pressure_drop_drift_is_not_kept_on_with_no_samples_after_an_unread_middle():
    tracker = HealthTracker({**PISO_HINTS, "max_co": 1, "monitors": {"inlet": "mon_in", "outlet": "mon_out"}})
    w = Watcher(tracker)
    w.lines(HEADER)

    def monitors(dp: float) -> list[str]:
        return ["surfaceFieldValue mon_in write:", f"    areaAverage(in) of p = {dp}", "", "surfaceFieldValue mon_out write:", "    areaAverage(out) of p = 0", ""]

    for i in range(1, 60):
        w.lines(step_lines(i * 1e-3)[:-1] + monitors(10.0 if i < 30 else 50.0) + [""])
    assert tracker.level.get("monitor_drift") == 1
    assert tracker.verdict == "watch"
    tracker.gap()
    for i in range(100, 120):
        w.lines(step_lines(i * 1e-3))
    # No samples since the gap: carried for the gap's first steps, then off, and the verdict eases.
    assert tracker.level.get("monitor_drift") == 0
    rec = w.final()
    assert rec["verdict"] == "healthy"
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
