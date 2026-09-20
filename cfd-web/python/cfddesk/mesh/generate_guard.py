"""Keep one generate_* process per mesh case folder.

A killed wrapper used to leave a child ``generate_standard.py`` filling tets
on the same ``--case-dir``. The next Generate then raced it and could be
overwritten. Reap any other generator whose cmdline points at this case.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

LOCK_NAME = ".generate.lock"
GENERATOR_SCRIPTS = (
    "generate_standard.py",
    "generate_snappy.py",
    "generate_cfmesh_standard.py",
)


def _norm(s: str) -> str:
    return str(s or "").replace("/", "\\").lower()


def pids_targeting_case(
    rows: list[tuple[int, str]],
    case_dir: Path | str,
    *,
    keep_pids: set[int] | None = None,
) -> list[int]:
    """Return PIDs whose command is a mesh generator for ``case_dir``."""
    keep = set(keep_pids or ())
    needle = _norm(str(Path(case_dir)))
    if not needle:
        return []
    out: list[int] = []
    for pid, cmd in rows:
        try:
            n = int(pid)
        except (TypeError, ValueError):
            continue
        if n <= 0 or n in keep:
            continue
        c = _norm(cmd)
        if not any(name in c for name in GENERATOR_SCRIPTS):
            continue
        if needle in c:
            out.append(n)
    return out


def kill_pid_tree(pid: int) -> None:
    n = int(pid)
    if n <= 0:
        return
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/PID", str(n), "/T", "/F"],
            check=False,
            capture_output=True,
            timeout=15,
        )
        return
    try:
        os.kill(n, 9)
    except OSError:
        pass


def _list_generator_rows() -> list[tuple[int, str]]:
    if sys.platform != "win32":
        return []
    script = (
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.CommandLine -and ("
        "$_.CommandLine -like '*generate_standard.py*' -or "
        "$_.CommandLine -like '*generate_snappy.py*' -or "
        "$_.CommandLine -like '*generate_cfmesh_standard.py*'"
        ") } | "
        "ForEach-Object { '{0}`t{1}' -f $_.ProcessId, $_.CommandLine }"
    )
    try:
        r = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    rows: list[tuple[int, str]] = []
    for line in (r.stdout or "").splitlines():
        if "\t" not in line:
            continue
        pid_s, cmd = line.split("\t", 1)
        try:
            rows.append((int(pid_s), cmd))
        except ValueError:
            continue
    return rows


def reap_all_generators(*, keep_pids: set[int] | None = None) -> list[int]:
    """Kill every generate_* process (server boot / leftover after a restart)."""
    keep = set(keep_pids or ())
    keep.add(os.getpid())
    try:
        keep.add(os.getppid())
    except OSError:
        pass
    killed: list[int] = []
    for pid, cmd in _list_generator_rows():
        if pid in keep:
            continue
        if not any(name in _norm(cmd) for name in GENERATOR_SCRIPTS):
            continue
        kill_pid_tree(pid)
        killed.append(pid)
    return killed


def reap_stale_generators(case_dir: Path | str, *, keep_pids: set[int] | None = None) -> list[int]:
    """Kill other generate_* processes targeting this case folder."""
    keep = set(keep_pids or ())
    keep.add(os.getpid())
    try:
        keep.add(os.getppid())
    except OSError:
        pass
    killed: list[int] = []
    for pid in pids_targeting_case(_list_generator_rows(), case_dir, keep_pids=keep):
        kill_pid_tree(pid)
        killed.append(pid)
    return killed


def claim_generate_case(
    case_dir: Path | str,
    *,
    generate_id: str,
    mesh_id: str = "",
) -> list[int]:
    dest = Path(case_dir)
    dest.mkdir(parents=True, exist_ok=True)
    keep = {os.getpid()}
    try:
        keep.add(os.getppid())
    except OSError:
        pass
    killed = reap_stale_generators(dest, keep_pids=keep)
    lock = dest / LOCK_NAME
    if lock.is_file():
        try:
            prev = json.loads(lock.read_text(encoding="utf-8"))
            pid = int(prev.get("pid") or 0)
            if pid and pid not in keep:
                kill_pid_tree(pid)
                killed.append(pid)
        except (OSError, ValueError, json.JSONDecodeError):
            pass
    lock.write_text(
        json.dumps(
            {
                "pid": os.getpid(),
                "generate_id": str(generate_id or ""),
                "mesh_id": str(mesh_id or ""),
            }
        ),
        encoding="utf-8",
    )
    return killed


def release_generate_case(case_dir: Path | str, *, generate_id: str) -> None:
    lock = Path(case_dir) / LOCK_NAME
    if not lock.is_file():
        return
    try:
        prev = json.loads(lock.read_text(encoding="utf-8"))
        if str(prev.get("generate_id") or "") != str(generate_id or ""):
            return
        if int(prev.get("pid") or 0) not in (os.getpid(), 0):
            return
        lock.unlink()
    except (OSError, ValueError, json.JSONDecodeError):
        pass
