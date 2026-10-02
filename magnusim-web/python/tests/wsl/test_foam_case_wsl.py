"""H15 on real OpenFOAM in WSL: the step table, the relay, stops and the meshing plan.

Deselected by default (``pytest -m wsl``; run it under the WSL test lock). Each
test uses its own throwaway WSL case root under /tmp.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import pytest

from cfddesk.wsl import case_procs
from cfddesk.wsl.foam_case import STEP_TABLE, check_steps, render_foam_pre
from cfddesk.wsl.openfoam import run_wsl_bash

pytestmark = pytest.mark.wsl

PY_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = PY_ROOT / "tests" / "fixtures"
RUN_FOAM_CASE = PY_ROOT / "tools" / "run_foam_case.py"
WSL_CASE_PROCS = PY_ROOT / "tools" / "wsl_case_procs.py"
MESH_PLAN = [
    {"tool": "blockMesh"},
    {"tool": "surfaceFeatureExtract"},
    {"tool": "decomposePar"},
    {"tool": "snappyHexMesh", "parallel": True},
    {"tool": "reconstructParMesh"},
    {"tool": "checkMesh"},
]
SOLVER = {
    "app": "pimpleFoam",
    "keep_frames": "all",
    "frame_fields": ["U", "p"],
    "process_names": ["pimpleFoam"],
    "stop_strategy": "stopAt_writeNow",
    "parallel": "mpirun",
}


def _sh(cmd: str, timeout: float = 120) -> subprocess.CompletedProcess:
    r = run_wsl_bash(cmd, timeout=timeout)
    return subprocess.CompletedProcess([], r.returncode, r.stdout, r.stderr)


def _foam_demo() -> Any:
    spec = importlib.util.spec_from_file_location("h15_wsl_foam_demo", FIXTURES / "foam-plugins" / "foam-demo" / "plugin.py")
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def world(tmp_path: Path):
    tag = uuid.uuid4().hex[:10]
    base = f"/tmp/magnusim-foam-wsl-{tag}"
    root = f"{base}/cases"
    assert _sh(f"mkdir -p {shlex.quote(root)}").returncode == 0
    plugins = tmp_path / "plugins"
    shutil.copytree(FIXTURES / "foam-plugins", plugins)
    projects = tmp_path / "projects"
    (projects / "proj").mkdir(parents=True)
    (projects / "proj" / "project.json").write_text("{}", encoding="utf-8")
    env = dict(os.environ)
    env.update(
        MAGNUSIM_PROJECTS_ROOT=str(projects),
        MAGNUSIM_PLUGINS_DIR=str(plugins),
        MAGNUSIM_WSL_CASE_ROOT=root,
        PYTHONIOENCODING="utf-8",
        PYTHONUTF8="1",
    )
    w = World(tmp_path, projects, root, env)
    try:
        yield w
    finally:
        for job in w.jobs:
            subprocess.run([sys.executable, str(PY_ROOT / "tools" / "foam_relay_ctl.py"), "kill", "--job-id", job],
                           capture_output=True, timeout=60)
        # "[/]tmp/..." matches the case processes but not this shell's own command line
        # (so the folder's name is given to rm in a separate call).
        _sh(f"pkill -f {shlex.quote('[/]' + base[1:])}; true")
        _sh(f"rm -rf -- {shlex.quote(base)}")
        assert _sh(f"test -e {shlex.quote(base)}").returncode != 0, f"{base} was left behind"


class World:
    def __init__(self, tmp: Path, projects: Path, root: str, env: dict[str, str]) -> None:
        self.tmp, self.projects, self.root, self.env = tmp, projects, root, env
        self.jobs: list[str] = []

    def case(self, name: str) -> tuple[Path, Path, list[str]]:
        base = self.projects / "proj" / "plugins" / "foam-demo"
        parts = ["studies", "st-1", "cases", name]
        case = base.joinpath(*parts)
        case.mkdir(parents=True)
        return case, base, parts

    def cavity(self, name: str, **kw: Any) -> tuple[Path, Path, list[str]]:
        case, base, parts = self.case(name)
        for rel, text in _foam_demo().cavity_files(**{"end_time": 0.5, "write_interval": 0.1, "write_format": "ascii", "broken": False, **kw}).items():
            target = case / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8", newline="\n")
        return case, base, parts

    def spec(self, case: Path, base: Path, parts: list[str], **over: Any) -> tuple[Path, dict[str, Any]]:
        token = secrets.token_hex(4)
        job = f"fc-{secrets.token_hex(4)}-{secrets.token_hex(3)}"
        doc: dict[str, Any] = {
            "v": 1, "kind": "foam", "job_id": job, "token": token, "project_id": "proj",
            "case_dir": str(case), "case_base": str(base), "case_parts": parts, "plugin": "foam-demo",
            "wsl_case": f"cfddesk-pf-foam-demo-st-1-{token}", "wsl_root": self.root, "n_procs": 1,
            "slots_hint": None, "prepare": None, "pre": [{"tool": "blockMesh"}], "solver": dict(SOLVER),
            "owner": None, "hooks": [],
        }
        doc.update(over)
        if doc.get("prepare") == "mesh":
            doc["prepare"] = {"job": "foam_demo_write_mesh_case", "runtime": "core", "args": [],
                              "env": {"MAGNUSIM_PLUGIN_KEY": "foam-demo", "MAGNUSIM_JOB_ID": job, "MAGNUSIM_CASE_DIR": str(case)}}
        folder = self.tmp / ".cache" / "foam-specs"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{job}.json"
        path.write_text(json.dumps(doc), encoding="utf-8")
        self.jobs.append(job)
        return path, doc

    def relay(self, spec: Path, timeout: float = 300) -> tuple[int, list[dict[str, Any]]]:
        r = subprocess.run([sys.executable, str(RUN_FOAM_CASE), "--spec", str(spec)], capture_output=True, text=True,
                           encoding="utf-8", env=self.env, timeout=timeout)
        return r.returncode, events(r.stdout)

    def exists(self, wsl_case: str) -> bool:
        return _sh(f"test -e {shlex.quote(self.root + '/' + wsl_case)}").returncode == 0


def events(text: str) -> list[dict[str, Any]]:
    out = []
    for line in text.splitlines():
        if line.startswith("MAGNUSIM_EVENT "):
            out.append(json.loads(line[len("MAGNUSIM_EVENT "):]))
    return out


def status(case: Path) -> dict[str, Any]:
    return json.loads((case / ".magnusim-run.json").read_text(encoding="utf-8"))


def n_cells(case: Path) -> int:
    m = re.search(r"nCells:\s*(\d+)", (case / "constant" / "polyMesh" / "owner").read_text(encoding="utf-8", errors="replace"))
    assert m
    return int(m.group(1))


def patches(case: Path) -> list[str]:
    text = (case / "constant" / "polyMesh" / "boundary").read_text(encoding="utf-8")
    body = text.split("(", 1)[1]
    return re.findall(r"^\s{4}(\w+)\s*$", body, flags=re.M)


# ---------------------------------------------------------------------------


def test_every_allowed_flag_is_in_the_tools_help():
    """Freezes the table (the r5 rows included) against the installed OpenFOAM."""
    for tool, rule in STEP_TABLE.items():
        r = _sh(f"openfoam2606 {tool} -help 2>&1", timeout=120)
        text = r.stdout + r.stderr
        assert "Usage" in text, f"{tool}: {text[-500:]}"
        for flag in sorted(set(rule.flags) | set(rule.host_adds)):
            assert re.search(rf"(^|\s){re.escape(flag)}(\s|$)", text, flags=re.M), f"{tool} -help has no {flag}"
        if rule.parallel:
            assert re.search(r"(^|\s)-parallel(\s|$)", text, flags=re.M), f"{tool} -help has no -parallel"


def test_the_rendered_script_is_valid_bash(tmp_path: Path):
    text = render_foam_pre(dst="/tmp/x/cases/cfddesk-pf-a-b-0a1b2c3d", win_out="/mnt/c/x/it's", token="0a1b2c3d",
                           steps=check_steps(MESH_PLAN), n_procs=2)
    r = subprocess.run(["wsl", "-d", os.environ.get("MAGNUSIM_WSL_DISTRO", "Ubuntu-24.04"), "-e", "bash", "-n"],
                       input=text.encode("utf-8"), capture_output=True, timeout=60)
    assert r.returncode == 0, r.stderr


def test_checkmesh_exit_code_on_a_failing_check(world: World, record_property):
    """Recorded, not asserted: whether checkMesh exits non-zero when a mesh check fails
    (a run's checkMesh step then fails the run)."""
    case, base, parts = world.case("bad")
    files = _foam_demo().cavity_files(end_time=0.5, write_interval=0.1, write_format="ascii", broken=False)
    # A 3D slab (no empty patch) a hundred-thousandth thick: its aspect ratio fails a check.
    files["system/blockMeshDict"] = files["system/blockMeshDict"].replace("(0 0 0.1)", "(0 0 0.00001)").replace(
        "(1 0 0.1)", "(1 0 0.00001)").replace("(1 1 0.1)", "(1 1 0.00001)").replace("(0 1 0.1)", "(0 1 0.00001)").replace(
        "type empty;", "type patch;")
    for rel, text in files.items():
        (case / rel).parent.mkdir(parents=True, exist_ok=True)
        (case / rel).write_text(text, encoding="utf-8", newline="\n")
    spec, doc = world.spec(case, base, parts, pre=[{"tool": "blockMesh"}, {"tool": "checkMesh"}], solver=None)
    code, evs = world.relay(spec)
    log = (case / "log.checkMesh.2").read_text(encoding="utf-8", errors="replace")
    assert "Failed" in log and "mesh checks" in log
    check = next(e for e in evs if e["event"] == "pre" and e["tool"] == "checkMesh")
    record_property("checkMesh_exit_code_on_failed_checks", check["exit_code"])
    print(f"checkMesh exit code with a failed mesh check: {check['exit_code']}")
    assert isinstance(check["exit_code"], int)
    if check["exit_code"] == 0:
        assert code == 0 and evs[-1]["outcome"] == {"ok": True, "phase": "pre"}
    else:
        assert evs[-1]["outcome"]["phase"] == "pre" and evs[-1]["outcome"]["tool"] == "checkMesh"


def test_the_cavity_runs_and_comes_back(world: World):
    case, base, parts = world.cavity("c1")
    spec, doc = world.spec(case, base, parts)
    code, evs = world.relay(spec)
    assert code == 0, evs[-3:]
    assert evs[-1]["event"] == "relay_end" and evs[-1]["outcome"]["ok"] is True and evs[-1]["clean"] is True
    pre = [e for e in evs if e["event"] == "pre"]
    assert pre == [{"event": "pre", "tool": "blockMesh", "index": 1, "exit_code": 0, "parallel": False, "n_procs": 1}]
    assert (case / "constant" / "polyMesh" / "owner").is_file() and (case / "log.blockMesh.1").is_file()
    assert sorted(e["t"] for e in evs if e["event"] == "time_saved") == [0.1, 0.2, 0.3, 0.4, 0.5]
    for t in ("0.1", "0.2", "0.3", "0.4", "0.5"):
        assert (case / t / "U").is_file() and (case / t / "p").is_file()
    assert not world.exists(doc["wsl_case"])
    st = status(case)
    assert st["result_ok"] and st["cleanup_seen"] and st["n_saved"] == 5 and st["outcome"]["ok"]


def test_a_marker_before_the_solve(world: World):
    case, base, parts = world.cavity("c2")
    (case / ".magnusim-stop").write_text(json.dumps({"level": "graceful", "seq": 1, "at": "t", "by": "user"}), encoding="utf-8")
    spec, doc = world.spec(case, base, parts)
    code, evs = world.relay(spec)
    assert code == 130 and evs[-1]["outcome"]["stopped"] is True
    assert not (case / ".magnusim-ran").exists() and not world.exists(doc["wsl_case"])


def _follow(proc: subprocess.Popen, seen: list[dict[str, Any]]) -> threading.Thread:
    def read() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            if line.startswith("MAGNUSIM_EVENT "):
                seen.append(json.loads(line[len("MAGNUSIM_EVENT "):]))

    t = threading.Thread(target=read, daemon=True)
    t.start()
    return t


def _wait(cond, timeout: float, what: str) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return
        time.sleep(0.25)
    raise AssertionError(f"timed out waiting for {what}")


def test_a_graceful_stop_during_the_solve_saves_a_frame(world: World):
    case, base, parts = world.cavity("c3", end_time=200.0, write_interval=100.0)
    # OpenFOAM sees a changed controlDict only when its time moved past the old one by
    # fileModificationSkew (5 s); cp -a keeps the Windows time. A case written just now
    # would ignore writeNow (the relay then kills the solver after 20 s).
    old = time.time() - 3600
    os.utime(case / "system" / "controlDict", (old, old))
    spec, doc = world.spec(case, base, parts)
    seen: list[dict[str, Any]] = []
    proc = subprocess.Popen([sys.executable, str(RUN_FOAM_CASE), "--spec", str(spec)], stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, encoding="utf-8", env=world.env)
    reader = _follow(proc, seen)
    try:
        _wait(lambda: sum(e["event"] == "progress" for e in seen) >= 20, 180, "the solve to run")
        # Live during the solve, by its scripts and by its case copy.
        probe = subprocess.run([sys.executable, str(WSL_CASE_PROCS), "probe", "--wsl-case", doc["wsl_case"],
                                "--script", f"solve-pf-{doc['token']}.sh"], capture_output=True, text=True, env=world.env, timeout=60)
        assert json.loads(probe.stdout) == {"ok": True, "live": True}
        (case / ".magnusim-stop").write_text(json.dumps({"level": "graceful", "seq": 1, "at": "t", "by": "user"}), encoding="utf-8")
        proc.wait(timeout=180)
        reader.join(10)
    finally:
        if proc.poll() is None:
            proc.kill()
    end = seen[-1]
    assert end["event"] == "relay_end" and end["outcome"]["phase"] == "solve" and end["outcome"]["stopped"] is True
    saved = [e["t"] for e in seen if e["event"] == "time_saved"]
    assert saved and max(saved) < 200.0
    st = status(case)
    assert st["stop"]["level"] == "graceful" and st["stop"]["applied"][0]["action"] == "write_now"
    assert case_procs.probe(doc["wsl_case"], [f"solve-pf-{doc['token']}.sh"], root=world.root) == {"ok": True, "live": False}


def test_probe_sees_reconstructpar_in_the_case_copy(world: World):
    wsl_case = f"cfddesk-pf-foam-demo-st-1-{secrets.token_hex(4)}"
    copy = f"{world.root}/{wsl_case}"
    q = shlex.quote
    assert _sh(f"mkdir -p {q(copy)} && cd {q(copy)} && (setsid bash -c 'exec -a reconstructPar sleep 300' </dev/null >/dev/null 2>&1 &); "
               "for i in $(seq 50); do pgrep -f '^reconstructPar' >/dev/null && exit 0; sleep 0.1; done; exit 1").returncode == 0
    assert case_procs.probe(wsl_case, root=world.root) == {"ok": True, "live": True}
    assert case_procs.kill(wsl_case, root=world.root)["killed"] == 1
    assert case_procs.probe(wsl_case, root=world.root) == {"ok": True, "live": False}


@pytest.mark.parametrize("n_procs", [2, 1])
def test_the_meshing_plan(world: World, n_procs: int):
    """The runner's reuse on real OpenFOAM: a prepare step, then the meshing utilities
    with a parallel snappyHexMesh span; no solver."""
    case, base, parts = world.case(f"mesh{n_procs}")
    spec, doc = world.spec(case, base, parts, prepare="mesh", pre=MESH_PLAN, solver=None, n_procs=n_procs)
    t0 = time.time()
    code, evs = world.relay(spec)
    assert code == 0, [e for e in evs if e["event"] in ("refused", "pre", "pre_result", "relay_end", "log")][-8:]
    assert time.time() - t0 < 180
    assert evs[-1]["outcome"] == {"ok": True, "phase": "pre"} and evs[-1]["clean"] is True
    ranks = next(e["n_procs"] for e in evs if e["event"] == "ranks")
    pre = {e["tool"]: e for e in evs if e["event"] == "pre"}
    if ranks == 2:
        assert pre["snappyHexMesh"]["parallel"] is True and pre["snappyHexMesh"]["n_procs"] == 2
        assert not pre["decomposePar"].get("skipped") and (case / "log.decomposePar.3").is_file()
    else:
        assert pre["snappyHexMesh"]["parallel"] is False
        assert pre["decomposePar"]["skipped"] is True and pre["reconstructParMesh"]["skipped"] is True
    assert ranks == min(n_procs, 2) or n_procs == 1
    # The mesh came back: more than the background box alone, with the STL's patch.
    assert n_cells(case) != 1000 and "body" in patches(case)
    assert (case / "log.snappyHexMesh.4").is_file() and (case / "log.prepare").is_file()
    assert not any(p.name.startswith("processor") for p in case.iterdir())
    assert not world.exists(doc["wsl_case"])
    assert [e for e in evs if e["event"] == "prepare_stage"] == [{"event": "prepare_stage", "stage": "writing"}]


CAVITY_FIXTURE = FIXTURES / "foam-results" / "cavity-2d"
FIXTURE_FRAMES = ["0.1", "0.2", "0.3", "0.4", "0.5"]


def test_cavity_fixture(world: World):
    """foam-results/cavity-2d is this run's output (MAGNUSIM_REGEN_CAVITY_FIXTURE=1 rewrites it)."""
    case, base, parts = world.cavity("fixture", write_format="ascii")
    spec, _doc = world.spec(case, base, parts)
    code, evs = world.relay(spec)
    assert code == 0, evs[-3:]
    frames = sorted(p.name for p in case.iterdir() if p.is_dir() and re.fullmatch(r"[0-9.]+", p.name) and p.name != "0")
    assert frames == FIXTURE_FRAMES
    if os.environ.get("MAGNUSIM_REGEN_CAVITY_FIXTURE") == "1":
        readme = (CAVITY_FIXTURE / "README.md").read_text(encoding="utf-8")
        shutil.rmtree(CAVITY_FIXTURE)
        CAVITY_FIXTURE.mkdir(parents=True)
        (CAVITY_FIXTURE / "README.md").write_text(readme, encoding="utf-8")
        for name in ["0", *FIXTURE_FRAMES, "constant", "system"]:
            shutil.copytree(case / name, CAVITY_FIXTURE / name, ignore=shutil.ignore_patterns("phi"))
        doc = {"rho": 1000, "kinematic_fields": ["p"], "frame_fields": ["U", "p"], "app": "pimpleFoam",
               "plugin": "foam-demo", "study_id": "st-1"}
        (CAVITY_FIXTURE / "w27-case.json").write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    for name in FIXTURE_FRAMES:
        assert (CAVITY_FIXTURE / name / "U").is_file() and (CAVITY_FIXTURE / name / "p").is_file()
    for name in ("points", "faces", "owner", "neighbour", "boundary"):
        # read_text reads CRLF and LF alike (a Windows checkout may hold either).
        mine = (case / "constant" / "polyMesh" / name).read_text(encoding="utf-8")
        kept = (CAVITY_FIXTURE / "constant" / "polyMesh" / name).read_text(encoding="utf-8")
        assert mine == kept, name
