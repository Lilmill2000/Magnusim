"""Heat Transfer's material models: a fluid and a solid with thermal properties.

- ``thermo_fluid`` (role fluid): density, dynamic viscosity, specific heat,
  thermal conductivity, thermal expansion and molar mass;
- ``thermo_solid`` (role solid): density, specific heat and thermal conductivity
  (the same in every direction).

Constant properties, at 20 °C (and 1 atm for the fluids); the sources are in the
plugin's README.

A study of a Heat Transfer analysis holds one material record per group of
bodies (host API 1.8): every body of a fluid record is fluid, every body of a
solid record is a solid that conducts heat (conjugate heat transfer). A body no
record names is left out of the mesh.

``fluid_props`` / ``solid_props`` read one saved record: its own numbers, else
its preset's (a record keeps the numbers it was saved with). ``fluid_problem`` /
``solid_problem`` say which saved number cannot be solved with (a thermal
expansion of 0 is a real value: no buoyancy from temperature).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from cfddesk.registry.material import MaterialModel
from cfddesk.registry.schema import SchemaField

FLUID_MODEL = "thermo_fluid"
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


def _solid_row(key: str, name: str, *, rho: float, cp: float, k: float, library: str, codes: tuple[str, ...] = ()) -> dict[str, Any]:
    return {
        "key": key,
        "name": name,
        "values": {"rho": rho, "cp": cp, "k": k},
        "library": library,
        "codes": codes or (library,),
        "names": (name,),
    }


# At 20 to 27 °C (README: sources). FR-4's conductivity is through the board's
# thickness (along the board it conducts about three times better).
SOLID_PRESETS: tuple[dict[str, Any], ...] = (
    _solid_row("aluminium_6061", "Aluminium 6061", rho=2700.0, cp=896.0, k=167.0, library="HT_AL6061",
               codes=("HT_AL6061", "DEFAULT")),
    _solid_row("aluminium", "Aluminium (pure)", rho=2702.0, cp=903.0, k=237.0, library="HT_AL"),
    _solid_row("copper", "Copper", rho=8933.0, cp=385.0, k=401.0, library="HT_CU"),
    _solid_row("steel", "Steel (plain carbon, AISI 1010)", rho=7832.0, cp=434.0, k=63.9, library="HT_STEEL"),
    _solid_row("stainless_304", "Stainless steel 304", rho=7900.0, cp=477.0, k=14.9, library="HT_SS304"),
    _solid_row("brass", "Brass (70 % copper, 30 % zinc)", rho=8530.0, cp=380.0, k=110.0, library="HT_BRASS"),
    _solid_row("fr4", "FR-4 (circuit board)", rho=1850.0, cp=1100.0, k=0.29, library="HT_FR4"),
    _solid_row("glass", "Glass (soda-lime plate)", rho=2500.0, cp=750.0, k=1.4, library="HT_GLASS"),
    _solid_row("abs", "ABS", rho=1050.0, cp=1400.0, k=0.17, library="HT_ABS"),
    _solid_row("pla", "PLA", rho=1240.0, cp=1800.0, k=0.13, library="HT_PLA"),
    # The user's own: starts from Aluminium 6061's numbers and keeps the ones typed.
    {**_solid_row(CUSTOM_PRESET, "Custom solid", rho=2700.0, cp=896.0, k=167.0, library="HT_CUSTOM_SOLID"), "names": ()},
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
SOLID_RECORD_KEYS: dict[str, tuple[str, ...]] = {
    "rho": ("density", "rho"),
    "cp": ("specific_heat", "cp"),
    "k": ("thermal_conductivity", "k"),
}
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


def _solid_schema() -> tuple[SchemaField, ...]:
    al = SOLID_PRESETS[0]["values"]
    return (
        SchemaField("rho", "(ρ) Density", "float", default=al["rho"], min=0.0, quantity="density", group="thermal"),
        SchemaField("cp", "(cp) Specific heat", "float", default=al["cp"], min=0.0, quantity="specific_heat",
                    group="thermal", description="How much heat it stores: how fast it warms in a transient run."),
        SchemaField("k", "(k) Thermal conductivity", "float", default=al["k"], min=0.0, quantity="thermal_conductivity",
                    group="thermal", description="The same in every direction."),
        # No minimum: 0 is no source, below 0 takes heat out (host: any finite number).
        SchemaField("heat_source_W", "Heat source", "float", default=0.0, quantity="power", group="heat_source",
                    description="The heat the solid gives off, spread evenly through it (a chip, a heater). "
                    "0 is none; below 0 takes heat out. Give it in total here or per volume below, not both."),
        SchemaField("heat_source_W_m3", "Heat source per volume", "float", default=0.0, quantity="power_density",
                    group="heat_source", description="The same heat as a rate per volume of the solid."),
    )


# A solid record's heat source (host API 1.8: kept on the record, so it copies and
# goes with it): total W, or W/m3.
SOURCE_KEYS: tuple[str, str] = ("heat_source_W", "heat_source_W_m3")


def build_thermo_solid() -> MaterialModel:
    return MaterialModel(
        key=SOLID_MODEL,
        label="Solid (thermal)",
        role="solid",
        properties_schema=_solid_schema(),
        library=SOLID_PRESETS,
        record_keys=SOLID_RECORD_KEYS,
        record_constants={"type": "Solid", "properties_at": "20 °C"},
        custom_preset=CUSTOM_PRESET,
    )


@dataclass(frozen=True)
class SolidProps:
    """One solid record's properties, SI."""

    name: str
    rho: float
    cp: float
    k: float

    @property
    def diffusivity(self) -> float:
        return self.k / (self.rho * self.cp) if self.rho > 0 and self.cp > 0 else 0.0


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
    return _problem(rec, FLUID_RECORD_KEYS)


def solid_props(rec: dict[str, Any]) -> SolidProps:
    v = _read(rec, SOLID_RECORD_KEYS, SOLID_PRESETS)
    return SolidProps(name=str(rec.get("name") or "Solid"), **v)


def solid_problem(rec: dict[str, Any]) -> str | None:
    """A saved property of a solid record the solve cannot use (0 or below), else None."""
    return _problem(rec, SOLID_RECORD_KEYS)


def _problem(rec: dict[str, Any], keys: dict[str, tuple[str, ...]]) -> str | None:
    for prop, names in keys.items():
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
    """This plugin's material records of a study (fluid and solid), in order."""
    from magnusim_sdk.study import matches_study

    rows = materials.get("materials") if isinstance(materials, dict) else materials
    if not isinstance(rows, (list, tuple)):
        return []
    return [
        m
        for m in rows
        if isinstance(m, dict) and matches_study(m, sim_id) and record_model(m) in (FLUID_MODEL, SOLID_MODEL)
    ]
