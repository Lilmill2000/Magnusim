"""H15: the processes of one WSL case copy (cfddesk.wsl.case_procs, tools/wsl_case_procs.py).

The script and its answers without WSL; the tests marked ``wsl`` run real
processes in WSL (``pytest -m wsl``).
"""

from __future__ import annotations

import json
import re
import shlex
import subprocess
import uuid
from typing import Any

import pytest
import wsl_case_procs

from cfddesk.wsl import case_procs

ROOT = "/tmp/magnusim-test/cases"
CASE = "cfddesk-w27-run1"


@pytest.fixture(autouse=True)
def _root(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("MAGNUSIM_WSL_CASE_ROOT", ROOT)


def test_the_script_quotes_every_value_and_checks_names():
    text = case_procs.render_script(root=ROOT, wsl_case=CASE, mode="kill", scripts=["solve-pf-0a1b2c3d.sh"], names=["changeDictionary", "mpirun"])
    assert f"ROOT={ROOT}" in text and f"NAME={CASE}" in text and "MODE=kill" in text
    assert "SCRIPTS=(solve-pf-0a1b2c3d.sh)" in text and "NAMES=(changeDictionary mpirun)" in text
    quoted = case_procs.render_script(root="/tmp/a b/cases", wsl_case=CASE, mode="probe")
    assert "ROOT='/tmp/a b/cases'" in quoted
    for bad in (["solve.sh"], ["x-1.sh"], ["solve-a;rm.sh"], ["solve-../x.sh"], ["foam-pre-x.sh x"]):
        with pytest.raises(case_procs.CaseProcsError):
            case_procs.render_script(root=ROOT, wsl_case=CASE, mode="probe", scripts=bad)
    for bad in (["mpi run"], ["-x"], ["a;b"], ["1abc"]):
        with pytest.raises(case_procs.CaseProcsError):
            case_procs.render_script(root=ROOT, wsl_case=CASE, mode="kill", names=bad)
    with pytest.raises(case_procs.CaseProcsError):
        case_procs.render_script(root="/home/it's/cases", wsl_case=CASE, mode="probe")
    with pytest.raises(case_procs.CaseProcsError):
        case_procs.render_script(root=ROOT, wsl_case=CASE, mode="nuke")


def test_the_script_matches_with_a_boundary_and_kills_scripts_first():
    text = case_procs.render_script(root=ROOT, wsl_case=CASE, mode="kill", scripts=["solve-pf-0a1b2c3d.sh"])
    # Itself and its parent are never matched.
    assert 'if [ "$pid" = "$SELF" ] || [ "$pid" = "$PARENT" ]; then continue; fi' in text
    # The name after the root ends at /, a space or a quote: run1 never matches run10.
    assert "seg=\"${rest%%[/[:space:]\\'\\\"]*}\"" in text and '[ "$seg" = "$NAME" ]' in text
    # cwd at or below the case copy (a removed folder still counts).
    assert '"${1% (deleted)}"' in text and '[[ "$cwd" == "$CASE"/* ]]' in text
    # No pgrep -x: process names longer than 15 characters exist (changeDictionary).
    assert "pgrep" not in text and '"${n:0:15}"' in text
    body = text.split('killed=0', 1)[1]
    assert body.index("SCRIPT_PIDS[@]") < body.index("OTHER_PIDS[@]")
    assert text.count("sleep 1") == 2 and "_signal TERM" in text and "_signal KILL" in text


def test_a_unique_remote_name_per_call():
    names = {case_procs.remote_script_name() for _ in range(50)}
    assert len(names) == 50
    for name in names:
        assert re.fullmatch(r"/tmp/cfddesk-procs-\d+-[0-9a-f]{16}\.sh", name)


def test_run_script_sends_lf_bytes_through_wsl_e(monkeypatch: pytest.MonkeyPatch):
    seen: dict[str, Any] = {}

    def fake_run(argv: list[str], **kw: Any) -> Any:
        seen["argv"] = argv
        seen["kw"] = kw
        return subprocess.CompletedProcess(argv, 0, b"CASE_PROCS dead\n", b"")

    monkeypatch.setenv("MAGNUSIM_WSL_DISTRO", "Test-Distro")
    monkeypatch.setattr(case_procs.subprocess, "run", fake_run)
    assert case_procs.probe(CASE, ["solve-pf-0a1b2c3d.sh"]) == {"ok": True, "live": False}
    argv = seen["argv"]
    assert argv[:5] == ["wsl", "-d", "Test-Distro", "-e", "bash"] and argv[5] == "-c"
    m = re.fullmatch(r"cat > (\S+) && bash (\S+); ec=\$\?; rm -f (\S+); exit \$ec", argv[6])
    assert m and m.group(1) == m.group(2) == m.group(3) and m.group(1).startswith("/tmp/cfddesk-procs-")
    # The case path is never on a command line (only in the script).
    assert CASE not in " ".join(argv)
    data = seen["kw"]["input"]
    assert isinstance(data, bytes) and b"\r\n" not in data and CASE.encode() in data
    assert seen["kw"]["timeout"] == 12.0


def test_answers(monkeypatch: pytest.MonkeyPatch):
    calls: list[str] = []

    def fake(text: str, *, timeout: float) -> str | None:
        calls.append(text)
        return answers.pop(0)

    monkeypatch.setattr(case_procs, "run_script", fake)
    answers: list[str | None] = ["noise\nCASE_PROCS live\n", "CASE_PROCS dead", None, "garbage", "CASE_PROCS killed 3\n"]
    assert case_procs.probe(CASE) == {"ok": True, "live": True}
    assert case_procs.probe(CASE) == {"ok": True, "live": False}
    assert case_procs.probe(CASE) == {"ok": False}
    assert case_procs.probe(CASE) == {"ok": False}
    assert case_procs.kill(CASE, ["solve-pf-0a1b2c3d.sh"], names=["pimpleFoam"]) == {"ok": True, "killed": 3}
    assert "MODE=kill" in calls[-1] and "NAMES=(pimpleFoam)" in calls[-1]
    # An id start_solve would refuse: nothing can run under it, and WSL is not asked.
    calls.clear()
    assert case_procs.probe("Bad Id") == {"ok": True, "invalid_id": True, "live": False}
    assert case_procs.kill("cfddesk-") == {"ok": True, "invalid_id": True, "killed": 0}
    assert calls == []


def test_the_root(monkeypatch: pytest.MonkeyPatch):
    def no_probe() -> str:
        raise AssertionError("the configured root (and its WSL HOME probe) is not read when Node passes one")

    monkeypatch.setattr(case_procs, "get_wsl_case_root", no_probe)
    monkeypatch.setattr(case_procs, "run_script", lambda text, timeout: "CASE_PROCS dead")
    assert case_procs.probe(CASE) == {"ok": True, "live": False}
    assert case_procs.case_root() == ROOT
    for bad in ("/home/it's/cases", "relative/cases", "/home/__X__/cases", "/home/$u/cases"):
        monkeypatch.setenv("MAGNUSIM_WSL_CASE_ROOT", bad)
        assert case_procs.case_root() is None
        assert case_procs.probe(CASE) == {"ok": False, "error": "the WSL case root is not usable"}
        assert case_procs.kill(CASE)["ok"] is False


def test_the_cli(monkeypatch: pytest.MonkeyPatch, capsys):
    monkeypatch.setattr(case_procs, "run_script", lambda text, timeout: "CASE_PROCS killed 2")
    assert wsl_case_procs.main(["kill", "--wsl-case", CASE, "--script", "solve-pf-0a1b2c3d.sh", "--names", "a,b"]) == 0
    assert json.loads(capsys.readouterr().out) == {"ok": True, "killed": 2}
    monkeypatch.setattr(case_procs, "run_script", lambda text, timeout: None)
    assert wsl_case_procs.main(["probe", "--wsl-case", CASE]) == 1
    assert json.loads(capsys.readouterr().out) == {"ok": False}
    assert wsl_case_procs.main(["probe", "--wsl-case", CASE, "--script", "evil;.sh"]) == 1
    assert json.loads(capsys.readouterr().out)["ok"] is False


# ---------------------------------------------------------------------------
# Real processes in WSL
# ---------------------------------------------------------------------------


def _sh(cmd: str) -> str:
    from cfddesk.wsl.openfoam import run_wsl_bash

    r = run_wsl_bash(cmd, timeout=60)
    assert r.returncode == 0, f"{cmd}\n{r.stdout}\n{r.stderr}"
    return r.stdout


@pytest.fixture
def wsl_root(monkeypatch: pytest.MonkeyPatch):
    tag = uuid.uuid4().hex[:10]
    base = f"/tmp/magnusim-procs-test-{tag}"
    root = f"{base}/cases"
    monkeypatch.setenv("MAGNUSIM_WSL_CASE_ROOT", root)
    _sh(f"mkdir -p {shlex.quote(root)}")
    try:
        yield SimpleRoot(base, root, tag)
    finally:
        from cfddesk.wsl.openfoam import run_wsl_bash

        run_wsl_bash(f"pkill -f {shlex.quote('^h15procs-' + tag)}; rm -rf -- {shlex.quote(base)}", timeout=60)


class SimpleRoot:
    def __init__(self, base: str, root: str, tag: str) -> None:
        self.base, self.root, self.tag = base, root, tag

    def hold(self, name: str, *, cwd: str | None = None, cmd_path: str | None = None, argv0: str | None = None) -> None:
        """A sleeping process named ``h15procs-<tag>-<name>`` (or ``argv0``), working in
        ``cwd`` and/or naming ``cmd_path`` on its command line."""
        q = shlex.quote
        label = argv0 or f"h15procs-{self.tag}-{name}"
        words = f"{label} {cmd_path}" if cmd_path else label
        where = q(cwd) if cwd else "/"
        pat = q(f"^h15procs-{self.tag}-{name}") if not argv0 else q(f"^{argv0}")
        _sh(
            f"mkdir -p {where} && cd {where} && (setsid bash -c {q('exec -a ' + q(words) + ' sleep 300')} </dev/null >/dev/null 2>&1 &); "
            f"for i in $(seq 50); do pgrep -f {pat} >/dev/null && exit 0; sleep 0.1; done; exit 1"
        )


@pytest.mark.wsl
def test_probe_matches_exactly_in_wsl(wsl_root: SimpleRoot):
    r = wsl_root.root
    assert case_procs.probe("cfddesk-w27-run1") == {"ok": True, "live": False}  # never itself
    wsl_root.hold("cwd10", cwd=f"{r}/cfddesk-w27-run10/sub")
    assert case_procs.probe("cfddesk-w27-run1") == {"ok": True, "live": False}
    assert case_procs.probe("cfddesk-w27-run10") == {"ok": True, "live": True}
    # A command line that names the copy, after the copy is gone.
    wsl_root.hold("cmd2", cmd_path=f"{r}/cfddesk-w27-run2/hold")
    assert case_procs.probe("cfddesk-w27-run2") == {"ok": True, "live": True}
    assert case_procs.probe("cfddesk-w27-run") == {"ok": True, "live": False}
    # reconstructPar working in the copy is seen.
    wsl_root.hold("rp", cwd=f"{r}/cfddesk-w27-run3", argv0=f"reconstructPar-{wsl_root.tag}")
    assert case_procs.probe("cfddesk-w27-run3") == {"ok": True, "live": True}
    # A script by its name.
    wsl_root.hold("script", cmd_path=f"/tmp/somewhere-{wsl_root.tag}/solve-pf-0a1b2c3d.sh")
    assert case_procs.probe("cfddesk-w27-run4", ["solve-pf-0a1b2c3d.sh"]) == {"ok": True, "live": True}
    assert case_procs.probe("cfddesk-w27-run4", ["solve-pf-ffffffff.sh"]) == {"ok": True, "live": False}


@pytest.mark.wsl
def test_kill_with_names_and_scripts_in_wsl(wsl_root: SimpleRoot):
    r = wsl_root.root
    wsl_root.hold("a", cwd=f"{r}/cfddesk-w27-run5")
    wsl_root.hold("b", cwd=f"{r}/cfddesk-w27-run5")
    # --names: only processes of those names (the holders are "sleep" processes).
    assert case_procs.kill("cfddesk-w27-run5", names=["pimpleFoam"]) == {"ok": True, "killed": 0}
    assert case_procs.probe("cfddesk-w27-run5")["live"] is True
    assert case_procs.kill("cfddesk-w27-run5", names=["sleep"]) == {"ok": True, "killed": 2}
    assert case_procs.probe("cfddesk-w27-run5") == {"ok": True, "live": False}
    wsl_root.hold("s", cmd_path=f"/tmp/x-{wsl_root.tag}/solve-pf-0a1b2c3d.sh")
    wsl_root.hold("c", cwd=f"{r}/cfddesk-w27-run6")
    out = case_procs.kill("cfddesk-w27-run6", ["solve-pf-0a1b2c3d.sh"])
    assert out == {"ok": True, "killed": 2}
    assert case_procs.probe("cfddesk-w27-run6", ["solve-pf-0a1b2c3d.sh"]) == {"ok": True, "live": False}
