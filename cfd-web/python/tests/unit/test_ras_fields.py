
"""RAS field writer coverage."""
from __future__ import annotations

from pathlib import Path

from cfddesk.case.ras import _ras_boundary_blocks, inlet_turbulence_scalars, write_ras_fields


def test_komega_writes_omega_not_epsilon(tmp_case_dir):
    write_ras_fields(tmp_case_dir, "kOmegaSST", U_ref=10.0, intensity_pct=5.0)
    zero = tmp_case_dir / "0"
    assert (zero / "k").is_file()
    assert (zero / "omega").is_file()
    assert (zero / "nut").is_file()
    assert not (zero / "epsilon").is_file()


def test_kepsilon_writes_epsilon_not_omega(tmp_case_dir):
    write_ras_fields(tmp_case_dir, "kEpsilon", U_ref=10.0, intensity_pct=5.0)
    zero = tmp_case_dir / "0"
    assert (zero / "epsilon").is_file()
    assert not (zero / "omega").is_file()


def test_laminar_removes_ras(tmp_case_dir):
    write_ras_fields(tmp_case_dir, "kOmegaSST", U_ref=10.0, intensity_pct=5.0)
    write_ras_fields(tmp_case_dir, "laminar", U_ref=10.0, intensity_pct=5.0)
    zero = tmp_case_dir / "0"
    for name in ("k", "epsilon", "omega", "nut", "R"):
        assert not (zero / name).is_file()


def test_ras_boundary_blocks_per_semantic():
    s = inlet_turbulence_scalars(10.0, intensity_pct=5.0)
    sem = {
        "inlet": "inlet",
        "outlet": "outlet",
        "walls": "wall",
        "sym": "symmetry",
        "empty1": "empty",
        "wedge1": "wedge",
        "custom1": "custom",
        "atm": "open",
    }
    k = dict(_ras_boundary_blocks(s, field="k", patch_semantics=sem))
    assert "fixedValue" in k["inlet"]
    assert "inletOutlet" in k["outlet"]
    assert "inletOutlet" in k["atm"]
    assert "kqRWallFunction" in k["walls"]
    assert "type            symmetry" in k["sym"]
    assert "type            empty" in k["empty1"]
    assert "type            wedge" in k["wedge1"]
    assert "zeroGradient" in k["custom1"]
    nut = dict(_ras_boundary_blocks(s, field="nut", patch_semantics=sem))
    assert "nutkWallFunction" in nut["walls"]
    assert "calculated" in nut["inlet"]
    assert "calculated" in nut["custom1"]
