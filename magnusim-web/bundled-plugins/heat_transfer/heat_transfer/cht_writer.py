"""The OpenFOAM case of a conjugate heat transfer run: a fluid and solids, or solids alone.

chtMultiRegionSimpleFoam (steady) or chtMultiRegionFoam (transient), OpenFOAM ESI
v2606, laid out as HT0 found it works:

- one region per material record with bodies (heat_transfer.cht): the mesh of
  several regions is copied unsplit to ``constant/polyMesh`` with its patch types
  set, and the case lists ``splitMeshRegions -cellZonesOnly -overwrite`` as a WSL
  pre-step (it keeps the files written per region and the patch types); a case of
  one region gets its mesh in ``constant/<region>/polyMesh`` and no pre-step;
- ``constant/regionProperties``, ``constant/g``, and no field in ``0/`` itself
  (the split would copy it into every region);
- a fluid region: ``constant/<f>/thermophysicalProperties`` and
  ``turbulenceProperties``, ``0/<f>/`` U and the turbulence fields from
  Incompressible Flow's exported flow BCs and T, p_rgh, p and alphat as a buoyant
  run writes them, ``system/<f>/`` fvSchemes and fvSolution;
- a solid region: heSolidThermo (constant conductivity, specific heat and
  density), ``0/<s>/T`` and ``0/<s>/p`` (calculated: the solvers need it),
  ``system/<s>/`` fvSchemes, fvSolution and, for a heat source, fvOptions
  (scalarSemiImplicitSource on h: ``absolute`` for W, ``specific`` for W/m³);
- the faces two regions share: ``compressible::turbulentTemperatureRadCoupledMixed``
  on both sides (``kappaMethod`` fluidThermo / solidThermo), a no-slip wall for the
  fluid;
- a solid's outer faces: adiabatic, a fixed temperature, or
  ``externalWallHeatFluxTemperature`` (a heat flux, or a heat transfer coefficient
  to an ambient temperature) with ``kappaMethod solidThermo``.

Pressure is gauge as in a buoyant run (0 at the operating pressure). The
decomposeParDict of each region is written by the runner for a parallel run.
"""

from __future__ import annotations

import dataclasses
import json
import shutil
from pathlib import Path
from typing import Any

from magnusim_sdk.foam import write_decompose_par_dict, write_foam_dict, write_vol_field

from .bcs import ADIABATIC, FIXED_T, HEAT_FLUX, HTC, record_kind, wall_thermal
from .cht import FLUID, SOLID, ChtError, Layout, layout, locate_points
from .materials import solid_props
from .runspec import HtSpec

# -cellZonesOnly: a region is exactly a cellZone, named after it (one material on two
# separate bodies stays one region; -cellZones would walk the mesh and make domain<N>).
SPLIT_STEP = {"tool": "splitMeshRegions", "args": ["-cellZonesOnly", "-overwrite"]}
STEADY_SOLVER = "chtMultiRegionSimpleFoam"
TRANSIENT_SOLVER = "chtMultiRegionFoam"
# The largest diffusion number of a solid's time step (adjustable time steps, HT0).
MAX_DI = 10.0
OPENINGS = ("inlet", "pressure", "velocity_outlet", "freestream", "total_pressure")
_FLUID_FILES = ("thermophysicalProperties", "turbulenceProperties")


def solver_app(spec: HtSpec) -> str:
    return TRANSIENT_SOLVER if spec.transient is not None else STEADY_SOLVER


def num(x: float) -> str:
    from .writer import num as _num

    return _num(x)


def coupled(kappa: str, value: str) -> dict[str, str]:
    """The interface temperature on one side (HT0: the same on both, never the baffle BC)."""
    return {
        "type": "compressible::turbulentTemperatureRadCoupledMixed",
        "Tnbr": "T",
        "kappaMethod": kappa,
        "qr": "none",
        "qrNbr": "none",
        "value": f"uniform {value}",
    }


def solid_wall_T(rec: dict[str, Any] | None, start: str) -> dict[str, str]:
    """A solid's outer face: its record's thermal condition (adiabatic when none)."""
    w = wall_thermal(rec)
    if w["mode"] == FIXED_T:
        return {"type": "fixedValue", "value": f"uniform {num(w['T'])}"}
    if w["mode"] == HEAT_FLUX:
        return {
            "type": "externalWallHeatFluxTemperature",
            "mode": "flux",
            "q": f"uniform {num(w['q'])}",
            "kappaMethod": "solidThermo",
            "value": f"uniform {start}",
        }
    if w["mode"] == HTC:
        return {
            "type": "externalWallHeatFluxTemperature",
            "mode": "coefficient",
            "h": f"uniform {num(w['h'])}",
            "Ta": f"constant {num(w['Ta'])}",
            "kappaMethod": "solidThermo",
            "value": f"uniform {start}",
        }
    return {"type": "zeroGradient"}


def solid_thermo_text(rho: float, cp: float, k: float) -> str:
    # molWeight is not used by a solid of constant density; heSolidThermo still reads it.
    return f"""thermoType
{{
    type            heSolidThermo;
    mixture         pureMixture;
    transport       constIso;
    thermo          hConst;
    equationOfState rhoConst;
    specie          specie;
    energy          sensibleEnthalpy;
}}

mixture
{{
    specie          {{ molWeight 1; }}
    transport       {{ kappa {num(k)}; }}
    thermodynamics  {{ Cp {num(cp)}; Hf 0; }}
    equationOfState {{ rho {num(rho)}; }}
}}"""


def solid_schemes_text(*, numerics: str, transient: Any) -> str:
    from .writer import _SCHEMES

    s = _SCHEMES.get(numerics) or _SCHEMES["robust"]
    if transient is None:
        ddt = "steadyState"
    else:
        ddt = "backward" if transient.time_scheme == "backward" else "Euler"
    return f"""ddtSchemes {{ default {ddt}; }}
gradSchemes {{ default Gauss linear; }}
divSchemes {{ default none; }}
laplacianSchemes {{ default {s["laplacian"]}; }}
interpolationSchemes {{ default linear; }}
snGradSchemes {{ default {s["sn_grad"]}; }}"""


def solid_solution_text(*, n_non_orth: int, transient: Any) -> str:
    if transient is None:
        return f"""solvers
{{
    h
    {{
        solver          PCG;
        preconditioner  DIC;
        tolerance       1e-8;
        relTol          0.01;
    }}
}}

SIMPLE
{{
    nNonOrthogonalCorrectors {int(n_non_orth)};
}}

relaxationFactors
{{
    equations
    {{
        h               1;
    }}
}}"""
    return f"""solvers
{{
    h
    {{
        solver          PCG;
        preconditioner  DIC;
        tolerance       1e-8;
        relTol          0.01;
    }}
    hFinal
    {{
        $h;
        relTol          0;
    }}
}}

PIMPLE
{{
    nNonOrthogonalCorrectors {int(n_non_orth)};
}}"""


def heat_source_text(mode: str, value: float) -> str:
    """A region's heat source on its energy: W in all (``absolute``) or W/m³ (``specific``)."""
    volume_mode = "absolute" if mode == "power" else "specific"
    return f"""ht_heat_source
{{
    type            scalarSemiImplicitSource;
    selectionMode   all;
    volumeMode      {volume_mode};
    sources
    {{
        h           ({num(value)} 0);
    }}
}}"""


def region_properties_text(lay: Layout) -> str:
    fluids = " ".join(r.name for r in lay.fluids)
    solids = " ".join(r.name for r in lay.solids)
    return f"regions ( fluid ({fluids}) solid ({solids}) );"


# ---------------------------------------------------------------------------
# The case
# ---------------------------------------------------------------------------


def _clean_for_cht(out: Path, *, keep_times: bool) -> None:
    """What a buoyant case (or an earlier CHT case) left that a CHT case must not have:
    fields in ``0/`` itself (the split would copy them into every region), the
    one-region dictionaries, and (written again) the regions' folders."""
    zero = out / "0"
    if zero.is_dir():
        for child in list(zero.iterdir()):
            if child.is_file():
                child.unlink(missing_ok=True)
            elif not keep_times and child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
    for name in _FLUID_FILES:
        (out / "constant" / name).unlink(missing_ok=True)
    (out / "system" / "fvOptions").unlink(missing_ok=True)
    (out / "constant" / "cellToRegion").unlink(missing_ok=True)
    if keep_times:
        return
    for folder in ("constant", "system"):
        root = out / folder
        if not root.is_dir():
            continue
        for child in list(root.iterdir()):
            if child.is_dir() and child.name not in ("triSurface",):
                shutil.rmtree(child, ignore_errors=True)


def _patch_records(spec: HtSpec, patch_names: list[str]) -> dict[str, dict[str, Any]]:
    """{patch: BC record} as Start maps them (its name, a face name, a BC baked into the mesh)."""
    from magnusim_sdk.study import map_bc_to_patch

    from .contract import _mesh_web_bcs

    names = set(patch_names)
    web = _mesh_web_bcs(Path(spec.mesh_case_dir))
    out: dict[str, dict[str, Any]] = {}
    for rec in spec.records:
        patch = map_bc_to_patch(rec, names, web)
        if patch in names and patch not in out:
            out[patch] = rec
    return out


def _patch_types(lay: Layout, by_patch: dict[str, dict[str, Any]]) -> dict[str, str]:
    """The unsplit mesh's patch types: openings ``patch``, symmetry, every other one a wall."""
    types: dict[str, str] = {}
    for patch in lay.patch_types:
        kind = record_kind(by_patch.get(patch))
        if kind == "symmetry":
            types[patch] = "symmetry"
        elif kind in OPENINGS:
            types[patch] = "patch"
        else:
            types[patch] = "wall"
    return types


def _copy_mesh(src_case: Path, dst: Path) -> Path:
    src = src_case / "constant" / "polyMesh"
    if not (src / "owner").is_file() and not (src / "owner.gz").is_file():
        raise ChtError("The mesh has no constant/polyMesh: generate it again.")
    if dst.exists():
        shutil.rmtree(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dst)
    return dst


def _wall_turbulence(flow: Any, field: str) -> dict[str, str]:
    """A no-slip wall's entry of a turbulence field, as Incompressible Flow writes it."""
    for patch, kind in flow.kinds.items():
        if kind == "wall" and flow.wall_motion.get(patch, "no_slip") == "no_slip":
            entry = (flow.turbulence.get(field) or {}).get(patch)
            if entry:
                return dict(entry)
    fn = {"k": "kqRWallFunction", "omega": "omegaWallFunction", "epsilon": "epsilonWallFunction", "nut": "nutkWallFunction"}
    value = "uniform 0" if field == "nut" else str(flow.turbulence_internal.get(field) or "uniform 0")
    return {"type": fn.get(field, "zeroGradient"), "value": value}


def write_cht_case(spec: HtSpec, out: Path, *, restart_from: float | None) -> dict[str, Any]:
    """Write a conjugate heat transfer run's case into ``out``; the report the core records."""
    from incompressible_flow.flow_bcs import flow_patches

    from .functions import OPENING_KINDS
    from .physics import solved_turbulence_fields
    from .runspec import convergence_stops_off
    from .settle import plan_settle, settle_functions_text
    from .writer import (
        PRT,
        control_dict_text,
        fv_schemes_text,
        fv_solution_text,
        reference_density,
        thermal_entries,
        thermophysical_text,
        turbulence_text,
    )

    keep = restart_from is not None
    _clean_for_cht(out, keep_times=keep)
    mesh_case = Path(spec.mesh_case_dir)
    rows = (spec.inputs.mesh or {}).get("regions") if spec.inputs is not None else None
    mesh_name = str(((spec.inputs.mesh or {}) if spec.inputs is not None else {}).get("mesh_name") or "The mesh")
    records = [*spec.fluid_records, *spec.solid_records]
    try:
        per_volume = any(s.on and s.mode == "density" for s in spec.heat_sources.values())
        lay = layout(rows, records, mesh_case / "constant" / "polyMesh", mesh_name=mesh_name, volumes=per_volume, keep=True)
    except ChtError as exc:
        return {"ok": False, "error": str(exc)}
    names = [r.name for r in lay.regions]
    all_patches = list(lay.patch_types)
    by_patch = _patch_records(spec, all_patches)
    types = _patch_types(lay, by_patch)

    # The mesh: unsplit with its patch types (split in WSL), or straight in its region.
    from magnusim_sdk.gmsh_helpers import apply_boundary_patch_types

    if lay.split:
        poly = out / "constant" / "polyMesh"
        region_meshes = all((out / "constant" / n / "polyMesh" / "owner").is_file() for n in names)
        if not (keep and region_meshes):
            _copy_mesh(mesh_case, poly)
            apply_boundary_patch_types(poly / "boundary", types)
    else:
        # One region: its mesh straight in its folder, no split. The case keeps the mesh in
        # constant/polyMesh too (the runner's gate wants a mesh there; the solver and the
        # results read the region's).
        only = names[0]
        for poly in (out / "constant" / only / "polyMesh", out / "constant" / "polyMesh"):
            if not (keep and (poly / "owner").is_file()):
                _copy_mesh(mesh_case, poly)
                apply_boundary_patch_types(poly / "boundary", types)
    for name in names:
        (out / "0" / name).mkdir(parents=True, exist_ok=True)
        (out / "system" / name).mkdir(parents=True, exist_ok=True)
        (out / "constant" / name).mkdir(parents=True, exist_ok=True)

    ph = spec.physics
    start = num(ph.start_temperature())
    transient = spec.transient is not None
    model = ph.turbulence_model
    turbulent = model != "laminar"
    fluid = spec.fluid
    density = spec.density_model
    rho_ref = reference_density(fluid, density, ph.reference_temperature, ph.operating_pressure) if fluid else None
    flow = None
    if lay.fluids and fluid is not None and rho_ref:
        # Every patch of the unsplit mesh (the copied one: its patch types are set).
        flow = flow_patches(
            spec.inputs,
            nu=fluid.mu / rho_ref,
            rho=rho_ref,
            turbulence_model=model,
            poly_mesh=out / "constant" / "polyMesh",
            compressible=True,
        )

    region_rows: list[dict[str, Any]] = []
    sources_total = 0.0
    thermal_meta: dict[str, dict[str, Any]] = {}
    opening_patches: list[str] = []
    dims = {"k": "[0 2 -2 0 0 0 0]", "omega": "[0 0 -1 0 0 0 0]", "epsilon": "[0 2 -3 0 0 0 0]", "nut": "[0 2 -1 0 0 0 0]"}
    for region in lay.regions:
        r = region.name
        patches = list(lay.patches.get(r, []))
        ifaces = lay.interfaces(r)
        z = out / "0" / r
        walls: list[str] = []
        row: dict[str, Any] = {
            "name": r,
            "role": region.role,
            "bodies": list(region.bodies),
            "material_id": region.record.get("id"),
            "material": region.material_name,
            "label": region.label,
            "patches": patches,
            "interfaces": ifaces,
            "volume_m3": lay.volumes.get(r),
        }
        if region.role == FLUID and flow is not None and fluid is not None:
            th, meta = thermal_entries(flow, spec, turbulent=turbulent)
            U = {p: flow.U[p] for p in patches if p in flow.U}
            T = {p: th["T"][p] for p in patches if p in th["T"]}
            p_rgh = {p: th["p_rgh"][p] for p in patches if p in th["p_rgh"]}
            p_ = {p: th["p"][p] for p in patches if p in th["p"]}
            alphat = {p: th["alphat"][p] for p in patches if p in th["alphat"]}
            for f in ifaces:
                U[f] = {"type": "noSlip"}
                T[f] = coupled("fluidThermo", start)
                p_rgh[f] = {"type": "fixedFluxPressure", "value": "uniform 0"}
                p_[f] = {"type": "calculated", "value": "uniform 0"}
                alphat[f] = (
                    {"type": "compressible::alphatJayatillekeWallFunction", "Prt": num(PRT), "value": "uniform 0"}
                    if turbulent
                    else {"type": "calculated", "value": "uniform 0"}
                )
            write_vol_field(z / "U", object_name="U", cls="volVectorField", dims="[0 1 -1 0 0 0 0]",
                            internal="uniform (0 0 0)", patches=U)
            write_vol_field(z / "T", object_name="T", cls="volScalarField", dims="[0 0 0 1 0 0 0]",
                            internal=f"uniform {start}", patches=T)
            write_vol_field(z / "p_rgh", object_name="p_rgh", cls="volScalarField", dims="[1 -1 -2 0 0 0 0]",
                            internal="uniform 0", patches=p_rgh)
            write_vol_field(z / "p", object_name="p", cls="volScalarField", dims="[1 -1 -2 0 0 0 0]",
                            internal="uniform 0", patches=p_)
            if turbulent:
                write_vol_field(z / "alphat", object_name="alphat", cls="volScalarField", dims="[1 -1 -1 0 0 0 0]",
                                internal="uniform 0", patches=alphat)
                for name in solved_turbulence_fields(model) + ("nut",):
                    entries = {p: e for p, e in (flow.turbulence.get(name) or {}).items() if p in patches}
                    for f in ifaces:
                        entries[f] = _wall_turbulence(flow, name)
                    write_vol_field(z / name, object_name=name, cls="volScalarField", dims=dims[name],
                                    internal=flow.turbulence_internal[name], patches=entries)
            write_foam_dict(out / "constant" / r / "thermophysicalProperties", "dictionary", "thermophysicalProperties",
                            thermophysical_text(fluid, density=density, t_ref=ph.reference_temperature,
                                                p_op=ph.operating_pressure, transient=transient))
            write_foam_dict(out / "constant" / r / "turbulenceProperties", "dictionary", "turbulenceProperties",
                            turbulence_text(model))
            write_foam_dict(out / "system" / r / "fvSchemes", "dictionary", "fvSchemes",
                            fv_schemes_text(model=model, numerics=ph.numerics, transient=spec.transient))
            write_foam_dict(out / "system" / r / "fvSolution", "dictionary", "fvSolution",
                            fv_solution_text(model=model, residual=ph.residual, n_non_orth=ph.n_non_orthogonal,
                                             transient=spec.transient, residual_control=False,
                                             relax=(ph.relax_u, ph.relax_p, ph.relax_h)))
            for p in patches:
                kind = flow.kinds.get(p, "wall")
                if kind == "wall":
                    walls.append(p)
                elif kind in OPENING_KINDS:
                    opening_patches.append(p)
                thermal_meta[f"{r}/{p}"] = {"region": r, "patch": p, **meta.get(p, {"kind": kind})}
            row["fluid"] = {"name": fluid.name, "density_model": density}
        else:
            props = solid_props(region.record)
            T = {}
            for p in patches:
                rec = by_patch.get(p)
                kind = record_kind(rec) or "wall"
                if kind == "symmetry":
                    T[p] = {"type": "symmetry"}
                    thermal_meta[f"{r}/{p}"] = {"region": r, "patch": p, "kind": "symmetry"}
                    continue
                T[p] = solid_wall_T(rec, start)
                walls.append(p)
                thermal_meta[f"{r}/{p}"] = {"region": r, "patch": p, "kind": "solid_wall", **wall_thermal(rec)}
            for f in ifaces:
                T[f] = coupled("solidThermo", start)
            write_vol_field(z / "T", object_name="T", cls="volScalarField", dims="[0 0 0 1 0 0 0]",
                            internal=f"uniform {start}", patches=T)
            # A solid region needs its p (HT0): calculated, gauge.
            write_vol_field(z / "p", object_name="p", cls="volScalarField", dims="[1 -1 -2 0 0 0 0]",
                            internal="uniform 0", patches={'".*"': {"type": "calculated", "value": "uniform 0"}})
            write_foam_dict(out / "constant" / r / "thermophysicalProperties", "dictionary", "thermophysicalProperties",
                            solid_thermo_text(props.rho, props.cp, props.k))
            write_foam_dict(out / "system" / r / "fvSchemes", "dictionary", "fvSchemes",
                            solid_schemes_text(numerics=ph.numerics, transient=spec.transient))
            write_foam_dict(out / "system" / r / "fvSolution", "dictionary", "fvSolution",
                            solid_solution_text(n_non_orth=ph.n_non_orthogonal, transient=spec.transient))
            src = spec.heat_sources.get(str(region.record.get("id") or ""))
            fv = out / "system" / r / "fvOptions"
            if src is not None and src.on:
                value = src.power_w if src.mode == "power" else src.power_density_w_m3
                write_foam_dict(fv, "dictionary", "fvOptions", heat_source_text(src.mode, value))
                total = src.total_w(float(lay.volumes.get(r) or 0.0))
                row["source"] = {"mode": src.mode, "value": value, "W": total}
                sources_total += total
            else:
                fv.unlink(missing_ok=True)
            row["solid"] = {"name": props.name, "rho": props.rho, "cp": props.cp, "k": props.k}
        row["walls"] = walls
        region_rows.append(row)

    write_foam_dict(out / "constant" / "regionProperties", "dictionary", "regionProperties", region_properties_text(lay))
    g = ph.g()
    write_foam_dict(out / "constant" / "g", "uniformDimensionedVectorField", "g",
                    f"dimensions      [0 1 -2 0 0 0 0];\nvalue           ({num(g[0])} {num(g[1])} {num(g[2])});")
    # The top-level dictionaries the solvers still read (each region has its own).
    write_foam_dict(out / "system" / "fvSchemes", "dictionary", "fvSchemes",
                    "ddtSchemes {} gradSchemes {} divSchemes {} laplacianSchemes {} interpolationSchemes {} snGradSchemes {}")
    outer = int(spec.transient.n_outer_correctors) if spec.transient is not None else 1
    write_foam_dict(out / "system" / "fvSolution", "dictionary", "fvSolution", f"PIMPLE {{ nOuterCorrectors {outer}; }}")

    from .cht_functions import cht_functions_text, plan_cht_monitors

    stops_off = convergence_stops_off(spec)
    try:
        plans = plan_cht_monitors(spec, lay, by_patch, out=out, poly_dir=mesh_case / "constant" / "polyMesh")
    except ChtError as exc:
        return {"ok": False, "error": str(exc)}
    settle = None if stops_off else plan_settle(spec, plans)
    functions = cht_functions_text(lay, region_rows, opening_patches=opening_patches, monitor_plans=plans,
                                   fluid_region=lay.fluids[0].name if lay.fluids and flow is not None else None,
                                   t_ref=ph.reference_temperature)
    stop_text = settle_functions_text(settle, region=names[0])
    if stop_text:
        functions += "\n" + stop_text
    app = solver_app(spec)
    write_foam_dict(out / "system" / "controlDict", "dictionary", "controlDict",
                    control_dict_text(app=app, spec=spec, functions=functions, restart_from=restart_from,
                                      max_di=MAX_DI if transient else None))
    if int(spec.n_procs) > 1:
        write_decompose_par_dict(out / "system" / "decomposeParDict", int(spec.n_procs))
    else:
        (out / "system" / "decomposeParDict").unlink(missing_ok=True)
    (out / "case.foam").write_text("", encoding="ascii")

    mapped = []
    for patch, rec in by_patch.items():
        faces = [str(f) for f in rec.get("faces") or []]
        area = sum(float((spec.face_props.get(f) or {}).get("area_m2") or 0) for f in faces) or None
        mapped.append({
            "id": rec.get("id"),
            "name": rec.get("name"),
            "bc_type": rec.get("bc_type"),
            "patch": patch,
            "regions": lay.regions_of_patch(patch),
            "faces": faces,
            "face_area_m2": area,
        })
    sidecar: dict[str, Any] = {
        "endTime": spec.end_time,
        "writeInterval": spec.write_interval,
        "nProcs": int(spec.n_procs),
        "solver": app,
        "time_dependency": "Transient" if transient else "Steady-state",
        # The runner: the case's regions (and the split that makes them).
        "regions": [{"name": r.name, "role": r.role} for r in lay.regions],
        "kinematic_fields": [],
        "cht": True,
        "region_rows": region_rows,
        "touching": [list(t) for t in lay.touching],
        "fluid_region": lay.fluids[0].name if lay.fluids else None,
        "patches": all_patches,
        "mapped": mapped,
        "thermal": thermal_meta,
        "opening_patches": opening_patches,
        "sources_W": sources_total,
        "ht_monitors": plans,
        "gravity_m_s2": list(g),
        "operating_pressure_Pa": ph.operating_pressure,
        "reference_temperature_K": ph.reference_temperature,
        "initial_temperature_K": ph.start_temperature(),
        "turbulence": {"model": model},
        "numerics": {"preset": ph.numerics, "n_non_orthogonal": ph.n_non_orthogonal,
                     "relax_u": ph.relax_u, "relax_p_rgh": ph.relax_p, "relax_h": ph.relax_h},
        "n_cells": spec.n_cells,
        "mesh_id": spec.mesh_id,
        "run_id": spec.run_id,
    }
    if lay.split:
        sidecar["pre_steps"] = [dict(SPLIT_STEP)]
    if fluid is not None and rho_ref:
        sidecar["rho"] = rho_ref
        sidecar["nu"] = fluid.mu / rho_ref
        sidecar["fluid"] = {**dataclasses.asdict(fluid), "prandtl": fluid.prandtl}
        sidecar["density_model"] = density
        if flow is not None:
            sidecar["turbulence"].update({"speed_ref_m_s": flow.speed_ref, "hydraulic_diameter_m": flow.hydraulic_diameter})
    if settle is not None:
        sidecar["settle"] = settle
    if transient and spec.transient is not None:
        sidecar["transient"] = {**dataclasses.asdict(spec.transient), "max_di": MAX_DI}
    if restart_from is not None:
        sidecar["restart"] = {"from_time": restart_from, "end_time": float(spec.end_time)}
        if stops_off:
            sidecar["restart"]["stops_off"] = True
    (out / "w27-case.json").write_text(json.dumps(sidecar, indent=2) + "\n", encoding="utf-8")
    report: dict[str, Any] = {
        "ok": True,
        "case_dir": str(out),
        "solver": app,
        "n_procs": int(spec.n_procs),
        "patches": all_patches,
        "regions": names,
        "polyMesh_copied": True,
    }
    if restart_from is not None:
        report["restart"] = dict(sidecar["restart"])
    return report


def located(spec: HtSpec, lay: Layout, poly_dir: Path, points: list[list[float]]) -> list[str | None]:
    """The region of each thermocouple point (None outside the mesh); every point the one
    region of a mesh of one region."""
    if not points:
        return []
    try:
        return locate_points(lay, poly_dir, points, keep=True)
    except ChtError:
        return [None for _ in points]


__all__ = [
    "MAX_DI",
    "SOLID",
    "SPLIT_STEP",
    "STEADY_SOLVER",
    "TRANSIENT_SOLVER",
    "ADIABATIC",
    "solver_app",
    "write_cht_case",
]
