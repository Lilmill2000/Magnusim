"""Unit/integration tests for solve template + progress→JSONL parsing."""
from __future__ import annotations

import importlib.util
import inspect
from pathlib import Path

import pytest

from cfddesk.jobs.events import EVENT_PREFIX, parse_line
from cfddesk.wsl.solve_run import (
    WRITE_NOW_SED,
    ProgressParser,
    events_from_lines,
    render_solve_script,
    solve_is_live,
    solve_template_path,
    start_solve,
    stop_solve,
    write_solve_script,
)

SAMPLE_LOG = """\
CFDDESK_EVENT {"event":"start","run_id":"run-1","n_procs":1,"app":"simpleFoam"}
CFDDESK_EVENT {"event":"stage","stage":"copy_to_wsl"}
CFDDESK_EVENT {"event":"stage","stage":"solve","parallel":false,"app":"simpleFoam"}
Time = 1
Smooth solver:  Solving for Ux, Initial residual = 1.2e-1, Final residual = 1e-3, No Iterations 2
Smooth solver:  Solving for Uy, Initial residual = 2.3e-2, Final residual = 1e-4, No Iterations 2
Smooth solver:  Solving for Uz, Initial residual = 3.4e-3, Final residual = 1e-5, No Iterations 1
DICPCG:  Solving for p, Initial residual = 4.5e-1, Final residual = 1e-4, No Iterations 20
Smooth solver:  Solving for omega, Initial residual = 5.6e-2, Final residual = 1e-5, No Iterations 3
Smooth solver:  Solving for k, Initial residual = 6.7e-2, Final residual = 1e-5, No Iterations 3
Time = 2
Smooth solver:  Solving for Ux, Initial residual = 1.1e-1, Final residual = 1e-3, No Iterations 2
DICPCG:  Solving for p, Initial residual = 3.3e-1, Final residual = 1e-4, No Iterations 18
CFDDESK_EVENT {"event":"time_saved","t":2}
CFDDESK_EVENT {"event":"stage","stage":"copy"}
CFDDESK_EVENT {"event":"result","ok":true,"exit_code":0}
"""

TRANSIENT_LOG = """\
CFDDESK_EVENT {"event":"stage","stage":"solve","parallel":false,"app":"pimpleFoam"}
Courant Number mean: 0.12 max: 0.98
deltaT = 0.000123
Time = 0.000123
Smooth solver:  Solving for Ux, Initial residual = 0.5, Final residual = 1e-3, No Iterations 2
DICPCG:  Solving for p, Initial residual = 0.4, Final residual = 1e-4, No Iterations 10
"""


def test_template_exists_and_has_placeholders():
    p = solve_template_path()
    assert p.is_file()
    text = p.read_text(encoding="utf-8")
    for tok in ("__DST__", "__WIN_OUT__", "__NPROCS__", "__APP__", "__RUN_ID__"):
        assert tok in text
    assert "MAGNUSIM_EVENT" in text
    assert 'echo "MAGNUSIM_EVENT' in text  # emit preferred brand
    assert "openfoam2606" in text
    assert "decomposePar" in text
    assert "mpirun --oversubscribe -np" in text
    assert "W27_" not in text
    assert "reconstructPar -latestTime" in text
    assert "reconstructPar -newTimes" not in text
    assert "postProcessing" in text
    assert "_latest_time" in text
    assert "sync_live_frames" in text
    assert "copy_saved_time" in text


def test_render_substitutes_all_placeholders(tmp_path: Path):
    body = render_solve_script(
        dst="/home/cfddesk/cases/cfddesk-w27-run-1",
        win_out="/mnt/c/Magnusim-fixture/cfd-web/projects/x/runs/run-run-1",
        n_procs=4,
        app="pimpleFoam",
        run_id="run-1",
    )
    assert "__DST__" not in body
    assert "__APP__" not in body
    assert 'DST="/home/cfddesk/cases/cfddesk-w27-run-1"' in body
    assert 'APP="pimpleFoam"' in body
    assert 'NPROCS="4"' in body
    assert "\r" not in body
    out = tmp_path / "solve.sh"
    write_solve_script(
        out,
        dst="/home/cfddesk/cases/cfddesk-w27-run-1",
        win_out="/mnt/c/tmp/out",
        n_procs=1,
        app="simpleFoam",
        run_id="run-9",
    )
    assert out.read_bytes().startswith(b"#!/usr/bin/env bash")


def test_events_from_steady_sample_log():
    events = events_from_lines(SAMPLE_LOG.splitlines())
    kinds = [e.event for e in events]
    assert "start" in kinds
    assert "stage" in kinds
    assert "progress" in kinds
    assert "residual" in kinds
    assert "time_saved" in kinds
    assert "result" in kinds
    residuals = [e for e in events if e.event == "residual"]
    fields_seen = {e.fields.get("field") for e in residuals}
    assert "Ux" in fields_seen
    assert "p" in fields_seen
    saved = [e for e in events if e.event == "time_saved"]
    assert saved and float(saved[0].fields.get("t")) == 2.0
    result = [e for e in events if e.event == "result"][-1]
    assert result.fields.get("ok") is True


def test_time_line_promotes_without_stage_event():
    log = """\
Courant Number mean: 0.12 max: 0.98
deltaT = 0.000123
Time = 0.000123
Smooth solver:  Solving for Ux, Initial residual = 0.5, Final residual = 1e-3, No Iterations 2
DICPCG:  Solving for p, Initial residual = 0.4, Final residual = 1e-4, No Iterations 10
"""
    events = events_from_lines(log.splitlines())
    kinds = [e.event for e in events]
    assert "progress" in kinds
    parser = ProgressParser()
    for line in log.splitlines():
        parser.feed(line)
    assert parser.stage == "solve"
    assert parser.current is not None
    assert float(parser.current["t"]) == pytest.approx(0.000123)


def test_events_from_transient_courant():
    events = events_from_lines(TRANSIENT_LOG.splitlines())
    kinds = [e.event for e in events]
    assert "courant" in kinds
    assert "progress" in kinds
    assert "residual" in kinds
    progress = [e for e in events if e.event == "progress"][0]
    assert progress.fields.get("time") == pytest.approx(0.000123)
    assert progress.fields.get("co_max") == pytest.approx(0.98)
    assert progress.fields.get("delta_t") == pytest.approx(0.000123)


def test_progress_parser_snapshot():
    parser = ProgressParser()
    for line in SAMPLE_LOG.splitlines():
        parser.feed(line)
    snap = parser.snapshot()
    assert snap["stage"] == "copy"
    assert float(snap["saved_times"][0]) == 2.0
    assert snap["n_steps"] >= 2


def test_jsonl_lines_roundtrip_parseable():
    events = events_from_lines(SAMPLE_LOG.splitlines())
    for ev in events:
        line = EVENT_PREFIX + ev.to_json()
        back = parse_line(line)
        assert back is not None
        assert back.event == ev.event
        bare = parse_line(ev.to_json())
        assert bare is not None
        assert bare.event == ev.event


def _load_run_solve():
    path = Path(__file__).resolve().parents[2] / "tools" / "run_solve.py"
    spec = importlib.util.spec_from_file_location("run_solve_cli", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_run_solve_parse_log_cli(tmp_path: Path, capsys):
    log = tmp_path / "sample.log"
    log.write_text(SAMPLE_LOG, encoding="utf-8")
    mod = _load_run_solve()
    rc = mod.main(["--parse-log", str(log)])
    assert rc == 0
    out = capsys.readouterr().out.strip().splitlines()
    assert out
    parsed = [parse_line(ln) for ln in out]
    assert all(p is not None for p in parsed)
    assert any(p.event == "residual" for p in parsed if p)
    assert any(p.event == "result" for p in parsed if p)


def test_magnusim_prefixed_sample():
    log = SAMPLE_LOG.replace("CFDDESK_EVENT", "MAGNUSIM_EVENT")
    events = events_from_lines(log.splitlines())
    assert any(e.event == "residual" for e in events)
    assert any(e.event == "result" for e in events)


def test_write_now_sed_matches_flush_and_indented():
    assert "[[:space:]]*stopAt" in WRITE_NOW_SED
    assert "writeNow" in WRITE_NOW_SED
    src = inspect.getsource(stop_solve)
    assert "WRITE_NOW_SED" in src


def test_solve_is_live_targets_solver_names():
    src = inspect.getsource(solve_is_live)
    assert "pgrep -x pimpleFoam" in src
    assert "pgrep -x simpleFoam" in src
    assert "live-frames" in src


def test_stop_solve_cli_has_probe():
    path = Path(__file__).resolve().parents[2] / "tools" / "stop_solve.py"
    text = path.read_text(encoding="utf-8")
    assert "--probe" in text
    assert "solve_is_live" in text


def test_start_solve_kills_leftover_wsl_solver():
    src = inspect.getsource(start_solve)
    assert "solve_is_live" in src
    assert "kill_solve" in src
