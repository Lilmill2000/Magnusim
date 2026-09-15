"""Parallel OpenFOAM solve path: clean → decompose → mpirun → reconstruct.

AmgX is serial-only (N=1); callers must refuse AmgX+N>1 before entering here.
"""

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


def clean_processor_dirs(wsl_case: str) -> ParallelStepResult:
    """Remove stale processor* before decompose (N changes leave orphans)."""
    cmd = (
        f"cd {shlex.quote(wsl_case)} && "
        r"rm -rf processor*[0-9]* && echo CLEAN_OK"
    )
    r = run_wsl_bash(cmd, timeout=120.0)
    text = (r.stdout or "") + (r.stderr or "")
    ok = "CLEAN_OK" in text and r.returncode == 0
    return ParallelStepResult("clean_processor", ok, text, detail=text[-500:])


def run_decompose_par(wsl_case: str, *, log_name: str = "log.decomposePar") -> ParallelStepResult:
    log_q = shlex.quote(log_name)
    dest = shlex.quote(wsl_case)
    inner = (
        f"cd {dest} && : > {log_q} && "
        f"openfoam2606 bash -c {shlex.quote(f'cd {wsl_case} && decomposePar > {log_name} 2>&1')}"
    )
    r = run_wsl_bash(inner, timeout=600.0)
    cat = run_wsl_bash(f"cat {dest}/{log_q} 2>/dev/null || true", timeout=60.0)
    text = cat.stdout or ""
    ok = (
        "End" in text
        or "Finished decomposing" in text
        or ("nCells" in text and "FOAM FATAL" not in text)
    ) and "FOAM FATAL" not in text
    if not ok and r.returncode == 0 and "processor" in text.lower():
        ok = "FOAM FATAL" not in text
    return ParallelStepResult("decomposePar", ok, text)


def run_reconstruct_par(
    wsl_case: str, *, log_name: str = "log.reconstructPar"
) -> ParallelStepResult:
    log_q = shlex.quote(log_name)
    dest = shlex.quote(wsl_case)
    inner = (
        f"cd {dest} && : > {log_q} && "
        f"openfoam2606 bash -c {shlex.quote(f'cd {wsl_case} && reconstructPar -latestTime > {log_name} 2>&1')}"
    )
    r = run_wsl_bash(inner, timeout=600.0)
    cat = run_wsl_bash(f"cat {dest}/{log_q} 2>/dev/null || true", timeout=60.0)
    text = cat.stdout or ""
    ok = "FOAM FATAL" not in text and (
        "End" in text or "Reconstructing" in text or r.returncode == 0
    )
    return ParallelStepResult("reconstructPar", ok, text)


def mpirun_simplefoam_inner(
    wsl_case: str, *, n: int, log_name: str, backend: str
) -> str:
    """Bash fragment: prepare fvSolution + mpirun simpleFoam -parallel → log file."""
    log_q = shlex.quote(log_name)
    dest_q = shlex.quote(wsl_case)
    foam_inner = (
        "export AMGX_DIR=${AMGX_DIR:-$HOME/cfd/builds/amgx-install}; "
        "export PETSC_DIR=${PETSC_DIR:-$HOME/cfd/builds/petsc}; "
        "export PETSC_ARCH=${PETSC_ARCH:-linux-gnu-cuda-opt}; "
        "export PETSC_OPTIONS='-use_gpu_aware_mpi 0'; "
        "export LD_LIBRARY_PATH=$AMGX_DIR/lib:"
        "$PETSC_DIR/$PETSC_ARCH/lib:"
        "${FOAM_USER_LIBBIN}:${FOAM_LIBBIN}:/usr/local/cuda/lib64:"
        "${LD_LIBRARY_PATH}; "
        f"cd {shlex.quote(wsl_case)} && "
        f"mpirun -np {int(n)} simpleFoam -parallel > {log_q} 2>&1"
    )
    return (
        f"cd {dest_q} && "
        f"if [[ -f system/fvSolution.{backend} ]]; then "
        f"cp -f system/fvSolution.{backend} system/fvSolution; fi; "
        f": > {log_q}; "
        f"openfoam2606 bash -c {shlex.quote(foam_inner)}"
    )


def kill_mpirun_tree(wsl_case: str) -> ParallelStepResult:
    """Kill mpirun + solver/mesh ranks for this case (Force Stop).

    Covers simpleFoam/pimpleFoam (solve) and snappyHexMesh (parallel mesh) plus mpirun.
    Matches by cmdline *or* /proc/PID/cwd == case (snappy argv often omits the
    case path). Writes a real ``.sh`` under /tmp and runs it — never inline
    ``pkill -f run_snappy_parallel.sh`` (that self-matches the killer cmdline).
    """
    import hashlib
    import tempfile
    from pathlib import Path

    case_q = shlex.quote(wsl_case)
    script = f"""#!/usr/bin/env bash
set -uo pipefail
CASE={case_q}
kill_case_procs() {{
  local sig="$1"
  pkill -$sig -f "simpleFoam.*$CASE" 2>/dev/null || true
  pkill -$sig -f "pimpleFoam.*$CASE" 2>/dev/null || true
  pkill -$sig -f "mpirun.*$CASE" 2>/dev/null || true
  pkill -$sig -f "snappyHexMesh.*$CASE" 2>/dev/null || true
  for pid in $(pgrep -f 'simpleFoam|pimpleFoam|snappyHexMesh|mpirun' 2>/dev/null || true); do
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


def run_potential_foam(
    wsl_case: str, *, log_name: str = "log.potentialFoam"
) -> ParallelStepResult:
    """potentialFoam with log-file redirect; scan log, never trust RC alone."""
    log_q = shlex.quote(log_name)
    dest = shlex.quote(wsl_case)
    foam_inner = (
        f"cd {shlex.quote(wsl_case)} && "
        f"potentialFoam -writep -initialiseUBCs > {log_q} 2>&1"
    )
    inner = (
        f"cd {dest} && : > {log_q} && "
        f"openfoam2606 bash -c {shlex.quote(foam_inner)}"
    )
    run_wsl_bash(inner, timeout=600.0)
    cat = run_wsl_bash(f"cat {dest}/{log_q} 2>/dev/null || true", timeout=60.0)
    text = cat.stdout or ""
    ok = "FOAM FATAL" not in text and (
        "End" in text or "Writing" in text or "potentialFoam" in text
    )
    return ParallelStepResult("potentialFoam", ok, text)
