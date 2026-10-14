"""Heat Transfer's material model: a fluid with thermal properties.

``thermo_fluid`` (role fluid): density, dynamic viscosity, specific heat,
thermal conductivity, thermal expansion and molar mass. Constant properties,
at 20 °C and 1 atm; the sources are in the plugin's README.

A study of a Heat Transfer analysis holds one material record per group of
bodies (host API 1.8); every body of a fluid record is fluid. Solids (heat
conduction through solid bodies) are not part of this version: a record of the
solid model a development build saved (``thermo_solid``) is refused at Start.

``fluid_props`` reads one saved record: its own numbers, else its preset's
(a record keeps the numbers it was saved with). ``fluid_problem`` says which
saved number cannot be solved with (a thermal expansion of 0 is a real value:
no buoyancy from temperature).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from cfddesk.registry.material import MaterialModel
from cfddesk.registry.schema import SchemaField

FLUID_MODEL = "thermo_fluid"
# The solid model of development builds: no longer registered; a study that
# still holds one of its records is refused at Start (heat_transfer.contract).
SOLID_MODEL = "thermo_solid"
CUSTOM_PRESET = "custom"

# A fluid lighter than this (kg/m³) is a gas: its density follows the ideal gas
# law (incompressible perfect gas) when the study's density model is automatic.
GAS_DENSITY_LIMIT = 50.0

# The universal gas constant, J/(kmol·K).
R_UNIVERSAL = 8314.462618


def _fluid_row(
    key: str,
    name: str,
    *,
    rho: float,
    mu: float,
    cp: float,
    k: float,
    beta: float,
    molar_mass: float,
    library: str,
    codes: tuple[str, ...] = (),
) -> dict[str, Any]:
    return {
        "key": key,
        "name": name,
        "values": {"rho": rho, "mu": mu, "cp": cp, "k": k, "beta": beta, "molar_mass": molar_mass},
        "library": library,
        "codes": codes or (library,),
        "names": (name,),
    }


# At 20 °C, 1 atm (README: sources).
FLUID_PRESETS: tuple[dict[str, Any], ...] = (
    _fluid_row(
        "air", "Air", rho=1.204, mu=1.825e-5, cp=1007.0, k=0.02514, beta=3.411e-3, molar_mass=28.97,
        library="HT_AIR", codes=("HT_AIR", "DEFAULT"),
    ),
    _fluid_row(
        "water", "Water", rho=998.0, mu=1.002e-3, cp=4182.0, k=0.598, beta=2.07e-4, molar_mass=18.015,
        library="HT_WATER",
    ),
    _fluid_row(
        "oil_vg32", "Oil (ISO VG 32)", rho=869.0, mu=0.075, cp=1881.0, k=0.145, beta=7.0e-4, molar_mass=400.0,
        library="HT_OIL_VG32",
    ),
    _fluid_row(
        "nitrogen", "Nitrogen", rho=1.165, mu=1.76e-5, cp=1040.0, k=0.0253, beta=3.411e-3, molar_mass=28.013,
        library="HT_NITROGEN",
    ),
    # The user's own: starts from Air's numbers and keeps the ones typed.
    {**_fluid_row(
        CUSTOM_PRESET, "Custom fluid", rho=1.204, mu=1.825e-5, cp=1007.0, k=0.02514, beta=3.411e-3,
        molar_mass=28.97, library="HT_CUSTOM_FLUID",
    ), "names": ()},
)


# How a study's material record stores each property: the record keys that may
# hold it, the first preferred.
FLUID_RECORD_KEYS: dict[str, tuple[str, ...]] = {
    "rho": ("density", "rho"),
    "mu": ("dynamic_viscosity", "mu"),
    "cp": ("specific_heat", "cp"),
    "k": ("thermal_conductivity", "k"),
    "beta": ("thermal_expansion", "beta"),
    "molar_mass": ("molar_mass",),
}
# Properties that may be 0 (thermal expansion: no buoyancy from temperature);
# every other one must be above 0.
ZERO_ALLOWED: frozenset[str] = frozenset({"beta"})
PROPERTY_LABELS: dict[str, str] = {
    "rho": "density",
    "mu": "dynamic viscosity",
    "cp": "specific heat",
    "k": "thermal conductivity",
    "beta": "thermal expansion",
    "molar_mass": "molar mass",
}


def _fluid_schema() -> tuple[SchemaField, ...]:
    air = FLUID_PRESETS[0]["values"]
    return (
        SchemaField("rho", "(ρ) Density", "float", default=air["rho"], min=0.0, quantity="density", group="thermal",
                    description="At the reference temperature. A gas's density follows the ideal gas law from its molar mass "
                    "(incompressible perfect gas); a liquid's follows its thermal expansion (Boussinesq)."),
        SchemaField("mu", "(μ) Dynamic viscosity", "float", default=air["mu"], min=0.0, quantity="dynamic_viscosity",
                    group="thermal"),
        SchemaField("cp", "(cp) Specific heat", "float", default=air["cp"], min=0.0, quantity="specific_heat",
                    group="thermal"),
        SchemaField("k", "(k) Thermal conductivity", "float", default=air["k"], min=0.0, quantity="thermal_conductivity",
                    group="thermal"),
        SchemaField("beta", "(β) Thermal expansion", "float", default=air["beta"], min=0.0, quantity="thermal_expansion",
                    group="thermal", description="Used by the Boussinesq density model: ρ = ρ₀ (1 − β (T − T_ref))."),
        SchemaField("molar_mass", "(M) Molar mass", "float", default=air["molar_mass"], min=0.0, quantity="molar_mass",
                    group="thermal", description="Used by the incompressible perfect gas model: ρ = p_op M / (R T)."),
    )


def build_thermo_fluid() -> MaterialModel:
    return MaterialModel(
        key=FLUID_MODEL,
        label="Fluid (thermal)",
        role="fluid",
        properties_schema=_fluid_schema(),
        library=FLUID_PRESETS,
        record_keys=FLUID_RECORD_KEYS,
        record_constants={"type": "Fluid", "properties_at": "20 °C"},
        custom_preset=CUSTOM_PRESET,
    )


@dataclass(frozen=True)
class FluidProps:
    """One fluid record's properties, SI."""

    name: str
    rho: float
    mu: float
    cp: float
    k: float
    beta: float
    molar_mass: float

    @property
    def nu(self) -> float:
        return self.mu / self.rho if self.rho > 0 else 0.0

    @property
    def prandtl(self) -> float:
        return self.mu * self.cp / self.k if self.k > 0 else 0.0

    @property
    def gas(self) -> bool:
        return self.rho < GAS_DENSITY_LIMIT

    def density_at(self, temperature_k: float, *, model: str, t_ref: float, p_op: float) -> float:
        """The density the solver computes at a temperature (the model's own formula)."""
        if model == "perfect_gas":
            return p_op * self.molar_mass / (R_UNIVERSAL * max(temperature_k, 1e-6))
        if model == "boussinesq":
            return self.rho * (1.0 - self.beta * (temperature_k - t_ref))
        return self.rho


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _preset_values(rec: dict[str, Any], presets: tuple[dict[str, Any], ...]) -> dict[str, float]:
    """The preset a record names (its preset key, else its library code, else its name)."""
    key = str(rec.get("preset") or "").strip().lower()
    lib = str(rec.get("library") or "").strip().upper()
    name = str(rec.get("name") or "").strip().lower()
    for row in presets:
        if key and row["key"] == key:
            return dict(row["values"])
    for row in presets:
        if lib and lib in row["codes"]:
            return dict(row["values"])
    for row in presets:
        if name and name in (n.lower() for n in row["names"]):
            return dict(row["values"])
    return dict(presets[0]["values"])


def _saved(rec: dict[str, Any], names: tuple[str, ...]) -> float | None:
    """The first of a property's record keys that holds a number."""
    return next((v for v in (_num(rec.get(n)) for n in names) if v is not None), None)


def _usable(prop: str, value: float | None) -> bool:
    return value is not None and (value >= 0 if prop in ZERO_ALLOWED else value > 0)


def _read(rec: dict[str, Any], keys: dict[str, tuple[str, ...]], presets: tuple[dict[str, Any], ...]) -> dict[str, float]:
    base = _preset_values(rec, presets)
    out: dict[str, float] = {}
    for prop, names in keys.items():
        got = _saved(rec, names)
        out[prop] = got if got is not None and _usable(prop, got) else float(base[prop])
    return out


def fluid_props(rec: dict[str, Any]) -> FluidProps:
    v = _read(rec, FLUID_RECORD_KEYS, FLUID_PRESETS)
    return FluidProps(name=str(rec.get("name") or "Fluid"), **v)


def fluid_problem(rec: dict[str, Any]) -> str | None:
    """A saved property the solve cannot use, in the user's words, else None: one of 0 or
    below (thermal expansion: below 0)."""
    for prop, names in FLUID_RECORD_KEYS.items():
        got = _saved(rec, names)
        if got is not None and not _usable(prop, got):
            limit = "at least 0" if prop in ZERO_ALLOWED else "above 0"
            return f"its {PROPERTY_LABELS[prop]} is {got:g}; it must be {limit}"
    return None


def record_model(rec: dict[str, Any]) -> str:
    return str(rec.get("material_model") or "")


def record_bodies(rec: dict[str, Any]) -> list[str]:
    vols = rec.get("assigned_volumes")
    out = [str(v) for v in vols if v] if isinstance(vols, list) else []
    if not out and rec.get("assigned_volume"):
        out = [str(rec["assigned_volume"])]
    return out


def study_materials(materials: Any, sim_id: str | None) -> list[dict[str, Any]]:
    """This plugin's material records of a study (fluid, and a development build's solid), in order."""
    from magnusim_sdk.study import matches_study

    rows = materials.get("materials") if isinstance(materials, dict) else materials
    if not isinstance(rows, (list, tuple)):
        return []
    return [
        m
        for m in rows
        if isinstance(m, dict) and matches_study(m, sim_id) and record_model(m) in (FLUID_MODEL, SOLID_MODEL)
    ]
