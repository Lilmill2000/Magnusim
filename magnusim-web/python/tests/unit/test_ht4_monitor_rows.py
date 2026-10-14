"""An analysis's registry row names the monitor types a user may add to its runs.

The Monitors dialog lists only those (``monitorTypes`` in src/monitors.ts). With
Incompressible Flow and Heat Transfer both on, each analysis's runs offer its own
types and never the other plugin's; an analysis that names none publishes no
``monitors`` and offers every user-creatable type.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from cfddesk.registry import load_all, reset_for_tests


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setenv("MAGNUSIM_LOCAL_JSON", str(tmp_path / "local.json"))
    monkeypatch.setenv("MAGNUSIM_PLUGINS_DIR", str(tmp_path / "plugins"))
    reset_for_tests()
    yield
    reset_for_tests()


def test_each_analysis_row_names_its_own_monitor_types(tmp_path: Path) -> None:
    hub = load_all(web_root=tmp_path, force=True)
    rows = {r["key"]: r for r in hub.registry("analysis").describe()}
    owner = {r["key"]: r.get("plugin") for r in hub.registry("monitor").describe()}
    for key in ("incompressible_steady", "incompressible_transient", "heat_transfer_steady", "heat_transfer_transient"):
        monitors = rows[key]["monitors"]
        assert monitors, key
        assert {owner[m] for m in monitors} == {rows[key]["plugin"]}, (key, monitors)
    assert "area_average" in rows["incompressible_steady"]["monitors"]
    assert "ht_wall_heat_flux" in rows["heat_transfer_steady"]["monitors"]
    assert "ht_wall_heat_flux" not in rows["incompressible_steady"]["monitors"]
    assert "area_average" not in rows["heat_transfer_steady"]["monitors"]
