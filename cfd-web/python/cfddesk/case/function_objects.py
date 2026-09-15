"""Web UI monitor functionObjects: mon_<patch> / flow_<patch>.

Matches w27-solve.js surfaceFieldValue blocks that Graphs / getRunMonitors
consume. Do NOT swap to pInlet/pOutlet (legacy CLI path in surface_averages.py).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Literal, Sequence

from cfddesk.project.transient import TransientControl
from cfddesk.project.web_adapter import (
    bc_faces as _bc_faces_adapter,
    is_pressure_bc as _is_pressure_bc_adapter,
    is_velocity_inlet as _is_velocity_inlet_adapter,
    is_velocity_outlet as _is_velocity_outlet_adapter,
)

MonitorKind = Literal["area_average", "flow"]


@dataclass(frozen=True)
class MonitorSpec:
    patch: str
    kind: MonitorKind


def _foam_ident_ok(name: str) -> bool:
    if not name:
        return False
    if not (name[0].isalpha() or name[0] == "_"):
        return False
    return all(c.isalnum() or c == "_" for c in name)


def js_to_precision(n: float, prec: int = 6) -> str:
    """Match ECMAScript Number.prototype.toPrecision(prec) for CFD floats."""
    if not math.isfinite(n):
        return str(n)
    if n == 0:
        return "0." + ("0" * (prec - 1)) if prec > 1 else "0"
    sign = "-" if n < 0 else ""
    ax = abs(float(n))
    e = int(math.floor(math.log10(ax)))
    scale = 10 ** (prec - 1 - e)
    m = int(round(ax * scale))
    if m >= 10 ** prec:
        m //= 10
        e += 1
    digits = f"{m:0{prec}d}"
    if -6 <= e < prec:
        if e >= 0:
            int_part = digits[: e + 1]
            frac = digits[e + 1 :]
            if frac:
                body = int_part + "." + frac
            else:
                pad = prec - len(int_part)
                body = int_part + ("." + ("0" * pad) if pad > 0 else "")
        else:
            zeros = -e - 1
            body = "0." + ("0" * zeros) + digits
        return sign + body
    if prec > 1:
        mant = digits[0] + "." + digits[1:]
    else:
        mant = digits
    return sign + mant + f"e{e:+d}"


def surface_field_value_block(
    name: str,
    patch: str,
    *,
    operation: str,
    fields: Sequence[str],
    write_control_text: str,
    log: bool,
) -> str:
    """One indented surfaceFieldValue FO body (inside functions { })."""
    fields_s = " ".join(fields)
    log_s = "true" if log else "false"
    return f"""    {name}
    {{
        type            surfaceFieldValue;
        libs            ("libfieldFunctionObjects.so");
        {write_control_text}
        log             {log_s};
        writeFields     false;
        regionType      patch;
        name            {patch};
        operation       {operation};
        fields          ( {fields_s} );
    }}"""


def monitor_write_control_text(*, transient: TransientControl | None) -> str:
    """Steady: every timeStep. Transient: runTime at write_interval/50 (w27)."""
    if transient is not None:
        wi_s = js_to_precision(float(transient.write_interval) / 50.0, 6)
        return (
            f"writeControl    runTime;\n"
            f"        writeInterval   {wi_s};"
        )
    return (
        "writeControl    timeStep;\n"
        "        writeInterval   1;"
    )


def monitors_functions_text(
    patches: Iterable[str],
    *,
    transient: TransientControl | None = None,
) -> str:
    """Emit mon_<patch> + flow_<patch> blocks for each patch (w27 L1397+)."""
    mon_write = monitor_write_control_text(transient=transient)
    blocks: list[str] = []
    for patch in patches:
        if not _foam_ident_ok(patch):
            continue
        blocks.append(
            surface_field_value_block(
                f"mon_{patch}",
                patch,
                operation="areaAverage",
                fields=("U", "p"),
                write_control_text=mon_write,
                log=True,
            )
        )
        blocks.append(
            surface_field_value_block(
                f"flow_{patch}",
                patch,
                operation="sum",
                fields=("phi",),
                write_control_text=mon_write,
                log=False,
            )
        )
    return "\n".join(blocks) if blocks else "    // no area-average probes"


def _bc_faces(bc: object) -> list[str]:
    if isinstance(bc, dict):
        return _bc_faces_adapter(bc)
    faces = list(getattr(bc, "faces", []) or [])
    face = getattr(bc, "face", None)
    if face and face not in faces:
        faces.append(face)
    return [str(f) for f in faces if f]


def _as_bc_dict(bc: object) -> dict:
    if isinstance(bc, dict):
        return bc
    return {
        "bc_type": getattr(bc, "bc_type", "") or "",
        "faces": list(getattr(bc, "faces", []) or []),
        "face": getattr(bc, "face", None),
    }


def _is_velocity_inlet(bc: object) -> bool:
    return _is_velocity_inlet_adapter(_as_bc_dict(bc))


def _is_velocity_outlet(bc: object) -> bool:
    return _is_velocity_outlet_adapter(_as_bc_dict(bc))


def _is_pressure_bc(bc: object) -> bool:
    return _is_pressure_bc_adapter(_as_bc_dict(bc))


def monitor_patches_from_mapped(
    mapped: Sequence[tuple[object, str] | dict],
    *,
    aa_faces: Sequence[str] | None = None,
    patch_names: Sequence[str] | None = None,
) -> list[str]:
    """Inlets, pressure BCs, velocity outlets, plus AA face owners (w27)."""
    monitored: list[str] = []
    seen: set[str] = set()

    def _add(p: str) -> None:
        if p and p not in seen:
            seen.add(p)
            monitored.append(p)

    items: list[tuple[object, str]] = []
    for m in mapped:
        if isinstance(m, dict):
            items.append((m.get("bc") or m, str(m.get("patch") or "")))
        else:
            items.append((m[0], str(m[1])))  # type: ignore[index]

    for bc, patch in items:
        if _is_velocity_inlet(bc) or _is_pressure_bc(bc) or _is_velocity_outlet(bc):
            _add(patch)

    names = set(patch_names or [])
    for lab in aa_faces or []:
        for bc, patch in items:
            if lab in _bc_faces(bc) and (not names or patch in names):
                _add(patch)
                break
    return monitored


def monitor_patches(project_or_runspec) -> list[str]:
    """Prefer RunSpec.monitor_patches; else derive from mapped BCs."""
    mp = getattr(project_or_runspec, "monitor_patches", None)
    if mp is not None:
        return list(mp)
    mapped = getattr(project_or_runspec, "mapped", None) or []
    aa = getattr(project_or_runspec, "aa", None)
    aa_faces: list[str] = []
    if isinstance(aa, dict):
        try:
            from cfddesk.project.web_adapter import list_aa_faces

            aa_faces = list_aa_faces(aa)
        except Exception:
            aa_faces = []
    return monitor_patches_from_mapped(mapped, aa_faces=aa_faces)
