"""Unit/integration tests for solve template + progress→JSONL parsing."""
from __future__ import annotations

import importlib.util
import inspect
from pathlib import Path

import pytest
from magnusim_sdk.progress import ProgressParser

from cfddesk.jobs.events import EVENT_PREFIX, parse_line
from cfddesk.wsl.solve_run import (
    WRITE_NOW_SED,
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
    # Transient: frames the live sync already rebuilt are not rebuilt again at the
    # end (-newTimes); a frame it left incomplete is removed first so it is redone.
    assert "reconstructPar -noZero -newTimes" in text
    assert 'rm -rf "${DST:?}/$t"' in text
    # Live frames are rebuilt in one reconstructPar per tick, not one per frame.
    assert "reconstructPar -noZero -time '$times'" in text
    assert "reconstructPar -time $t" not in text
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
        frame_fields=("U", "p"),
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
        frame_fields=("U", "p"),
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


def test_solve_is_live_targets_the_runs_solver_names(monkeypatch):
    """The run's own process names (from its launch spec); legacy runs fall back."""
    import cfddesk.wsl.solve_run as sr

    seen: list[str] = []

    class _R:
        stdout = "DEAD"
        stderr = ""

    monkeypatch.setattr(sr, "run_wsl_bash", lambda inner, timeout=8.0: seen.append(inner) or _R())
    assert solve_is_live("cfddesk-w27-x", ("laplacianFoam",)) is False
    assert "pgrep -x laplacianFoam" in seen[-1] and "pgrep -x mpirun" in seen[-1]
    assert "simpleFoam" not in seen[-1]
    solve_is_live("cfddesk-w27-x")
    assert "pgrep -x pimpleFoam" in seen[-1] and "pgrep -x simpleFoam" in seen[-1]
    assert "live-frames" in seen[-1]
    with pytest.raises(ValueError):
        solve_is_live("cfddesk-w27-x", ("rm -rf /",))


def test_render_solve_script_uses_the_launch_spec():
    from cfddesk.wsl.solve_run import render_solve_script

    kw = {"dst": "/d", "win_out": "/w", "n_procs": 2, "run_id": "r1", "frame_fields": ("T",)}
    body = render_solve_script(app="laplacianFoam", keep_frames="all", **kw)
    assert 'APP="laplacianFoam"' in body and 'KEEP_FRAMES="all"' in body
    assert '[ "$KEEP_FRAMES" = "all" ]' in body and "pimpleFoam" not in body
    assert "__" not in body.split("set -uo pipefail", 1)[1].split("_evt()", 1)[0]
    assert 'KEEP_FRAMES="latest"' in render_solve_script(app="simpleFoam", **kw)
    for bad in ("simple Foam", "a;b", "$(x)", ""):
        with pytest.raises(ValueError):
            render_solve_script(app=bad, **kw)
    with pytest.raises(ValueError):
        render_solve_script(app="simpleFoam", keep_frames="some", **kw)
    assert 'FRAME_FIELDS="T"' in body


def test_render_solve_script_needs_the_frame_fields():
    # No default: the caller passes the launch spec's fields, so no analysis
    # gets another analysis's frame test by leaving them out.
    with pytest.raises(TypeError):
        render_solve_script(dst="/d", win_out="/w", n_procs=1, app="simpleFoam", run_id="r1")  # type: ignore[call-arg]
    for bad in ((), ("a b",), ("$(x)",)):
        with pytest.raises(ValueError):
            render_solve_script(dst="/d", win_out="/w", n_procs=1, app="simpleFoam", run_id="r1", frame_fields=bad)


def test_run_solve_render_only_writes_the_given_frame_fields(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    import run_solve

    monkeypatch.setenv("MAGNUSIM_WSL_CASE_ROOT", "/home/test/cases")
    out = tmp_path / "solve.sh"
    argv = ["--case-dir", str(tmp_path), "--wsl-case", "cfddesk-w27-run-1", "--app", "laplacianFoam",
            "--render-only", "--render-out", str(out)]
    assert run_solve.main([*argv, "--frame-fields", "T"]) == 0
    text = out.read_text(encoding="utf-8")
    assert 'FRAME_FIELDS="T"' in text and "__FRAME_FIELDS__" not in text
    # Without the flag: the frames of a case written before API 1.1.
    assert run_solve.main(argv) == 0
    assert 'FRAME_FIELDS="U p"' in out.read_text(encoding="utf-8")


def test_stop_solve_cli_has_probe():
    path = Path(__file__).resolve().parents[2] / "tools" / "stop_solve.py"
    text = path.read_text(encoding="utf-8")
    assert "--probe" in text
    assert "solve_is_live" in text


def test_start_solve_kills_leftover_wsl_solver():
    src = inspect.getsource(start_solve)
    assert "solve_is_live" in src
    assert "kill_solve" in src


def test_stage_wall_clock_becomes_phase_durations():
    lines = [
        'MAGNUSIM_EVENT {"event":"stage","stage":"copy_to_wsl","t_wall":100.0}',
        'MAGNUSIM_EVENT {"event":"stage","stage":"decompose","t_wall":102.5}',
        'MAGNUSIM_EVENT {"event":"stage","stage":"decompose_end","exit_code":0,"t_wall":106.0}',
        'MAGNUSIM_EVENT {"event":"stage","stage":"solve","parallel":true,"t_wall":106.1}',
        "Time = 1",
        'MAGNUSIM_EVENT {"event":"stage","stage":"reconstruct","exit_code":0,"t_wall":200.1}',
        'MAGNUSIM_EVENT {"event":"stage","stage":"copy","t_wall":219.1}',
        'MAGNUSIM_EVENT {"event":"result","ok":true,"exit_code":0,"t_wall":220.0}',
    ]
    parser = ProgressParser()
    phases = [ev for line in lines for ev in parser.feed(line) if ev.event == "phase"]
    assert [(ev.fields["phase"], ev.fields["seconds"]) for ev in phases] == [
        ("copy_in", 2.5),
        ("decompose", 3.5),
        ("solve", 94.0),
        ("reconstruct", 19.0),
        ("copy_back", 0.9),
    ]
    assert parser.snapshot()["phases"] == {
        "copy_in": 2.5,
        "decompose": 3.5,
        "solve": 94.0,
        "reconstruct": 19.0,
        "copy_back": 0.9,
    }
    # The phase events survive the JSONL round trip Node reads.
    assert parse_line(EVENT_PREFIX + phases[0].to_json()).event == "phase"


def test_stage_events_without_wall_clock_record_no_phases():
    # The SDK's parser, as the core streams a run; Incompressible Flow's own parser
    # (its residual fields) is tested with the plugin (tests/test_parser.py).
    parser = ProgressParser()
    for line in SAMPLE_LOG.splitlines():
        parser.feed(line)
    snap = parser.snapshot()
    assert snap["stage"] == "copy"
    assert float(snap["saved_times"][0]) == 2.0
    assert snap["n_steps"] >= 2
    assert snap["phases"] == {}

