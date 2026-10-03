"""The materials.json mirror keeps a material's properties under its model's
record keys (the registry's), and under the keys it has always written when no
model is loaded: old projects' materials.json read and write the same."""

from types import SimpleNamespace

import pytest

from cfddesk.project.web_mirrors import materials as mirror
from cfddesk.registry import discovery


@pytest.fixture
def no_models(monkeypatch):
    empty = SimpleNamespace(keys=lambda: [], get=lambda key: None)
    hub = SimpleNamespace(registry=lambda kind: empty, manifests={})
    monkeypatch.setattr(discovery, "get_hub", lambda: hub)


@pytest.fixture
def other_model(monkeypatch):
    model = SimpleNamespace(record_keys={"mu": ("dynamic_viscosity", "mu")})
    models = SimpleNamespace(keys=lambda: ["other"], get=lambda key: model)
    analysis = SimpleNamespace(material_models=("other",))
    analyses = SimpleNamespace(keys=lambda: ["steady_x"], get=lambda key: analysis)
    hub = SimpleNamespace(registry=lambda kind: models if kind == "material" else analyses)
    monkeypatch.setattr(discovery, "get_hub", lambda: hub)
    monkeypatch.setattr(discovery, "default_analysis_of", lambda h: {"steady": "steady_x"})


def test_with_no_model_loaded_the_old_keys_are_written(no_models):
    assert mirror.record_keys() == {"nu": ("kinematic_viscosity", "nu"), "rho": ("density", "rho")}
    row = mirror._material_row({"name": "Air", "nu": 1.5e-5, "rho": 1.2}, sim_id="s1", project_id="p1")
    assert row["kinematic_viscosity"] == 1.5e-5 and row["density"] == 1.2
    kept = mirror._material_row({"kinematic_viscosity": 2e-5, "nu": 1.5e-5}, sim_id=None, project_id=None)
    assert kept["kinematic_viscosity"] == 2e-5
    [back] = mirror.from_web_materials({"materials": [{"name": "Air", "kinematic_viscosity": "1.5e-5", "density": 1}]})
    assert (back["nu"], back["kinematic_viscosity"], back["rho"], back["density"]) == (1.5e-5, 1.5e-5, 1.0, 1.0)
    # The property's own key wins over the record key, as before.
    [both] = mirror.from_web_materials([{"nu": 3e-5, "kinematic_viscosity": 1e-5}])
    assert both["nu"] == both["kinematic_viscosity"] == 3e-5
    # A stored None or a non-number leaves the record as it is.
    [odd] = mirror.from_web_materials([{"nu": None, "kinematic_viscosity": 1e-5, "rho": "x"}])
    assert odd["nu"] is None and odd["kinematic_viscosity"] == 1e-5 and odd["rho"] == "x" and "density" not in odd


def test_a_loaded_model_names_its_own_record_keys(other_model):
    assert mirror.record_keys() == {"mu": ("dynamic_viscosity", "mu")}
    row = mirror._material_row({"mu": 1e-3, "nu": 1e-6}, sim_id=None, project_id=None)
    assert row["dynamic_viscosity"] == 1e-3 and "kinematic_viscosity" not in row
    [back] = mirror.from_web_materials([{"dynamic_viscosity": 2e-3}])
    assert back["mu"] == back["dynamic_viscosity"] == 2e-3
