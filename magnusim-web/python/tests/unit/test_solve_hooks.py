"""H15: solve hooks (gate:h15-hooks-fired, gate:h15-hooks-isolated).

``solve.prepare``, ``solve.parse_line`` and ``solve.stop`` fire in the solve relay,
only when the host passes hook names; listeners never slow or break a solve,
and nothing they print can reach the event stream.
"""

from __future__ import annotations

import ast
import io
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from cfddesk.registry import reset_for_tests
from cfddesk.registry.hooks import FIRED_HOOKS, HOOK_NAMES, RESERVED_HOOKS, HookBus, get_hooks
from cfddesk.registry.solve_context import SolveContext, parse_owner, solve_context
from cfddesk.wsl import solve_hooks
from cfddesk.wsl.solve_hooks import HookOutput, HookRunner, LineSink, hook_log_line, hook_names

PY_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = PY_ROOT / "tests" / "fixtures"
RUN_SOLVE = PY_ROOT / "tools" / "run_solve.py"


@pytest.fixture(autouse=True)
def _clean_bus():
    reset_for_tests()
    yield
    reset_for_tests()


def ctx(owner: str = "core") -> SolveContext:
    return SolveContext(owner, "proj", "sim-1", None, None, "run-1", "pimpleFoam", None, "cfddesk-w27-run-1", 1)  # type: ignore[arg-type]


def sink() -> tuple[LineSink, io.StringIO]:
    buf = io.StringIO()
    return LineSink(buf), buf


def lines_of(buf: io.StringIO) -> list[dict[str, Any]]:
    out = []
    for line in buf.getvalue().splitlines():
        assert line.startswith("MAGNUSIM_EVENT "), line
        out.append(json.loads(line[len("MAGNUSIM_EVENT "):]))
    return out


def wait_for(cond, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return True
        time.sleep(0.01)
    return cond()


# ---------------------------------------------------------------------------
# The bus
# ---------------------------------------------------------------------------


def test_fired_and_reserved_names():
    assert FIRED_HOOKS == {"case.write", "case.written", "ui.tree.transform", "solve.prepare", "solve.parse_line", "solve.stop"}
    assert RESERVED_HOOKS == HOOK_NAMES - FIRED_HOOKS
    assert len(RESERVED_HOOKS) == 12


def test_the_fire_sites_are_the_fired_hooks():
    """Every name the core fires (call/apply/notify on the bus, or listeners handed
    lines) is in FIRED_HOOKS, and every name in FIRED_HOOKS has a fire site."""
    fired: set[str] = set()
    for folder in (PY_ROOT / "cfddesk", PY_ROOT / "tools"):
        for path in folder.rglob("*.py"):
            if "__pycache__" in path.parts:
                continue
            tree = ast.parse(path.read_text(encoding="utf-8-sig"))
            for node in ast.walk(tree):
                if (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr in ("call", "apply", "notify", "listeners")
                    and node.args
                    and isinstance(node.args[0], ast.Constant)
                    and isinstance(node.args[0].value, str)
                    and node.args[0].value in HOOK_NAMES
                ):
                    fired.add(node.args[0].value)
    assert fired == set(FIRED_HOOKS)


def test_notify_drops_a_listener_that_raises():
    bus = HookBus()
    seen: list[str] = []

    def bad(**_kw: Any) -> None:
        raise RuntimeError("no")

    bus.on("solve.stop", bad, plugin="a")
    bus.on("solve.stop", lambda **kw: seen.append("good"), plugin="b")
    assert bus.has_listeners("solve.stop") and not bus.has_listeners("solve.prepare")
    assert bus.notify("solve.stop", ctx=None, forced=True) == 1
    assert seen == ["good"]
    assert [p for p, _ in bus.listeners("solve.stop")] == ["b"]
    assert bus.notify("solve.stop", ctx=None, forced=True) == 1


def test_a_reserved_name_is_legal_and_logged_once(caplog: pytest.LogCaptureFixture):
    bus = HookBus()
    with caplog.at_level(logging.WARNING, logger="cfddesk.registry.hooks"):
        bus.on("mesh.result", lambda **kw: None, plugin="h15-reserved-test")
        bus.on("mesh.result", lambda **kw: None, plugin="h15-reserved-test")
        bus.around("results.load", lambda proceed, **kw: proceed(**kw), plugin="h15-reserved-test")
        bus.on("solve.stop", lambda **kw: None, plugin="h15-reserved-test")
    said = [r.getMessage() for r in caplog.records]
    assert sum("hook mesh.result is reserved and never fires in API 1.3" in m for m in said) == 1
    assert sum("hook results.load is reserved" in m for m in said) == 1
    assert not any("solve.stop" in m for m in said)


def test_a_plugin_registering_a_reserved_name_still_loads(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    from cfddesk.registry import load_all

    plugins = tmp_path / "plugins"
    shutil.copytree(FIXTURES / "hook-plugins", plugins)
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    hub = load_all(force=True)
    assert {"hook-demo", "hook-reserved"} <= set(hub.manifests)
    assert not [f for f in hub.failures if f["key"].startswith("hook-")]
    bus = get_hooks()
    assert all(bus.has_listeners(n) for n in ("solve.prepare", "solve.parse_line", "solve.stop"))


def test_listening_rpc(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    from cfddesk.worker.foam_methods import solve_hooks_listening

    empty = tmp_path / "none"
    empty.mkdir()
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(empty))
    assert solve_hooks_listening() == {"names": []}
    reset_for_tests()
    plugins = tmp_path / "plugins"
    shutil.copytree(FIXTURES / "hook-plugins", plugins)
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    assert solve_hooks_listening() == {"names": ["solve.prepare", "solve.parse_line", "solve.stop"]}


# ---------------------------------------------------------------------------
# The context
# ---------------------------------------------------------------------------


def test_owners(caplog: pytest.LogCaptureFixture):
    assert parse_owner("core:proj one/sim-abc-123") == {"owner": "core", "project_id": "proj one", "simulation_id": "sim-abc-123", "plugin": None, "study_id": None}
    assert parse_owner("plugin:proj/foam-demo/st-1") == {"owner": "plugin", "project_id": "proj", "simulation_id": None, "plugin": "foam-demo", "study_id": "st-1"}
    for bad in ("", "core:proj", "core:../x/sim", "core:proj/sim/extra", "plugin:proj/foam-demo/St_1", "plugin:proj/../st-1",
                "plugin:proj/foam-demo.", "other:proj/sim", "core:proj\x01/sim", "core:./sim",
                "plugin:proj/foam-demo/st-1/extra", "plugin:proj/foam-demo"):
        assert parse_owner(bad) is None, bad
    with caplog.at_level(logging.WARNING, logger="cfddesk.registry.solve_context"):
        assert solve_context("core:../h15-bad-owner", wsl_case="x") is None
        assert solve_context("core:../h15-bad-owner", wsl_case="x") is None
    assert sum("h15-bad-owner" in r.getMessage() for r in caplog.records) == 1
    c = solve_context("plugin:proj/foam-demo/st-1", wsl_case="cfddesk-pf-x-0a1b2c3d", run_id="pf-0a1b2c3d", app="pimpleFoam", n_procs=2)
    assert c is not None and (c.owner, c.plugin, c.study_id, c.simulation_id, c.n_procs) == ("plugin", "foam-demo", "st-1", None, 2)


def test_hook_names():
    assert hook_names("solve.stop,solve.prepare,case.write, solve.parse_line") == ["solve.prepare", "solve.parse_line", "solve.stop"]
    assert hook_names("") == [] and hook_names(None) == []


# ---------------------------------------------------------------------------
# The runner (in process, a fake event stream)
# ---------------------------------------------------------------------------


def test_prepare_and_parse_line_fire_with_ctx_in_batches():
    bus = get_hooks()
    got: dict[str, Any] = {"prepare": [], "batches": []}
    bus.on("solve.prepare", lambda *, ctx, **kw: got["prepare"].append(ctx), plugin="p")
    bus.on("solve.parse_line", lambda *, ctx, lines, events, dropped, **kw: got["batches"].append((ctx, list(lines), list(events), dropped)), plugin="p")
    s, buf = sink()
    c = ctx()
    runner = HookRunner(c, ["solve.prepare", "solve.parse_line"], sink=s, loader=lambda: None)
    assert runner.start() is s
    assert runner.wait_ready(5)
    assert got["prepare"] == [c]
    from cfddesk.jobs.events import Event

    for i in range(600):
        runner.feed(f"line {i}", [Event("progress", {"time": i})] if i % 100 == 0 else [])
    runner.close(join=5)
    lines = [ln for _c, batch, _e, _d in got["batches"] for ln in batch]
    assert lines == [f"line {i}" for i in range(600)]
    assert all(len(batch) <= 256 for _c, batch, _e, _d in got["batches"]) and len(got["batches"]) >= 3
    assert all(cc is c for cc, *_ in got["batches"])
    events = [e for *_x, evs, _d in got["batches"] for e in evs]
    assert [e["time"] for e in events] == [0, 100, 200, 300, 400, 500]
    assert buf.getvalue() == ""


def test_a_full_queue_counts_dropped_lines_and_never_waits():
    bus = get_hooks()
    gate = threading.Event()
    batches: list[tuple[int, int]] = []
    bus.on("solve.parse_line", lambda *, lines, dropped, **kw: batches.append((len(lines), dropped)), plugin="p")
    s, _buf = sink()
    runner = HookRunner(ctx(), ["solve.parse_line"], sink=s, loader=gate.wait, queue_max=10)
    runner.start()
    feeder = threading.Thread(target=lambda: [runner.feed(f"l{i}") for i in range(25)], daemon=True)
    feeder.start()
    feeder.join(2.0)
    alive = feeder.is_alive()
    gate.set()
    assert not alive, "the read loop waited on the hooks"
    assert wait_for(lambda: sum(n for n, _ in batches) == 10)
    runner.close(join=2)
    assert sum(d for _n, d in batches) == 15


def test_a_slow_listener_is_dropped_after_three_strikes():
    bus = get_hooks()
    fast: list[int] = []
    slow_calls: list[int] = []

    def slow(**kw: Any) -> None:
        slow_calls.append(1)
        time.sleep(0.05)

    bus.on("solve.parse_line", slow, plugin="slow-one")
    bus.on("solve.parse_line", lambda *, lines, **kw: fast.append(len(lines)), plugin="fast-one")
    s, buf = sink()
    runner = HookRunner(ctx(), ["solve.parse_line"], sink=s, loader=lambda: None, strike_seconds=0.01, batch_seconds=0.01, batch_lines=1)
    runner.start()
    runner.wait_ready(5)
    for i in range(8):
        runner.feed(f"l{i}")
        time.sleep(0.03)
    runner.close(join=5)
    assert len(slow_calls) == 3
    assert sum(fast) == 8
    logged = [e["line"] for e in lines_of(buf)]
    assert any("slow-one solve.parse_line is off for this run" in line for line in logged)
    assert runner.dropped_listeners and runner.dropped_listeners[0][0] == "slow-one"


def test_a_raising_listener_is_dropped_at_once():
    bus = get_hooks()
    calls: list[int] = []
    other: list[int] = []

    def bad(**kw: Any) -> None:
        calls.append(1)
        raise ValueError("listener bug")

    bus.on("solve.parse_line", bad, plugin="bad-one")
    bus.on("solve.parse_line", lambda *, lines, **kw: other.append(len(lines)), plugin="ok-one")
    s, buf = sink()
    runner = HookRunner(ctx(), ["solve.parse_line"], sink=s, loader=lambda: None, batch_lines=1, batch_seconds=0.01)
    runner.start()
    runner.wait_ready(5)
    for i in range(5):
        runner.feed(f"l{i}")
    runner.close(join=5)
    assert calls == [1] and sum(other) == 5
    assert any("bad-one solve.parse_line is off for this run: it raised: listener bug" in e["line"] for e in lines_of(buf))


def test_a_load_failure_turns_hooks_off_and_the_run_goes_on():
    def broken() -> None:
        raise RuntimeError("a plugin broke the import")

    s, buf = sink()
    runner = HookRunner(ctx(), ["solve.prepare", "solve.parse_line", "solve.stop"], sink=s, loader=broken)
    runner.start()
    assert runner.wait_ready(5)
    assert not runner.loaded
    for i in range(10):
        runner.feed(f"l{i}")
    runner.stop_notice(forced=True, join=1)
    runner.close(join=1)
    logged = lines_of(buf)
    assert len(logged) == 1
    assert logged[0]["line"].startswith("[hook] solve hooks are off for this run: the plugins could not be loaded")


def test_no_names_loads_nothing(monkeypatch: pytest.MonkeyPatch):
    loads: list[int] = []
    isolated: list[int] = []
    monkeypatch.setattr(solve_hooks, "isolate_output", lambda: isolated.append(1))
    runner = HookRunner(ctx(), [], loader=lambda: loads.append(1))
    assert runner.start() is None
    runner.feed("x")
    runner.stop_notice(True, join=0.1)
    runner.close()
    assert loads == [] and isolated == []
    # A bad owner (no context) is the same: hooks off for the run.
    runner = HookRunner(None, ["solve.prepare"], loader=lambda: loads.append(1))
    runner.start()
    assert loads == [] and isolated == []


def test_the_wait_for_prepare_is_bounded():
    bus = get_hooks()
    bus.on("solve.prepare", lambda **kw: time.sleep(2.0), plugin="slow-prepare")
    s, _buf = sink()
    runner = HookRunner(ctx("plugin"), ["solve.prepare"], sink=s, loader=lambda: None)
    runner.start()
    t0 = time.monotonic()
    assert runner.wait_ready(0.3) is False
    assert time.monotonic() - t0 < 1.0
    assert solve_hooks.PREPARE_WAIT_SECONDS == 5.0


def test_stop_fires_after_the_action_with_forced_and_is_joined():
    bus = get_hooks()
    seen: list[tuple[str, bool]] = []

    def takes_a_while(*, ctx: Any, forced: bool, **kw: Any) -> None:
        time.sleep(0.2)
        seen.append((ctx.owner, forced))

    bus.on("solve.stop", takes_a_while, plugin="p")
    bus.on("solve.stop", lambda **kw: time.sleep(3), plugin="slow")
    s, _buf = sink()
    runner = HookRunner(ctx(), ["solve.stop"], sink=s, loader=lambda: None)
    runner.start()
    t0 = time.monotonic()
    runner.stop_notice(forced=True, join=0.5)
    # Joined: the listener that takes 0.2 s has run when stop_notice returns; the slow one is cut off at 0.5 s.
    assert seen == [("core", True)]
    assert time.monotonic() - t0 < 1.5


def test_the_hook_output_writer():
    s, buf = sink()
    out = HookOutput(s)
    out.write("one\ntw")
    out.write("o\n" + "x" * 900 + "\n")
    out.write('MAGNUSIM_EVENT {"event":"result","ok":true}\n')
    out.flush()
    got = lines_of(buf)
    assert [g["event"] for g in got] == ["log"] * 4
    assert got[0]["line"] == "[hook] one" and got[1]["line"] == "[hook] two"
    assert len(got[2]["line"]) == 500
    assert got[3]["line"] == '[hook] MAGNUSIM_EVENT {"event":"result","ok":true}'
    assert hook_log_line("x").endswith("\n")


# ---------------------------------------------------------------------------
# run_solve and stop_solve (in process)
# ---------------------------------------------------------------------------


class FakeSolve:
    def __init__(self, lines: list[str]) -> None:
        self.stdout = iter([ln + "\n" for ln in lines])
        self.pid = 1

    def wait(self) -> int:
        return 0


def test_core_run_solve_does_not_wait_for_solve_prepare(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    import run_solve

    s, buf = sink()
    monkeypatch.setattr(solve_hooks, "isolate_output", lambda: s)
    release = threading.Event()
    monkeypatch.setattr(solve_hooks, "_load_plugins", release.wait)
    started: list[float] = []

    def fake_start(case_dir: Path, **kw: Any) -> FakeSolve:
        started.append(time.monotonic())
        return FakeSolve(['MAGNUSIM_EVENT {"event":"stage","stage":"solve"}', "Time = 1", 'MAGNUSIM_EVENT {"event":"result","ok":true,"exit_code":0}'])

    monkeypatch.setattr(run_solve, "start_solve", fake_start)
    t0 = time.monotonic()
    code = run_solve.main(
        ["--case-dir", str(tmp_path), "--wsl-case", "cfddesk-w27-run-1", "--app", "pimpleFoam", "--run-id", "run-1",
         "--owner", "core:proj/sim-1", "--hooks", "solve.prepare,solve.parse_line"]
    )
    release.set()
    assert code == 0
    assert started and started[0] - t0 < 1.0
    kinds = [e["event"] for e in lines_of(buf)]
    assert kinds[:2] == ["stage", "progress"] and "result" in kinds


def test_run_solve_without_hooks_loads_nothing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys):
    import run_solve

    def no(*a: Any, **k: Any) -> None:
        raise AssertionError("no hook may load")

    monkeypatch.setattr(solve_hooks, "isolate_output", no)
    monkeypatch.setattr(solve_hooks, "_load_plugins", no)
    monkeypatch.setattr(run_solve, "start_solve", lambda case_dir, **kw: FakeSolve(["Time = 1"]))
    code = run_solve.main(["--case-dir", str(tmp_path), "--wsl-case", "cfddesk-w27-run-1", "--app", "pimpleFoam", "--owner", "core:proj/sim-1"])
    assert code == 0
    assert '"event":"progress"' in capsys.readouterr().out
    # Hooks asked for, but the owner is bad: off for the run.
    code = run_solve.main(["--case-dir", str(tmp_path), "--wsl-case", "cfddesk-w27-run-1", "--app", "pimpleFoam",
                           "--owner", "core:..", "--hooks", "solve.parse_line"])
    assert code == 0


def test_stop_solve_fires_solve_stop_after_the_action_and_never_on_probe(monkeypatch: pytest.MonkeyPatch, capsys):
    import stop_solve

    s, buf = sink()
    monkeypatch.setattr(solve_hooks, "isolate_output", lambda: s)
    monkeypatch.setattr(solve_hooks, "_load_plugins", lambda: None)
    order: list[str] = []
    monkeypatch.setattr(stop_solve, "stop_solve", lambda wsl_case, graceful=True: order.append("write_now"))
    monkeypatch.setattr(stop_solve, "kill_solve", lambda *a: order.append("kill"))
    monkeypatch.setattr(stop_solve, "solve_is_live", lambda *a: order.append("probe") or False)
    get_hooks().on("solve.stop", lambda *, ctx, forced, **kw: order.append(f"hook forced={forced} {ctx.owner} {ctx.app}"), plugin="p")
    args = ["--wsl-case", "cfddesk-w27-run-1", "--run-id", "run-1", "--owner", "core:proj/sim-1", "--hooks", "solve.stop",
            "--app", "pimpleFoam", "--case-dir", "C:/x", "--n-procs", "2"]
    assert stop_solve.main(args) == 0
    assert order == ["write_now", "hook forced=False core pimpleFoam"]
    assert json.loads(buf.getvalue().splitlines()[0]) == {"ok": True, "wsl_case": "cfddesk-w27-run-1", "forced": False}
    order.clear()
    assert stop_solve.main([*args, "--force"]) == 0
    assert order == ["kill", "hook forced=True core pimpleFoam"]
    order.clear()

    def no(*a: Any, **k: Any) -> None:
        raise AssertionError("a probe never loads hooks")

    monkeypatch.setattr(solve_hooks, "isolate_output", no)
    monkeypatch.setattr(solve_hooks, "_load_plugins", no)
    assert stop_solve.main([*args, "--probe"]) == 0
    assert order == ["probe"]
    assert json.loads(capsys.readouterr().out) == {"ok": True, "live": False, "wsl_case": "cfddesk-w27-run-1"}


def test_the_relay_waits_at_most_its_bound_for_solve_prepare(tmp_path: Path):
    from test_h15_relay import Recorder, make_run, make_spec, run

    class SlowPrepare:
        def __init__(self) -> None:
            self.events: LineSink | None = None
            self.fed = 0

        def start(self) -> Any:
            self.events, self.buf = sink()
            return self.events

        def wait_ready(self, timeout: float) -> bool:
            self.waited = timeout
            time.sleep(timeout)
            return False

        def feed(self, line: str, events: Any = ()) -> None:
            self.fed += 1

        def stop_notice(self, forced: bool) -> None:
            pass

        def close(self, join: float = 2.0) -> None:
            pass

    runner = SlowPrepare()
    r = make_run(tmp_path)
    rec = Recorder()
    t0 = time.monotonic()
    spec = make_spec(r, owner="plugin:proj/foam-demo/st-1", hooks=["solve.prepare", "solve.parse_line"])
    code, _evs = run(spec, r.root, rec.deps(hook_runner=lambda c, names: runner, hook_wait=0.4))
    assert code == 0 and runner.waited == 0.4 and time.monotonic() - t0 < 10
    assert runner.fed >= 5
    # The relay's events went to the hook runner's stream.
    assert '"event":"relay_end"' in runner.buf.getvalue()


def test_a_plugin_case_fires_its_hooks_with_the_plugin_context(tmp_path: Path):
    from test_h15_relay import TOKEN, Recorder, make_run, make_spec, run

    seen: dict[str, Any] = {"prepare": [], "lines": [], "ctx": []}
    bus = get_hooks()
    bus.on("solve.prepare", lambda *, ctx, **kw: seen["prepare"].append(ctx), plugin="p")
    bus.on("solve.parse_line", lambda *, ctx, lines, **kw: (seen["lines"].extend(lines), seen["ctx"].append(ctx)), plugin="p")
    buf = io.StringIO()

    def factory(c: Any, names: list[str]) -> HookRunner:
        return HookRunner(c, names, sink=LineSink(buf), loader=lambda: None)

    r = make_run(tmp_path)
    spec = make_spec(r, owner="plugin:proj/foam-demo/st-1", hooks=["solve.prepare", "solve.parse_line"])
    code, _ = run(spec, r.root, Recorder().deps(hook_runner=factory))
    assert code == 0
    c = seen["prepare"][0]
    assert (c.owner, c.project_id, c.plugin, c.study_id, c.run_id, c.app) == ("plugin", "proj", "foam-demo", "st-1", f"pf-{TOKEN}", "pimpleFoam")
    assert c.wsl_case.endswith(TOKEN) and c.case_dir == str(r.case)
    assert "Time = 0.005" in seen["lines"] and all(x is c for x in seen["ctx"])
    # The relay's events went to the private stream.
    assert '"event":"relay_end"' in buf.getvalue()
    # An owner that is not this case's plugin: hooks off for the run.
    reset_for_tests()
    got: list[str] = []
    get_hooks().on("solve.parse_line", lambda *, lines, **kw: got.extend(lines), plugin="p")
    r2 = make_run(tmp_path / "other")
    spec = make_spec(r2, owner="plugin:proj/other-plugin/st-1", hooks=["solve.parse_line"])
    code, _ = run(spec, r2.root, Recorder().deps(hook_runner=factory))
    assert code == 0 and got == []


# ---------------------------------------------------------------------------
# Isolation, end to end (a real process, the fixture plugins)
# ---------------------------------------------------------------------------

LOG = "\n".join(
    [
        'MAGNUSIM_EVENT {"event":"stage","stage":"solve","app":"pimpleFoam"}',
        "Time = 0.005",
        "smoothSolver:  Solving for Ux, Initial residual = 1, Final residual = 1e-06, No Iterations 3",
        "DICPCG:  Solving for p, Initial residual = 1, Final residual = 1e-06, No Iterations 9",
        "Time = 0.01",
        "smoothSolver:  Solving for Ux, Initial residual = 0.5, Final residual = 1e-06, No Iterations 3",
    ]
)


def _parse_log_run(tmp_path: Path, mode: str, hooks: str = "solve.prepare,solve.parse_line") -> tuple[subprocess.CompletedProcess, list[dict[str, Any]]]:
    plugins = tmp_path / "plugins"
    if not plugins.exists():
        shutil.copytree(FIXTURES / "hook-plugins", plugins)
    log = tmp_path / "log.pimpleFoam"
    log.write_text(LOG + "\n", encoding="utf-8")
    hook_log = tmp_path / f"hooks-{mode or 'plain'}.jsonl"
    env = dict(os.environ, MAGNUSIM_PLUGINS_DIR=str(plugins), HOOK_DEMO_MODE=mode, HOOK_DEMO_LOG=str(hook_log),
               MAGNUSIM_LOCAL_JSON=str(tmp_path / "local.json"), PYTHONIOENCODING="utf-8")
    args = [sys.executable, str(RUN_SOLVE), "--parse-log", str(log), "--owner", "core:proj/sim-1"]
    if hooks:
        args += ["--hooks", hooks]
    r = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", env=env, timeout=120)
    entries = [json.loads(x) for x in hook_log.read_text(encoding="utf-8").splitlines()] if hook_log.is_file() else []
    return r, entries


def test_isolated_output_end_to_end(tmp_path: Path):
    """gate:h15-hooks-isolated: a listener that prints, writes to fd 1 and fd 2 and
    forges an event line changes nothing in the event stream."""
    r, entries = _parse_log_run(tmp_path, "print")
    assert r.returncode == 0, r.stderr
    out_lines = [ln for ln in r.stdout.splitlines() if ln.strip()]
    events = []
    for line in out_lines:
        assert line.startswith("MAGNUSIM_EVENT "), line
        events.append(json.loads(line[len("MAGNUSIM_EVENT "):]))
    assert not any(e.get("forged") for e in events)
    assert "forged" not in r.stderr
    hook_lines = [e["line"] for e in events if e["event"] == "log" and e["line"].startswith("[hook]")]
    assert "[hook] hook-demo prints a line" in hook_lines and "[hook] hook-demo writes to stderr" in hook_lines
    kinds = [e["event"] for e in events]
    assert kinds.count("progress") == 2 and kinds.count("residual") == 3
    assert [k for k in kinds if k != "log"][-1] == "result"
    # gate:h15-hooks-fired: both hooks fired with the core context.
    assert entries[0] == {"hook": "solve.prepare", "owner": "core", "wsl_case": ""}
    parsed = [ln for e in entries if e["hook"] == "solve.parse_line" for ln in e["lines"]]
    assert parsed == LOG.splitlines()
    assert {"progress", "residual"} <= {k for e in entries if e["hook"] == "solve.parse_line" for k in e["events"]}


def test_a_raising_listener_never_breaks_the_run_end_to_end(tmp_path: Path):
    r, entries = _parse_log_run(tmp_path, "raise_parse")
    assert r.returncode == 0, r.stderr
    events = [json.loads(ln[len("MAGNUSIM_EVENT "):]) for ln in r.stdout.splitlines() if ln.strip()]
    assert [e["event"] for e in events].count("progress") == 2
    assert any("hook-demo solve.parse_line is off for this run: it raised" in e.get("line", "") for e in events)
    assert [e["hook"] for e in entries] == ["solve.prepare"]


def test_without_hook_names_nothing_loads_end_to_end(tmp_path: Path):
    r, entries = _parse_log_run(tmp_path, "print", hooks="")
    assert r.returncode == 0
    assert entries == []
    assert "[hook]" not in r.stdout
