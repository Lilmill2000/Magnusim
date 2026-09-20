"""Sync case tree to WSL ext4 and run OpenFOAM mesh utilities.

Parallel snappy (N>1): blockMesh → clean processor* → decomposePar →
mpirun snappyHexMesh -parallel → reconstructParMesh -constant → clean →
checkMesh. On complex geometry parallel snappy is often only 3–6× faster
than serial, not N×, because of load imbalance during refine/snap.
"""

from __future__ import annotations

import re
import shlex
import time
from dataclasses import dataclass, field
from pathlib import Path

from cfddesk.wsl.openfoam import WslCommandResult, run_wsl_bash

# Do not import cfddesk.runner.* at module level — runner.sync imports
# windows_to_wsl_path from this module (circular).

# Parallel snappy script name (written on Windows case, synced to ext4).
_SNAPPY_PARALLEL_SH = "run_snappy_parallel.sh"
_GMSH_STANDARD_SH = "run_gmsh_standard.sh"
_CFMESH_STANDARD_SH = "run_cfmesh_standard.sh"
_STANDARD_SH = "run_standard_mesh.sh"
_TEMPLATES = Path(__file__).resolve().parent / "templates"


def _read_mesh_template(name: str) -> str:
    """Load a bash body from `cfddesk/wsl/templates/` (LF, no BOM)."""
    raw = (_TEMPLATES / name).read_text(encoding="utf-8")
    if raw.startswith("\ufeff"):
        raw = raw.lstrip("\ufeff")
    return raw.replace("\r\n", "\n")


def _write_lf(path: Path, text: str) -> None:
    path.write_bytes(text.replace("\r\n", "\n").encode("utf-8"))


def windows_to_wsl_path(win_path: Path) -> str:
    """Convert ``C:\\...`` to ``/mnt/c/...`` for staging only (not for solving)."""
    win_path = Path(win_path).resolve()
    posix = win_path.as_posix()
    if len(posix) >= 2 and posix[1] == ":":
        drive = posix[0].lower()
        rest = posix[2:]
        if rest.startswith("/"):
            rest = rest[1:]
        return f"/mnt/{drive}/{rest}"
    return posix


@dataclass
class MeshRunResult:
    wsl_case: str
    blockMesh: WslCommandResult
    snappyHexMesh: WslCommandResult
    checkMesh: WslCommandResult
    n_cells: int | None
    check_ok: bool
    summary: str
    n_cpus: int = 1
    wall_s: float = 0.0
    extra_logs: dict[str, str] = field(default_factory=dict)
    n_points: int | None = None

    def detail_text(self) -> str:
        """Full stdout/stderr for UI + project log."""
        parts = [
            self.summary,
            f"wsl_case={self.wsl_case}",
            f"n_cpus={self.n_cpus}",
            f"wall_s={self.wall_s:.1f}",
        ]
        for name, res in (
            ("blockMesh", self.blockMesh),
            ("snappyHexMesh", self.snappyHexMesh),
            ("checkMesh", self.checkMesh),
        ):
            parts.append(f"\n===== {name} rc={res.returncode} =====")
            if res.stdout:
                parts.append("--- stdout ---")
                parts.append(res.stdout)
            if res.stderr:
                parts.append("--- stderr ---")
                parts.append(res.stderr)
        for name, text in self.extra_logs.items():
            parts.append(f"\n===== {name} =====")
            parts.append(text)
        return "\n".join(parts)


def _parse_mesh_count(check_stdout: str, label: str) -> int | None:
    prefix = f"{label}:"
    for line in check_stdout.splitlines():
        line = line.strip()
        if line.startswith(prefix):
            try:
                return int(line.split()[1])
            except (IndexError, ValueError):
                return None
    return None


def _parse_n_cells(check_stdout: str) -> int | None:
    return _parse_mesh_count(check_stdout, "cells")


def _parse_n_points(check_stdout: str) -> int | None:
    return _parse_mesh_count(check_stdout, "points")


def _checkmesh_ok(stdout: str, *, allow_skew: bool = False) -> bool:
    """Gate A2: require Mesh OK / Failed 0.

    When ``allow_skew`` is True (layers and/or explicit feature snap), a
    *single* skewness-only failure is accepted — industrial CAD + feature
    refinement routinely leaves a handful of high-skew faces while topology /
    non-ortho stay clean. Any other checkMesh failure still fails hard.
    """
    if "Failed 0 mesh checks" in stdout or "***Failed 0 mesh checks" in stdout:
        return True
    if "Mesh OK." in stdout and "Failed" not in stdout:
        return True
    if allow_skew and _checkmesh_skew_only(stdout):
        return True
    return False


def _checkmesh_skew_only(stdout: str) -> bool:
    """True when failures are only industrial quality (skew / few slivers).

    Prism skins and tet peels routinely leave a handful of high-skew faces
    and the odd high-aspect-ratio cell. Topology / openness / holes still
    fail hard. At most two failed checks; high-AR count must be ≤ 8.
    """
    m = re.search(r"Failed\s+(\d+)\s+mesh checks", stdout)
    if not m or not (1 <= int(m.group(1)) <= 2):
        return False
    stars = [ln.strip() for ln in stdout.splitlines() if ln.strip().startswith("***")]
    if not stars:
        return False
    for ln in stars:
        low = ln.lower()
        if "skewness" in low or "highly skew" in low:
            continue
        if "high aspect ratio" in low:
            n = re.search(r"number of cells\s+(\d+)", ln, flags=re.I)
            if n and int(n.group(1)) <= 8:
                continue
            return False
        return False
    return True


def _foam_log_failed(text: str) -> bool:
    """Never trust return code alone — scan for FOAM fatal markers."""
    if not text:
        return True
    upper = text
    markers = (
        "FOAM FATAL",
        "FOAM aborting",
        "Foam::error::",
        "command not found",
    )
    return any(m in upper for m in markers)


def _fail_summary(step: str, res: WslCommandResult) -> str:
    out = (res.stdout or "").strip()
    err = (res.stderr or "").strip()
    tail_out = out[-3000:] if out else "(empty)"
    tail_err = err[-1500:] if err else "(empty)"
    return (
        f"{step} FAILED (rc={res.returncode})\n"
        f"--- stdout (tail) ---\n{tail_out}\n"
        f"--- stderr (tail) ---\n{tail_err}"
    )


def write_run_snappy_parallel_sh(
    path: Path, *, n_cpus: int, decompose_method: str = "scotch"
) -> None:
    """Write ext4-native mesh script (LF). N and method baked in at write time.

    Parallel snappy on complex geometry is often only 3–6× faster than serial,
    not N×, because refine/snap load is uneven across ranks.
    Bodies live in `cfddesk/wsl/templates/run_snappy_parallel.sh`.
    """
    n = max(2, int(n_cpus))
    method = decompose_method if decompose_method else "scotch"
    text = _read_mesh_template(_SNAPPY_PARALLEL_SH)
    text = text.replace("__N__", str(n)).replace("__METHOD__", method)
    _write_lf(path, text)


def _cat_log(wsl_case: str, log_name: str) -> str:
    dest = shlex.quote(wsl_case)
    log_q = shlex.quote(log_name)
    r = run_wsl_bash(
        f"cat {dest}/{log_q} 2>/dev/null || true", timeout=60.0
    )
    return r.stdout or ""


def _run_serial_pipeline(
    dest: str,
    *,
    timeout_block: float,
    timeout_snappy: float,
    timeout_check: float,
    allow_skew: bool = False,
) -> MeshRunResult:
    def foam_to_log(tool: str, cmd: str, timeout: float) -> WslCommandResult:
        """Run an OF mesh tool with stdout/stderr redirected to a case log file."""
        log = f"log.{tool}"
        body = (
            f"cd {shlex.quote(dest)} && "
            f"{cmd} > {shlex.quote(log)} 2>&1; ec=$?; "
            f"cat {shlex.quote(log)}; exit $ec"
        )
        return run_wsl_bash(
            f"openfoam2606 bash -c {shlex.quote(body)}",
            timeout=timeout,
        )

    t0 = time.monotonic()
    bm = foam_to_log("blockMesh", "blockMesh", timeout_block)
    if bm.returncode != 0 or _foam_log_failed(bm.stdout or ""):
        return MeshRunResult(
            wsl_case=dest,
            blockMesh=bm,
            snappyHexMesh=WslCommandResult(1, "", "skipped", []),
            checkMesh=WslCommandResult(1, "", "skipped", []),
            n_cells=None,
            check_ok=False,
            summary=_fail_summary("blockMesh", bm),
            n_cpus=1,
            wall_s=time.monotonic() - t0,
        )

    sh = foam_to_log(
        "snappyHexMesh", "snappyHexMesh -overwrite", timeout_snappy
    )
    if sh.returncode != 0 or _foam_log_failed(sh.stdout or ""):
        return MeshRunResult(
            wsl_case=dest,
            blockMesh=bm,
            snappyHexMesh=sh,
            checkMesh=WslCommandResult(1, "", "skipped", []),
            n_cells=None,
            check_ok=False,
            summary=_fail_summary("snappyHexMesh", sh),
            n_cpus=1,
            wall_s=time.monotonic() - t0,
        )

    cm = foam_to_log("checkMesh", "checkMesh", timeout_check)
    n_cells = _parse_n_cells(cm.stdout)
    n_points = _parse_n_points(cm.stdout)
    cm_txt = cm.stdout or ""
    cm_ok = _checkmesh_ok(cm_txt, allow_skew=allow_skew) and not _foam_log_failed(
        cm_txt
    )
    ok = cm_ok
    if not ok:
        summary = _fail_summary("checkMesh", cm)
    elif allow_skew and _checkmesh_skew_only(cm_txt):
        summary = (
            f"checkMesh PASS (skew soft-ok); cells={n_cells}; "
            f"n_cpus=1 (serial)"
        )
    else:
        summary = f"checkMesh PASS; cells={n_cells}; n_cpus=1 (serial)"
    return MeshRunResult(
        wsl_case=dest,
        blockMesh=bm,
        snappyHexMesh=sh,
        checkMesh=cm,
        n_cells=n_cells,
        check_ok=ok,
        summary=summary,
        n_cpus=1,
        wall_s=time.monotonic() - t0,
        n_points=n_points,
    )


def _run_parallel_pipeline(
    dest: str,
    *,
    n_cpus: int,
    timeout_total: float,
    allow_skew: bool = False,
) -> MeshRunResult:
    """Execute ``run_snappy_parallel.sh`` on ext4; scan every log for FOAM FATAL."""
    t0 = time.monotonic()
    script = f"{dest}/{_SNAPPY_PARALLEL_SH}"
    # chmod + run the real script (no inline FOAM env on the Windows cmdline).
    run = run_wsl_bash(
        f"chmod +x {shlex.quote(script)} && bash {shlex.quote(script)}",
        timeout=timeout_total,
    )
    wall = time.monotonic() - t0

    bm_txt = _cat_log(dest, "log.blockMesh")
    dec_txt = _cat_log(dest, "log.decomposePar")
    sh_txt = _cat_log(dest, "log.snappyHexMesh")
    rec_txt = _cat_log(dest, "log.reconstructParMesh")
    cm_txt = _cat_log(dest, "log.checkMesh")
    script_out = (run.stdout or "") + (run.stderr or "")

    bm = WslCommandResult(
        0 if bm_txt and not _foam_log_failed(bm_txt) else 1,
        bm_txt,
        "",
        [],
    )
    sh = WslCommandResult(
        0
        if sh_txt
        and not _foam_log_failed(sh_txt)
        and "Finished meshing" in sh_txt
        else 1,
        sh_txt,
        "",
        [],
    )
    # Accept "Finished meshing without any errors" OR per-rank End + reconstruct OK
    if sh.returncode != 0 and sh_txt and not _foam_log_failed(sh_txt):
        if "End" in sh_txt and "FOAM FATAL" not in sh_txt:
            # Parallel logs often end with End per rank without the serial phrase.
            if "Writing mesh" in sh_txt or "Mesh snapped" in sh_txt or "snapped" in sh_txt.lower():
                sh = WslCommandResult(0, sh_txt, "", [])

    rec_ok = (
        bool(rec_txt)
        and not _foam_log_failed(rec_txt)
        and ("End" in rec_txt or "Reconstructing" in rec_txt)
    )
    cm = WslCommandResult(
        0
        if cm_txt
        and _checkmesh_ok(cm_txt, allow_skew=allow_skew)
        and not _foam_log_failed(cm_txt)
        else 1,
        cm_txt,
        "",
        [],
    )
    n_cells = _parse_n_cells(cm_txt)
    n_points = _parse_n_points(cm_txt)
    procs_left = run_wsl_bash(
        f"cd {shlex.quote(dest)} && ls -d processor* 2>/dev/null | head -5 || echo NONE",
        timeout=30.0,
    )
    procs_clean = "NONE" in (procs_left.stdout or "") or not (
        procs_left.stdout or ""
    ).strip()

    cm_ok = _checkmesh_ok(cm_txt, allow_skew=allow_skew) and not _foam_log_failed(
        cm_txt or ""
    )
    ok = (
        "MESH_SCRIPT_OK" in script_out
        and bm.returncode == 0
        and sh.returncode == 0
        and rec_ok
        and cm_ok
        and procs_clean
        and not _foam_log_failed(dec_txt)
    )

    if not ok:
        if _foam_log_failed(bm_txt) or not bm_txt:
            summary = _fail_summary("blockMesh", bm)
        elif _foam_log_failed(dec_txt):
            summary = f"decomposePar FAILED\n{dec_txt[-3000:]}"
        elif sh.returncode != 0:
            summary = _fail_summary("snappyHexMesh", sh)
        elif not rec_ok:
            summary = f"reconstructParMesh FAILED\n{rec_txt[-3000:]}"
        elif not procs_clean:
            summary = (
                "processor* dirs remain after reconstruct — cleanup failed\n"
                + (procs_left.stdout or "")
            )
        else:
            summary = _fail_summary("checkMesh", cm)
        if "MESH_SCRIPT_FAIL" in script_out:
            summary = script_out[-2000:] + "\n" + summary
    elif allow_skew and _checkmesh_skew_only(cm_txt or ""):
        summary = (
            f"checkMesh PASS (skew soft-ok); cells={n_cells}; "
            f"n_cpus={n_cpus} (parallel snappy); wall_s={wall:.1f}"
        )
    else:
        summary = (
            f"checkMesh PASS; cells={n_cells}; n_cpus={n_cpus} (parallel snappy); "
            f"wall_s={wall:.1f}"
        )

    return MeshRunResult(
        wsl_case=dest,
        blockMesh=bm,
        snappyHexMesh=sh,
        checkMesh=cm,
        n_cells=n_cells,
        check_ok=ok,
        summary=summary,
        n_cpus=n_cpus,
        wall_s=wall,
        extra_logs={
            "decomposePar": dec_txt,
            "reconstructParMesh": rec_txt,
            "script": script_out[-4000:],
        },
        n_points=n_points,
    )


def _snappy_add_layers_enabled(windows_case: Path) -> bool:
    """True when the staged snappyHexMeshDict requests ``addLayers true``."""
    path = Path(windows_case) / "system" / "snappyHexMeshDict"
    if not path.is_file():
        return False
    text = path.read_text(encoding="utf-8", errors="replace")
    return bool(re.search(r"addLayers\s+true\s*;", text))


def _snappy_explicit_features_enabled(windows_case: Path) -> bool:
    """True when explicit feature snap is on (CAD eMesh path)."""
    path = Path(windows_case) / "system" / "snappyHexMeshDict"
    if not path.is_file():
        return False
    text = path.read_text(encoding="utf-8", errors="replace")
    return bool(re.search(r"explicitFeatureSnap\s+true\s*;", text))


def run_snappy_pipeline(
    windows_case: Path,
    *,
    wsl_case_name: str = "cfddesk-vortex-a2",
    n_cpus: int = 1,
    decompose_method: str = "scotch",
    timeout_block: float = 300.0,
    timeout_snappy: float = 3600.0,
    timeout_check: float = 600.0,
    allow_skew: bool | None = None,
) -> MeshRunResult:
    """Copy case to ``~/cases/<id>`` on ext4, then mesh.

    N=1 (or less): serial ``snappyHexMesh -overwrite`` (unchanged behaviour).
    N>1: parallel script on ext4 — clean → decompose → mpirun snappy →
    reconstructParMesh -constant → clean → checkMesh.

    ``n_cpus`` must come from Simulation control Preferred CPUs / Automatic
    (same source as the solve path). Do not invent a separate mesh-N setting.

    When ``allow_skew`` is None, soft-pass skewness-only failures if
    ``addLayers true`` or ``explicitFeatureSnap true`` (industrial CAD).
    """
    from cfddesk.runner.case_id import assert_safe_wsl_case_dest, wsl_case_path

    windows_case = Path(windows_case).resolve()
    n = max(1, int(n_cpus))
    method = decompose_method or "scotch"
    if allow_skew is None:
        allow_skew = _snappy_add_layers_enabled(
            windows_case
        ) or _snappy_explicit_features_enabled(windows_case)

    if n > 1:
        # Lazy import — cfddesk.case.writer pulls ras → mesh → runner → this module.
        from cfddesk.case.writer import write_decompose_par_dict

        # Bake N into case before sync so the script and decomposeParDict land on ext4.
        write_decompose_par_dict(
            windows_case / "system" / "decomposeParDict",
            n_subdomains=n,
            method=method,
        )
        write_run_snappy_parallel_sh(
            windows_case / _SNAPPY_PARALLEL_SH,
            n_cpus=n,
            decompose_method=method,
        )

    src = windows_to_wsl_path(windows_case)
    dest = assert_safe_wsl_case_dest(wsl_case_path(wsl_case_name))

    sync = run_wsl_bash(
        f"rm -rf -- {shlex.quote(dest)} && mkdir -p -- {shlex.quote(dest)} && "
        f"cp -a {shlex.quote(src)}/. {shlex.quote(dest)}/",
        timeout=120.0,
    )
    if sync.returncode != 0:
        raise RuntimeError(
            f"WSL sync failed (rc={sync.returncode})\n"
            f"--- stdout ---\n{sync.stdout}\n--- stderr ---\n{sync.stderr}"
        )

    if n <= 1:
        # Serial: still scrub orphans so a prior parallel mesh cannot poison N=1.
        from cfddesk.runner.parallel import clean_processor_dirs

        clean_processor_dirs(dest)
        return _run_serial_pipeline(
            dest,
            timeout_block=timeout_block,
            timeout_snappy=timeout_snappy,
            timeout_check=timeout_check,
            allow_skew=bool(allow_skew),
        )

    # Parallel path timeout: block + decompose + snappy + reconstruct + check.
    timeout_total = (
        float(timeout_block)
        + float(timeout_snappy)
        + float(timeout_check)
        + 900.0
    )
    return _run_parallel_pipeline(
        dest,
        n_cpus=n,
        timeout_total=timeout_total,
        allow_skew=bool(allow_skew),
    )


def write_run_gmsh_standard_sh(path: Path) -> None:
    """Write ext4-native Standard mesh script (LF): gmshToFoam → checkMesh.

    Wall/patch types are applied on the Windows results copy after sync-back
    (`apply_boundary_patch_types`) — gmshToFoam defaults everything to
    `patch`. Body: `templates/run_gmsh_standard.sh`.
    """
    _write_lf(path, _read_mesh_template(_GMSH_STANDARD_SH))


def run_gmsh_pipeline(
    windows_case: Path,
    *,
    wsl_case_name: str = "cfddesk-standard",
    timeout_total: float = 3600.0,
    allow_skew: bool = True,
) -> MeshRunResult:
    """Sync Standard case to ext4, run ``run_gmsh_standard.sh``, return result.

    Host must already have written ``geometry.msh`` (MSH 2.2) under
    ``constant/triSurface``. Tet meshes often leave a few skew faces — skew-only
    checkMesh failures soft-pass by default (same industrial CAD stance as
    feature snap).
    """
    from cfddesk.runner.case_id import assert_safe_wsl_case_dest, wsl_case_path

    windows_case = Path(windows_case).resolve()
    write_run_gmsh_standard_sh(windows_case / _GMSH_STANDARD_SH)

    src = windows_to_wsl_path(windows_case)
    dest = assert_safe_wsl_case_dest(wsl_case_path(wsl_case_name))

    sync = run_wsl_bash(
        f"rm -rf -- {shlex.quote(dest)} && mkdir -p -- {shlex.quote(dest)} && "
        f"cp -a {shlex.quote(src)}/. {shlex.quote(dest)}/ && "
        f"chmod +x {shlex.quote(dest + '/' + _GMSH_STANDARD_SH)}",
        timeout=120.0,
    )
    if sync.returncode != 0:
        raise RuntimeError(
            f"WSL sync failed (rc={sync.returncode})\n"
            f"--- stdout ---\n{sync.stdout}\n--- stderr ---\n{sync.stderr}"
        )

    t0 = time.monotonic()
    script_q = shlex.quote(f"{dest}/{_GMSH_STANDARD_SH}")
    run = run_wsl_bash(
        f"bash {script_q}",
        timeout=float(timeout_total),
    )
    wall = time.monotonic() - t0

    gmsh_log = _cat_log(dest, "log.gmshToFoam")
    check_log = _cat_log(dest, "log.checkMesh")
    host_log = _cat_log(dest, "log.gmsh_host.txt")

    skipped = WslCommandResult(0, "skipped (Standard / no blockMesh)", "", [])
    # Reuse snappyHexMesh slot for gmshToFoam in MeshRunResult.detail_text.
    g2f = WslCommandResult(
        0 if "MESH_SCRIPT_OK" in (run.stdout or "") and not _foam_log_failed(gmsh_log)
        else (run.returncode or 1),
        gmsh_log,
        run.stderr or "",
        run.argv,
    )
    chk = WslCommandResult(
        0 if _checkmesh_ok(check_log, allow_skew=allow_skew) else 1,
        check_log,
        "",
        [],
    )

    if "MESH_SCRIPT_FAIL" in (run.stdout or "") or "MESH_SCRIPT_FAIL" in (
        run.stderr or ""
    ):
        return MeshRunResult(
            wsl_case=dest,
            blockMesh=skipped,
            snappyHexMesh=g2f,
            checkMesh=chk,
            n_cells=None,
            check_ok=False,
            summary=_fail_summary("gmsh_standard_script", run),
            n_cpus=1,
            wall_s=wall,
            extra_logs={
                "gmsh_host": host_log,
                "script_stdout": run.stdout or "",
                "script_stderr": run.stderr or "",
            },
        )

    if g2f.returncode != 0 or _foam_log_failed(gmsh_log):
        return MeshRunResult(
            wsl_case=dest,
            blockMesh=skipped,
            snappyHexMesh=g2f,
            checkMesh=chk,
            n_cells=None,
            check_ok=False,
            summary=_fail_summary("gmshToFoam", g2f),
            n_cpus=1,
            wall_s=wall,
            extra_logs={"gmsh_host": host_log},
        )

    n_cells = _parse_n_cells(check_log)
    n_points = _parse_n_points(check_log)
    ok = _checkmesh_ok(check_log, allow_skew=allow_skew)
    summary = (
        f"Standard mesh OK — {n_cells} cells"
        if ok
        else _fail_summary("checkMesh", chk)
    )
    return MeshRunResult(
        wsl_case=dest,
        blockMesh=skipped,
        snappyHexMesh=g2f,
        checkMesh=chk,
        n_cells=n_cells,
        check_ok=ok,
        n_points=n_points,
        summary=summary,
        n_cpus=1,
        wall_s=wall,
        extra_logs={"gmsh_host": host_log},
    )



def write_run_standard_sh(path: Path) -> None:
    """Write ext4-native script for the surface-first Standard mesh:
    gmshToFoam → patch types → optional layers-only snappyHexMesh → checkMesh.

    Body: `templates/run_standard_mesh.sh`.
    """
    _write_lf(path, _read_mesh_template(_STANDARD_SH))


def run_standard_pipeline(
    windows_case: Path,
    *,
    wsl_case_name: str = "cfddesk-standard",
    timeout_total: float = 3600.0,
    allow_skew: bool = True,
) -> MeshRunResult:
    """Sync the Standard case (``constant/triSurface/geometry.msh`` +
    ``patch_types.txt`` + optional layers snappyHexMeshDict) to ext4 and run
    ``run_standard_mesh.sh``. The snappyHexMesh slot carries the layers log."""
    from cfddesk.runner.case_id import assert_safe_wsl_case_dest, wsl_case_path

    windows_case = Path(windows_case).resolve()
    write_run_standard_sh(windows_case / _STANDARD_SH)

    src = windows_to_wsl_path(windows_case)
    dest = assert_safe_wsl_case_dest(wsl_case_path(wsl_case_name))

    sync = run_wsl_bash(
        f"rm -rf -- {shlex.quote(dest)} && mkdir -p -- {shlex.quote(dest)} && "
        f"cp -a {shlex.quote(src)}/. {shlex.quote(dest)}/ && "
        f"chmod +x {shlex.quote(dest + '/' + _STANDARD_SH)}",
        timeout=300.0,
    )
    if sync.returncode != 0:
        raise RuntimeError(
            f"WSL sync failed (rc={sync.returncode})\n"
            f"--- stdout ---\n{sync.stdout}\n--- stderr ---\n{sync.stderr}"
        )

    t0 = time.monotonic()
    run = run_wsl_bash(
        f"bash {shlex.quote(f'{dest}/{_STANDARD_SH}')}",
        timeout=float(timeout_total),
    )
    wall = time.monotonic() - t0

    g2f_log = _cat_log(dest, "log.gmshToFoam")
    layers_log = _cat_log(dest, "log.snappyHexMesh")
    check_log = _cat_log(dest, "log.checkMesh")
    types_log = _cat_log(dest, "log.patchTypes")
    script_out = (run.stdout or "") + "\n" + (run.stderr or "")

    g2f = WslCommandResult(
        0 if g2f_log and not _foam_log_failed(g2f_log) else 1, g2f_log, "", run.argv
    )
    layers_ok = bool(layers_log) and (
        "layers off" in layers_log
        or ("Finished meshing" in layers_log and not _foam_log_failed(layers_log))
    )
    layers = WslCommandResult(0 if layers_ok else 1, layers_log, "", [])
    chk = WslCommandResult(
        0 if _checkmesh_ok(check_log, allow_skew=allow_skew) else 1, check_log, "", []
    )
    extra = {
        "gmshToFoam": g2f_log[-4000:],
        "patchTypes": types_log,
        "script": script_out[-4000:],
    }
    n_cells = _parse_n_cells(check_log)
    n_points = _parse_n_points(check_log)

    if "MESH_SCRIPT_FAIL" in script_out or "MESH_SCRIPT_OK" not in script_out:
        step = "standard_mesh_script"
        m = re.search(r"MESH_SCRIPT_FAIL:\s*(\S+)", script_out)
        if m:
            step = m.group(1)
        failing = {
            "gmshToFoam": g2f,
            "snappyHexMesh": layers,
        }.get(step, WslCommandResult(run.returncode or 1, script_out, "", run.argv))
        return MeshRunResult(
            wsl_case=dest,
            blockMesh=WslCommandResult(0, "skipped (Standard)", "", []),
            snappyHexMesh=layers,
            checkMesh=chk,
            n_cells=n_cells,
            check_ok=False,
            summary=_fail_summary(step, failing),
            n_cpus=1,
            wall_s=wall,
            extra_logs=extra,
            n_points=n_points,
        )

    ok = g2f.returncode == 0 and layers_ok and chk.returncode == 0
    if ok:
        summary = f"Standard mesh OK — {n_cells} cells"
    elif g2f.returncode != 0:
        summary = _fail_summary("gmshToFoam", g2f)
    elif not layers_ok:
        summary = _fail_summary("snappyHexMesh (layers)", layers)
    else:
        summary = _fail_summary("checkMesh", chk)
    return MeshRunResult(
        wsl_case=dest,
        blockMesh=WslCommandResult(0, "skipped (Standard)", "", []),
        snappyHexMesh=layers,
        checkMesh=chk,
        n_cells=n_cells,
        check_ok=ok,
        summary=summary,
        n_cpus=1,
        wall_s=wall,
        extra_logs=extra,
        n_points=n_points,
    )


def write_run_cfmesh_standard_sh(path: Path) -> None:
    """Write ext4-native Standard+hexcore script (LF).

    `surfaceFeatureEdges` → `geometry.fms` (corners/edges), then
    `cartesianMesh` → optional face-split `createPatch` → retype
    inlet/outlet from `wall` → `patch` via `patch_types.txt` →
    `checkMesh`. Body: `templates/run_cfmesh_standard.sh`.
    """
    _write_lf(path, _read_mesh_template(_CFMESH_STANDARD_SH))


def run_cfmesh_pipeline(
    windows_case: Path,
    *,
    wsl_case_name: str = "cfddesk-cfmesh",
    timeout_total: float = 3600.0,
    allow_skew: bool = True,
) -> MeshRunResult:
    """Sync Standard+hexcore case to ext4, run ``run_cfmesh_standard.sh``.

    Host must already have written ``constant/triSurface/geometry.stl`` and
    ``system/meshDict``. Reuses MeshRunResult.snappyHexMesh for the
    ``cartesianMesh`` log (same UI/log slot as gmshToFoam).
    """
    from cfddesk.runner.case_id import assert_safe_wsl_case_dest, wsl_case_path

    windows_case = Path(windows_case).resolve()
    write_run_cfmesh_standard_sh(windows_case / _CFMESH_STANDARD_SH)

    src = windows_to_wsl_path(windows_case)
    dest = assert_safe_wsl_case_dest(wsl_case_path(wsl_case_name))

    sync = run_wsl_bash(
        f"rm -rf -- {shlex.quote(dest)} && mkdir -p -- {shlex.quote(dest)} && "
        f"cp -a {shlex.quote(src)}/. {shlex.quote(dest)}/ && "
        f"chmod +x {shlex.quote(dest + '/' + _CFMESH_STANDARD_SH)}",
        timeout=120.0,
    )
    if sync.returncode != 0:
        raise RuntimeError(
            f"WSL sync failed (rc={sync.returncode})\n"
            f"--- stdout ---\n{sync.stdout}\n--- stderr ---\n{sync.stderr}"
        )

    t0 = time.monotonic()
    script_q = shlex.quote(f"{dest}/{_CFMESH_STANDARD_SH}")
    run = run_wsl_bash(
        f"bash {script_q}",
        timeout=float(timeout_total),
    )
    wall = time.monotonic() - t0

    cf_log = _cat_log(dest, "log.cartesianMesh")
    check_log = _cat_log(dest, "log.checkMesh")
    host_log = _cat_log(dest, "log.cfmesh_host.txt")
    feat_log = _cat_log(dest, "log.surfaceFeatureEdges")

    skipped = WslCommandResult(0, "skipped (cfMesh / no blockMesh)", "", [])
    cart = WslCommandResult(
        0
        if "MESH_SCRIPT_OK" in (run.stdout or "") and not _foam_log_failed(cf_log)
        else (run.returncode or 1),
        cf_log,
        run.stderr or "",
        run.argv,
    )
    chk = WslCommandResult(
        0 if _checkmesh_ok(check_log, allow_skew=allow_skew) else 1,
        check_log,
        "",
        [],
    )

    if "MESH_SCRIPT_FAIL" in (run.stdout or "") or "MESH_SCRIPT_FAIL" in (
        run.stderr or ""
    ):
        return MeshRunResult(
            wsl_case=dest,
            blockMesh=skipped,
            snappyHexMesh=cart,
            checkMesh=chk,
            n_cells=None,
            check_ok=False,
            summary=_fail_summary("cfmesh_standard_script", run),
            n_cpus=1,
            wall_s=wall,
            extra_logs={
                "cfmesh_host": host_log,
                "surfaceFeatureEdges": feat_log,
                "script_stdout": run.stdout or "",
                "script_stderr": run.stderr or "",
            },
        )

    if cart.returncode != 0 or _foam_log_failed(cf_log):
        return MeshRunResult(
            wsl_case=dest,
            blockMesh=skipped,
            snappyHexMesh=cart,
            checkMesh=chk,
            n_cells=None,
            check_ok=False,
            summary=_fail_summary("cartesianMesh", cart),
            n_cpus=1,
            wall_s=wall,
            extra_logs={
                "cfmesh_host": host_log,
                "surfaceFeatureEdges": feat_log,
            },
        )

    n_cells = _parse_n_cells(check_log)
    n_points = _parse_n_points(check_log)
    ok = _checkmesh_ok(check_log, allow_skew=allow_skew)
    summary = (
        f"Standard+hexcore (cfMesh) OK — {n_cells} cells"
        if ok
        else _fail_summary("checkMesh", chk)
    )
    return MeshRunResult(
        wsl_case=dest,
        blockMesh=skipped,
        snappyHexMesh=cart,
        checkMesh=chk,
        n_cells=n_cells,
        check_ok=ok,
        n_points=n_points,
        summary=summary,
        n_cpus=1,
        wall_s=wall,
        extra_logs={
            "cfmesh_host": host_log,
            "surfaceFeatureEdges": feat_log,
        },
    )
