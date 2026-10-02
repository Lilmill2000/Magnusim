"""H15: the foam relay (cfddesk.wsl.foam_relay, tools/run_foam_case.py), without WSL.

Every WSL call is a fake here; tests/wsl/test_foam_case_wsl.py runs the real thing.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from cfddesk.wsl import foam_relay
from cfddesk.wsl.foam_relay import (
    EventWriter,
    RefusalError,
    RelayDeps,
    StatusWriter,
    check_prepare_shape,
    clamp_ranks,
    parse_job_line,
    prepare_environment,
    resolve_prepare,
    run_relay,
)

PY_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = PY_ROOT / "tests" / "fixtures"
RUN_FOAM_CASE = PY_ROOT / "tools" / "run_foam_case.py"
TOKEN = "0a1b2c3d"
JOB = "fc-abc123-0a1b2c"
WSL_CASE = f"cfddesk-pf-foam-demo-st-1-{TOKEN}"
WSL_ROOT = "/tmp/magnusim-test/cases"
SOLVER = {
    "app": "pimpleFoam",
    "keep_frames": "all",
    "frame_fields": ["U", "p"],
    "process_names": ["pimpleFoam"],
    "stop_strategy": "stopAt_writeNow",
    "parallel": "mpirun",
}


def write_cavity(case: Path, **kw: Any) -> Path:
    from test_h15_foam_case import write_cavity as write

    return write(case, **kw)


def make_run(tmp_path: Path, *, cavity: bool = True) -> SimpleNamespace:
    root = tmp_path / "projects"
    proj = root / "proj"
    base = proj / "plugins" / "foam-demo"
    parts = ["studies", "st-1", "cases", "c1"]
    case = base.joinpath(*parts)
    case.mkdir(parents=True)
    (proj / "project.json").write_text("{}", encoding="utf-8")
    if cavity:
        write_cavity(case)
    specs = tmp_path / ".cache" / "foam-specs"
    specs.mkdir(parents=True)
    return SimpleNamespace(root=root, proj=proj, base=base, parts=parts, case=case, specs=specs, tmp=tmp_path)


def make_spec(run: SimpleNamespace, **over: Any) -> Path:
    doc: dict[str, Any] = {
        "v": 1,
        "kind": "foam",
        "job_id": JOB,
        "token": TOKEN,
        "project_id": "proj",
        "case_dir": str(run.case),
        "case_base": str(run.base),
        "case_parts": list(run.parts),
        "plugin": "foam-demo",
        "wsl_case": WSL_CASE,
        "wsl_root": WSL_ROOT,
        "n_procs": 1,
        "slots_hint": None,
        "prepare": None,
        "pre": [{"tool": "blockMesh"}],
        "solver": dict(SOLVER),
        "owner": None,
        "hooks": [],
    }
    doc.update(over)
    name = over.get("_file", f"{doc['job_id']}.json")
    doc.pop("_file", None)
    path = run.specs / name
    path.write_text(json.dumps(doc), encoding="utf-8")
    return path


class FakeProc:
    """A finished process: its output lines and exit code."""

    def __init__(self, lines: list[str], code: int = 0, *, binary: bool = True, pid: int = 4242) -> None:
        self.stdout = iter([(ln + "\n").encode("utf-8") if binary else ln + "\n" for ln in lines])
        self.returncode = code
        self.pid = pid

    def wait(self, timeout: float | None = None) -> int:
        return self.returncode


def evt(**fields: Any) -> str:
    return "MAGNUSIM_EVENT " + json.dumps(fields, separators=(",", ":"))


PRE_OK = [
    evt(event="stage", stage="pre_copy_in", t_wall=100.0),
    evt(event="pre", tool="blockMesh", index=1, exit_code=0, parallel=False, n_procs=1),
    evt(event="stage", stage="pre_copy_back", t_wall=101.0),
    evt(event="stage", stage="pre_done", t_wall=101.5),
    evt(event="result", ok=True, exit_code=0, t_wall=102.5),
]
SOLVE_OK = [
    evt(event="start", run_id=f"pf-{TOKEN}", dst="/tmp/x", n_procs=1, app="pimpleFoam"),
    evt(event="stage", stage="copy_to_wsl", t_wall=110.0),
    evt(event="stage", stage="solve", parallel=False, app="pimpleFoam", t_wall=111.0),
    "Time = 0.005",
    "DILUPBiCGStab:  Solving for Ux, Initial residual = 1, Final residual = 1e-06, No Iterations 3",
    evt(event="time_saved", t=0.1),
    evt(event="stage", stage="solve_end", exit_code=0, t_wall=112.0),
    evt(event="stage", stage="copy", t_wall=112.5),
    evt(event="stage", stage="cleanup", t_wall=113.0),
    evt(event="result", ok=True, exit_code=0, win_out="/mnt/c/x", t_wall=113.1),
]


class Recorder:
    """Fake WSL side of a relay run; records every call."""

    def __init__(self, *, pre: list[str] | None = None, pre_code: int = 0, solve: list[str] | None = None,
                 solve_code: int = 0, slots: int = 16, probes: list[dict[str, Any]] | None = None) -> None:
        self.calls: list[tuple[str, Any]] = []
        self.pre = PRE_OK if pre is None else pre
        self.pre_code = pre_code
        self.solve = SOLVE_OK if solve is None else solve
        self.solve_code = solve_code
        self.slots = slots
        self.probes = list(probes or [])
        self.real_popen = subprocess.Popen

    def popen(self, argv: list[str], **kw: Any) -> Any:
        self.calls.append(("popen", list(argv)))
        if argv[:1] == ["wsl"]:
            return FakeProc(self.pre, self.pre_code)
        return self.real_popen(argv, **kw)

    def start_solve(self, case: Path, **kw: Any) -> Any:
        self.calls.append(("start_solve", kw))
        return FakeProc(self.solve, self.solve_code, binary=False)

    def mpi_slots(self) -> int:
        self.calls.append(("mpi_slots", None))
        return self.slots

    def probe(self, wsl_case: str, scripts: list[str], *, root: str | None = None) -> dict[str, Any]:
        self.calls.append(("probe", (wsl_case, list(scripts), root)))
        return self.probes.pop(0) if self.probes else {"ok": True, "live": False}

    def kill_case(self, *a: Any, **kw: Any) -> dict[str, Any]:
        self.calls.append(("kill_case", (a, kw)))
        return {"ok": True, "killed": 0}

    def remove_case(self, wsl_case: str) -> bool:
        self.calls.append(("remove_case", wsl_case))
        return True

    def names(self) -> list[str]:
        return [name for name, _ in self.calls]

    def deps(self, **over: Any) -> RelayDeps:
        base: dict[str, Any] = {
            "popen": self.popen,
            "start_solve": self.start_solve,
            "kill_case": self.kill_case,
            "probe_case": self.probe,
            "write_now": lambda *a, **k: self.calls.append(("write_now", a)),
            "remove_case": self.remove_case,
            "mpi_slots": self.mpi_slots,
            "sleep": lambda s: None,
            "status_every": 0.05,
            "stop_every": 0.05,
        }
        base.update(over)
        return RelayDeps(**base)


def events(out: io.StringIO) -> list[dict[str, Any]]:
    return [ev for ev in (parse_job_line(line) for line in out.getvalue().splitlines()) if ev]


def run(spec: Path, root: Path, deps: RelayDeps) -> tuple[int, list[dict[str, Any]]]:
    out = io.StringIO()
    code = run_relay(spec, projects_root=root, out=out, deps=deps)
    return code, events(out)


def status(case: Path) -> dict[str, Any]:
    return json.loads((case / ".magnusim-run.json").read_text(encoding="utf-8"))


@pytest.fixture(autouse=True)
def _relay_env(monkeypatch: pytest.MonkeyPatch):
    # The relay sets these for itself and its children; keep them per test.
    monkeypatch.setenv("MAGNUSIM_JOB_ID", "")
    monkeypatch.setenv("MAGNUSIM_WSL_CASE_ROOT", WSL_ROOT)
    monkeypatch.setenv("MAGNUSIM_WSL_DISTRO", "Test-Distro")


def no_popen(*a: Any, **k: Any) -> Any:
    raise AssertionError("nothing may start before the gate passed")


# ---------------------------------------------------------------------------
# The gate
# ---------------------------------------------------------------------------


def _refused(code: int, evs: list[dict[str, Any]]) -> str:
    assert code == 2
    refused = [e for e in evs if e["event"] == "refused"]
    assert len(refused) == 1
    assert evs[-1]["event"] == "relay_end" and evs[-1]["exit_code"] == 2 and evs[-1]["clean"] is True
    assert evs[-1]["outcome"]["phase"] == "gate"
    return refused[0]["code"]


GATE_CASES = {
    "solver app not plain": ({"solver": {**SOLVER, "app": "simpleFoam; rm -rf ~"}}, "app_not_allowed"),
    "a field name": ({"solver": {**SOLVER, "frame_fields": ["U", "__p"]}}, "bad_request"),
    "a step flag": ({"pre": [{"tool": "blockMesh"}, {"tool": "createPatch", "args": ["-dict"]}]}, "pre_not_allowed"),
    "the WSL root with a quote": ({"wsl_root": "/home/it's/cases"}, "invalid_path"),
    "the WSL root relative": ({"wsl_root": "cases"}, "invalid_path"),
    "a bad token": ({"token": "nothex00"}, "invalid_spec"),
    "a case id of another token": ({"wsl_case": "cfddesk-pf-foam-demo-st-1-ffffffff"}, "invalid_spec"),
    "a core case id": ({"wsl_case": "cfddesk-w27-run-1"}, "invalid_spec"),
    "a job id that is not the file's": ({"job_id": "fc-zzz999-000000", "_file": f"{JOB}.json"}, "invalid_spec"),
    "an unknown kind": ({"kind": "solve"}, "invalid_spec"),
    "nothing to run": ({"pre": [], "solver": None}, "invalid_spec"),
    "hooks without a solver": ({"solver": None, "hooks": ["solve.parse_line"]}, "invalid_spec"),
    "n_procs too high": ({"n_procs": 65}, "invalid_spec"),
    "a prepare env name not in the list": ({"prepare": {"job": "x", "runtime": "core", "args": [], "env": {"PATH": "x"}}}, "invalid_spec"),
    "a prepare arg with NUL": ({"prepare": {"job": "x", "runtime": "core", "args": ["a\x00b"], "env": {}}}, "invalid_spec"),
    "an unknown plugin key": ({"plugin": "../x"}, "invalid_spec"),
}


@pytest.mark.parametrize("name", sorted(GATE_CASES))
def test_the_gate_refuses_before_anything_runs(tmp_path: Path, name: str):
    over, want = GATE_CASES[name]
    r = make_run(tmp_path)
    rec = Recorder()
    code, evs = run(make_spec(r, **over), r.root, rec.deps(popen=no_popen, start_solve=no_popen, mpi_slots=no_popen))
    assert _refused(code, evs) == want
    assert rec.calls == []
    assert not (r.case / ".magnusim-ran").exists()


def test_the_spec_file_must_be_the_hosts(tmp_path: Path):
    r = make_run(tmp_path)
    good = make_spec(r)
    other = tmp_path / "elsewhere"
    other.mkdir()
    moved = other / good.name
    moved.write_text(good.read_text(encoding="utf-8"), encoding="utf-8")
    code, evs = run(moved, r.root, Recorder().deps(popen=no_popen))
    assert _refused(code, evs) == "invalid_spec"
    renamed = r.specs / "spec.json"
    renamed.write_text(good.read_text(encoding="utf-8"), encoding="utf-8")
    code, evs = run(renamed, r.root, Recorder().deps(popen=no_popen))
    assert _refused(code, evs) == "invalid_spec"


def test_the_real_path_rule(tmp_path: Path):
    r = make_run(tmp_path)
    # case_base in another project.
    other = r.root / "other" / "plugins" / "foam-demo"
    other.mkdir(parents=True)
    code, evs = run(make_spec(r, case_base=str(other)), r.root, Recorder().deps(popen=no_popen))
    assert _refused(code, evs) == "invalid_path"
    # A plugin case outside that plugin's folder (another plugin's, same project).
    elsewhere = r.proj / "plugins" / "other-plugin"
    target = elsewhere.joinpath(*r.parts)
    write_cavity(target)
    code, evs = run(make_spec(r, case_base=str(elsewhere), case_dir=str(target)), r.root, Recorder().deps(popen=no_popen))
    assert _refused(code, evs) == "invalid_path"
    # The parts do not lead to the case.
    code, evs = run(make_spec(r, case_parts=["studies", "st-1", "cases", "c2"]), r.root, Recorder().deps(popen=no_popen))
    assert _refused(code, evs) == "invalid_path"
    # A missing case.
    code, evs = run(make_spec(r, case_dir=str(r.case.parent / "nope")), r.root, Recorder().deps(popen=no_popen))
    assert _refused(code, evs) == "not_found"


def test_a_plan_of_another_kind_must_lie_in_its_project(tmp_path: Path):
    # A step-list plan that is not a plugin case (a mesher's) has no own-plugin-folder
    # rule behind it: its case_base must still be inside <root>/<project_id>.
    r = make_run(tmp_path)
    elsewhere = tmp_path / "elsewhere" / "base"
    target = elsewhere.joinpath(*r.parts)
    write_cavity(target)
    rec = Recorder()
    spec = make_spec(r, kind="mesh", solver=None, case_base=str(elsewhere), case_dir=str(target))
    code, evs = run(spec, r.root, rec.deps(popen=no_popen, start_solve=no_popen, mpi_slots=no_popen))
    assert _refused(code, evs) == "invalid_path"
    assert [e["error"] for e in evs if e["event"] == "refused"] == ["The case folder is not in its project"]
    assert rec.calls == []
    assert not (target / ".magnusim-ran").exists()


def test_hooks_must_be_solve_hooks(tmp_path: Path):
    r = make_run(tmp_path)
    rec = Recorder()
    spec = make_spec(r, owner="plugin:proj/foam-demo/st-1", hooks=["solve.parse_line", "solve.bogus"])
    code, evs = run(spec, r.root, rec.deps(popen=no_popen, start_solve=no_popen, mpi_slots=no_popen))
    assert _refused(code, evs) == "invalid_spec"
    assert rec.calls == []


def test_a_junction_swapped_into_a_parent_is_refused(tmp_path: Path):
    from test_h15_foam_case import _junction

    r = make_run(tmp_path)
    # After Node's check, a parent folder becomes a junction to a copy elsewhere.
    studies = r.base / "studies"
    moved = tmp_path / "outside-studies"
    studies.rename(moved)
    _junction(moved, studies)
    code, evs = run(make_spec(r), r.root, Recorder().deps(popen=no_popen))
    assert _refused(code, evs) == "invalid_path"
    assert not (moved / "st-1" / "cases" / "c1" / ".magnusim-ran").exists()


def test_the_temp_folder_rule(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    r = make_run(tmp_path)
    for name in ("it's", "a$b"):
        temp = tmp_path / name
        temp.mkdir()
        monkeypatch.setattr(foam_relay.tempfile, "gettempdir", lambda t=temp: str(t))
        code, evs = run(make_spec(r), r.root, Recorder().deps(popen=no_popen))
        assert _refused(code, evs) == "invalid_path"
        refused = next(e for e in evs if e["event"] == "refused")
        assert refused["error"].startswith("The temp folder path has a character the WSL scripts cannot take:")


def test_a_refusal_writes_the_final_status_but_not_into_another_runs_folder(tmp_path: Path):
    r = make_run(tmp_path)
    code, _ = run(make_spec(r, pre=[{"tool": "createPatch", "args": ["-dict"]}]), r.root, Recorder().deps(popen=no_popen))
    assert code == 2
    st = status(r.case)
    assert st["outcome"]["phase"] == "gate" and st["outcome"]["code"] == "pre_not_allowed"
    assert st["clean"] is True and st["exit_code"] == 2
    (r.case / ".magnusim-run.json").unlink()
    # The folder already ran under another job: its status stays that run's.
    (r.case / ".magnusim-ran").write_text(json.dumps({"job_id": "fc-other1-000000"}), encoding="utf-8")
    code, evs = run(make_spec(r), r.root, Recorder().deps(popen=no_popen))
    assert _refused(code, evs) == "has_results"
    assert not (r.case / ".magnusim-run.json").exists()


# ---------------------------------------------------------------------------
# A whole run (fake WSL)
# ---------------------------------------------------------------------------


def test_a_whole_run(tmp_path: Path):
    r = make_run(tmp_path)
    rec = Recorder()
    code, evs = run(make_spec(r), r.root, rec.deps())
    assert code == 0
    kinds = [e["event"] for e in evs]
    # .magnusim-ran only after the gate, before anything ran.
    ran = json.loads((r.case / ".magnusim-ran").read_text(encoding="utf-8"))
    assert ran["job_id"] == JOB and ran["token"] == TOKEN
    # foam_pre.sh through wsl -e, no shell; its result renamed.
    wsl = [c for n, c in rec.calls if n == "popen"]
    assert len(wsl) == 1 and wsl[0][:4] == ["wsl", "-d", "Test-Distro", "-e"] and wsl[0][4] == "bash"
    assert wsl[0][5].endswith(f"/foam-pre-{TOKEN}.sh")
    assert "pre_result" in kinds and kinds.count("result") == 1
    assert {"event": "phase", "phase": "pre", "seconds": 2.5} in evs
    # The solver: start_solve, unchanged, with the run id the scripts are named after.
    (name, kw), = [c for c in rec.calls if c[0] == "start_solve"]
    assert kw["run_id"] == f"pf-{TOKEN}" and kw["wsl_case_id"] == WSL_CASE and kw["app"] == "pimpleFoam"
    assert kw["n_procs"] == 1 and kw["keep_frames"] == "all" and kw["frame_fields"] == ("U", "p")
    assert "progress" in kinds and "residual" in kinds
    # Nothing in parallel and one rank: no WSL call for ranks.
    assert "mpi_slots" not in rec.names()
    assert {"event": "ranks", "n_procs": 1} in evs
    end = evs[-1]
    assert end == {"event": "relay_end", "exit_code": 0, "clean": True, "outcome": {"ok": True, "phase": "solve", "exit_code": 0, "stopped": False}}
    st = status(r.case)
    assert st["outcome"]["ok"] is True and st["clean"] is True and st["exit_code"] == 0
    assert st["pre_ok"] and st["result_ok"] and st["cleanup_seen"] and st["wsl_reached"]
    assert st["saved"] == [0.1] and st["n_saved"] == 1 and st["n_steps"] == 1 and st["time"] == 0.005
    assert st["job_id"] == JOB and st["relay_pid"] == os.getpid() and st["stdout_lost"] is False
    # No probe: solve.sh's result was seen.
    assert "probe" not in rec.names()
    assert os.environ["MAGNUSIM_JOB_ID"] == JOB and os.environ["MAGNUSIM_WSL_CASE_ROOT"] == WSL_ROOT


def test_a_stopped_marker_before_the_start(tmp_path: Path):
    r = make_run(tmp_path)
    (r.case / ".magnusim-stop").write_text(json.dumps({"level": "graceful", "seq": 1, "at": "x", "by": "user"}), encoding="utf-8")
    rec = Recorder()
    code, evs = run(make_spec(r), r.root, rec.deps())
    assert code == 130
    assert evs[-1]["outcome"] == {"ok": False, "stopped": True, "phase": "start"} and evs[-1]["clean"] is True
    assert rec.calls == [] and not (r.case / ".magnusim-ran").exists()


def test_ranks(tmp_path: Path):
    assert clamp_ranks(8, 4, None) == 4
    assert clamp_ranks(8, 0, 3) == 3
    assert clamp_ranks(8, 0, None) == 8
    assert clamp_ranks(2, 16, 1) == 2
    plan = [{"tool": "blockMesh"}, {"tool": "decomposePar"}, {"tool": "renumberMesh", "parallel": True}, {"tool": "reconstructParMesh"}]
    r = make_run(tmp_path)
    rec = Recorder(slots=2)
    code, evs = run(make_spec(r, n_procs=4, pre=plan), r.root, rec.deps())
    assert code == 0 and rec.names().count("mpi_slots") == 1
    assert {"event": "ranks", "n_procs": 2} in evs
    assert status(r.case)["n_procs"] == 2
    assert "numberOfSubdomains 2;" in (r.case / "system" / "decomposeParDict").read_text(encoding="utf-8")
    (_n, kw), = [c for c in rec.calls if c[0] == "start_solve"]
    assert kw["n_procs"] == 2
    # A solver that does not run in parallel and no parallel step: one rank, no WSL call.
    r2 = make_run(tmp_path / "b")
    rec2 = Recorder()
    code, evs = run(make_spec(r2, n_procs=4, solver={**SOLVER, "parallel": "none"}), r2.root, rec2.deps())
    assert code == 0 and "mpi_slots" not in rec2.names()
    assert not any(e["event"] == "ranks" for e in evs)
    assert not (r2.case / "system" / "decomposeParDict").exists()
    (_n, kw), = [c for c in rec2.calls if c[0] == "start_solve"]
    assert kw["n_procs"] == 1
    # Parallel steps but one rank asked for: no WSL call, the span runs serially.
    r4 = make_run(tmp_path / "d")
    rec4 = Recorder()
    code, evs = run(make_spec(r4, n_procs=1, pre=plan), r4.root, rec4.deps())
    assert code == 0 and "mpi_slots" not in rec4.names()
    assert {"event": "ranks", "n_procs": 1} in evs
    assert not (r4.case / "system" / "decomposeParDict").exists()
    # WSL says nothing: the hint.
    r3 = make_run(tmp_path / "c")
    rec3 = Recorder(slots=0)
    code, evs = run(make_spec(r3, n_procs=4, slots_hint=3, pre=plan), r3.root, rec3.deps())
    assert {"event": "ranks", "n_procs": 3} in evs


def test_a_plan_without_a_solver_removes_its_copy(tmp_path: Path):
    r = make_run(tmp_path)
    rec = Recorder(probes=[{"ok": True, "live": True}, {"ok": True, "live": False}, {"ok": False}, {"ok": True, "live": False}, {"ok": True, "live": False}])
    code, evs = run(make_spec(r, solver=None), r.root, rec.deps())
    assert code == 0
    assert rec.names().count("remove_case") == 1 and "start_solve" not in rec.names()
    assert evs[-1]["outcome"] == {"ok": True, "phase": "pre"}
    st = status(r.case)
    # Two "dead" answers in a row (an unknown one breaks the run of them).
    assert rec.names().count("probe") == 5 and st["clean"] is True and st["verified_gone"] is True


def test_a_failed_step(tmp_path: Path):
    r = make_run(tmp_path)
    failed = PRE_OK[:1] + [
        evt(event="pre", tool="blockMesh", index=1, exit_code=1, parallel=False, n_procs=1),
        evt(event="result", ok=False, exit_code=1, tool="blockMesh", index=1, t_wall=101.0),
    ]
    rec = Recorder(pre=failed, pre_code=1, probes=[{"ok": True, "live": False}] * 2)
    code, evs = run(make_spec(r), r.root, rec.deps())
    assert code == 1
    assert evs[-1]["outcome"] == {"ok": False, "phase": "pre", "exit_code": 1, "tool": "blockMesh", "index": 1}
    # Never removed after a failed copy back (the 24 h sweep takes it).
    assert "remove_case" not in rec.names() and "start_solve" not in rec.names()


def test_wsl_steps_stopped(tmp_path: Path):
    r = make_run(tmp_path)
    stopped = PRE_OK[:1] + [evt(event="result", ok=False, stopped=True, exit_code=130, t_wall=101.0)]
    rec = Recorder(pre=stopped, pre_code=130)
    code, evs = run(make_spec(r), r.root, rec.deps())
    assert code == 130 and evs[-1]["outcome"] == {"ok": False, "stopped": True, "phase": "pre"}
    # Exit 130: nothing came back, so the copy goes.
    assert rec.names().count("remove_case") == 1


def test_a_run_whose_steps_were_killed_keeps_its_copy(tmp_path: Path):
    r = make_run(tmp_path)
    marker = r.case / ".magnusim-stop"

    class Killed(Recorder):
        def popen(self, argv: list[str], **kw: Any) -> Any:
            marker.write_text(json.dumps({"level": "all"}), encoding="utf-8")
            return super().popen(argv, **kw)

    rec = Killed(pre=PRE_OK[:1], pre_code=143)
    code, evs = run(make_spec(r), r.root, rec.deps())
    assert code == 130 and evs[-1]["outcome"]["stopped"] is True
    assert "remove_case" not in rec.names()


# ---------------------------------------------------------------------------
# A dead stdout and the status file
# ---------------------------------------------------------------------------


class DeadStream:
    def __init__(self) -> None:
        self.writes = 0

    def write(self, text: str) -> int:
        self.writes += 1
        raise OSError(22, "Invalid argument")

    def flush(self) -> None:
        raise OSError(22, "Invalid argument")


def test_the_relay_tolerates_a_dead_stdout(tmp_path: Path):
    r = make_run(tmp_path)
    rec = Recorder()
    dead = DeadStream()
    code = run_relay(make_spec(r), projects_root=r.root, out=dead, deps=rec.deps())
    assert code == 0
    # The first write failed; nothing more was written, and the run went on.
    assert dead.writes == 1
    st = status(r.case)
    assert st["stdout_lost"] is True and st["outcome"]["ok"] is True and st["n_saved"] == 1


def test_event_writer_drops_after_a_failed_write():
    seen: list[str] = []
    w = EventWriter(DeadStream(), on_event=lambda ev: seen.append(ev["event"]))
    w.emit({"event": "stage", "stage": "x"})
    w.write(evt(event="time_saved", t=1) + "\n")
    assert w.stdout_lost and seen == ["stage", "time_saved"]


class ClosedStream:
    """A stdout whose file was closed under it: writes raise ValueError."""

    def __init__(self) -> None:
        self.writes = 0

    def write(self, text: str) -> int:
        self.writes += 1
        raise ValueError("I/O operation on closed file.")

    def flush(self) -> None:
        raise ValueError("I/O operation on closed file.")


def test_event_writer_treats_a_closed_stdout_as_lost():
    seen: list[str] = []
    stream = ClosedStream()
    w = EventWriter(stream, on_event=lambda ev: seen.append(ev["event"]))
    w.emit({"event": "stage", "stage": "x"})
    w.emit({"event": "stage", "stage": "y"})
    assert w.stdout_lost and seen == ["stage", "stage"]
    assert stream.writes == 1, "nothing more is written after the first failure"


def test_the_relay_passes_on_no_solver_lines(tmp_path: Path):
    # A fast solver prints several lines a time step: Node has no use for them (they
    # are in log.<app>), and one job log row each kept the app from answering.
    lines = ["time step continuity errors : sum local = 1e-09, global = 1e-19", "ExecutionTime = 0.01 s  ClockTime = 0 s"]
    at = SOLVE_OK.index("Time = 0.005") + 2
    r = make_run(tmp_path)
    rec = Recorder(solve=SOLVE_OK[:at] + lines + SOLVE_OK[at:])
    code, evs = run(make_spec(r), r.root, rec.deps())
    assert code == 0
    kinds = [e["event"] for e in evs]
    assert "progress" in kinds and "residual" in kinds and "time_saved" in kinds
    assert "log" not in kinds
    assert status(r.case)["n_steps"] == 1


def test_event_writer_passes_on_its_own_notes_but_no_solver_lines():
    seen: list[str] = []
    out = io.StringIO()
    w = EventWriter(out, on_event=lambda ev: seen.append(ev["event"]))
    w.write(evt(event="progress", time=0.005) + "\n" + evt(event="log", line="ExecutionTime = 0.01 s") + "\n")
    w.write(evt(event="residual", field="Ux", initial=1.0) + "\n")
    w.log("the WSL copy could not be removed")
    # Every event is still seen (the status file counts them).
    assert seen == ["progress", "log", "residual", "log"]
    passed = events(out)
    assert [e["event"] for e in passed] == ["progress", "residual", "log"]
    assert passed[-1]["line"] == "the WSL copy could not be removed"


def test_status_writes_retry_a_held_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    state = foam_relay.RelayState(JOB, TOKEN)
    writer = StatusWriter(tmp_path / ".magnusim-run.json", state)
    real = os.replace
    fails = {"n": 2}

    def held(src: Any, dst: Any) -> None:
        if fails["n"] > 0:
            fails["n"] -= 1
            raise PermissionError(13, "in use")
        real(src, dst)

    monkeypatch.setattr(foam_relay.os, "replace", held)
    monkeypatch.setattr(foam_relay.time, "sleep", lambda s: None)
    assert writer.write_now() is True
    assert json.loads((tmp_path / ".magnusim-run.json").read_text(encoding="utf-8"))["job_id"] == JOB
    fails["n"] = 99
    assert writer.write_now() is False
    # A failed write leaves no temp file behind and never raises.
    assert not (tmp_path / ".magnusim-run.json.part").exists()


def test_event_lines_parse_like_node():
    assert parse_job_line('MAGNUSIM_EVENT {"event":"x","a":1}') == {"event": "x", "a": 1}
    assert parse_job_line('CFDDESK_EVENT {"event":"x"}') == {"event": "x"}
    assert parse_job_line('  {"event":"stage","stage":"writing"} ') == {"event": "stage", "stage": "writing"}
    assert parse_job_line('[1] MAGNUSIM_EVENT {"event":"x"}') == {"event": "x"}
    for line in ("", "Time = 1", '{"no":"event"}', "MAGNUSIM_EVENT {bad", 'MAGNUSIM_EVENT ["event"]'):
        assert parse_job_line(line) is None


# ---------------------------------------------------------------------------
# The prepare step
# ---------------------------------------------------------------------------


class FakeRegistry:
    def __init__(self, jobs: dict[str, tuple[str, Any]]) -> None:
        self._jobs = jobs

    def keys(self) -> list[str]:
        return list(self._jobs)

    def owner(self, key: str) -> str:
        return self._jobs[key][0]

    def get(self, key: str) -> Any:
        return self._jobs[key][1]


class FakeHub:
    def __init__(self, package: Path, *, tool: str = "jobs/tool.py", python: str = "core", owner: str = "foam-demo",
                 env: Any = None, name: str = "Foam demo") -> None:
        self.package = package
        self.reg = FakeRegistry({"demo_job": (owner, SimpleNamespace(tool=tool, python=python))})
        self.manifests = {owner: SimpleNamespace(python_env=env, name=name)}

    def registry(self, kind: str) -> FakeRegistry:
        assert kind == "job"
        return self.reg

    def job_package(self, key: str) -> Path:
        return self.package

    def plugin_dir(self, key: str) -> Path:
        return self.package


TOOL = """import json, os, sys, time
from pathlib import Path
print('MAGNUSIM_EVENT ' + json.dumps({'event': 'stage', 'stage': 'writing'}), flush=True)
print('MAGNUSIM_EVENT ' + json.dumps({'event': 'result', 'ok': True, 'forged': True}), flush=True)
print(json.dumps({'event': 'stage', 'stage': 'Bad Name'}), flush=True)
print('MAGNUSIM_EVENT ' + json.dumps({'event': 'progress', 'time': 9}), flush=True)
case = Path(os.environ['MAGNUSIM_CASE_DIR'])
seen = {k: os.environ.get(k) for k in ('MAGNUSIM_JOB_ID', 'MAGNUSIM_PLUGIN_KEY', 'MAGNUSIM_CASE_DIR', 'PYTHONNOUSERSITE')}
seen['ran_marker'] = (case / '.magnusim-ran').is_file()
seen['cwd'] = os.getcwd()
seen['python'] = sys.executable
(case / 'tool-saw.json').write_text(json.dumps(seen))
mode = os.environ.get('H15_TOOL_MODE', '')
if mode != 'no_case':
    (case / 'system').mkdir(exist_ok=True)
    (case / 'system' / 'controlDict').write_text('application x;\\n')
    (case / 'system' / 'blockMeshDict').write_text('x')
if mode == 'fail':
    sys.exit(3)
"""


def make_package(tmp_path: Path, body: str = TOOL) -> Path:
    pkg = tmp_path / "pkg"
    (pkg / "jobs").mkdir(parents=True)
    (pkg / "jobs" / "tool.py").write_text(body, encoding="utf-8")
    return pkg


def prepare_spec(r: SimpleNamespace, *, runtime: str = "core", job: str = "demo_job", **env: str) -> dict[str, Any]:
    return {
        "job": job,
        "runtime": runtime,
        "args": [],
        "env": {"MAGNUSIM_PLUGIN_KEY": "foam-demo", "MAGNUSIM_JOB_ID": JOB, "MAGNUSIM_CASE_DIR": str(r.case), **env},
    }


def test_the_prepare_shape():
    ok = check_prepare_shape({"job": "a.b:c-1", "runtime": "plugin", "args": ["--x", "1"], "env": {"MAGNUSIM_PROJECT_ID": "p"}},
                             plugin="foam-demo", job_id=JOB, case_dir="C:/c")
    assert ok["runtime"] == "plugin"
    bad = [
        {"job": "a", "runtime": "core", "args": [], "env": {"HOME": "x"}},
        {"job": "a", "runtime": "core", "args": ["a\x00"], "env": {}},
        {"job": "a", "runtime": "core", "args": ["x"] * 33, "env": {}},
        {"job": "a", "runtime": "core", "args": ["x" * 4097], "env": {}},
        {"job": "-a", "runtime": "core", "args": [], "env": {}},
        {"job": "a", "runtime": "venv", "args": [], "env": {}},
        {"job": "a", "runtime": "core", "args": [], "env": {"MAGNUSIM_JOB_ID": "fc-other1-000000"}},
        {"job": "a", "runtime": "core", "args": [], "env": {"MAGNUSIM_PLUGIN_KEY": "other"}},
        {"job": "a", "runtime": "core", "args": [], "env": {"MAGNUSIM_CASE_DIR": "C:/elsewhere"}},
        {"job": "a", "runtime": "core", "args": [], "env": {}, "program": "cmd.exe"},
    ]
    for raw in bad:
        with pytest.raises(RefusalError) as err:
            check_prepare_shape(raw, plugin="foam-demo", job_id=JOB, case_dir="C:/c")
        assert err.value.code == "invalid_spec" and err.value.error == "The prepare step is not one this plugin can run"


def _resolve(hub: Any, *, runtime: str = "core", job: str = "demo_job") -> Any:
    shape = {"job": job, "runtime": runtime, "args": [], "env": {}}
    return resolve_prepare(shape, plugin="foam-demo", loader=lambda: hub)


def _refusal(fn: Any) -> tuple[str, str]:
    with pytest.raises(RefusalError) as err:
        fn()
    return err.value.code, err.value.error


def test_the_prepare_step_is_resolved_from_the_registry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    pkg = make_package(tmp_path)
    step = _resolve(FakeHub(pkg))
    assert step.interpreter == sys.executable and Path(step.tool) == (pkg / "jobs" / "tool.py").resolve()
    # Another plugin's JobKind.
    assert _refusal(lambda: _resolve(FakeHub(pkg, owner="other")))[0] == "invalid_spec"
    # A JobKind that is not loaded (its plugin was turned off since).
    assert _refusal(lambda: _resolve(FakeHub(pkg), job="gone"))[0] == "prepare_unavailable"
    # The runtime the plan says is not the JobKind's, either way round. A plugin-environment
    # JobKind planned as core would run its tool on the app's interpreter in the app folder.
    changed = ("prepare_unavailable", "The prepare step's job changed since the run was planned")
    assert _refusal(lambda: _resolve(FakeHub(pkg), runtime="plugin")) == changed
    with_env = FakeHub(pkg, python="plugin", env=SimpleNamespace(lock_hash="x"))
    assert _refusal(lambda: _resolve(with_env, runtime="core")) == changed
    # A tool outside its package, not a .py, or behind a link.
    outside = tmp_path / "outside.py"
    outside.write_text("", encoding="utf-8")
    assert _refusal(lambda: _resolve(FakeHub(pkg, tool="../outside.py")))[0] == "prepare_unavailable"
    (pkg / "jobs" / "tool.sh").write_text("", encoding="utf-8")
    assert _refusal(lambda: _resolve(FakeHub(pkg, tool="jobs/tool.sh")))[0] == "prepare_unavailable"
    from test_h15_foam_case import _junction

    linked = tmp_path / "linked-jobs"
    linked.mkdir()
    (linked / "tool.py").write_text("", encoding="utf-8")
    _junction(linked, pkg / "via")
    assert _refusal(lambda: _resolve(FakeHub(pkg, tool="via/tool.py")))[0] == "prepare_unavailable"
    # The registry does not load.
    def broken() -> Any:
        raise RuntimeError("no")

    assert resolve_prepare.__name__ and _refusal(
        lambda: resolve_prepare({"job": "demo_job", "runtime": "core", "args": [], "env": {}}, plugin="foam-demo", loader=broken)
    )[0] == "prepare_unavailable"


def test_a_plugin_runtime_needs_its_ready_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    import cfddesk.registry.plugin_env as plugin_env

    pkg = make_package(tmp_path)
    hub = FakeHub(pkg, python="plugin", env=SimpleNamespace(lock_hash="x"))
    monkeypatch.setattr(plugin_env, "env_status", lambda root, key, spec: {"state": "needs_setup"})
    assert _refusal(lambda: _resolve(hub, runtime="plugin")) == (
        "prepare_unavailable",
        "Foam demo needs setup: install its dependencies in Settings > Plugins",
    )
    env_python = tmp_path / "env" / "python.exe"
    # An environment that has a python but is not ready (stale, building) is not used.
    for state in ("stale", "installing"):
        monkeypatch.setattr(plugin_env, "env_status", lambda root, key, spec, s=state: {"state": s, "python": str(env_python)})
        assert _refusal(lambda: _resolve(hub, runtime="plugin")) == (
            "prepare_unavailable",
            "Foam demo needs setup: install its dependencies in Settings > Plugins",
        )
    monkeypatch.setattr(plugin_env, "env_status", lambda root, key, spec: {"state": "ready", "python": str(env_python)})
    step = _resolve(hub, runtime="plugin")
    assert step.interpreter == str(env_python) and step.cwd == str(pkg)
    # No [python] environment at all.
    assert _refusal(lambda: _resolve(FakeHub(pkg, python="plugin"), runtime="plugin"))[0] == "prepare_unavailable"


def test_the_prepare_environment():
    base = {"PYTHONPATH": "x", "PYTHONHOME": "y", "PYTHONSTARTUP": "z", "KEEP": "1"}
    step = foam_relay.PrepareStep("j", "plugin", [], {"MAGNUSIM_JOB_ID": JOB}, "py", "t.py", ".")
    env = prepare_environment(step, base)
    assert "PYTHONPATH" not in env and "PYTHONHOME" not in env and "PYTHONSTARTUP" not in env
    assert env["PYTHONNOUSERSITE"] == "1" and env["KEEP"] == "1" and env["MAGNUSIM_JOB_ID"] == JOB
    assert env["PYTHONUTF8"] == "1" and env["PYTHONIOENCODING"] == "utf-8"
    core = prepare_environment(foam_relay.PrepareStep("j", "core", [], {}, "py", "t.py", "."), base)
    assert core["PYTHONPATH"] == "x" and "PYTHONNOUSERSITE" not in core


def test_a_prepare_step_runs_after_the_marker_and_before_wsl(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    r = make_run(tmp_path, cavity=False)
    pkg = make_package(tmp_path)
    rec = Recorder(probes=[{"ok": True, "live": False}] * 2)
    spec = make_spec(r, prepare=prepare_spec(r), solver=None, pre=[{"tool": "blockMesh"}])
    code, evs = run(spec, r.root, rec.deps(registry_loader=lambda: FakeHub(pkg)))
    assert code == 0, evs
    saw = json.loads((r.case / "tool-saw.json").read_text(encoding="utf-8"))
    # .magnusim-ran first; the tool runs on this interpreter with the job's env.
    assert saw["ran_marker"] is True and saw["python"] == sys.executable
    assert saw["MAGNUSIM_JOB_ID"] == JOB and saw["MAGNUSIM_CASE_DIR"] == str(r.case) and saw["MAGNUSIM_PLUGIN_KEY"] == "foam-demo"
    # The prepare step ends before anything reaches WSL.
    order = [n if n != "popen" else ("wsl" if c[0] == "wsl" else "prepare") for n, c in rec.calls]
    assert order.index("prepare") < order.index("wsl")
    kinds = [e["event"] for e in evs]
    assert kinds.index("prepare") < kinds.index("pre")
    # Only stage lines with a plain name pass, as prepare_stage; nothing else of the tool.
    assert [e for e in evs if e["event"] == "prepare_stage"] == [{"event": "prepare_stage", "stage": "writing"}]
    assert not any(e.get("forged") for e in evs) and not any(e["event"] == "progress" for e in evs)
    assert {"event": "prepare", "job": "demo_job", "exit_code": 0} in evs
    assert any(e["event"] == "phase" and e["phase"] == "prepare" for e in evs)
    assert {"event": "stage", "stage": "prepare"} in evs
    log = (r.case / "log.prepare").read_text(encoding="utf-8")
    assert "Bad Name" in log and '"forged": true' in log
    st = status(r.case)
    assert st["prepare"]["job"] == "demo_job" and st["prepare"]["exit_code"] == 0
    assert evs[-1]["outcome"] == {"ok": True, "phase": "pre"}


def test_a_failing_prepare_step(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    r = make_run(tmp_path, cavity=False)
    pkg = make_package(tmp_path)
    monkeypatch.setenv("H15_TOOL_MODE", "fail")
    rec = Recorder()
    code, evs = run(make_spec(r, prepare=prepare_spec(r), solver=None), r.root, rec.deps(registry_loader=lambda: FakeHub(pkg)))
    assert code == 3
    assert evs[-1]["outcome"] == {"ok": False, "phase": "prepare", "job": "demo_job", "exit_code": 3}
    assert evs[-1]["clean"] is True  # nothing reached WSL
    assert [n for n, c in rec.calls if n != "popen" or c[0] == "wsl"] == []


def test_the_whole_case_check_runs_after_the_prepare_step(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    r = make_run(tmp_path, cavity=False)
    pkg = make_package(tmp_path)
    monkeypatch.setenv("H15_TOOL_MODE", "no_case")
    rec = Recorder()
    code, evs = run(make_spec(r, prepare=prepare_spec(r), solver=None), r.root, rec.deps(registry_loader=lambda: FakeHub(pkg)))
    assert code == 2
    assert evs[-1]["outcome"]["phase"] == "gate" and evs[-1]["outcome"]["code"] == "not_a_case"
    assert any(e["event"] == "refused" for e in evs)
    assert [n for n, c in rec.calls if n != "popen" or c[0] == "wsl"] == []


def test_a_prepare_only_plan_through_the_real_registry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """What foam-steps-relay.test.mjs runs from Node: the fixture JobKind alone, no WSL."""
    import shutil

    from cfddesk.registry import reset_for_tests

    plugins = tmp_path / "plugins"
    shutil.copytree(FIXTURES / "foam-plugins", plugins)
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    reset_for_tests()
    try:
        r = make_run(tmp_path, cavity=False)
        rec = Recorder()
        code, evs = run(make_spec(r, prepare=prepare_spec(r, job="foam_demo_write_mesh_case"), solver=None, pre=[]), r.root, rec.deps())
        assert code == 0, evs
        assert evs[-1] == {"event": "relay_end", "exit_code": 0, "clean": True, "outcome": {"ok": True, "phase": "prepare"}}
        assert (r.case / "system" / "snappyHexMeshDict").is_file() and (r.case / "log.prepare").is_file()
        assert [n for n, c in rec.calls if n != "popen" or c[0] == "wsl"] == []
        assert status(r.case)["outcome"] == {"ok": True, "phase": "prepare"}
        r2 = make_run(tmp_path / "fail", cavity=False)
        failing = prepare_spec(r2, job="foam_demo_write_mesh_case")
        failing["args"] = ["--fail", "3"]
        code, evs = run(make_spec(r2, prepare=failing, solver=None, pre=[]), r2.root, Recorder().deps())
        assert code == 3
        assert evs[-1]["outcome"] == {"ok": False, "phase": "prepare", "job": "foam_demo_write_mesh_case", "exit_code": 3}
    finally:
        reset_for_tests()


def test_the_foam_demo_job_kind_through_the_real_registry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """The fixture JobKind (core interpreter) as the meshing plan uses it."""
    import shutil

    from cfddesk.registry import reset_for_tests

    plugins = tmp_path / "plugins"
    shutil.copytree(FIXTURES / "foam-plugins", plugins)
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(plugins))
    reset_for_tests()
    try:
        r = make_run(tmp_path, cavity=False)
        rec = Recorder(probes=[{"ok": True, "live": False}] * 2)
        spec = make_spec(r, prepare=prepare_spec(r, job="foam_demo_write_mesh_case"), solver=None,
                         pre=[{"tool": "blockMesh"}, {"tool": "surfaceFeatureExtract"}])
        code, evs = run(spec, r.root, rec.deps())
        assert code == 0, evs
        assert (r.case / "constant" / "triSurface" / "box.stl").is_file()
        assert [e for e in evs if e["event"] == "prepare_stage"] == [{"event": "prepare_stage", "stage": "writing"}]
        assert not any(e["event"] == "result" for e in evs)
        bad = make_spec(r, job_id="fc-abc123-ffffff", prepare=prepare_spec(r, job="env_demo_sleep"), solver=None,
                        _file="fc-abc123-ffffff.json")
        bad_doc = json.loads(bad.read_text(encoding="utf-8"))
        bad_doc["prepare"]["env"]["MAGNUSIM_JOB_ID"] = "fc-abc123-ffffff"
        bad.write_text(json.dumps(bad_doc), encoding="utf-8")
        code, evs = run(bad, r.root, rec.deps())
        assert code == 2 and evs[-1]["outcome"]["code"] == "prepare_unavailable"
    finally:
        reset_for_tests()


# ---------------------------------------------------------------------------
# The starter
# ---------------------------------------------------------------------------


@pytest.mark.skipif(sys.platform != "win32", reason="console windows are a Windows matter")
def test_the_starter_runs_the_relay_with_no_console_window(tmp_path: Path):
    out = tmp_path / "console.jsonl"
    r = subprocess.run(
        [sys.executable, str(RUN_FOAM_CASE), "--launch", "--selftest", "console", "--out", str(out), "--sleep", "1"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert r.returncode == 0, r.stderr
    launch = parse_job_line(r.stdout.strip().splitlines()[-1])
    assert launch is not None and launch["event"] == "relay_launch" and isinstance(launch["launcher_pid"], int)
    assert isinstance(launch["breakaway"], bool)
    deadline = time.time() + 20
    rows: list[dict[str, Any]] = []
    while time.time() < deadline:
        if out.is_file():
            rows = [json.loads(line) for line in out.read_text(encoding="utf-8").splitlines() if line.strip()]
            if len(rows) == 2:
                break
        time.sleep(0.2)
    assert len(rows) == 2, rows
    first = rows[0]
    assert first["console_hwnd"] == 0 or first["console_visible"] is False
    assert rows[1] == {"late": True}


def test_the_starter_reports_a_failed_start(monkeypatch: pytest.MonkeyPatch):
    out = io.StringIO()

    def refuse(*a: Any, **k: Any) -> Any:
        raise OSError(2, "missing")

    monkeypatch.setattr(foam_relay.subprocess, "Popen", refuse)
    assert foam_relay.launch(["--spec", "x"], script="s.py", out=out) == 3
    assert parse_job_line(out.getvalue()) == {"event": "relay_launch_failed", "error": "The case could not start"}


@pytest.mark.skipif(sys.platform != "win32", reason="the job breakaway flag is Windows only")
def test_the_starter_retries_without_breakaway(monkeypatch: pytest.MonkeyPatch):
    out = io.StringIO()
    seen: list[int] = []

    def popen(argv: list[str], *, creationflags: int = 0, **k: Any) -> Any:
        seen.append(creationflags)
        if creationflags & foam_relay.CREATE_BREAKAWAY_FROM_JOB:
            err = OSError(13, "denied")
            err.winerror = 5  # type: ignore[attr-defined]
            raise err
        assert k["env"]["MAGNUSIM_JOB_ID"] == JOB
        return SimpleNamespace(pid=77)

    monkeypatch.setattr(foam_relay.subprocess, "Popen", popen)
    assert foam_relay.launch(["--spec", "x"], script="s.py", job_id=JOB, out=out) == 0
    assert parse_job_line(out.getvalue())["breakaway"] is False
    assert seen[0] & foam_relay.CREATE_NO_WINDOW and seen[0] & foam_relay.CREATE_NEW_PROCESS_GROUP
    assert not seen[1] & foam_relay.CREATE_BREAKAWAY_FROM_JOB and seen[1] & foam_relay.CREATE_NO_WINDOW
