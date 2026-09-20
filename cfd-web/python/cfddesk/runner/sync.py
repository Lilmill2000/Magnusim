"""WSL case sync and mandatory results copy-back."""

from __future__ import annotations

import shlex
from dataclasses import dataclass
from pathlib import Path

from cfddesk.runner.case_id import assert_safe_wsl_case_dest, wsl_case_path
from cfddesk.wsl.mesh_run import windows_to_wsl_path
from cfddesk.wsl.openfoam import WslCommandResult, run_wsl_bash

# Exclude heavy regenerated dumps from copy-back (viewer uses native .foam).
_COPY_BACK_EXCLUDES = (
    "--exclude=VTK",
    "--exclude=processor*",
    "--exclude=dynamicCode",
    "--exclude=*.gz.bak",
)

# Marker written into approved results dirs before any destructive clear.
RESULTS_MARKER = ".cfddesk-results"


@dataclass(frozen=True)
class SyncResult:
    wsl_case: str
    result: WslCommandResult

    @property
    def ok(self) -> bool:
        return self.result.returncode == 0


@dataclass(frozen=True)
class CopyBackResult:
    wsl_case: str
    windows_results: Path
    result: WslCommandResult
    bytes_copied: int | None = None

    @property
    def ok(self) -> bool:
        return self.result.returncode == 0 and self.windows_results.is_dir()


def sync_to_wsl(
    windows_case: Path,
    wsl_case_id: str,
    *,
    timeout: float = 600.0,
) -> SyncResult:
    """Copy Windows staging case → WSL ext4 (solve location). Wipes dest.

    ``wsl_case_id`` must pass :func:`validate_wsl_case_id`. Dest must be a
    proper subdirectory of the case root — never ``rm -rf ~/cases/``.
    """
    windows_case = Path(windows_case).resolve()
    if not windows_case.is_dir():
        raise FileNotFoundError(f"Windows case not found: {windows_case}")
    src = windows_to_wsl_path(windows_case)
    dest = assert_safe_wsl_case_dest(wsl_case_path(wsl_case_id))
    cmd = (
        f"rm -rf -- {shlex.quote(dest)} && mkdir -p -- {shlex.quote(dest)} && "
        f"cp -a {shlex.quote(src)}/. {shlex.quote(dest)}/"
    )
    return SyncResult(wsl_case=dest, result=run_wsl_bash(cmd, timeout=timeout))

def sync_solve_dicts_to_wsl(
    windows_case: Path,
    wsl_case_id: str,
    *,
    timeout: float = 300.0,
) -> SyncResult:
    """Copy 0/, system/, physics dicts, *.foam onto an existing WSL mesh case.

    Does **not** wipe ``constant/polyMesh`` — use after a successful mesh.
    """
    windows_case = Path(windows_case).resolve()
    if not windows_case.is_dir():
        raise FileNotFoundError(f"Windows case not found: {windows_case}")
    src = windows_to_wsl_path(windows_case)
    dest = wsl_case_path(wsl_case_id)
    # Quote each full path — never shlex.quote(src)+"/constant/foo" (breaks the
    # closing quote and silently skips transportProperties). Shell $vars also
    # need escape_wsl_bash_dollars (applied in run_wsl_bash).
    q = shlex.quote
    poly = q(f"{dest}/constant/polyMesh")
    cmd_parts = [
        f"test -d {poly} || {{ echo 'missing polyMesh - mesh first' >&2; exit 2; }}",
        f"mkdir -p {q(f'{dest}/0')} {q(f'{dest}/system')} {q(f'{dest}/constant')}",
        # Wipe prior 0/ so switching laminar↔RAS does not leave orphan fields.
        f"rm -rf {q(f'{dest}/0')} && mkdir -p {q(f'{dest}/0')}",
        f"cp -a {q(f'{src}/0')}/. {q(f'{dest}/0')}/",
        f"cp -a {q(f'{src}/system')}/. {q(f'{dest}/system')}/",
    ]
    for name in ("transportProperties", "turbulenceProperties"):
        src_f = q(f"{src}/constant/{name}")
        dest_f = q(f"{dest}/constant/{name}")
        cmd_parts.append(
            f"if [[ -f {src_f} ]]; then cp -a {src_f} {dest_f}; "
            f"else echo 'missing {src}/constant/{name}' >&2; exit 3; fi"
        )
    cmd_parts.extend(
        [
            f"shopt -s nullglob; foams=({q(src)}/*.foam)",
            f"if [[ ${{#foams[@]}} -gt 0 ]]; then cp -a \"${{foams[@]}}\" {q(dest)}/; "
            f"else touch {q(f'{dest}/case.foam')}; fi",
            f"test -f {q(f'{dest}/constant/transportProperties')}",
        ]
    )
    cmd = "; ".join(cmd_parts)
    return SyncResult(wsl_case=dest, result=run_wsl_bash(cmd, timeout=timeout))


def push_polymesh_to_wsl(
    windows_results: Path,
    wsl_case_id: str,
    *,
    timeout: float = 600.0,
) -> SyncResult:
    """Replace WSL ``constant/polyMesh`` from a Windows mesh results tree.

    Used when multiple meshes share one WSL case id: Solve for mesh A must
    restore A's polyMesh after Generate for mesh B overwrote the WSL case.
    """
    windows_results = Path(windows_results).resolve()
    poly_src = windows_results / "constant" / "polyMesh"
    if not (poly_src / "points").is_file():
        raise FileNotFoundError(f"missing polyMesh points under {poly_src}")
    src = windows_to_wsl_path(poly_src)
    dest = wsl_case_path(wsl_case_id)
    q = shlex.quote
    poly_dest = q(f"{dest}/constant/polyMesh")
    cmd = (
        f"mkdir -p {q(f'{dest}/constant')} && "
        f"rm -rf {poly_dest} && "
        f"cp -a {q(src)} {poly_dest}"
    )
    return SyncResult(wsl_case=dest, result=run_wsl_bash(cmd, timeout=timeout))


def assert_safe_results_dir(windows_results: Path) -> Path:
    """Refuse destructive copy-back into unexpected Windows paths.

    Allowed if basename is ``results``, path is ``…/results/mesh-*``, **or**
    the directory already contains a ``.cfddesk-results`` marker.
    Refuse drive roots, user-profile roots, and a path that is itself a
    project directory (has ``project.json`` as a direct child).
    """
    path = Path(windows_results).resolve()
    if path.exists() and not path.is_dir():
        raise RuntimeError(f"copy_back target is not a directory: {path}")

    # Drive root (C:\) or UNC share root
    if path.parent == path:
        raise RuntimeError(f"copy_back refused: target is a filesystem root: {path}")

    home = Path.home().resolve()
    if path == home:
        raise RuntimeError(f"copy_back refused: target is the user profile root: {path}")

    # Project directory itself (contains project.json) — never wipe that
    if (path / "project.json").is_file():
        raise RuntimeError(
            f"copy_back refused: target looks like a project directory "
            f"(contains project.json): {path}"
        )

    marker = path / RESULTS_MARKER
    name_ok = path.name.lower() == "results"
    # Multi-mesh: results/mesh-<id> (basename is mesh-*, parent is results)
    parent_ok = (
        path.parent.name.lower() == "results"
        and path.name.lower().startswith("mesh-")
    )
    # Phase 6 named runs: results/mesh-<id>/run-<id>
    run_ok = (
        path.name.lower().startswith("run-")
        and path.parent.name.lower().startswith("mesh-")
        and path.parent.parent.name.lower() == "results"
    )
    marker_ok = marker.is_file()
    if not name_ok and not parent_ok and not run_ok and not marker_ok:
        raise RuntimeError(
            f"copy_back refused: target must be named 'results', "
            f"'results/mesh-*', 'results/mesh-*/run-*', or contain "
            f"{RESULTS_MARKER} (got {path}). "
            f"Fail loud rather than rm -rf unexpected paths."
        )
    return path


def copy_back(
    wsl_case_id: str,
    windows_results: Path,
    *,
    timeout: float = 1800.0,
) -> CopyBackResult:
    """Mandatory copy of mesh/results from WSL ext4 → Windows-local results dir.

    Copies polyMesh, time directories, system/, *.foam, and logs. Excludes VTK/
    (native OpenFOAM reader is the production path). Fails loud on error.

    Destructive clear is guarded by :func:`assert_safe_results_dir`.
    """
    windows_results = assert_safe_results_dir(windows_results)
    windows_results.mkdir(parents=True, exist_ok=True)
    marker = windows_results / RESULTS_MARKER
    if not marker.is_file():
        marker.write_text(
            "cfddesk results directory - safe for copy_back clear\n",
            encoding="ascii",
        )

    dest = windows_to_wsl_path(windows_results)
    src = wsl_case_path(wsl_case_id)
    excludes = " ".join(_COPY_BACK_EXCLUDES)
    marker_q = shlex.quote(f"{dest}/{RESULTS_MARKER}")
    # Copy to /mnt/c: dereference symlinks (-L) so Windows can open every file.
    # Clear contents but preserve the safety marker; recreate it after wipe.
    cmd = (
        f"test -d {shlex.quote(src)} || {{ echo 'missing WSL case' >&2; exit 2; }}; "
        f"mkdir -p {shlex.quote(dest)}; "
        f"find {shlex.quote(dest)} -mindepth 1 -maxdepth 1 "
        f"! -name {shlex.quote(RESULTS_MARKER)} -exec rm -rf {{}} +; "
        f"if command -v rsync >/dev/null 2>&1; then "
        f"  rsync -aL {excludes} {shlex.quote(src)}/ {shlex.quote(dest)}/; "
        f"else "
        f"  cp -aL {shlex.quote(src)}/. {shlex.quote(dest)}/ && "
        f"  rm -rf {shlex.quote(dest)}/VTK; "
        f"fi; "
        f"printf '%s\\n' 'cfddesk results directory - safe for copy_back clear' > {marker_q}; "
        f"shopt -s nullglob; foams=({shlex.quote(dest)}/*.foam); "
        f"if [ ${{#foams[@]}} -eq 0 ]; then touch {shlex.quote(dest)}/case.foam; fi"
    )
    result = run_wsl_bash(cmd, timeout=timeout)
    bytes_copied: int | None = None
    if result.returncode == 0:
        foams = list(windows_results.glob("*.foam"))
        if not foams:
            (windows_results / "case.foam").write_text("", encoding="ascii")
        total = 0
        for p in windows_results.rglob("*"):
            try:
                if p.is_file():
                    total += p.stat().st_size
            except OSError:
                continue
        bytes_copied = total

    cb = CopyBackResult(
        wsl_case=src,
        windows_results=windows_results,
        result=result,
        bytes_copied=bytes_copied,
    )
    if not cb.ok:
        raise RuntimeError(
            f"copy_back FAILED from {src} → {windows_results}\n"
            f"rc={result.returncode}\nstdout={result.stdout[-2000:]}\n"
            f"stderr={result.stderr[-2000:]}"
        )
    return cb


def copy_back_mesh(
    wsl_case_id: str,
    windows_results: Path,
    *,
    timeout: float = 1800.0,
) -> CopyBackResult:
    """Copy only polyMesh + mesh logs to Windows. WSL remains the case source.

    Does not wipe the host case directory (keeps the .msh / STL already there).
    """
    windows_results = assert_safe_results_dir(windows_results)
    windows_results.mkdir(parents=True, exist_ok=True)
    marker = windows_results / RESULTS_MARKER
    if not marker.is_file():
        marker.write_text(
            "cfddesk results directory - safe for copy_back clear\n",
            encoding="ascii",
        )

    dest = windows_to_wsl_path(windows_results)
    src = wsl_case_path(wsl_case_id)
    q = shlex.quote
    marker_q = q(f"{dest}/{RESULTS_MARKER}")
    cmd = (
        f"test -d {q(src)} || {{ echo 'missing WSL case' >&2; exit 2; }}; "
        f"test -d {q(src)}/constant/polyMesh || {{ echo 'missing polyMesh' >&2; exit 3; }}; "
        f"mkdir -p {q(dest)}/constant; "
        f"rm -rf {q(dest)}/constant/polyMesh; "
        f"cp -a {q(src)}/constant/polyMesh {q(dest)}/constant/; "
        f"shopt -s nullglob; "
        f"for f in {q(src)}/log.*; do "
        f"  [ -e \"$f\" ] && cp -f \"$f\" {q(dest)}/; "
        f"done; "
        f"touch {q(dest)}/case.foam; "
        f"printf '%s\\n' 'cfddesk results directory - safe for copy_back clear' > {marker_q}"
    )
    result = run_wsl_bash(cmd, timeout=timeout)
    bytes_copied: int | None = None
    if result.returncode == 0:
        total = 0
        poly = windows_results / "constant" / "polyMesh"
        if poly.is_dir():
            for p in poly.rglob("*"):
                try:
                    if p.is_file():
                        total += p.stat().st_size
                except OSError:
                    continue
        bytes_copied = total

    cb = CopyBackResult(
        wsl_case=src,
        windows_results=windows_results,
        result=result,
        bytes_copied=bytes_copied,
    )
    if not cb.ok:
        raise RuntimeError(
            f"copy_back_mesh FAILED from {src} → {windows_results}\n"
            f"rc={result.returncode}\nstdout={result.stdout[-2000:]}\n"
            f"stderr={result.stderr[-2000:]}"
        )
    return cb


def ensure_foam_marker(case_dir: Path) -> Path:
    """Ensure a *.foam marker exists for the OpenFOAM reader."""
    case_dir = Path(case_dir)
    existing = list(case_dir.glob("*.foam"))
    if existing:
        return existing[0]
    marker = case_dir / "case.foam"
    marker.write_text("", encoding="ascii")
    return marker
