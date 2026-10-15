"""What blocks a conjugate heat transfer run (a study with a solid body), in plain words.

In Start's order, after the materials and the study settings:

1. the mesh: made for these materials (one region per material record), and
   readable; no solid about one cell thick (heat_transfer.cht.thin_problem);
2. the boundary conditions: each on a patch of the mesh; an inlet, outlet,
   pressure or freestream only on a fluid body, a Solid wall only on a solid one;
   Incompressible Flow's own checks of the fluid's boundaries, and each one's
   thermal fields;
3. the fluid (when there is one): a pressure level when it has openings, and
   something that moves it when it has none (gravity, a moving wall);
4. heat paths: every group of touching bodies needs a way for its temperature to
   be set. A steady solve needs a place where heat can leave (a fixed temperature,
   a heat transfer coefficient, or the flow through an inlet and an outlet) as
   soon as heat comes in (a heat source, a heat flux); a group with nothing at all
   (every face adiabatic, no source, no flow) is refused in either kind of run;
5. the density model against gravity and the temperatures (as a buoyant run).
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from .bcs import (
    ADIABATIC,
    FIXED_T,
    HEAT_FLUX,
    HTC,
    record_kind,
    thermal_problem,
    wall_mode,
    wall_thermal,
)
from .cht import FLUID, SOLID, ChtError, Layout, bodies_text, layout, thin_problem

OPENINGS = ("inlet", "pressure", "velocity_outlet", "freestream", "total_pressure")
CFMESH_TEXT = "cfMesh can't mesh solid bodies separately: mesh with Standard or Hex-dominant."


def _fix_mesh(ctx: Any) -> dict[str, Any]:
    return {"go": "mesh", "id": ctx.mesh.get("mesh_id"), "name": ctx.mesh.get("mesh_name")}


def mesh_layout(ctx: Any, records: list[dict[str, Any]]) -> Layout | dict[str, Any]:
    """The study's regions on its mesh, or the issue that blocks them."""
    mesh = ctx.mesh or {}
    name = str(mesh.get("mesh_name") or "The mesh")
    rows = mesh.get("regions")
    if mesh.get("out_of_date_materials"):
        text = (
            f"{name} was made before the materials changed (each material's bodies are meshed as a region "
            "of their own): generate it again."
        )
        if not rows and str(mesh.get("engine") or "") == "cfmesh":
            text += " " + CFMESH_TEXT
        return {"message": text, "fix": _fix_mesh(ctx)}
    case = Path(ctx.mesh_case_dir) if ctx.mesh_case_dir else None
    if case is None:
        return {"message": f"{name} has no case folder: generate it again.", "fix": _fix_mesh(ctx)}
    try:
        return layout(rows, records, case / "constant" / "polyMesh", mesh_name=name, thin=True, keep=True)
    except ChtError as exc:
        return {"message": str(exc), "fix": _fix_mesh(ctx)}


def _regions_of_bc(lay: Layout, bc: dict[str, Any], patch: str) -> list[Any]:
    return [lay.region(r) for r in lay.regions_of_record(bc, patch)]


def _source_on(heat_sources: dict[str, Any], region: Any) -> bool:
    src = heat_sources.get(str(region.record.get("id") or ""))
    return bool(src is not None and src.on)


def _source_sign(heat_sources: dict[str, Any], region: Any) -> float:
    """+1 a source that heats, -1 one that takes heat out, 0 none (a per-volume source's
    sign is its rate's)."""
    src = heat_sources.get(str(region.record.get("id") or ""))
    if src is None or not src.on:
        return 0.0
    return math.copysign(1.0, src.power_w if src.mode == "power" else src.power_density_w_m3)


def validate_cht(ctx: Any, records: list[dict[str, Any]], fluid: Any, physics: Any, *, transient: bool,
                 imperial: bool) -> list[dict[str, Any]]:
    """The issues of a conjugate heat transfer study (empty when it can run)."""
    from incompressible_flow.flow_bcs import first_boundary_problem, varies_with_time, wall_motion
    from magnusim_sdk.study import bc_faces, map_bc_to_patch, matches_study

    from .contract import BOUSSINESQ_LIMIT, _fmt_t, _mesh_web_bcs, boundary_temperatures
    from .physics import heat_sources_of

    lay = mesh_layout(ctx, records)
    if isinstance(lay, dict):
        return [lay]
    thin = thin_problem(lay)
    if thin:
        return [{"message": thin, "fix": _fix_mesh(ctx)}]

    sid = ctx.simulation_id
    bcs = [b for b in ctx.bcs if matches_study(b, sid) and bc_faces(b)]
    patch_names = set(ctx.patches) or set(lay.patch_types)
    web_bcs = _mesh_web_bcs(ctx.mesh_case_dir)
    on_patch: dict[str, dict[str, Any]] = {}
    for bc in bcs:
        patch = map_bc_to_patch(bc, patch_names, web_bcs)
        if patch not in patch_names:
            return [
                {
                    "message": (
                        f'Mesh has no patch for "{bc.get("name")}" (looked for {patch}). '
                        "Generate the mesh after assigning BCs."
                    ),
                    "fix": _fix_mesh(ctx),
                    "patches": sorted(patch_names),
                }
            ]
        on_patch.setdefault(patch, bc)
        kind = record_kind(bc) or ""
        fix = {"go": "bc", "id": bc.get("id"), "name": bc.get("name")}
        where = _regions_of_bc(lay, bc, patch)
        roles = {r.role for r in where}
        if kind in OPENINGS and SOLID in roles:
            solid = next(r for r in where if r.role == SOLID)
            return [
                {
                    "message": (
                        f'"{bc.get("name")}" is on {bodies_text(solid.bodies)}, which is solid ({solid.material_name}): '
                        "fluid comes in or goes out only through a fluid body's faces. Move it to the fluid's faces, "
                        "or give the solid's faces a Solid wall."
                    ),
                    "fix": fix,
                }
            ]
        if kind == "solid_wall" and FLUID in roles:
            fl = next(r for r in where if r.role == FLUID)
            return [
                {
                    "message": (
                        f'Solid wall "{bc.get("name")}" is on {bodies_text(fl.bodies)}, which is fluid ({fl.material_name}). '
                        "Give a fluid's faces a Wall."
                    ),
                    "fix": fix,
                }
            ]

    fluid_bcs = [
        b for b in bcs if any(r.role == FLUID for r in _regions_of_bc(lay, b, map_bc_to_patch(b, patch_names, web_bcs)))
    ]
    if lay.fluids:
        flow_problem = first_boundary_problem(fluid_bcs, turbulence_model=physics.turbulence_model, transient=transient)
        if flow_problem is not None:
            owner: dict[str, Any] = next(
                (
                    b
                    for b in fluid_bcs
                    if first_boundary_problem([b], turbulence_model=physics.turbulence_model, transient=transient)
                    == flow_problem
                ),
                {},
            )
            return [{"message": flow_problem.message, "fix": {"go": "bc", "id": owner.get("id"), "name": owner.get("name")}}]
    for bc in bcs:
        kind = record_kind(bc) or ""
        fix = {"go": "bc", "id": bc.get("id"), "name": bc.get("name")}
        problem = thermal_problem(bc, kind)
        if not problem and transient and kind in ("pressure", "total_pressure") and varies_with_time(bc, transient=True):
            problem = (
                '"Varies with time" is not used on pressure boundaries in heat transfer studies; '
                "turn it off and give the boundary a fixed pressure"
            )
        if problem:
            return [{"message": f'"{bc.get("name")}": {problem}.', "fix": fix}]
        if bc in fluid_bcs and kind == "wall" and wall_motion(bc) == "slip" and wall_mode(bc) != ADIABATIC:
            what = {FIXED_T: "a fixed temperature", HEAT_FLUX: "a heat flux", HTC: "a heat transfer coefficient"}[wall_mode(bc)]
            return [
                {
                    "message": (
                        f'Wall "{bc.get("name")}" is a slip wall with {what}: a slip wall has no boundary layer, '
                        "so the heat through it would be wrong. Make it a No-slip wall, or set its Thermal to Adiabatic."
                    ),
                    "fix": fix,
                }
            ]
    study_rec = ctx.study if isinstance(ctx.study, dict) else {}
    from .physics import heat_source_problem

    solid_recs = [r.record for r in lay.solids]
    source_issue = heat_source_problem(study_rec, solid_recs)
    if source_issue:
        mat = source_issue["material"]
        if mat is None:
            return [{"message": f"Study settings: {source_issue['message']}.", "fix": {"go": "study"}}]
        return [{"message": f"{source_issue['message']}.", "fix": {"go": "material", "id": mat.get("id"), "name": mat.get("name")}}]
    sources = heat_sources_of(study_rec, solid_recs)

    kinds = {p: record_kind(b) or "" for p, b in on_patch.items()}
    if lay.fluids:
        fluid_region = lay.fluids[0]
        fkinds = [kinds.get(p, "wall") for p in lay.patches.get(fluid_region.name, [])]
        openings = [k for k in fkinds if k in OPENINGS]
        if openings and not any(k in ("pressure", "freestream", "total_pressure") for k in fkinds):
            return [{"message": "Add a pressure boundary with an assigned face", "fix": {"go": "bc-picker"}}]
        for bc in fluid_bcs:
            if record_kind(bc) == "velocity_outlet":
                try:
                    zero = float(bc.get("value")) == 0
                except (TypeError, ValueError):
                    zero = False
                if zero:
                    return [
                        {
                            "message": (
                                f'Velocity outlet "{bc.get("name")}" lets nothing out (its value is 0). '
                                "Give it an outflow, or make it a Wall."
                            ),
                            "fix": {"go": "bc", "id": bc.get("id"), "name": bc.get("name")},
                        }
                    ]
        if not openings:
            moving = any(wall_motion(b) in ("moving", "rotating") for b in fluid_bcs if record_kind(b) == "wall")
            if not physics.gravity_on and not moving:
                return [
                    {
                        "message": (
                            f"Nothing moves the fluid in {fluid_region.label}: it has no inlet or outlet, gravity is off "
                            "and no wall moves. Turn gravity on (natural convection), make a wall Moving or Rotating, "
                            "or add an inlet and an outlet."
                        ),
                        "fix": {"go": "study"},
                    }
                ]

    # Heat paths, group by group of touching bodies. A heat source or a heat flux brings heat
    # in (or takes it out, below 0); only a temperature, a coefficient or an opening sets one.
    for group in lay.groups():
        regions = [lay.region(n) for n in group]
        sink = False
        heat_in: list[str] = []
        heat_out: list[str] = []
        for r in regions:
            sign = _source_sign(sources, r) if r.role == SOLID else 0.0
            if sign:
                (heat_in if sign > 0 else heat_out).append(f"the heat source in {bodies_text(r.bodies)}")
            for p in lay.patches.get(r.name, []):
                bc = on_patch.get(p)
                kind = kinds.get(p, "")
                if r.role == FLUID and kind in OPENINGS:
                    sink = True
                    continue
                if kind not in ("wall", "solid_wall"):
                    continue
                w = wall_thermal(bc)
                if w["mode"] in (FIXED_T, HTC):
                    sink = True
                elif w["mode"] == HEAT_FLUX and w.get("q"):
                    flux_at = f'the heat flux on "{bc.get("name") if bc else p}"'
                    (heat_in if float(w["q"]) > 0 else heat_out).append(flux_at)
        if sink:
            continue
        labels = " and ".join(r.label for r in regions)
        if not heat_in and not heat_out:
            solid = next((r for r in regions if r.role == SOLID), None)
            if solid is not None and len(regions) == 1:
                text = (
                    f"{solid.label} is solid, but every face of it is adiabatic and it has no heat source: nothing sets "
                    "its temperature. Give a face a Solid wall with a temperature or a heat transfer coefficient, "
                    "or a heat source, or let it touch the fluid."
                )
            else:
                text = (
                    f"Nothing heats or cools {labels}: every face is adiabatic and nothing flows through. Give a face a "
                    "temperature, a heat flux or a heat transfer coefficient, or a solid a heat source."
                )
            return [{"message": text, "fix": {"go": "bc-picker"}}]
        if not transient:
            if heat_in:
                text = (
                    f"A steady solve of {labels} needs a way for heat to leave: here heat comes in "
                    f"({heat_in[0]}) but no face takes it out, so there is no steady temperature."
                )
            else:
                text = (
                    f"A steady solve of {labels} needs a face that sets a temperature: here heat only goes out "
                    f"({heat_out[0]}) and nothing brings it in, so there is no steady temperature."
                )
            return [
                {
                    "message": text + (
                        " Give a face a fixed temperature or a heat transfer coefficient, add an inlet and an outlet, "
                        "or solve it as a transient study."
                    ),
                    "fix": {"go": "bc-picker"},
                }
            ]

    if fluid is not None and lay.fluids:
        density = physics.density_for(fluid)
        if density == "constant" and physics.gravity_on:
            return [
                {
                    "message": (
                        "Constant density cannot carry buoyancy: with gravity on, use Boussinesq or incompressible "
                        "perfect gas, or turn gravity off for forced convection."
                    ),
                    "fix": {"go": "study"},
                }
            ]
        if density == "perfect_gas" and not fluid.gas:
            return [
                {
                    "message": (
                        f"Incompressible perfect gas is for gases, and {fluid.name} is a liquid "
                        f"({fluid.rho:g} kg/m³). Use Boussinesq."
                    ),
                    "fix": {"go": "study"},
                }
            ]
        temps = boundary_temperatures(bcs)
        heated = next((r for r in lay.solids if _source_sign(sources, r) > 0), None)
        if density == "boussinesq" and fluid.gas and heated is not None:
            # HT0: air under Boussinesq round a 10 W heater ran to 600 K, where its density
            # (rho (1 - beta dT)) went to 0. How hot a source makes it is not known before the solve.
            return [
                {
                    "message": (
                        f"Boussinesq holds for small temperature differences, and the heat source in "
                        f"{bodies_text(heated.bodies)} can heat {fluid.name} far past them (its density would go "
                        "to 0). Use incompressible perfect gas."
                    ),
                    "fix": {"go": "study"},
                }
            ]
        if density == "boussinesq":
            t_ref = physics.reference_temperature
            all_t = [*temps, ("the starting temperature", physics.start_temperature())]
            worst = max(all_t, key=lambda nt: abs(nt[1] - t_ref))
            product = fluid.beta * abs(worst[1] - t_ref)
            if product >= BOUSSINESQ_LIMIT:
                return [
                    {
                        "message": (
                            f"Boussinesq holds for small temperature differences: β·ΔT is {product:.2f} "
                            f"({_fmt_t(worst[1], imperial)} at {worst[0]} against the reference {_fmt_t(t_ref, imperial)}), "
                            f"and it must stay below {BOUSSINESQ_LIMIT:g}. Use incompressible perfect gas, or bring the "
                            "temperatures closer to the reference."
                        ),
                        "fix": {"go": "study"},
                    }
                ]
    if any(not math.isfinite(t) or t <= 0 for _n, t in boundary_temperatures(bcs)):
        return [{"message": "A boundary temperature is not above absolute zero.", "fix": {"go": "bc-picker"}}]
    return []
