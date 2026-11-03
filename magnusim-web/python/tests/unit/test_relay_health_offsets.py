"""Run health in the relay's stream (RH1, spec 2.3 "Log offsets" and 3.5 item 4): which lines
are the solver's, and where each starts in the run's whole log.

A fake solve's stdout mixes, in order: the start and copy events, decomposePar's output (with
its own "Time = 0" lines), the decompose_end and solve stages, the solver's lines (Run_2's
first 900, with time_saved and log events between them and one line with a multi-byte
character), the reconstruct stage and reconstructPar's output. The tracker gets exactly the
solver's lines, each with its offset in log.pimpleFoam.1 (an earlier part) + the
log.pimpleFoam tee would write.
"""

from __future__ import annotations

import gzip
import io
import json
from pathlib import Path

from magnusim_sdk.health import HealthTracker, line_key

from cfddesk.wsl.foam_relay import earlier_log_bytes
from cfddesk.wsl.solve_run import SolverLogCounter, stream_events_to_stdout

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "health"
HINTS = json.loads((FIX / "run2.hints.json").read_text(encoding="utf-8"))


def ev(doc: dict) -> str:
    return "MAGNUSIM_EVENT " + json.dumps(doc)


class FakeProc:
    def __init__(self, lines: list[str]) -> None:
        self.stdout = io.StringIO("".join(line + "\n" for line in lines))

    def wait(self) -> int:
        return 0


def solver_lines() -> list[str]:
    text = gzip.decompress((FIX / "run2-head.log.gz").read_bytes()).decode("utf-8")
    lines = text.split("\n")[:900]
    # A line with a multi-byte character in the solver's own output.
    lines.insert(60, "Selecting finite volume options type limitVelocity — ü")
    return lines


def test_offsets_skip_events_and_decompose_output(tmp_path: Path):
    part1 = tmp_path / "log.pimpleFoam.1"
    part1.write_bytes(b"an earlier part\n" * 1000)
    base = earlier_log_bytes(tmp_path, "pimpleFoam")
    assert base == part1.stat().st_size
    solver = solver_lines()
    stream: list[str] = [
        ev({"event": "start", "run_id": "pf-1"}),
        ev({"event": "stage", "stage": "copy_to_wsl"}),
        ev({"event": "log", "line": "cwd=/home/cfduser/cases/x"}),
        ev({"event": "stage", "stage": "decompose"}),
        "Create time",
        "Time = 0",
        "Decomposing mesh region0",
        "Time = 0",
        ev({"event": "stage", "stage": "decompose_end", "exit_code": 0}),
        ev({"event": "stage", "stage": "solve", "parallel": True, "n_procs": 15, "app": "pimpleFoam"}),
    ]
    for i, line in enumerate(solver):
        stream.append(line)
        if i % 97 == 50:
            stream.append(ev({"event": "time_saved", "t": 0.001 * i}))
        if i % 131 == 7:
            stream.append(ev({"event": "log", "line": "live sync"}))
    stream += [
        ev({"event": "stage", "stage": "reconstruct", "exit_code": 0}),
        "Reconstructing fields",
        "Time = 0.1",
        ev({"event": "result", "ok": True}),
    ]
    tracker = HealthTracker(HINTS)
    out = io.StringIO()
    code, _ = stream_events_to_stdout(FakeProc(stream), None, out=out, health=tracker, log_base=lambda: base)
    assert code == 0
    # The tracker's steps are the solver's own: decomposePar's and reconstructPar's Time lines are not.
    assert tracker.steps == sum(1 for line in solver if line.startswith("Time = "))
    assert tracker.lines == len(solver)
    # What tee writes, after the earlier part.
    whole = part1.read_bytes() + "".join(line + "\n" for line in solver).encode("utf-8")
    rec = tracker.report()
    findings = [f for f in rec["findings"] if f.get("evidence")]
    assert findings, rec["findings"]
    for f in findings:
        at, key = f["evidence"]["log_at"], f["evidence"]["key"]
        end = whole.index(b"\n", at)
        line = whole[at:end]
        assert whole[at - 1 : at] == b"\n"
        assert line_key(line.decode("utf-8")) == key
    # The line after the multi-byte one is still exact.
    after = solver.index("Selecting finite volume options type limitVelocity — ü") + 1
    counter = SolverLogCounter(base)
    counter.feed(ev({"event": "stage", "stage": "solve"}))
    offsets = [counter.feed(line) for line in solver]
    target = offsets[after]
    assert whole[target : target + len(solver[after].encode("utf-8"))] == solver[after].encode("utf-8")
    # The health events went out with the parser's.
    sent = [json.loads(line.split(" ", 1)[1]) for line in out.getvalue().splitlines() if line.startswith("MAGNUSIM_EVENT ")]
    health = [e for e in sent if e.get("event") == "health"]
    assert health and health[-1]["live"] is False
    assert {e["verdict"] for e in health} >= {"watch", "unhealthy"}


def test_counter_rules():
    c = SolverLogCounter(100)
    assert c.feed("Time = 0") is None  # before the solve stage
    assert c.feed(ev({"event": "stage", "stage": "solve"})) is None
    assert c.feed("Time = 1") == 100
    assert c.feed(ev({"event": "time_saved", "t": 1})) is None
    assert c.feed("é") == 109  # "Time = 1" is 8 bytes + LF
    assert c.feed("x") == 112  # "é" is 2 bytes + LF
    assert c.feed(ev({"event": "stage", "stage": "solve_end"})) is None
    assert c.feed("Time = 2") is None
