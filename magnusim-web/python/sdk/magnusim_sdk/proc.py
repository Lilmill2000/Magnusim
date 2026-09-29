"""Run a program with a timeout; stopping it stops everything it started."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class ExeResult:
    returncode: int | None
    stdout: str
    stderr: str
    timed_out: bool


def kill_tree(pid: int) -> None:
    """Kill ``pid`` and every process it started."""
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/PID", str(int(pid)), "/T", "/F"],
            capture_output=True,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    else:
        try:
            os.killpg(os.getpgid(int(pid)), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass


def run_exe(
    args: Sequence[str | os.PathLike[str]],
    *,
    stdin: str | None = None,
    timeout: float | None = None,
    cwd: str | os.PathLike[str] | None = None,
    env: Mapping[str, str] | None = None,
) -> ExeResult:
    """Run ``args`` to completion (text I/O). On timeout the whole process tree is killed."""
    kwargs: dict[str, Any] = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0
        )
    else:
        kwargs["start_new_session"] = True
    proc = subprocess.Popen(
        [str(a) for a in args],
        stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(Path(cwd)) if cwd is not None else None,
        env=dict(env) if env is not None else None,
        text=True,
        **kwargs,
    )
    try:
        out, err = proc.communicate(input=stdin, timeout=timeout)
        return ExeResult(proc.returncode, out or "", err or "", False)
    except subprocess.TimeoutExpired:
        kill_tree(proc.pid)
        out, err = proc.communicate()
        return ExeResult(None, out or "", err or "", True)
