"""Run a written case's OpenFOAM steps in a fresh /tmp folder in WSL (the wsl tests).

The case is copied in, each step runs there with its output in ``log.<tool>``,
and the logs, the saved times and the start folder (as ``0.after``) come back
beside the case. The /tmp folder is removed afterwards.
"""

from __future__ import annotations

from pathlib import Path

SCRIPT = """#!/usr/bin/env bash
set -u
SRC="{src}"
D=$(mktemp -d /tmp/iff-case-XXXXXX)
cp -a "$SRC/." "$D/"
cd "$D" || exit 47
EC=0
{steps}
cp -f "$D"/log.* "$SRC/" 2>/dev/null
rm -rf "$SRC/0.after"
cp -a "$D/0" "$SRC/0.after"
for t in "$D"/[0-9]*; do
  n=$(basename "$t")
  [ "$n" = "0" ] && continue
  [ -d "$t" ] && rm -rf "$SRC/$n" && cp -a "$t" "$SRC/$n"
done
cd / && rm -rf "$D"
exit $EC
"""

STEP = """if [ "$EC" -eq 0 ]; then
  openfoam2606 {cmd} > log.{tool} 2>&1
  EC=$?
fi"""


def run_steps(case: Path, commands: list[str], *, timeout: float = 600.0) -> int:
    """Run ``commands`` (each an OpenFOAM program and its flags) on a /tmp copy of ``case``."""
    from cfddesk.wsl.mesh_run import windows_to_wsl_path
    from cfddesk.wsl.openfoam import run_wsl_bash

    steps = "\n".join(STEP.format(cmd=c, tool=c.split()[0]) for c in commands)
    script = case / "run-tmp.sh"
    script.write_bytes(SCRIPT.format(src=windows_to_wsl_path(case), steps=steps).encode("utf-8"))
    result = run_wsl_bash(f"bash '{windows_to_wsl_path(script)}'", timeout=timeout)
    return result.returncode


def log(case: Path, tool: str) -> str:
    p = case / f"log.{tool}"
    return p.read_text(encoding="utf-8", errors="replace") if p.is_file() else ""
