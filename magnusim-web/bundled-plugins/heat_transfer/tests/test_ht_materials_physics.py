"""The material model (presets, how a record reads) and the study settings (defaults, gravity, density)."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from heat_transfer import __version__
from heat_transfer.materials import (
    FLUID_PRESETS,
    build_thermo_fluid,
    fluid_problem,
    fluid_props,
)
from heat_transfer.physics import DEFAULT_PHYSICS, physics_from_record, physics_problem

PLUGIN_DIR = Path(__file__).resolve().parents[1]


def test_the_presets_the_materials_panel_offers():
    assert [r["name"] for r in FLUID_PRESETS] == ["Air", "Water", "Oil (ISO VG 32)", "Nitrogen", "Custom fluid"]
    fluid = build_thermo_fluid()
    assert fluid.role == "fluid"
    assert {f.key: f.quantity for f in fluid.properties_schema} == {
        "rho": "density", "mu": "dynamic_viscosity", "cp": "specific_heat", "k": "thermal_conductivity",
        "beta": "thermal_expansion", "molar_mass": "molar_mass",
    }
    for row in FLUID_PRESETS:
        assert all(v > 0 for v in row["values"].values()), row["name"]


def test_the_fluid_and_the_solid_models_are_registered():
    """HT5: a body of a solid material conducts heat (conjugate heat transfer)."""
    from cfddesk.registry import load_all, reset_for_tests
    from cfddesk.registry.discovery import get_registry

    reset_for_tests()
    load_all()
    mine = [k for k in get_registry("material").keys() if str(k).startswith("thermo_")]
    assert mine == ["thermo_fluid", "thermo_solid"]
    assert get_registry("material").get("thermo_solid").role == "solid"
    analysis = get_registry("analysis").get("heat_transfer_steady")
    assert analysis.material_models == ("thermo_fluid", "thermo_solid") and analysis.region_roles == ("fluid", "solid")


def test_a_record_reads_its_own_numbers_then_its_preset():
    water = fluid_props({"name": "Water", "preset": "water", "density": 1000})
    assert water.rho == 1000 and water.cp == 4182 and not water.gas
    assert water.prandtl == pytest.approx(1.002e-3 * 4182 / 0.598)
    air = fluid_props({"name": "My air", "library": "HT_AIR"})
    assert air.gas and air.molar_mass == 28.97 and air.nu == pytest.approx(1.825e-5 / 1.204)


def test_a_thermal_expansion_of_zero_is_kept_and_other_zeros_are_refused():
    """β = 0 is a real value (no buoyancy from temperature): solved as 0, not replaced by the
    preset's. Any other property at 0 or below is named at Start instead of being replaced."""
    still = fluid_props({"name": "Still", "preset": "water", "thermal_expansion": 0})
    assert still.beta == 0.0
    assert fluid_problem({"name": "Still", "preset": "water", "thermal_expansion": 0}) is None
    assert fluid_problem({"preset": "water", "thermal_conductivity": 0}) == "its thermal conductivity is 0; it must be above 0"
    assert fluid_problem({"preset": "water", "thermal_expansion": -1e-4}) == (
        "its thermal expansion is -0.0001; it must be at least 0"
    )
    assert fluid_problem({"preset": "air", "density": -2}) == "its density is -2; it must be above 0"
    assert fluid_problem({"preset": "air", "specific_heat": "bad"}) is None


def test_density_formulas():
    air = fluid_props({"preset": "air"})
    assert air.density_at(300, model="perfect_gas", t_ref=293.15, p_op=101325) == pytest.approx(101325 * 28.97 / (8314.462618 * 300))
    assert air.density_at(303.15, model="boussinesq", t_ref=293.15, p_op=0) == pytest.approx(1.204 * (1 - 3.411e-3 * 10))


def test_study_settings_and_their_defaults():
    assert physics_from_record({}) == DEFAULT_PHYSICS
    assert DEFAULT_PHYSICS.g() == (0.0, 0.0, -9.80665)
    p = physics_from_record({"gravity": "custom", "gravity_vector": [0, 2, 0], "gravity_magnitude": 1.62,
                             "density_model": "boussinesq", "reference_temperature": 300, "initial_temperature": 310,
                             "turbulence_model": "laminar", "numerics_preset": "accurate", "n_non_orthogonal": 2})
    assert p.g() == (0.0, 1.62, 0.0) and p.start_temperature() == 310 and p.n_non_orthogonal == 2
    bad = physics_from_record({"gravity": "sideways", "density_model": "?", "turbulence_model": "SSG"})
    assert bad.gravity == "-z" and bad.density_model == "auto"
    assert bad.turbulence_model == "kOmegaSST"
    off = physics_from_record({"gravity": "off"})
    assert not off.gravity_on and off.g() == (0.0, 0.0, 0.0)
    assert DEFAULT_PHYSICS.density_for(fluid_props({"preset": "air"})) == "perfect_gas"
    assert DEFAULT_PHYSICS.density_for(fluid_props({"preset": "oil_vg32"})) == "boussinesq"


@pytest.mark.parametrize(
    ("saved", "said"),
    [
        ({"operating_pressure": 0}, "the operating pressure must be above 0"),
        ({"operating_pressure": -5}, "the operating pressure must be above 0"),
        ({"reference_temperature": 0}, "the reference temperature must be above absolute zero"),
        ({"initial_temperature": 0}, "the starting temperature must be above absolute zero"),
        ({"residual_target": 0}, "the residual target must be above 0"),
        ({"relax_h": 0}, "the relaxation energy is 0; it must be above 0 and at most 1"),
        ({"relax_u": 1.5}, "the relaxation U is 1.5; it must be above 0 and at most 1"),
        ({"gravity": "-z", "gravity_magnitude": 0}, "the gravity magnitude must be above 0 (or set Gravity to Off)"),
        ({"gravity": "custom", "gravity_vector": [0, 0, 0]}, "the gravity direction has no length (all three components are 0)"),
    ],
)
def test_a_saved_setting_the_solve_cannot_use_is_named(saved, said):
    """A 0 the study panel saved is not swapped for the default behind the user's back."""
    assert physics_problem(saved) == said


def test_settings_that_are_fine_have_no_problem():
    assert physics_problem({}) is None
    assert physics_problem({"gravity": "off", "gravity_magnitude": 0, "initial_temperature": None}) is None
    assert physics_problem({"relax_h": 1, "operating_pressure": 2e5, "reference_temperature": 350}) is None


def test_the_version_is_the_manifests():
    manifest = re.search(r'^version = "([^"]+)"', (PLUGIN_DIR / "manifest.toml").read_text(encoding="utf-8"), re.M)
    assert manifest and manifest.group(1) == __version__
