"""Heat Transfer's walls are Incompressible Flow's (flow_patches): k-omega SST takes Spalding's law
with stepwise omega (validation/README.md, 2026-11-06), k-epsilon keeps nutkWallFunction, the
heat's own alphatJayatillekeWallFunction stays; "Numerics as written" says so under Stays fixed,
and a conjugate case's interface fallback follows the model."""

from __future__ import annotations

import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from cfddesk.registry import load_all, reset_for_tests
from ht_inputs import make_inputs

from heat_transfer.cht_writer import _wall_turbulence
from heat_transfer.precheck import run_check
from heat_transfer.runspec import load_spec
from heat_transfer.writer import write_case


@pytest.fixture(autouse=True)
def _registry():
    reset_for_tests()
    load_all()
    yield
    reset_for_tests()


def _write(tmp_path: Path, model: str) -> Path:
    case = tmp_path / "case"
    spec = load_spec(make_inputs(tmp_path, study={"turbulence_model": model}))
    assert spec.ok, spec.error
    assert write_case(spec, case)["ok"]
    return case


def _types(text: str) -> set[str]:
    return set(re.findall(r"type\s+(\w+(?:::\w+)?);", text))


def test_k_omega_sst_walls_take_spaldings_law_and_stepwise_omega(tmp_path: Path):
    case = _write(tmp_path, "kOmegaSST")
    nut = (case / "0" / "nut").read_text(encoding="utf-8")
    omega = (case / "0" / "omega").read_text(encoding="utf-8")
    assert "nutUSpaldingWallFunction" in _types(nut) and "nutkWallFunction" not in _types(nut)
    assert "omegaWallFunction" in _types(omega) and re.search(r"blending\s+stepwise;", omega)
    assert "compressible::alphatJayatillekeWallFunction" in _types((case / "0" / "alphat").read_text(encoding="utf-8"))


def test_k_epsilon_walls_keep_the_k_log_law(tmp_path: Path):
    nut = (_write(tmp_path, "kEpsilon") / "0" / "nut").read_text(encoding="utf-8")
    assert "nutkWallFunction" in _types(nut) and "nutUSpaldingWallFunction" not in _types(nut)


def test_numerics_as_written_names_the_wall_treatment(tmp_path: Path):
    def rows(model: str, sub: str) -> dict[str, str]:
        out = run_check(transient=False, inputs=make_inputs(tmp_path / sub, study={"turbulence_model": model}), settings={"end_time": 500})
        return {f"{r['group']}/{r['label']}": r["value"] for r in out["numerics"]}

    assert rows("kOmegaSST", "a")["Stays fixed/Wall treatment"] == (
        "nut nutUSpaldingWallFunction, k kqRWallFunction, omega omegaWallFunction (stepwise), "
        "alphat compressible::alphatJayatillekeWallFunction (Prt 0.85)"
    )
    assert rows("kEpsilon", "b")["Stays fixed/Wall treatment"].startswith("nut nutkWallFunction, k kqRWallFunction, epsilon epsilonWallFunction")
    assert "Stays fixed/Wall treatment" not in rows("laminar", "c")


def test_a_cht_interface_without_a_no_slip_wall_to_copy_follows_the_model():
    flow = SimpleNamespace(kinds={}, wall_motion={}, turbulence={}, turbulence_internal={"omega": "uniform 20", "k": "uniform 0.1"})
    assert _wall_turbulence(flow, "nut", "kOmegaSST") == {"type": "nutUSpaldingWallFunction", "value": "uniform 0"}
    assert _wall_turbulence(flow, "omega", "kOmegaSST") == {"type": "omegaWallFunction", "blending": "stepwise", "value": "uniform 20"}
    assert _wall_turbulence(flow, "nut", "kEpsilon") == {"type": "nutkWallFunction", "value": "uniform 0"}
    assert _wall_turbulence(flow, "k", "kEpsilon") == {"type": "kqRWallFunction", "value": "uniform 0.1"}


def test_the_model_help_gives_only_the_y_plus_that_were_tested():
    """Heat Transfer's model help gives what Incompressible Flow's walls read on the clean developed
    wedge at the y+ that were run, not "below about 0.5" (one run at y+ 0.3)."""
    from heat_transfer.analyses import settings_schema

    text = next(f for f in settings_schema() if f.key == "turbulence_model").description
    assert ("a developed pipe read its friction within 4.5 % with the first cell's centre at y+ 5 to 100 and 6 to 9 % "
            "low at y+ 1 to 3") in text
    assert "below about 0.5" not in text
