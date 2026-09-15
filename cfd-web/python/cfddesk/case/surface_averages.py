"""Inlet/outlet area-average(p) functionObjects + log/.dat parsers.

Phase 6 result control: live area average of pressure on the first inlet
and first outlet patch. Function-object names are fixed (``pInlet`` /
``pOutlet``); patch names come from the project BC registry.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_FOAM_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_TIME = re.compile(r"^Time = ([0-9.eE+-]+)\s*$")
_FO_HEADER = re.compile(
    r"^(?:surfaceFieldValue\s+)?(pInlet|pOutlet)\s+(?:write|output)\s*:\s*$"
)
_AREA_P = re.compile(r"areaAverage\(p\)\s*=\s*([+-]?[0-9.eE+-]+)")


@dataclass(frozen=True)
class SurfacePressureSample:
    iteration: int
    p_inlet: float | None
    p_outlet: float | None


def inlet_outlet_patch_names(project) -> tuple[str, str] | None:
    """First inlet and outlet patch names, or None if either is missing."""
    from cfddesk.case.writer import _patch_semantics_from_project

    sem = _patch_semantics_from_project(project)
    inlet = next((name for name, kind in sem.items() if kind == "inlet"), None)
    outlet = next((name for name, kind in sem.items() if kind == "outlet"), None)
    if inlet and outlet:
        return inlet, outlet
    return None


def foam_ident_ok(name: str) -> bool:
    return bool(_FOAM_IDENT.fullmatch(name))


def control_dict_surface_p_block(inlet_patch: str, outlet_patch: str) -> str:
    """Indented functionObject bodies for insertion inside ``functions { }``."""
    if not foam_ident_ok(inlet_patch) or not foam_ident_ok(outlet_patch):
        return ""
    return f"""    pInlet
    {{
        type            surfaceFieldValue;
        libs            (fieldFunctionObjects);
        writeControl    timeStep;
        writeInterval   1;
        log             true;
        writeFields     false;
        regionType      patch;
        name            {inlet_patch};
        operation       areaAverage;
        fields          (p);
    }}
    pOutlet
    {{
        type            surfaceFieldValue;
        libs            (fieldFunctionObjects);
        writeControl    timeStep;
        writeInterval   1;
        log             true;
        writeFields     false;
        regionType      patch;
        name            {outlet_patch};
        operation       areaAverage;
        fields          (p);
    }}
"""


def parse_surface_pressure_averages(log_text: str) -> list[SurfacePressureSample]:
    """Parse ``areaAverage(p)`` samples keyed by the preceding ``Time =``."""
    current_time: int | None = None
    current_fo: str | None = None
    pending: dict[str, float] = {}
    out: list[SurfacePressureSample] = []

    def _flush() -> None:
        nonlocal pending
        if current_time is None or not pending:
            pending = {}
            return
        out.append(
            SurfacePressureSample(
                iteration=current_time,
                p_inlet=pending.get("pInlet"),
                p_outlet=pending.get("pOutlet"),
            )
        )
        pending = {}

    for raw in log_text.splitlines():
        line = raw.strip()
        tm = _TIME.match(raw) or _TIME.match(line)
        if tm:
            _flush()
            try:
                current_time = int(float(tm.group(1)))
            except ValueError:
                current_time = None
            current_fo = None
            continue
        hm = _FO_HEADER.match(line)
        if hm:
            current_fo = hm.group(1)
            continue
        am = _AREA_P.search(line)
        if am and current_fo in ("pInlet", "pOutlet"):
            pending[current_fo] = float(am.group(1))
    _flush()
    return out


def parse_surface_field_value_dat(text: str) -> list[tuple[float, float]]:
    """Parse an OpenFOAM ``surfaceFieldValue.dat`` (Time, areaAverage)."""
    rows: list[tuple[float, float]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        try:
            rows.append((float(parts[0]), float(parts[1])))
        except ValueError:
            continue
    return rows
