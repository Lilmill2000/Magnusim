"""Keep one generate_* process per mesh case folder.

A killed wrapper used to leave a child ``generate_standard.py`` filling tets
on the same ``--case-dir``. The next Generate then raced it and could be
overwritten. Reap any other generator whose cmdline points at this case.

At server boot, reap only generators working in this server's projects folder:
the user's app, an e2e host on its own root or a test may be meshing elsewhere
on the same machine at the same moment.
"""

from __future__ import annotations

import json
import ntpath
import os
import re
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


def _norm_path(s: str) -> str:
    """A Windows path, lower case, ``/`` as ``\\``, no trailing separator."""
    p = str(s or "").strip().strip('"')
    if not p:
        return ""
    return ntpath.normpath(p).rstrip("\\").lower()


def _arg_value(cmd: str, flag: str) -> str:
    """The value after ``flag`` in a command line ("quoted" when it has spaces)."""
    m = re.search(r'(?:^|\s)' + re.escape(flag) + r'(?:=|\s+)(?:"([^"]*)"|(\S+))', str(cmd or ""))
    if not m:
        return ""
    return m.group(1) if m.group(1) is not None else m.group(2)


def pids_under_projects_root(
    rows: list[tuple[int, str]],
    projects_root: Path | str,
    *,
    keep_pids: set[int] | None = None,
) -> list[int]:
    """Return PIDs whose command is a mesh generator for a project under ``projects_root``.

    The server passes ``--project-dir <root>\\<project id>``: the project folder's
    parent must be the root itself, so a sibling (``projects2``) or a root nested
    inside this one belongs to another server. Without ``--project-dir`` the
    ``--case-dir`` must lie under the root.
    """
    keep = set(keep_pids or ())
    root = _norm_path(str(projects_root or ""))
    if not root:
        return []
    out: list[int] = []
    for pid, cmd in rows:
        try:
            n = int(pid)
        except (TypeError, ValueError):
            continue
        if n <= 0 or n in keep:
            continue
        if not any(name in _norm(cmd) for name in GENERATOR_SCRIPTS):
            continue
        project_dir = _norm_path(_arg_value(cmd, "--project-dir"))
        if project_dir:
            mine = ntpath.dirname(project_dir).rstrip("\\") == root
        else:
            mine = _norm_path(_arg_value(cmd, "--case-dir")).startswith(root + "\\")
        if mine:
            out.append(n)
    return out


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
    # [char]9, not `t: a backtick escape is literal inside '...', and with it no
    # row ever split (every reap found nothing). UTF-8 keeps non-ASCII paths matchable.
    script = (
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; "
        "Get-CimInstance Win32_Process | "
        "Where-Object { $_.CommandLine -and ("
        "$_.CommandLine -like '*generate_standard.py*' -or "
        "$_.CommandLine -like '*generate_snappy.py*' -or "
        "$_.CommandLine -like '*generate_cfmesh_standard.py*'"
        ") } | "
        "ForEach-Object { '{0}{1}{2}' -f $_.ProcessId, [char]9, $_.CommandLine }"
    )
    try:
        r = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
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


def descendants_of(parents: dict[int, int], root_pid: int) -> set[int]:
    """Every process below ``root_pid`` in a pid -> parent pid map (not the root itself)."""
    children: dict[int, list[int]] = {}
    for pid, ppid in parents.items():
        if pid != ppid:
            children.setdefault(ppid, []).append(pid)
    out: set[int] = set()
    todo = list(children.get(root_pid, []))
    while todo:
        pid = todo.pop()
        if pid in out:
            continue
        out.add(pid)
        todo.extend(children.get(pid, []))
    return out


def _process_parents() -> dict[int, int]:
    """pid -> parent pid for every process (Windows), else {}."""
    if sys.platform != "win32":
        return {}
    script = (
        "Get-CimInstance Win32_Process | "
        "ForEach-Object { '{0}{1}{2}' -f $_.ProcessId, [char]9, $_.ParentProcessId }"
    )
    try:
        r = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            text=True,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {}
    out: dict[int, int] = {}
    for line in (r.stdout or "").splitlines():
        a, _, b = line.partition("\t")
        try:
            out[int(a)] = int(b)
        except ValueError:
            continue
    return out


def reap_generators_under_root(
    projects_root: Path | str,
    *,
    keep_pids: set[int] | None = None,
    spare_descendants_of: int | None = None,
) -> list[int]:
    """Kill generate_* processes left running in this projects folder (server boot).

    Generators for any other projects folder, or for no project at all (tests),
    are left alone. ``spare_descendants_of`` is the server's own pid: a mesh it
    already started (a Generate before its boot ran, or the instance a dev
    reload replaced in the same process) is its own work, not a leftover.
    """
    keep = set(keep_pids or ())
    keep.add(os.getpid())
    try:
        keep.add(os.getppid())
    except OSError:
        pass
    if spare_descendants_of:
        keep |= descendants_of(_process_parents(), int(spare_descendants_of))
    killed: list[int] = []
    for pid in pids_under_projects_root(_list_generator_rows(), projects_root, keep_pids=keep):
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
