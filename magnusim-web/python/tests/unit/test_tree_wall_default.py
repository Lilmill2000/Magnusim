"""The tree's wall default is the one the solve uses: defaults.json over the legacy file."""
import json

from cfddesk.project.scope import _wall


def test_saved_default_wins_over_the_legacy_file(tmp_path):
    (tmp_path / "boundary_conditions").mkdir()
    (tmp_path / "boundary_conditions" / "defaults.json").write_text(
        json.dumps({"defaults": {"wall_type": "Slip"}, "defaults_by_simulation": {"s1": {"wall_type": "Slip"}}})
    )
    (tmp_path / "boundary_conditions.json").write_text(
        json.dumps({"defaults_by_simulation": {"s1": {"wall_type": "No-slip"}}})
    )
    assert _wall(tmp_path, "s1") == "Slip"


def test_legacy_file_alone_still_reads(tmp_path):
    (tmp_path / "boundary_conditions.json").write_text(json.dumps({"defaults": {"wall_type": "Slip"}}))
    assert _wall(tmp_path, "s1") == "Slip"
    assert _wall(tmp_path / "missing", "s1") == "No-slip"
