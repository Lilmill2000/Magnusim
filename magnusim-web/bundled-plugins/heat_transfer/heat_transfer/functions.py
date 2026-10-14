"""The function objects a Heat Transfer case writes (``system/controlDict`` ``functions``).

Every case:

- ``ht_wall_heat_flux`` (wallHeatFlux) on every wall patch: each iteration it
  writes ``postProcessing/ht_wall_heat_flux/<start>/wallHeatFlux.dat`` (per
  patch: min, max and the integral in W, positive into the fluid), and at
  each saved time the ``wallHeatFlux`` field (W/m²);
- ``ht_htc_raw`` (heatTransferCoeff, fixed reference temperature) on the same
  walls and ``ht_htc`` (reference, scale -1): the ``htc`` field (W/(m²·K)) at
  each saved time, h = q / (T_wall − T_ref) against the study's reference
  temperature, so it is positive on a wall that heats the fluid and on one that
  cools it. OpenFOAM's heatTransferCoeff divides by T_ref − T_wall (its
  ``htcRaw`` is the negative of h; it is never written);
- ``ht_rho`` (writeObjects): the solver's density ``rho`` at each saved time
  (the buoyant solvers do not write it themselves);
- ``ht_enthalpy_<patch>`` (surfaceFieldValue, weightedSum of h by the mass flux
  phi) on each opening: the enthalpy flow through it in W (out positive), for
  the energy balance.

Per monitor (heat_transfer.monitors): ``ht_Tavg_<patch>`` / ``ht_Tmax_<patch>``
(areaAverage / max of T) on its patches (a wall heat flux monitor reads the
wallHeatFlux rows and these areas), and ``ht_probe_<key>`` (probes of T) for
a thermocouple. Monitors and the balance write every iteration (every time
step in a transient run).
"""

from __future__ import annotations

import re
from typing import Any

from .monitors import (
    DEFAULT_WALLS,
    DEFAULT_WALLS_PATCH,
    SURFACE_TEMPERATURE,
    THERMOCOUPLE,
    WALL_HEAT_FLUX,
)
from .settle import WALL_HEAT_FLUX_OBJECT

HTC_RAW_OBJECT = "ht_htc_raw"
HTC_RAW_FIELD = "htcRaw"
HTC_OBJECT = "ht_htc"
HTC_FIELD = "htc"
RHO_OBJECT = "ht_rho"
WALL_HEAT_FLUX_FIELD = "wallHeatFlux"
OPENING_KINDS: tuple[str, ...] = ("inlet", "pressure", "velocity_outlet", "freestream", "total_pressure")


def num(x: float) -> str:
    return f"{float(x):.8g}"


def monitor_key(name: str, taken: set[str]) -> str:
    """``ht_probe_<slug>``: a function object name of the monitor's name, unique in the case."""
    slug = re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_").lower() or "monitor"
    key = f"ht_probe_{slug}"
    n = 2
    while key in taken:
        key = f"ht_probe_{slug}_{n}"
        n += 1
    taken.add(key)
    return key


def plan_monitors(spec: Any, flow: Any) -> list[dict[str, Any]]:
    """The run's monitors on this mesh: ``{id, name, type, patches | points, key?}`` each.

    A boundary is a BC's id (its patch) or ``@walls`` (the walls no BC claims); a
    wall heat flux monitor keeps only wall patches.
    """
    by_id = {str(rec.get("id")): patch for patch, rec in flow.records.items() if rec.get("id") is not None}
    by_name = {str(rec.get("name")): patch for patch, rec in flow.records.items() if rec.get("name")}
    taken: set[str] = set()
    out: list[dict[str, Any]] = []
    for m in spec.monitors:
        row: dict[str, Any] = {"id": m.get("id"), "name": m.get("name"), "type": m["type"]}
        if m["type"] == THERMOCOUPLE:
            row["points"] = list(m.get("points") or [])
            row["key"] = monitor_key(str(m.get("name") or "thermocouple"), taken)
        else:
            patches: list[str] = []
            for b in m.get("boundaries") or []:
                if b == DEFAULT_WALLS:
                    patch = DEFAULT_WALLS_PATCH if DEFAULT_WALLS_PATCH in flow.patch_names else ""
                else:
                    patch = by_id.get(str(b)) or by_name.get(str(b)) or ""
                if not patch or patch in patches:
                    continue
                if m["type"] == WALL_HEAT_FLUX and flow.kinds.get(patch) != "wall":
                    continue
                patches.append(patch)
            row["patches"] = patches
        out.append(row)
    return out


def _sfv(name: str, patch: str, *, operation: str, fields: str, weight: str = "") -> str:
    weight_line = f"\n        weightField     {weight};" if weight else ""
    return f"""    {name}
    {{
        type            surfaceFieldValue;
        libs            (fieldFunctionObjects);
        writeControl    timeStep;
        writeInterval   1;
        log             false;
        writeFields     false;
        regionType      patch;
        name            {patch};
        operation       {operation};{weight_line}
        fields          ( {fields} );
    }}"""


def functions_text(
    *,
    wall_patches: list[str],
    opening_patches: list[str],
    monitor_plans: list[dict[str, Any]],
    t_ref: float,
) -> str:
    """The function object blocks (inside ``functions { }``)."""
    blocks: list[str] = []
    if wall_patches:
        walls = " ".join(wall_patches)
        blocks.append(
            f"""    {WALL_HEAT_FLUX_OBJECT}
    {{
        type            wallHeatFlux;
        libs            (fieldFunctionObjects);
        patches         ( {walls} );
        executeControl  timeStep;
        executeInterval 1;
        writeControl    writeTime;
        log             false;
    }}"""
        )
        blocks.append(
            f"""    {HTC_RAW_OBJECT}
    {{
        type            heatTransferCoeff;
        libs            (fieldFunctionObjects);
        field           T;
        patches         ( {walls} );
        htcModel        fixedReferenceTemperature;
        TRef            {num(t_ref)};
        result          {HTC_RAW_FIELD};
        writeControl    none;
        log             false;
    }}
    {HTC_OBJECT}
    {{
        type            reference;
        libs            (fieldFunctionObjects);
        field           {HTC_RAW_FIELD};
        refValue        constant 0;
        scale           -1;
        result          {HTC_FIELD};
        writeControl    writeTime;
        log             false;
    }}"""
        )
    blocks.append(
        f"""    {RHO_OBJECT}
    {{
        type            writeObjects;
        libs            (utilityFunctionObjects);
        objects         ( rho );
        writeOption     anyWrite;
        writeControl    writeTime;
    }}"""
    )
    for patch in opening_patches:
        blocks.append(_sfv(f"ht_enthalpy_{patch}", patch, operation="weightedSum", fields="h", weight="phi"))
    surface: list[str] = []
    for plan in monitor_plans:
        if plan["type"] in (SURFACE_TEMPERATURE, WALL_HEAT_FLUX):
            for patch in plan.get("patches") or []:
                if patch not in surface:
                    surface.append(patch)
    for patch in surface:
        blocks.append(_sfv(f"ht_Tavg_{patch}", patch, operation="areaAverage", fields="T"))
        blocks.append(_sfv(f"ht_Tmax_{patch}", patch, operation="max", fields="T"))
    for plan in monitor_plans:
        if plan["type"] != THERMOCOUPLE or not plan.get("points"):
            continue
        pts = " ".join(f"({num(p[0])} {num(p[1])} {num(p[2])})" for p in plan["points"])
        blocks.append(
            f"""    {plan["key"]}
    {{
        type            probes;
        libs            (sampling);
        writeControl    timeStep;
        writeInterval   1;
        log             false;
        fields          ( T );
        probeLocations  ( {pts} );
    }}"""
        )
    return "\n".join(blocks) if blocks else "    // no function objects"
