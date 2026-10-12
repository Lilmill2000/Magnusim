"""A study may hold materials of other plugins' models (host API 1.8): the fluid is this plugin's own."""

from __future__ import annotations

from incompressible_flow.runspec import air_from_materials


def test_the_fluid_is_this_plugins_record_never_another_models():
    mats = {
        "materials": [
            {"id": "al", "name": "Aluminium", "material_model": "other_solid", "assigned_volumes": ["Body2"], "density": 2700},
            {"id": "w", "name": "Water", "material_model": "newtonian_incompressible", "assigned_volumes": ["Body1"],
             "kinematic_viscosity": 1e-6, "density": 998.2},
        ]
    }
    air = air_from_materials(mats)
    assert air is not None
    assert (air["name"], air["rho"], air["assigned"]) == ("Water", 998.2, True)


def test_a_record_that_names_no_model_is_still_the_fluid():
    air = air_from_materials({"materials": [{"id": "a", "name": "Air", "assigned_volumes": ["Body1"], "density": 1.2}]})
    assert air is not None and air["name"] == "Air"


def test_only_other_models_means_no_fluid():
    assert air_from_materials({"materials": [{"id": "al", "material_model": "other_solid", "assigned_volumes": ["Body1"]}]}) is None
