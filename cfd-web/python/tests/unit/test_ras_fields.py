
"""RAS field writer coverage."""
from __future__ import annotations

from pathlib import Path

from cfddesk.case.ras import write_ras_fields


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
