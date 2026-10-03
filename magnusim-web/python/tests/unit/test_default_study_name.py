"""The name a study gets when none is stored comes from the default analysis
([default_analysis] study_name in the required plugin's manifest, or its
analysis family's study_name once loaded), not from the core."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from cfddesk.project.model import Project
from cfddesk.registry import load_all, reset_for_tests
from cfddesk.registry.analysis import default_study_name
from cfddesk.registry.discovery import _parse_default_analysis
from tests.conftest import PROJECTS


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


def _table(**extra: object) -> dict:
    return {"default_analysis": {"steady": "flow_steady", **extra}}


def test_study_name_is_optional_plain_text():
    assert "study_name" not in _parse_default_analysis(_table())
    assert _parse_default_analysis(_table(study_name="  Flow  "))["study_name"] == "Flow"
    assert _parse_default_analysis(_table(study_name="x" * 40))["study_name"] == "x" * 40


@pytest.mark.parametrize("value", ["", "   ", "x" * 41, "two\nlines", 5, ["Flow"]])
def test_a_bad_study_name_is_refused(value: object):
    with pytest.raises(ValueError, match=r"\[default_analysis\] study_name"):
        _parse_default_analysis(_table(study_name=value))


def _unnamed_v13() -> dict:
    doc = json.loads((PROJECTS / "v13.json").read_text(encoding="utf-8"))
    doc = copy.deepcopy(doc)
    doc["simulations"][0].pop("name")
    return doc


def test_an_unnamed_study_gets_the_bundled_default_analysis_name():
    # From the manifest before the registry loads, from the family after: the same.
    before = default_study_name()
    assert before == "Incompressible"
    assert Project.from_dict(_unnamed_v13()).primary_simulation().name == before
    load_all()
    assert default_study_name() == before
    from cfddesk.project import model

    assert model.PRIMARY_SIM_NAME == before


def test_without_the_bundled_plugin_a_study_is_a_simulation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    empty = tmp_path / "bundled"
    empty.mkdir()
    monkeypatch.setenv("MAGNUSIM_BUNDLED_DIR", str(empty))
    assert default_study_name() == "Simulation"
    assert Project.from_dict(_unnamed_v13()).primary_simulation().name == "Simulation"
