"""Run inputs for Heat Transfer tests: what the core gathers for one run, built by hand."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from cfddesk.project.run_inputs import RunInputs

FIXTURES = Path(__file__).resolve().parent / "fixtures"
GOLDEN = Path(__file__).resolve().parent / "goldens"
MESH = FIXTURES / "mesh"
MESH_PATCHES = ["walls", "inlet", "outlet", "heater", "cold_plate", "lid", "side"]

AIR = {
    "id": "m-air",
    "name": "Air",
    "material_model": "thermo_fluid",
    "preset": "air",
    "library": "HT_AIR",
    "assigned_volumes": ["Body1"],
    "density": 1.204,
    "dynamic_viscosity": 1.825e-5,
    "specific_heat": 1007.0,
    "thermal_conductivity": 0.02514,
    "thermal_expansion": 3.411e-3,
    "molar_mass": 28.97,
}
WATER = {
    "id": "m-water",
    "name": "Water",
    "material_model": "thermo_fluid",
    "preset": "water",
    "library": "HT_WATER",
    "assigned_volumes": ["Body1"],
    "density": 998.0,
    "dynamic_viscosity": 1.002e-3,
    "specific_heat": 4182.0,
    "thermal_conductivity": 0.598,
    "thermal_expansion": 2.07e-4,
    "molar_mass": 18.015,
}
ALUMINIUM = {
    "id": "m-al",
    "name": "Aluminium 6061",
    "material_model": "thermo_solid",
    "preset": "aluminium_6061",
    "assigned_volumes": ["Body2"],
    "density": 2700.0,
    "specific_heat": 896.0,
    "thermal_conductivity": 167.0,
}

# A channel: inlet at 20 °C, a pressure outlet, a heated wall (heat flux), a cold
# plate (fixed temperature), a lid exchanging heat with 15 °C (HTC), a symmetry side
# and the walls no BC claims (adiabatic).
CHANNEL_BCS: list[dict[str, Any]] = [
    {"id": "bc-in", "name": "inlet", "bc_type": "Velocity inlet", "value": 0.5, "unit": "m/s", "faces": ["face 1@Body1"],
     "inlet_temperature": 293.15},
    {"id": "bc-out", "name": "outlet", "bc_type": "Pressure", "value": 0, "unit": "Pa", "faces": ["face 2@Body1"],
     "backflow_temperature": 295.15},
    {"id": "bc-heat", "name": "heater", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["face 3@Body1"],
     "thermal_condition": "heat_flux", "wall_heat_flux": 2500},
    {"id": "bc-cold", "name": "cold_plate", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["face 4@Body1"],
     "thermal_condition": "temperature", "wall_temperature": 283.15},
    {"id": "bc-lid", "name": "lid", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["face 5@Body1"],
     "thermal_condition": "heat_transfer_coefficient", "wall_htc": 12, "ambient_temperature": 288.15},
    {"id": "bc-side", "name": "side", "bc_type": "Symmetry", "faces": ["face 6@Body1"]},
]

# A closed box: a hot and a cold wall (the de Vahl Davis cavity's).
CAVITY_BCS: list[dict[str, Any]] = [
    {"id": "bc-hot", "name": "heater", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["face 3@Body1"],
     "thermal_condition": "temperature", "wall_temperature": 303.15},
    {"id": "bc-cold", "name": "cold_plate", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["face 4@Body1"],
     "thermal_condition": "temperature", "wall_temperature": 293.15},
    {"id": "bc-side", "name": "side", "bc_type": "Symmetry", "faces": ["face 6@Body1"]},
]

FACE_PROPS = {f"face {i}@Body1": {"area_m2": 0.001 * i, "normal": [1.0, 0.0, 0.0], "centroid": [0.0, 0.0, 0.0]} for i in range(1, 7)}

MONITORS = [
    {"id": "mon-q", "name": "Heater flux", "monitor_type": "ht_wall_heat_flux", "boundaries": ["bc-heat"]},
    {"id": "mon-t", "name": "Plate temperature", "monitor_type": "ht_surface_temperature", "boundaries": ["bc-cold", "@walls"]},
    {"id": "mon-tc", "name": "Thermocouple 1", "monitor_type": "ht_thermocouple", "points": [[0.05, 0.01, 0.02]]},
]


def make_inputs(
    root: Path,
    *,
    materials: list[dict[str, Any]] | None = None,
    bcs: list[dict[str, Any]] | None = None,
    study: dict[str, Any] | None = None,
    run: dict[str, Any] | None = None,
    transient: dict[str, Any] | None = None,
    mesh_dir: Path | None = MESH,
    restart: dict[str, Any] | None = None,
    n_procs: int = 1,
) -> RunInputs:
    mats = [{**m, "simulation_id": "sim_1"} for m in (materials if materials is not None else [AIR])]
    records = [{**b, "simulation_id": "sim_1"} for b in (bcs if bcs is not None else CHANNEL_BCS)]
    td = "transient" if transient is not None else "steady"
    return RunInputs(
        project_dir=root,
        run_id="run_1",
        simulation_id="sim_1",
        mesh_id="mesh_1",
        n_procs=n_procs,
        require_mesh=mesh_dir is not None,
        time_dependency=td,  # type: ignore[arg-type]
        analysis_key=f"heat_transfer_{td}",
        solver_key="buoyantPimpleFoam" if transient is not None else "buoyantSimpleFoam",
        materials={"materials": mats},
        bcs_doc={"defaults": {"wall_type": "No-slip"}, "boundary_conditions": records},
        result_controls={},
        simulation_control={"endTime": 500, "writeInterval": 100},
        mesh={"ok": True, "case_dir": str(mesh_dir or root), "patches": MESH_PATCHES, "n_cells": 1000, "mesh_id": "mesh_1"}
        if mesh_dir is not None
        else {},
        face_props=FACE_PROPS,
        study=dict(study or {}),
        run=dict(run or {}),
        transient_override=transient,
        restart=restart,
    )
