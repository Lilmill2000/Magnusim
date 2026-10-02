"""Force Stop for parallel runs: kill mpirun and the ranks of one case."""

from __future__ import annotations

import shlex
from dataclasses import dataclass

from cfddesk.wsl.openfoam import run_wsl_bash


@dataclass(frozen=True)
class ParallelStepResult:
    name: str
    ok: bool
    log_text: str
    detail: str = ""


def kill_mpirun_tree(wsl_case: str, process_names: tuple[str, ...]) -> ParallelStepResult:
    """Kill mpirun + solver/mesh ranks for this case (Force Stop).

    Covers the run's solver processes (its launch spec's process names) and
    snappyHexMesh (parallel mesh) plus mpirun.
    Matches by cmdline *or* /proc/PID/cwd == case (snappy argv often omits the
    case path). Writes a real ``.sh`` under /tmp and runs it — never inline
    ``pkill -f <pattern>`` (that self-matches the killer cmdline).
    """
    import hashlib
    import re
    import tempfile
    from pathlib import Path

    names = [n for n in (*process_names, "mpirun", "snappyHexMesh") if re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", n)]
    case_q = shlex.quote(wsl_case)
    pkills = "\n".join(f'  pkill -$sig -f "{n}.*$CASE" 2>/dev/null || true' for n in names)
    alt = "|".join(names)
    script = f"""#!/usr/bin/env bash
set -uo pipefail
CASE={case_q}
kill_case_procs() {{
  local sig="$1"
{pkills}
  for pid in $(pgrep -f '{alt}' 2>/dev/null || true); do
    [ -d "/proc/$pid" ] || continue
    cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)
    if [ "$cwd" = "$CASE" ]; then
      kill -$sig "$pid" 2>/dev/null || true
    fi
  done
}}
kill_case_procs TERM
sleep 1
kill_case_procs KILL
echo KILL_DONE
"""
    tag = hashlib.sha1(wsl_case.encode("utf-8")).hexdigest()[:12]
    remote = f"/tmp/cfddesk-kill-{tag}.sh"
    with tempfile.TemporaryDirectory(prefix="cfddesk-kill-") as td:
        local = Path(td) / "kill.sh"
        local.write_bytes(script.replace("\r\n", "\n").encode("utf-8"))
        # Staging via /mnt/c is OK for a tiny script; execution is on ext4 /tmp.
        from cfddesk.wsl.mesh_run import windows_to_wsl_path

        src = windows_to_wsl_path(local)
        r = run_wsl_bash(
            f"cp -f {shlex.quote(src)} {shlex.quote(remote)} && "
            f"chmod +x {shlex.quote(remote)} && "
            f"bash {shlex.quote(remote)}; ec=$?; "
            f"rm -f {shlex.quote(remote)}; exit $ec",
            timeout=30.0,
        )
    text = (r.stdout or "") + (r.stderr or "")
    ok = "KILL_DONE" in text
    return ParallelStepResult("kill_mpirun_tree", ok, text, detail=text[-500:])
