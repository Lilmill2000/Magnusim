"""Post-snappy conversion of periodic patch halves to OpenFOAM cyclic pairs."""

from __future__ import annotations

import shlex
from pathlib import Path
from typing import Any

from cfddesk.mesh.case_writer import _foam_header, _write_foam
from cfddesk.runner.case_id import assert_safe_wsl_case_dest, wsl_case_path
from cfddesk.wsl.mesh_run import windows_to_wsl_path
from cfddesk.wsl.openfoam import WslCommandResult, run_wsl_bash

_LOG_FAIL_NEEDLES = (
    "foam fatal",
    "fatal error",
    "serious error",
    "wrong patch",
    "cannot find patch",
    "face mismatch",
    "unable to match",
    "does not match neighbour",
    "cannot match vectors",
    "foam exiting",
)


def _paired_bc_id(bc: Any) -> str | None:
    pid = getattr(bc, "paired_bc_id", None)
    if pid:
        return str(pid)
    settings = getattr(bc, "settings", None) or {}
    if isinstance(settings, dict) and settings.get("paired_bc_id"):
        return str(settings["paired_bc_id"])
    return None


def _vector3(settings: dict[str, Any], key: str) -> tuple[float, float, float] | None:
    v = settings.get(key)
    if isinstance(v, (list, tuple)) and len(v) >= 3:
        return (float(v[0]), float(v[1]), float(v[2]))
    return None


def _fmt_vec(v: tuple[float, float, float]) -> str:
    return f"({v[0]:g} {v[1]:g} {v[2]:g})"


def is_periodic_bc(bc: Any) -> bool:
    """True when menu type or registry key denotes a periodic BC."""
    from cfddesk.case.bc_menu import registry_key_for_bc
    from cfddesk.case.bc_registry import get_type

    if str(getattr(bc, "type", "")).lower() == "periodic":
        return True
    reg = registry_key_for_bc(bc)
    if reg == "periodic":
        return True
    try:
        spec = get_type(reg)
    except KeyError:
        return False
    return str(getattr(spec, "semantic", "")).lower() == "periodic"


def has_periodic_bcs(project) -> bool:
    return any(
        is_periodic_bc(bc) and bc.face_ids for bc in project.boundary_conditions
    )


def periodic_pairs(project) -> list[tuple[Any, Any]]:
    """Mutually paired periodic BC halves with assigned faces."""
    periodic = [
        bc
        for bc in project.boundary_conditions
        if is_periodic_bc(bc) and bc.face_ids
    ]
    by_id = {bc.id: bc for bc in project.boundary_conditions}
    pairs: list[tuple[Any, Any]] = []
    used: set[str] = set()
    for bc in sorted(periodic, key=lambda b: b.patch_name):
        if bc.id in used:
            continue
        pid = _paired_bc_id(bc)
        if not pid:
            continue
        partner = by_id.get(pid)
        if partner is None or not is_periodic_bc(partner):
            continue
        if partner.id == bc.id:
            continue
        if _paired_bc_id(partner) != bc.id:
            continue
        used.add(bc.id)
        used.add(partner.id)
        pairs.append((bc, partner))
    return pairs


def validate_periodic_ready(project) -> None:
    """Raise when periodic BCs are unpaired or missing transform data."""
    periodic = [
        bc
        for bc in project.boundary_conditions
        if is_periodic_bc(bc) and bc.face_ids
    ]
    if not periodic:
        return

    by_id = {bc.id: bc for bc in project.boundary_conditions}
    errors: list[str] = []
    for bc in periodic:
        pid = _paired_bc_id(bc)
        if not pid:
            errors.append(f"{bc.patch_name}: missing paired_bc_id")
            continue
        if pid == bc.id:
            errors.append(f"{bc.patch_name}: self-paired")
            continue
        partner = by_id.get(pid)
        if partner is None:
            errors.append(f"{bc.patch_name}: paired_bc_id {pid!r} not found")
            continue
        if not is_periodic_bc(partner):
            errors.append(
                f"{bc.patch_name}: paired BC {partner.patch_name} is not periodic"
            )
        elif _paired_bc_id(partner) != bc.id:
            errors.append(
                f"{bc.patch_name}: mutual pairing required with {partner.patch_name}"
            )

        settings = bc.settings if isinstance(bc.settings, dict) else {}
        transform = str(settings.get("transform", "")).lower()
        if transform not in ("rotational", "translational"):
            errors.append(
                f"{bc.patch_name}: transform must be rotational|translational"
            )
            continue
        if transform == "rotational":
            if _vector3(settings, "rotationAxis") is None:
                errors.append(f"{bc.patch_name}: rotationAxis required")
            if _vector3(settings, "rotationCentre") is None:
                errors.append(f"{bc.patch_name}: rotationCentre required")
        else:
            if _vector3(settings, "separationVector") is None:
                errors.append(f"{bc.patch_name}: separationVector required")

    paired_ids = {bc.id for pair in periodic_pairs(project) for bc in pair}
    for bc in periodic:
        if bc.id not in paired_ids:
            errors.append(f"{bc.patch_name}: not in a mutual periodic pair")

    if errors:
        raise RuntimeError(
            "Periodic BC not ready for createPatch:\n  " + "\n  ".join(errors)
        )


def _patch_info_block(bc_self: Any, bc_neighbour: Any) -> str:
    settings = bc_self.settings if isinstance(bc_self.settings, dict) else {}
    transform = str(settings.get("transform", "")).lower()
    lines = [
        "        patchInfo",
        "        {",
        "            type            cyclic;",
        f"            neighbourPatch  {bc_neighbour.patch_name};",
        f"            transform       {transform};",
    ]
    if transform == "rotational":
        axis = _vector3(settings, "rotationAxis")
        centre = _vector3(settings, "rotationCentre")
        if axis is not None:
            lines.append(f"            rotationAxis    {_fmt_vec(axis)};")
        if centre is not None:
            lines.append(f"            rotationCentre  {_fmt_vec(centre)};")
    elif transform == "translational":
        sep = _vector3(settings, "separationVector")
        if sep is not None:
            lines.append(f"            separationVector {_fmt_vec(sep)};")
    lines.append("        }")
    return "\n".join(lines)


def write_conformal_box_block_mesh(
    case_dir: Path,
    *,
    size_m: float = 0.1,
    cells: int = 4,
    patch_a: str = "period_a",
    patch_b: str = "period_b",
    outlet: str = "outlet",
    walls: str = "walls",
) -> Path:
    """Write a hex blockMeshDict with opposite X faces as named patches.

    Opposite faces share identical topology so ``createPatch`` can form true
    ``cyclic`` pairs (snappy surfaces are not point-matched and will fail).
    """
    s = float(size_m)
    n = max(1, int(cells))
    path = Path(case_dir) / "system" / "blockMeshDict"
    path.parent.mkdir(parents=True, exist_ok=True)
    body = (
        _foam_header("blockMeshDict")
        + f"""
scale   1;

vertices
(
    (0 0 0)
    ({s:g} 0 0)
    ({s:g} {s:g} 0)
    (0 {s:g} 0)
    (0 0 {s:g})
    ({s:g} 0 {s:g})
    ({s:g} {s:g} {s:g})
    (0 {s:g} {s:g})
);

blocks
(
    hex (0 1 2 3 4 5 6 7) ({n} {n} {n}) simpleGrading (1 1 1)
);

boundary
(
    {patch_a}
    {{
        type patch;
        faces
        (
            (0 4 7 3)
        );
    }}
    {patch_b}
    {{
        type patch;
        faces
        (
            (1 2 6 5)
        );
    }}
    {outlet}
    {{
        type patch;
        faces
        (
            (4 5 6 7)
        );
    }}
    {walls}
    {{
        type wall;
        faces
        (
            (0 1 5 4)
            (3 7 6 2)
            (0 3 2 1)
        );
    }}
);
"""
    )
    _write_foam(path, body)
    return path


def run_block_mesh(
    case_dir: Path,
    wsl_case_name: str,
    *,
    timeout: float = 300.0,
) -> WslCommandResult:
    """Sync case to WSL and run ``blockMesh`` (log redirect, no unread PIPE)."""
    case_dir = Path(case_dir).resolve()
    dest = assert_safe_wsl_case_dest(wsl_case_path(wsl_case_name))
    src = windows_to_wsl_path(case_dir)
    q_dest = shlex.quote(dest)
    q_src = shlex.quote(src)
    sync = run_wsl_bash(
        f"rm -rf -- {q_dest} && mkdir -p -- {q_dest} && "
        f"cp -a {q_src}/. {q_dest}/",
        timeout=120.0,
    )
    if sync.returncode != 0:
        raise RuntimeError(
            f"blockMesh case sync failed (rc={sync.returncode})\n"
            f"{sync.stdout}\n{sync.stderr}"
        )
    body = (
        f"cd {q_dest} && "
        "blockMesh > log.blockMesh 2>&1; ec=$?; "
        "cat log.blockMesh; exit $ec"
    )
    result = run_wsl_bash(
        f"openfoam2606 bash -c {shlex.quote(body)}",
        timeout=timeout,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"blockMesh failed (rc={result.returncode})\n"
            f"{(result.stdout or '')[-4000:]}"
        )
    return result


def _write_patches_dict(path: Path, blocks: list[str]) -> Path:
    body = (
        _foam_header("createPatchDict")
        + "\npointSync false;\n\npatches\n(\n"
        + "\n".join(blocks)
        + "\n);\n"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    _write_foam(path, body)
    return path


def write_create_patch_dict(case_dir: Path, project) -> Path:
    """Write two-pass createPatch dicts for all periodic pairs.

    Pass 1 (``createPatchDict.rename``): rename each half to ``<name>__src``.
    Pass 2 (``createPatchDict``): build ``cyclic`` patches under the original
    names. A single-pass dict cannot do both — v2606 evaluates all entries
    against the pre-pass mesh, so ``__src`` does not exist yet for pass 2.
    Same-name dest==source also fails to apply ``patchInfo type cyclic``.
    """
    pairs = periodic_pairs(project)
    if not pairs:
        raise RuntimeError("write_create_patch_dict called with no periodic pairs")

    rename_blocks: list[str] = []
    cyclic_blocks: list[str] = []
    for bc_a, bc_b in pairs:
        tmp_a = f"{bc_a.patch_name}__src"
        tmp_b = f"{bc_b.patch_name}__src"
        for tmp, src in ((tmp_a, bc_a.patch_name), (tmp_b, bc_b.patch_name)):
            rename_blocks.append(
                "    {\n"
                f"        name            {tmp};\n"
                "        patchInfo\n"
                "        {\n"
                "            type            patch;\n"
                "        }\n"
                "        constructFrom   patches;\n"
                f"        patches         ({src});\n"
                "    }"
            )
        cyclic_blocks.append(
            "    {\n"
            f"        name            {bc_a.patch_name};\n"
            f"{_patch_info_block(bc_a, bc_b)}\n"
            "        constructFrom   patches;\n"
            f"        patches         ({tmp_a});\n"
            "    }"
        )
        cyclic_blocks.append(
            "    {\n"
            f"        name            {bc_b.patch_name};\n"
            f"{_patch_info_block(bc_b, bc_a)}\n"
            "        constructFrom   patches;\n"
            f"        patches         ({tmp_b});\n"
            "    }"
        )

    system = Path(case_dir) / "system"
    _write_patches_dict(system / "createPatchDict.rename", rename_blocks)
    path = _write_patches_dict(system / "createPatchDict.cyclic", cyclic_blocks)
    # Default createPatchDict = cyclic (readable artifact); script swaps as needed.
    _write_patches_dict(system / "createPatchDict", cyclic_blocks)
    return path


def write_run_create_patch_sh(case_dir: Path) -> Path:
    """Shell helper: two createPatch passes + promote 0/polyMesh → constant."""
    path = Path(case_dir) / "run_createPatch.sh"
    text = """#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
promote_mesh() {
  if [ -d 0/polyMesh ]; then
    rm -rf constant/polyMesh
    mv 0/polyMesh constant/polyMesh
    rmdir 0 2>/dev/null || true
  fi
}
# Pass 1: rename period_* to period_*__src
cp -f system/createPatchDict.rename system/createPatchDict
openfoam2606 bash -c 'createPatch -overwrite > log.createPatch.rename 2>&1'
promote_mesh
# Pass 2: build cyclic under original names from __src
cp -f system/createPatchDict.cyclic system/createPatchDict
openfoam2606 bash -c 'createPatch -overwrite > log.createPatch.cyclic 2>&1'
promote_mesh
{
  echo "===== createPatch rename ====="
  cat log.createPatch.rename 2>/dev/null || true
  echo "===== createPatch cyclic ====="
  cat log.createPatch.cyclic 2>/dev/null || true
} > log.createPatch
"""
    path.write_bytes(text.replace("\r\n", "\n").encode("ascii", errors="strict"))
    return path


def _create_patch_log_failed(log: str, returncode: int) -> str | None:
    if returncode != 0:
        return f"createPatch exit code {returncode}"
    lower = log.lower()
    for needle in _LOG_FAIL_NEEDLES:
        if needle in lower:
            return f"log contains {needle!r}"
    for line in log.splitlines():
        if "***Failed" in line and "Failed 0" not in line:
            return line.strip()
    return None


def run_create_patch(
    case_dir: Path,
    wsl_case_name: str,
    *,
    timeout: float = 600.0,
) -> WslCommandResult:
    """Sync dict + script to WSL and invoke ``run_createPatch.sh`` (not inline $FOAM)."""
    case_dir = Path(case_dir).resolve()
    sh_path = write_run_create_patch_sh(case_dir)
    dest = assert_safe_wsl_case_dest(wsl_case_path(wsl_case_name))
    src = windows_to_wsl_path(case_dir)
    q_dest = shlex.quote(dest)
    q_src = shlex.quote(src)
    q_sh = shlex.quote(str(sh_path.name))

    sync = run_wsl_bash(
        f"mkdir -p {q_dest}/system && "
        f"cp -a {q_src}/system/createPatchDict {q_dest}/system/ && "
        f"cp -a {q_src}/system/createPatchDict.rename {q_dest}/system/ && "
        f"cp -a {q_src}/system/createPatchDict.cyclic {q_dest}/system/ && "
        f"cp -a {q_src}/{q_sh} {q_dest}/{q_sh} && "
        f"chmod +x {q_dest}/{q_sh}",
        timeout=60.0,
    )
    if sync.returncode != 0:
        raise RuntimeError(
            f"createPatch dict sync failed (rc={sync.returncode})\n"
            f"{sync.stdout}\n{sync.stderr}"
        )

    # Invoke the script file — Windows must not expand $FOAM_* inside bash -lc.
    body = (
        f"cd {q_dest} && bash ./{q_sh}; ec=$?; "
        "cat log.createPatch 2>/dev/null || true; exit $ec"
    )
    result = run_wsl_bash(body, timeout=timeout)
    fail = _create_patch_log_failed(result.stdout or "", result.returncode)
    if fail:
        raise RuntimeError(f"createPatch failed: {fail}\n{(result.stdout or '')[-4000:]}")
    return result
