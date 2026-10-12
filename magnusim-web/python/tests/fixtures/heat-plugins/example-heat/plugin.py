"""Heat example: the host API 1.8 pieces a heat-transfer analysis builds on.

An analysis that offers a fluid and a solid material model (a study holds one
material per group of bodies) and adds Thermal fields to Incompressible Flow's
inlets and walls (``bc_fields``). It writes no case: e2e/ht1-several-materials
tests the panels, the tree and Generate's answer, not a solve. It imports
nothing but cfddesk.registry.
"""

from __future__ import annotations

from typing import Any

from cfddesk.registry import AnalysisType, BcFieldGroup, MaterialModel, SchemaField
from cfddesk.registry.contract import AnalysisFamily

PLUGIN = "example-heat"

FAMILY = AnalysisFamily(
    key="example_heat",
    label="Heat (example)",
    title="Heat (example)",
    description="A test simulation type with fluid and solid materials.",
    tags=("TEST",),
    study_name="Heat",
)

FLUID = MaterialModel(
    key="example_heat_fluid",
    label="Fluid",
    role="fluid",
    properties_schema=(
        SchemaField("k", "(k) Thermal conductivity", "float", default=0.0257, min=0, quantity="thermal_conductivity"),
        SchemaField("cp", "(cp) Specific heat", "float", default=1005.0, min=0, quantity="specific_heat"),
    ),
    library=(
        {"key": "air", "name": "Air", "values": {"k": 0.0257, "cp": 1005.0}, "library": "AIR", "codes": ("AIR", "DEFAULT")},
        {"key": "water", "name": "Water", "values": {"k": 0.598, "cp": 4182.0}, "library": "WATER", "codes": ("WATER",)},
    ),
    record_keys={"k": ("thermal_conductivity", "k"), "cp": ("specific_heat", "cp")},
)

SOLID = MaterialModel(
    key="example_heat_solid",
    label="Solid",
    role="solid",
    properties_schema=(
        SchemaField("k", "(k) Thermal conductivity", "float", default=167.0, min=0, quantity="thermal_conductivity"),
    ),
    library=(
        {"key": "aluminium", "name": "Aluminium 6061", "values": {"k": 167.0}, "library": "AL6061", "codes": ("AL6061", "DEFAULT")},
        {"key": "copper", "name": "Copper", "values": {"k": 398.0}, "library": "CU", "codes": ("CU",)},
    ),
    record_keys={"k": ("thermal_conductivity", "k")},
)

INLET_T = SchemaField("inlet_temperature", "Inlet temperature", "float", default=293.15, quantity="temperature")
THERMAL = SchemaField(
    "thermal_wall", "Thermal", "choice", default="Adiabatic", choices=("Adiabatic", "Fixed temperature")
)
WALL_T = SchemaField(
    "wall_temperature",
    "Wall temperature",
    "float",
    default=293.15,
    quantity="temperature",
    depends_on={"thermal_wall": "Fixed temperature"},
)


def validate_ready(_ctx: Any) -> list[dict[str, Any]]:
    return [{"message": "The heat example does not solve", "fix": {"go": "study"}}]


def register(hub: Any) -> None:
    mats = hub.registry("material")
    mats.register(FLUID, plugin=PLUGIN)
    mats.register(SOLID, plugin=PLUGIN)
    hub.registry("analysis").register(
        AnalysisType(
            key="example_heat_steady",
            label="Heat (example)",
            category="test",
            time_dependency="steady",
            fields=("T",),
            bc_types=("velocity_inlet_fixed", "pressure_outlet_gauge", "wall_noslip", "wall_slip"),
            material_models=(FLUID.key, SOLID.key),
            bc_fields=(
                BcFieldGroup("inlet_thermal", "Thermal", (INLET_T,), families=("velocity_inlet",)),
                BcFieldGroup(
                    "wall_thermal",
                    "Thermal",
                    (THERMAL, WALL_T),
                    families=("wall",),
                    description="Heat through the wall.",
                ),
            ),
            family=FAMILY,
            algorithm_label="None",
            validate_ready=validate_ready,
        ),
        plugin=PLUGIN,
    )
