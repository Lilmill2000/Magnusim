"""Stale generate_* processes on the same case folder must be identified."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from cfddesk.mesh.generate_guard import (
    LOCK_NAME,
    _list_generator_rows,
    claim_generate_case,
    descendants_of,
    pids_targeting_case,
    pids_under_projects_root,
    reap_generators_under_root,
)


def test_pids_targeting_case_matches_same_folder_only():
    case = Path(r"C:\proj\meshes\Mesh_1\case")
    self_pid = os.getpid()
    rows = [
        (10, r"python tools\generate_standard.py --case-dir C:\proj\meshes\Mesh_1\case --generate-id old"),
        (11, r"python tools\generate_standard.py --case-dir C:\proj\meshes\Mesh_2\case --generate-id other"),
        (12, r"python tools\generate_standard.py --case-dir C:/proj/meshes/Mesh_1/case --generate-id slash"),
        (13, r"python tools\generate_snappy.py --case-dir C:\proj\meshes\Mesh_1\case"),
        (14, "python notepad.py --case-dir C:\\proj\\meshes\\Mesh_1\\case"),
        (self_pid, r"python tools\generate_standard.py --case-dir C:\proj\meshes\Mesh_1\case --generate-id self"),
    ]
    got = set(pids_targeting_case(rows, case, keep_pids={self_pid}))
    assert got == {10, 12, 13}


def test_lock_name_is_dotfile():
    assert LOCK_NAME == ".generate.lock"


def test_boot_reap_matches_this_projects_root_only():
    # Server boot reaps generators of its own projects folder, never another server's
    # (the user's app, an e2e host on its own root) or a test's.
    root = r"C:\Users\me\Magnusim\projects"
    self_pid = os.getpid()

    def gen(pid, project, case=None, script="generate_standard.py"):
        case = case or project + r"\meshes\Mesh_1\case"
        return (pid, f"python tools\\{script} --project-dir {project} --case-dir {case} --generate-id g{pid}")

    rows = [
        gen(10, root + r"\proj_a"),
        gen(11, r"C:\Users\me\AppData\Local\Temp\magnusim-g1-x\projects\proj_a"),
        gen(12, r"c:/users/ME/magnusim/Projects/proj_b", script="generate_snappy.py"),
        gen(13, r"C:\Users\me\Magnusim\projects2\proj_a"),
        gen(14, root + r"\nested\projects\proj_a"),
        gen(15, root + r"\proj_c", script="generate_cfmesh_standard.py"),
        (16, f"python tools\\generate_standard.py --case-dir {root}\\proj_d\\meshes\\m\\case"),
        (17, r"python tools\generate_standard.py --case-dir C:\Temp\pytest-1\case --prepare-only"),
        (18, f"python notepad.py --project-dir {root}\\proj_a"),
        gen(self_pid, root + r"\proj_a"),
    ]
    assert set(pids_under_projects_root(rows, root, keep_pids={self_pid})) == {10, 12, 15, 16}
    assert set(pids_under_projects_root(rows, root + "\\", keep_pids={self_pid})) == {10, 12, 15, 16}
    assert pids_under_projects_root(rows, "") == []


def test_boot_reap_reads_quoted_paths_with_spaces():
    root = r"C:\Users\me\My Projects"
    rows = [
        (20, rf'python tools\generate_standard.py --project-dir "{root}\proj a" --case-dir "{root}\proj a\case"'),
        (21, r'python tools\generate_standard.py --project-dir "C:\Users\me\My Projects 2\proj a" --case-dir x'),
    ]
    assert pids_under_projects_root(rows, root) == [20]


def _fake_generator(tools: Path, project: Path) -> subprocess.Popen:
    case = project / "meshes" / "Mesh_1" / "case"
    return subprocess.Popen(
        [sys.executable, str(tools / "generate_standard.py"), "--project-dir", str(project), "--case-dir", str(case)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _wait(pred, timeout: float) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.25)
    return pred()


@pytest.mark.skipif(sys.platform != "win32", reason="generator processes are listed on Windows only")
def test_boot_reap_kills_this_roots_generator_and_spares_another_roots(tmp_path: Path):
    # Real processes: a server booting on "mine" must leave the generator meshing in
    # "other" (the user's app on another port) running and kill its own leftover.
    tools = tmp_path / "tools"
    tools.mkdir()
    (tools / "generate_standard.py").write_text("import time\ntime.sleep(300)\n", encoding="utf-8")
    mine = tmp_path / "mine" / "projects"
    other = tmp_path / "other app" / "projects"
    procs = {
        "mine": _fake_generator(tools, mine / "proj_a"),
        "other": _fake_generator(tools, other / "proj_a"),
        "sibling": _fake_generator(tools, tmp_path / "mine" / "projects2" / "proj_a"),
    }
    try:
        seen = lambda: {p.pid for p in procs.values()} <= {pid for pid, _ in _list_generator_rows()}  # noqa: E731
        assert _wait(seen, 30), "fake generators never showed up in the process list"
        killed = reap_generators_under_root(str(mine))
        assert procs["mine"].pid in killed
        assert procs["other"].pid not in killed and procs["sibling"].pid not in killed
        assert _wait(lambda: procs["mine"].poll() is not None, 15), "this root's generator still running"
        time.sleep(1.0)
        assert procs["other"].poll() is None, "another projects root's generator was killed"
        assert procs["sibling"].poll() is None, "a sibling root's generator was killed"
    finally:
        for p in procs.values():
            if p.poll() is None:
                subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True, check=False)
            p.wait(timeout=15)


def test_descendants_of_walks_the_whole_subtree_only():
    parents = {10: 1, 11: 10, 12: 11, 13: 10, 20: 1, 21: 20, 5: 5}
    assert descendants_of(parents, 10) == {11, 12, 13}
    assert descendants_of(parents, 20) == {21}
    assert descendants_of(parents, 99) == set()


@pytest.mark.skipif(sys.platform != "win32", reason="generator processes are listed on Windows only")
def test_boot_reap_spares_what_the_server_started_itself(tmp_path: Path):
    # The server boots after the registry loads, so a Generate can come first; and a
    # dev reload boots again in the same process. Its own meshers are not leftovers.
    tools = tmp_path / "tools"
    tools.mkdir()
    (tools / "generate_standard.py").write_text("import time\ntime.sleep(300)\n", encoding="utf-8")
    root = tmp_path / "projects"
    own = _fake_generator(tools, root / "proj_own")
    # A leftover: started through a shell that has exited, as a dead server's mesher is.
    left_project = root / "proj_left"
    left_case = left_project / "meshes" / "Mesh_1" / "case"
    subprocess.run(
        ["cmd", "/c", "start", "", "/b", sys.executable, str(tools / "generate_standard.py"),
         "--project-dir", str(left_project), "--case-dir", str(left_case)],
        check=True,
    )

    def left_pid() -> int | None:
        for pid, cmd in _list_generator_rows():
            if "proj_left" in cmd:
                return pid
        return None

    try:
        assert _wait(lambda: left_pid() is not None and own.pid in {p for p, _ in _list_generator_rows()}, 30)
        leftover = left_pid()
        killed = reap_generators_under_root(str(root), spare_descendants_of=os.getpid())
        assert leftover in killed
        assert own.pid not in killed
        time.sleep(1.0)
        assert own.poll() is None, "the server's own mesher was killed"
        assert _wait(lambda: left_pid() is None, 15), "the leftover mesher still runs"
    finally:
        if own.poll() is None:
            subprocess.run(["taskkill", "/PID", str(own.pid), "/T", "/F"], capture_output=True, check=False)
        own.wait(timeout=15)
        stray = left_pid()
        if stray:
            subprocess.run(["taskkill", "/PID", str(stray), "/T", "/F"], capture_output=True, check=False)


@pytest.mark.skipif(sys.platform != "win32", reason="generator processes are listed on Windows only")
def test_claim_kills_a_leftover_on_this_case_only(tmp_path: Path):
    # A generator reaps a leftover on its own case folder itself (the server no longer
    # lists processes before the spawn): the other mesh's generator keeps running.
    tools = tmp_path / "tools"
    tools.mkdir()
    (tools / "generate_standard.py").write_text("import time\ntime.sleep(300)\n", encoding="utf-8")
    project = tmp_path / "projects" / "proj_a"
    procs = {
        "leftover": _fake_generator(tools, project),
        "other": subprocess.Popen(
            [sys.executable, str(tools / "generate_standard.py"), "--project-dir", str(project),
             "--case-dir", str(project / "meshes" / "Mesh_2" / "case")],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ),
    }
    case = project / "meshes" / "Mesh_1" / "case"
    try:
        seen = lambda: {p.pid for p in procs.values()} <= {pid for pid, _ in _list_generator_rows()}  # noqa: E731
        assert _wait(seen, 30), "fake generators never showed up in the process list"
        killed = claim_generate_case(case, generate_id="g-new", mesh_id="mesh_1")
        assert procs["leftover"].pid in killed
        assert procs["other"].pid not in killed
        assert _wait(lambda: procs["leftover"].poll() is not None, 15), "the leftover on this case still runs"
        time.sleep(1.0)
        assert procs["other"].poll() is None, "another mesh's generator was killed"
        lock = json.loads((case / LOCK_NAME).read_text(encoding="utf-8"))
        assert lock["pid"] == os.getpid() and lock["generate_id"] == "g-new"
    finally:
        for p in procs.values():
            if p.poll() is None:
                subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True, check=False)
            p.wait(timeout=15)
