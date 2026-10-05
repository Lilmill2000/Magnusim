"""Monitor functionObjects: mon_<patch> / flow_<patch> / rc_<name> surfaceFieldValue blocks.

The run monitors (analysis contract run_monitors) read what these write.
"""
from __future__ import annotations

import math
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Literal

from magnusim_sdk.study import bc_faces as _bc_faces_adapter
from magnusim_sdk.study import is_pressure_bc as _is_pressure_bc_adapter
from magnusim_sdk.study import is_velocity_inlet as _is_velocity_inlet_adapter
from magnusim_sdk.study import is_velocity_outlet as _is_velocity_outlet_adapter

from .bc_kinds import is_freestream, is_total_pressure_inlet
from .transient import TransientControl

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


def custom_monitor_key(name: str, taken: set[str]) -> str:
    """``rc_<slug>`` function-object / postProcessing name for a custom monitor."""
    slug = re.sub(r"[^a-z0-9]+", "_", str(name or "").lower()).strip("_") or "monitor"
    key = f"rc_{slug}"
    n = 2
    while key in taken:
        key = f"rc_{slug}_{n}"
        n += 1
    taken.add(key)
    return key


def sampled_surface_block(key: str, surface_file: str, *, write_control_text: str) -> str:
    """Area-average U and p over a surface cut from the CAD faces a monitor names.

    The surface (constant/triSurface/<file>) samples the nearest boundary
    faces, so a monitor works on any faces — not only a whole BC patch.
    """
    return f"""    {key}
    {{
        type            surfaceFieldValue;
        libs            ("libfieldFunctionObjects.so");
        {write_control_text}
        log             true;
        writeFields     false;
        regionType      sampledSurface;
        name            {key};
        sampledSurfaceDict
        {{
            type        meshedSurface;
            surface     {surface_file};
            source      boundaryFaces;
            interpolate false;
        }}
        operation       areaAverage;
        fields          ( U p );
    }}"""


def custom_monitors_functions_text(
    monitors: Iterable[dict],
    *,
    transient: TransientControl | None = None,
) -> str:
    """One sampledSurface block per written custom monitor (``key`` + ``surface``)."""
    write = monitor_write_control_text(transient=transient)
    return "\n".join(
        sampled_surface_block(str(m["key"]), str(m["surface"]), write_control_text=write)
        for m in monitors
        if m.get("key") and m.get("surface")
    )


# Result fields the case writes at every saved time through function objects
# (written into the time folders next to U and p; analyses._RESULT_FIELDS lists them).
YPLUS_FIELD = "yPlus"
WALL_SHEAR_STRESS_FIELD = "wallShearStress"
# The pressure function object's own name for it is "total(p)", which is not a
# plain field name results can show: it is written as pTotal.
TOTAL_PRESSURE_FIELD = "pTotal"
VORTICITY_FIELD = "vorticity"
Q_FIELD = "Q"
MEAN_VELOCITY_FIELD = "UMean"
MEAN_PRESSURE_FIELD = "pMean"


def _write_time_block(name: str, fo_type: str, entries: Sequence[tuple[str, str]] = ()) -> str:
    """One function object run and written only at the saved times (writeTime)."""
    rows = (
        ("type", fo_type),
        ("libs", '("libfieldFunctionObjects.so")'),
        ("executeControl", "writeTime"),
        ("writeControl", "writeTime"),
        *entries,
    )
    body = "\n".join(f"        {key:<16}{value};" for key, value in rows)
    return f"    {name}\n    {{\n{body}\n    }}"


def result_fields_functions_text(
    *,
    turbulent: bool,
    rho: float,
    transient: TransientControl | None = None,
) -> str:
    """Function objects that write extra result fields into every saved time.

    y+ (turbulent runs only: a laminar run has no wall model to report it for),
    wall shear stress, total pressure, vorticity and the Q-criterion. A
    transient run also averages U and p over time (UMean, pMean) from the
    run's "Average from" time.

    Kinematic like p (divided by density, results show them times rho):
    wallShearStress and pMean. Total pressure is written in Pa: the pressure
    function object needs the density of an incompressible case (rhoInf).
    """
    from .transient import foam_num

    blocks: list[str] = []
    if turbulent:
        blocks.append(_write_time_block(YPLUS_FIELD, "yPlus", (("log", "false"),)))
    blocks.append(_write_time_block(WALL_SHEAR_STRESS_FIELD, "wallShearStress", (("log", "false"),)))
    blocks.append(
        _write_time_block(
            TOTAL_PRESSURE_FIELD,
            "pressure",
            (
                ("mode", "total"),
                ("result", TOTAL_PRESSURE_FIELD),
                ("rho", "rhoInf"),
                ("rhoInf", foam_num(rho)),
            ),
        )
    )
    blocks.append(_write_time_block(VORTICITY_FIELD, "vorticity"))
    blocks.append(_write_time_block(Q_FIELD, "Q"))
    if transient is not None:
        blocks.append(field_average_block(transient))
    return "\n".join(blocks)


def field_average_block(transient: TransientControl) -> str:
    """Time averages of U and p (UMean, pMean), from the run's "Average from" time.

    Averaged every time step, written at the saved times. Frames saved before
    the start time hold no averages.
    """
    from .transient import foam_num

    start = float(getattr(transient, "average_from", 0.0) or 0.0)
    start_line = f"\n        timeStart       {foam_num(start)};" if start > 0 else ""
    return f"""    fieldAverage
    {{
        type            fieldAverage;
        libs            ("libfieldFunctionObjects.so");
        writeControl    writeTime;{start_line}
        fields
        (
            U
            {{
                mean        on;
                prime2Mean  off;
                base        time;
            }}
            p
            {{
                mean        on;
                prime2Mean  off;
                base        time;
            }}
        );
    }}"""


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
    """Inlets, pressure BCs, velocity outlets, total-pressure inlets, freestreams, plus AA face owners (w27)."""
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
            items.append((m[0], str(m[1])))

    for bc, patch in items:
        opening = is_freestream(_as_bc_dict(bc)) or is_total_pressure_inlet(_as_bc_dict(bc))
        if _is_velocity_inlet(bc) or _is_pressure_bc(bc) or _is_velocity_outlet(bc) or opening:
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
            from magnusim_sdk.study import list_aa_faces

            aa_faces = list_aa_faces(aa)
        except Exception:
            aa_faces = []
    return monitor_patches_from_mapped(mapped, aa_faces=aa_faces)
