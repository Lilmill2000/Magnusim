"""The function objects of a conjugate heat transfer case, region by region.

Every function object of a multi-region case names its ``region``; OpenFOAM writes
field function objects to ``postProcessing/<region>/<name>/<start>/`` and probes to
``postProcessing/<name>/<region>/<start>/`` (HT0). Every case:

- ``ht_wall_heat_flux_<r>`` (wallHeatFlux) in each region, on its outer walls and
  its interfaces (``<r>_to_<other>``): per patch and iteration the heat through it
  in W, positive into the region; at each saved time the ``wallHeatFlux`` field;
- in the fluid region: ``ht_htc_raw`` / ``ht_htc`` (the heat transfer coefficient
  against the reference temperature, on its walls and interfaces), ``ht_rho``
  (writeObjects of rho) and ``ht_enthalpy_<patch>`` on each opening (the enthalpy
  the flow carries out, W);
- in each solid region: ``ht_Tbody_avg_<r>`` / ``ht_Tbody_max_<r>`` (volume
  average and highest temperature), every iteration: the Run panel's row of each
  solid body.

Per monitor: ``ht_Tavg_<r>_<patch>`` / ``ht_Tmax_<r>_<patch>`` for a boundary's
part in each region it is in; a thermocouple's points go to the region each one
is in (heat_transfer.cht.locate_points: a thermocouple in a solid reads the
solid's temperature), one probes object per region (``ht_probe_<name>``, with
``_<region>`` when its points are in more than one).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .bcs import record_kind
from .cht import Layout, locate_points
from .functions import (
    HTC_FIELD,
    HTC_OBJECT,
    HTC_RAW_FIELD,
    HTC_RAW_OBJECT,
    RHO_OBJECT,
    monitor_key,
    num,
)
from .monitors import (
    DEFAULT_WALLS,
    DEFAULT_WALLS_PATCH,
    SURFACE_TEMPERATURE,
    THERMOCOUPLE,
    WALL_HEAT_FLUX,
)
from .settle import WALL_HEAT_FLUX_OBJECT


def wall_heat_flux_object(region: str) -> str:
    return f"{WALL_HEAT_FLUX_OBJECT}_{region}"


def body_objects(region: str) -> tuple[str, str]:
    """The volume average and highest temperature objects of a solid region."""
    return f"ht_Tbody_avg_{region}", f"ht_Tbody_max_{region}"


def surface_objects(region: str, patch: str) -> tuple[str, str]:
    return f"ht_Tavg_{region}_{patch}", f"ht_Tmax_{region}_{patch}"


def _is_wall(region_row: dict[str, Any], patch: str) -> bool:
    return patch in (region_row.get("walls") or [])


def plan_cht_monitors(
    spec: Any, lay: Layout, by_patch: dict[str, dict[str, Any]], *, out: Path, poly_dir: Path
) -> list[dict[str, Any]]:
    """The run's monitors on this case's regions: ``{id, name, type, patches, targets}`` for a
    boundary monitor (``targets``: ``{region, patch}``, a wall heat flux monitor's walls only),
    ``{id, name, type, points, key, probes, outside}`` for a thermocouple."""
    by_id = {str(rec.get("id")): patch for patch, rec in by_patch.items() if rec.get("id") is not None}
    by_name = {str(rec.get("name")): patch for patch, rec in by_patch.items() if rec.get("name")}
    taken: set[str] = set()
    out_rows: list[dict[str, Any]] = []
    for m in spec.monitors:
        row: dict[str, Any] = {"id": m.get("id"), "name": m.get("name"), "type": m["type"], "cht": True}
        if m["type"] == THERMOCOUPLE:
            points = [list(p) for p in m.get("points") or []]
            where = locate_points(lay, poly_dir, points, keep=True) if points else []
            base = monitor_key(str(m.get("name") or "thermocouple"), taken)
            groups: dict[str, list[int]] = {}
            outside: list[int] = []
            for i, region in enumerate(where):
                if region is None:
                    outside.append(i)
                else:
                    groups.setdefault(region, []).append(i)
            probes = []
            for region, idx in groups.items():
                key = base
                if len(groups) > 1:
                    key, n = f"{base}_{region}", 2
                    while key in taken:  # another monitor's name may make the same key
                        key, n = f"{base}_{region}_{n}", n + 1
                taken.add(key)
                probes.append({"key": key, "region": region, "index": idx})
            row.update({"points": points, "key": base, "probes": probes, "outside": outside})
        else:
            patches: list[str] = []
            for b in m.get("boundaries") or []:
                if b == DEFAULT_WALLS:
                    patch = DEFAULT_WALLS_PATCH if DEFAULT_WALLS_PATCH in lay.patch_types else ""
                else:
                    patch = by_id.get(str(b)) or by_name.get(str(b)) or ""
                if patch and patch not in patches:
                    patches.append(patch)
            targets = []
            for patch in patches:
                kind = record_kind(by_patch.get(patch)) or "wall"
                for region in lay.regions_of_record(by_patch.get(patch), patch):
                    if m["type"] == WALL_HEAT_FLUX and kind not in ("wall", "solid_wall"):
                        continue
                    targets.append({"region": region, "patch": patch})
            row["patches"] = sorted({t["patch"] for t in targets}, key=patches.index)
            row["targets"] = targets
        out_rows.append(row)
    return out_rows


def _sfv(name: str, region: str, patch: str, *, operation: str, fields: str, weight: str = "") -> str:
    weight_line = f"\n        weightField     {weight};" if weight else ""
    return f"""    {name}
    {{
        type            surfaceFieldValue;
        libs            (fieldFunctionObjects);
        region          {region};
        writeControl    timeStep;
        writeInterval   1;
        log             false;
        writeFields     false;
        regionType      patch;
        name            {patch};
        operation       {operation};{weight_line}
        fields          ( {fields} );
    }}"""


def _vfv(name: str, region: str, operation: str) -> str:
    return f"""    {name}
    {{
        type            volFieldValue;
        libs            (fieldFunctionObjects);
        region          {region};
        writeControl    timeStep;
        writeInterval   1;
        log             false;
        writeFields     false;
        regionType      all;
        operation       {operation};
        fields          ( T );
    }}"""


def cht_functions_text(
    lay: Layout,
    region_rows: list[dict[str, Any]],
    *,
    opening_patches: list[str],
    monitor_plans: list[dict[str, Any]],
    fluid_region: str | None,
    t_ref: float,
) -> str:
    """The function object blocks of a CHT case (inside ``functions { }``)."""
    blocks: list[str] = []
    rows = {r["name"]: r for r in region_rows}
    for region in lay.regions:
        row = rows.get(region.name) or {}
        patches = [*(row.get("walls") or []), *(row.get("interfaces") or [])]
        if not patches:
            continue
        blocks.append(
            f"""    {wall_heat_flux_object(region.name)}
    {{
        type            wallHeatFlux;
        libs            (fieldFunctionObjects);
        region          {region.name};
        patches         ( {" ".join(patches)} );
        executeControl  timeStep;
        executeInterval 1;
        writeControl    writeTime;
        log             false;
    }}"""
        )
    if fluid_region:
        row = rows.get(fluid_region) or {}
        patches = [*(row.get("walls") or []), *(row.get("interfaces") or [])]
        if patches:
            blocks.append(
                f"""    {HTC_RAW_OBJECT}
    {{
        type            heatTransferCoeff;
        libs            (fieldFunctionObjects);
        region          {fluid_region};
        field           T;
        patches         ( {" ".join(patches)} );
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
        region          {fluid_region};
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
        region          {fluid_region};
        objects         ( rho );
        writeOption     anyWrite;
        writeControl    writeTime;
    }}"""
        )
        for patch in opening_patches:
            blocks.append(_sfv(f"ht_enthalpy_{patch}", fluid_region, patch, operation="weightedSum", fields="h", weight="phi"))
    for region in lay.solids:
        avg, mx = body_objects(region.name)
        blocks.append(_vfv(avg, region.name, "volAverage"))
        blocks.append(_vfv(mx, region.name, "max"))
    seen: set[tuple[str, str]] = set()
    for plan in monitor_plans:
        if plan["type"] not in (SURFACE_TEMPERATURE, WALL_HEAT_FLUX):
            continue
        for t in plan.get("targets") or []:
            pair = (t["region"], t["patch"])
            if pair in seen:
                continue
            seen.add(pair)
            avg, mx = surface_objects(*pair)
            blocks.append(_sfv(avg, pair[0], pair[1], operation="areaAverage", fields="T"))
            blocks.append(_sfv(mx, pair[0], pair[1], operation="max", fields="T"))
    for plan in monitor_plans:
        if plan["type"] != THERMOCOUPLE:
            continue
        for probe in plan.get("probes") or []:
            pts = " ".join(
                f"({num(plan['points'][i][0])} {num(plan['points'][i][1])} {num(plan['points'][i][2])})" for i in probe["index"]
            )
            blocks.append(
                f"""    {probe["key"]}
    {{
        type            probes;
        libs            (sampling);
        region          {probe["region"]};
        writeControl    timeStep;
        writeInterval   1;
        log             false;
        fields          ( T );
        probeLocations  ( {pts} );
    }}"""
            )
    return "\n".join(blocks) if blocks else "    // no function objects"
