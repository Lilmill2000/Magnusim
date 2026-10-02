"""H15: relay control by identity (tools/foam_relay_ctl.py), never by a kept pid."""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import time
from typing import Any

import foam_relay_ctl
import psutil

JOB = "fc-abc123-0a1b2c"
OTHER = "fc-zzz999-ffffff"


class AccessDeniedError(Exception):
    pass


class NoSuchProcessError(Exception):
    pass


class ZombieProcessError(Exception):
    pass


class FakeProc:
    def __init__(self, pid: int, cmdline: list[str], env: Any = None, children: list[FakeProc] | None = None) -> None:
        self.pid = pid
        self.info = {"pid": pid, "cmdline": cmdline}
        self._env = env if env is not None else {}
        self._children = children or []
        self.terminated = False
        self.killed = False
        self.stubborn = False

    def environ(self) -> dict[str, str]:
        if isinstance(self._env, Exception):
            raise self._env
        return self._env

    def children(self, recursive: bool = False) -> list[FakeProc]:
        out: list[FakeProc] = []
        for c in self._children:
            out.append(c)
            if recursive:
                out += c.children(recursive=True)
        return out

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.killed = True


class FakePsutil:
    AccessDenied = AccessDeniedError
    NoSuchProcess = NoSuchProcessError
    ZombieProcess = ZombieProcessError

    def __init__(self, procs: list[FakeProc]) -> None:
        self.procs = procs

    def process_iter(self, attrs: list[str]) -> list[FakeProc]:
        return list(self.procs)

    def wait_procs(self, procs: list[FakeProc], timeout: float) -> tuple[list[FakeProc], list[FakeProc]]:
        alive = [p for p in procs if p.stubborn]
        return [p for p in procs if not p.stubborn], alive


def relay_cmd(job: str, launcher: bool = False) -> list[str]:
    exe = r"C:\app\python\.venv\Scripts\python.exe" if launcher else r"C:\Python310\python.exe"
    return [exe, r"C:\app\python\tools\run_foam_case.py", "--spec", rf"C:\app\.cache\foam-specs\{job}.json"]


def test_matches_the_relay_by_its_command_line():
    launcher = FakeProc(10, relay_cmd(JOB, launcher=True))
    real = FakeProc(11, relay_cmd(JOB))
    other_job = FakeProc(12, relay_cmd(OTHER))
    # A pid Node once saw, now reused by another program: never matched.
    reused = FakeProc(13, ["notepad.exe", "C:/notes.txt"])
    # The job's spec named on a command line that is not the relay's.
    viewer = FakeProc(14, ["code.exe", rf"C:\app\.cache\foam-specs\{JOB}.json"])
    ps = FakePsutil([launcher, real, other_job, reused, viewer])
    assert foam_relay_ctl.alive(JOB, ps=ps) == {"ok": True, "alive": True, "pids": [10, 11]}
    assert foam_relay_ctl.alive("fc-nothin-000000", ps=ps) == {"ok": True, "alive": False, "pids": []}


def test_matches_what_the_relay_started_by_its_environment():
    tool = FakeProc(20, ["python.exe", "jobs/write_mesh_case.py"], env={"MAGNUSIM_JOB_ID": JOB})
    other = FakeProc(21, ["python.exe", "x.py"], env={"MAGNUSIM_JOB_ID": OTHER})
    hidden = FakeProc(22, ["svchost.exe"], env=AccessDeniedError("no"))
    gone = FakeProc(23, ["x.exe"], env=NoSuchProcessError("gone"))
    ps = FakePsutil([tool, other, hidden, gone])
    assert foam_relay_ctl.alive(JOB, ps=ps)["pids"] == [20]


def test_kill_ends_each_match_with_its_children():
    wsl = FakeProc(31, ["wsl.exe", "-d", "Ubuntu"])
    grand = FakeProc(33, ["bash.exe"])
    tool = FakeProc(32, ["python.exe", "tool.py"], children=[grand])
    relay = FakeProc(30, relay_cmd(JOB), children=[wsl, tool])
    bystander = FakeProc(40, ["notepad.exe"])
    tool.stubborn = True
    ps = FakePsutil([relay, tool, bystander])
    out = foam_relay_ctl.kill(JOB, ps=ps)
    # relay, wsl.exe, tool, its child: each once.
    assert out == {"ok": True, "killed": 4}
    assert relay.terminated and wsl.terminated and tool.terminated and grand.terminated
    assert tool.killed and not relay.killed
    assert not bystander.terminated


def test_the_command_line_rule():
    assert foam_relay_ctl.command_line_matches(relay_cmd(JOB), JOB)
    assert foam_relay_ctl.command_line_matches(["py", "tools/run_foam_case.py", "--launch", "--spec", f"a/foam-specs/{JOB}.json"], JOB)
    assert not foam_relay_ctl.command_line_matches(relay_cmd(JOB), OTHER)
    assert not foam_relay_ctl.command_line_matches(["py", "run_foam_case.py.bak", f"{JOB}.json"], JOB)
    assert not foam_relay_ctl.command_line_matches(["py", "run_foam_case.py", f"{JOB}.json.old"], JOB)
    assert not foam_relay_ctl.command_line_matches(None, JOB)


def test_the_cli_refuses_a_bad_job_id(capsys):
    assert foam_relay_ctl.main(["alive", "--job-id", "1234"]) == 2
    assert json.loads(capsys.readouterr().out) == {"ok": False, "error": "not a job id"}


def test_a_real_process_found_and_ended_by_its_environment():
    # A real kill ends every process on this PC that carries the id: one of its own per run.
    job = f"fc-{secrets.token_hex(4)}-{secrets.token_hex(3)}"
    env = dict(os.environ, MAGNUSIM_JOB_ID=job)
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], env=env)
    try:
        deadline = time.time() + 10
        found: dict[str, Any] = {}
        while time.time() < deadline:
            found = foam_relay_ctl.alive(job)
            if proc.pid in found["pids"]:
                break
            time.sleep(0.2)
        assert proc.pid in found["pids"]
        assert foam_relay_ctl.kill(job)["killed"] >= 1
        proc.wait(10)
        assert not psutil.pid_exists(proc.pid) or proc.poll() is not None
        assert proc.pid not in foam_relay_ctl.alive(job)["pids"]
    finally:
        if proc.poll() is None:
            proc.kill()
