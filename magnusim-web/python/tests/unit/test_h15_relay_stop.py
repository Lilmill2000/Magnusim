"""H15: the relay's stop controller (stop by stage, sticky, timers, levels).

Fake stage feed, fake tools and a fake clock; one real prepare step stopped
through its marker.
"""

from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import psutil
import pytest

from cfddesk.wsl import foam_relay
from cfddesk.wsl.foam_relay import StopController, read_marker_level, stage_class

SCRIPTS = ["foam-pre-0a1b2c3d.sh", "solve-pf-0a1b2c3d.sh"]
CASE_ID = "cfddesk-pf-foam-demo-st-1-0a1b2c3d"


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


class Tools:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.records: list[dict[str, Any]] = []
        self.notified: list[bool] = []
        self.reached = True
        self.pid: int | None = None

    def kill_case(self, wsl_case: str, scripts: list[str], *, names: list[str] | None = None, root: str | None = None) -> None:
        self.calls.append(("kill_case", {"case": wsl_case, "scripts": list(scripts), "names": names, "root": root}))

    def write_now(self, wsl_case: str, *, graceful: bool = True) -> None:
        self.calls.append(("write_now", {"case": wsl_case, "graceful": graceful}))

    def kill_prepare(self, pid: int) -> None:
        self.calls.append(("kill_prepare", pid))


def controller(tmp_path: Path, tools: Tools, clock: Clock, *, strategy: str = "stopAt_writeNow") -> StopController:
    return StopController(
        marker=tmp_path / ".magnusim-stop",
        wsl_case=CASE_ID,
        scripts=SCRIPTS,
        process_names=["pimpleFoam"],
        stop_strategy=strategy,
        root="/tmp/r/cases",
        kill_case=tools.kill_case,
        write_now=tools.write_now,
        kill_prepare=tools.kill_prepare,
        prepare_pid=lambda: tools.pid,
        wsl_reached=lambda: tools.reached,
        on_change=tools.records.append,
        notify=tools.notified.append,
        clock=clock,
    )


def mark(tmp_path: Path, level: str = "graceful") -> None:
    (tmp_path / ".magnusim-stop").write_text(json.dumps({"level": level, "seq": 1, "at": "t", "by": "user"}), encoding="utf-8")


def names(tools: Tools) -> list[str]:
    return [n for n, _ in tools.calls]


def test_no_marker_no_action(tmp_path: Path):
    tools, clock = Tools(), Clock()
    c = controller(tmp_path, tools, clock)
    for stage in (None, "prepare", "pre", "solve", "copy"):
        c.set_stage(stage)
        assert c.tick() == []
    assert tools.calls == [] and c.record() is None


def test_stage_classes():
    assert stage_class("prepare") == "prepare"
    for s in (None, "", "pre_copy_in", "pre", "pre_copy_back", "pre_done", "copy_to_wsl", "decompose", "decompose_end"):
        assert stage_class(s) == "before", s
    assert stage_class("solve") == "solve"
    for s in ("reconstruct", "solve_end", "copy", "cleanup"):
        assert stage_class(s) == "after", s


def test_prepare_any_level_ends_its_tree(tmp_path: Path):
    tools, clock = Tools(), Clock()
    c = controller(tmp_path, tools, clock)
    c.set_stage("prepare")
    mark(tmp_path, "graceful")
    # Not started yet: nothing, and the next tick looks again.
    assert c.tick() == []
    tools.pid = 4321
    assert c.tick() == ["kill_prepare"]
    assert tools.calls == [("kill_prepare", 4321)]
    assert c.tick() == []  # once per stage and level
    assert tools.notified == [True]


def test_before_the_solve_kills_the_case_at_once_once_wsl_is_reached(tmp_path: Path):
    tools, clock = Tools(), Clock()
    tools.reached = False
    c = controller(tmp_path, tools, clock)
    mark(tmp_path)
    c.set_stage(None)
    assert c.tick() == []  # nothing in WSL yet
    tools.reached = True
    c.set_stage("pre_copy_in")
    assert c.tick() == ["kill_case"]
    assert tools.calls[-1] == ("kill_case", {"case": CASE_ID, "scripts": SCRIPTS, "names": None, "root": "/tmp/r/cases"})
    assert c.tick() == []
    # Sticky: every new stage applies the rule again while the marker is there.
    c.set_stage("copy_to_wsl")
    assert c.tick() == ["kill_case"]
    assert names(tools) == ["kill_case", "kill_case"]


def test_solve_graceful_writes_now_then_kills_the_solver_after_20_s(tmp_path: Path):
    tools, clock = Tools(), Clock()
    c = controller(tmp_path, tools, clock)
    c.set_stage("solve")
    mark(tmp_path)
    assert c.tick() == ["write_now"]
    assert tools.calls == [("write_now", {"case": CASE_ID, "graceful": True})]
    clock.t += 19.0
    assert c.tick() == []
    clock.t += 1.5
    assert c.tick() == ["kill_solver"]
    assert tools.calls[-1] == ("kill_case", {"case": CASE_ID, "scripts": [], "names": ["pimpleFoam", "mpirun"], "root": "/tmp/r/cases"})
    assert c.level == "solver"
    assert tools.notified == [False, True]
    rec = tools.records[-1]
    assert rec["level"] == "solver"
    assert [(a["level"], a["stage"], a["action"]) for a in rec["applied"]] == [
        ("graceful", "solve", "write_now"),
        ("solver", "solve", "kill_solver"),
    ]


def test_solve_with_another_strategy_kills_the_solver_at_once(tmp_path: Path):
    tools, clock = Tools(), Clock()
    c = controller(tmp_path, tools, clock, strategy="sigterm")
    c.set_stage("solve")
    mark(tmp_path)
    assert c.tick() == ["kill_solver"]
    assert "write_now" not in names(tools)


def test_level_solver_from_the_marker(tmp_path: Path):
    tools, clock = Tools(), Clock()
    c = controller(tmp_path, tools, clock)
    c.set_stage("solve")
    mark(tmp_path, "solver")
    assert c.tick() == ["kill_solver"]


def test_after_the_solve_waits_120_s_then_ends_everything(tmp_path: Path):
    tools, clock = Tools(), Clock()
    c = controller(tmp_path, tools, clock)
    c.set_stage("reconstruct")
    mark(tmp_path)
    assert c.tick() == ["wait"]
    assert tools.calls == [] and tools.notified == []
    c.set_stage("copy")
    assert c.tick() == ["wait"]
    clock.t += 119.0
    assert c.tick() == []
    clock.t += 2.0
    assert c.tick() == ["kill_case"]
    assert c.level == "all"
    assert tools.calls[-1][1]["scripts"] == SCRIPTS


def test_all_at_any_stage(tmp_path: Path):
    for stage in ("pre", "solve", "copy", "cleanup"):
        tools, clock = Tools(), Clock()
        c = controller(tmp_path, tools, clock)
        c.set_stage(stage)
        mark(tmp_path, "all")
        assert c.tick() == ["kill_case"], stage
        assert tools.calls[0][1]["scripts"] == SCRIPTS and tools.calls[0][1]["names"] is None


def test_levels_only_go_up(tmp_path: Path):
    tools, clock = Tools(), Clock()
    c = controller(tmp_path, tools, clock)
    c.set_stage("solve")
    mark(tmp_path, "all")
    c.tick()
    mark(tmp_path, "graceful")
    c.tick()
    assert c.level == "all"
    assert "write_now" not in names(tools)


def test_marker_levels(tmp_path: Path):
    path = tmp_path / ".magnusim-stop"
    assert read_marker_level(path) is None
    path.write_text("not json", encoding="utf-8")
    assert read_marker_level(path) == "graceful"
    path.write_text(json.dumps({"level": "nonsense"}), encoding="utf-8")
    assert read_marker_level(path) == "graceful"
    path.write_text(json.dumps({"level": "all"}), encoding="utf-8")
    assert read_marker_level(path) == "all"


def test_the_marker_gone_stops_new_actions(tmp_path: Path):
    tools, clock = Tools(), Clock()
    c = controller(tmp_path, tools, clock)
    c.set_stage("solve")
    mark(tmp_path)
    c.tick()
    (tmp_path / ".magnusim-stop").unlink()
    clock.t += 60
    c.set_stage("copy")
    assert c.tick() == []


def test_a_failing_action_or_callback_never_stops_the_controller(tmp_path: Path):
    tools, clock = Tools(), Clock()

    def boom(*a: Any, **k: Any) -> None:
        raise RuntimeError("wsl is gone")

    c = controller(tmp_path, tools, clock)
    c._kill_case = boom  # type: ignore[method-assign]
    c._notify = boom  # type: ignore[assignment]
    c.set_stage("pre")
    mark(tmp_path, "all")
    assert c.tick() == ["kill_case"]
    assert tools.records[-1]["applied"][-1]["action"] == "kill_case"


def test_the_controller_never_matches_by_prefix():
    """kill_solve, kill_mpirun_tree and solve_is_live match by prefix (run1 hits run10)."""
    src = Path(foam_relay.__file__).read_text(encoding="utf-8")
    tree = ast.parse(src)
    used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)} | {
        n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)
    } | {a.name for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) for a in n.names}
    assert not used & {"kill_solve", "kill_mpirun_tree", "solve_is_live"}


def test_the_thread_applies_a_new_stage_at_once(tmp_path: Path):
    tools = Tools()
    c = controller(tmp_path, tools, Clock())
    c.every = 30.0  # only a stage change can wake it within the test
    mark(tmp_path, "all")
    c.start()
    try:
        c.set_stage("pre")
        deadline = time.time() + 5
        while time.time() < deadline and not tools.calls:
            time.sleep(0.02)
    finally:
        c.stop()
    assert names(tools) == ["kill_case"]


# ---------------------------------------------------------------------------
# A real prepare step stopped through its marker
# ---------------------------------------------------------------------------

TREE_TOOL = """import json, os, subprocess, sys, time
from pathlib import Path
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
Path(os.environ['MAGNUSIM_CASE_DIR'], 'child.pid').write_text(str(child.pid))
print('MAGNUSIM_EVENT ' + json.dumps({'event': 'stage', 'stage': 'sleeping'}), flush=True)
time.sleep(120)
"""


def test_a_stop_during_the_prepare_step_ends_its_tree(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    # The relay sets these in this process for itself and its children: give them back after the test,
    # or a later relay_ctl kill by job id would also end this pytest process.
    for name in ("MAGNUSIM_JOB_ID", "MAGNUSIM_WSL_CASE_ROOT", "MAGNUSIM_WSL_DISTRO"):
        monkeypatch.setenv(name, os.environ.get(name, ""))
    from test_h15_relay import (
        FakeHub,
        Recorder,
        make_package,
        make_run,
        make_spec,
        prepare_spec,
        run,
    )

    r = make_run(tmp_path, cavity=False)
    pkg = make_package(tmp_path, TREE_TOOL)
    rec = Recorder()
    marker = r.case / ".magnusim-stop"
    spec = make_spec(r, prepare=prepare_spec(r), solver=None)

    def stop_soon() -> None:
        deadline = time.time() + 30
        while time.time() < deadline and not (r.case / "child.pid").exists():
            time.sleep(0.05)
        marker.write_text(json.dumps({"level": "graceful", "seq": 1, "at": "t", "by": "user"}), encoding="utf-8")

    import threading

    threading.Thread(target=stop_soon, daemon=True).start()
    t0 = time.time()
    code, evs = run(spec, r.root, rec.deps(popen=subprocess.Popen, registry_loader=lambda: FakeHub(pkg), stop_every=0.1))
    assert time.time() - t0 < 30
    assert code == 130
    assert evs[-1]["outcome"] == {"ok": False, "stopped": True, "phase": "prepare"}
    assert evs[-1]["clean"] is True
    child = int((r.case / "child.pid").read_text(encoding="utf-8"))
    deadline = time.time() + 10
    while time.time() < deadline and psutil.pid_exists(child):
        try:
            if psutil.Process(child).status() == psutil.STATUS_ZOMBIE:
                break
        except psutil.NoSuchProcess:
            break
        time.sleep(0.1)
    alive = psutil.pid_exists(child)
    if alive:
        try:
            alive = psutil.Process(child).cmdline()[-1:] == ["import time; time.sleep(120)"]
        except psutil.Error:
            alive = False
    assert not alive, "the prepare tool's child outlived the stop"
    st = json.loads((r.case / ".magnusim-run.json").read_text(encoding="utf-8"))
    assert st["stop"]["applied"][0]["action"] == "kill_prepare"
    assert not any(c[0] == "wsl" for n, c in rec.calls if n == "popen")


def test_kill_process_tree_ends_children(tmp_path: Path):
    parent = subprocess.Popen(
        [sys.executable, "-c", TREE_TOOL.replace("os.environ['MAGNUSIM_CASE_DIR']", repr(str(tmp_path)))],
        stdout=subprocess.DEVNULL,
    )
    deadline = time.time() + 20
    while time.time() < deadline and not (tmp_path / "child.pid").exists():
        time.sleep(0.05)
    child = int((tmp_path / "child.pid").read_text(encoding="utf-8"))
    assert foam_relay.kill_process_tree(parent.pid, wait=2.0) >= 2
    parent.wait(10)
    assert not psutil.pid_exists(child) or psutil.Process(child).status() == psutil.STATUS_ZOMBIE
    assert foam_relay.kill_process_tree(parent.pid) == 0
