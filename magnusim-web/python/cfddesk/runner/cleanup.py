"""Remove Magnusim's WSL scratch cases once they are finished.

Every mesh and solve works in its own copy under the WSL case root
(``~/cases/<id>``) and copies what it made back to the Windows case. Nothing
reads that copy afterwards: the next job on the same id starts with
``rm -rf`` and a fresh copy. Left alone they filled ~115 GB in 11 days.

- :func:`remove_wsl_case`: a job that succeeded removes its own copy.
- :func:`prune_wsl_cases`: the server's background sweep for the rest (failed,
  stopped or interrupted runs): cases nothing has touched for a day and no
  process holds. ``templates/prune_cases.sh`` says exactly what is kept.
"""

from __future__ import annotations

import json
import shlex
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from cfddesk.runner.case_id import assert_safe_wsl_case_dest, wsl_case_path
from cfddesk.wsl.config import get_wsl_case_root, get_wsl_distro
from cfddesk.wsl.mesh_run import windows_to_wsl_path
from cfddesk.wsl.openfoam import run_wsl_bash

DEFAULT_MAX_AGE_HOURS = 24.0
_PRUNE_SH = Path(__file__).resolve().parents[1] / "wsl" / "templates" / "prune_cases.sh"
_RESULT_PREFIX = "PRUNE_RESULT "


def remove_wsl_case(wsl_case_id: str, *, timeout: float = 300.0) -> bool:
    """Delete one finished job's WSL copy. Best effort: False when it could not."""
    dest = assert_safe_wsl_case_dest(wsl_case_path(wsl_case_id))
    try:
        r = run_wsl_bash(f"rm -rf -- {shlex.quote(dest)}", timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0


def prune_script_text() -> str:
    raw = _PRUNE_SH.read_text(encoding="utf-8").lstrip("\ufeff")
    return raw.replace("\r\n", "\n").replace("\r", "\n")


def parse_prune_output(text: str) -> dict[str, Any]:
    for line in reversed((text or "").splitlines()):
        line = line.strip()
        if line.startswith(_RESULT_PREFIX):
            try:
                doc = json.loads(line[len(_RESULT_PREFIX) :])
            except json.JSONDecodeError:
                break
            if isinstance(doc, dict):
                return doc
    return {"ok": False, "error": "no result from the WSL sweep", "output": (text or "")[-2000:]}


def prune_wsl_cases(
    *,
    max_age_hours: float = DEFAULT_MAX_AGE_HOURS,
    dry_run: bool = False,
    root: str | None = None,
    timeout: float = 3600.0,
) -> dict[str, Any]:
    """Remove finished cases under the WSL case root; return the sweep's counts.

    ``max_age_hours`` 0 removes every case no process holds (tests use it: ctime
    cannot be set back, so "old" cannot be faked).
    """
    if max_age_hours < 0:
        raise ValueError(f"max_age_hours must be >= 0, got {max_age_hours!r}")
    case_root = (root or get_wsl_case_root()).rstrip("/")
    minutes = int(round(max_age_hours * 60))
    with tempfile.TemporaryDirectory(prefix="magnusim-prune-") as td:
        sh = Path(td) / "prune_cases.sh"
        sh.write_bytes(prune_script_text().encode("utf-8"))
        # -e: no login shell in between, so the root reaches the script as one
        # argument, exactly as given (the script checks it).
        argv = [
            "wsl",
            "-d",
            get_wsl_distro(),
            "-e",
            "bash",
            windows_to_wsl_path(sh),
            case_root,
            str(minutes),
            "1" if dry_run else "0",
        ]
        try:
            r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return {"ok": False, "error": str(exc), "root": case_root}
    doc = parse_prune_output((r.stdout or "") + "\n" + (r.stderr or ""))
    doc["root"] = case_root
    doc["max_age_hours"] = max_age_hours
    return doc
