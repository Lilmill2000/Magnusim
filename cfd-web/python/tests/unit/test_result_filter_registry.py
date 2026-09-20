"""Phase 2 land6: ResultFilterType registry + export-backed builtins."""

from __future__ import annotations

from dataclasses import fields
from pathlib import Path

import pytest

from cfddesk.registry import (
    ResultFilterType,
    analysis_has_filter_bags,
    get_registry,
    load_all,
    reset_for_tests,
)
from cfddesk.registry.analysis import AnalysisType
from cfddesk.results import filters as rf

EXPECTED_FILTER_KEYS = {
    "cut_plane",
    "streamlines",
    "plot_over_path",
    "iso_surface",
    "iso_volume",
    "inspect_point",
    "surface_field",
    "mesh_surface",
    "mesh_section",
}

# Product FilterType Literal keys that have no export_*.py this land.
FILTERTYPE_WITHOUT_EXPORT = {"animation", "field_calculator"}


@pytest.fixture(autouse=True)
def _clean_registry():
    reset_for_tests()
    yield
    reset_for_tests()


def test_filters_module_names_untouched_no_collision():
    """results.filters FilterSpec / FilterType stay; registry is ResultFilterType."""
    assert rf.FilterSpec is not ResultFilterType
    assert "cut_plane" in rf.FilterType.__args__
    from cfddesk import registry as reg_mod

    assert hasattr(reg_mod, "ResultFilterType")
    assert not hasattr(reg_mod, "FilterSpec")
    assert not hasattr(reg_mod, "FilterType")
    assert not hasattr(reg_mod, "ResultFilterSpec")
    assert isinstance(ResultFilterType, type)


def test_analysis_type_has_no_filter_bags():
    """Soft-pass: no AnalysisType filter string bags — do not invent a third list."""
    names = {f.name for f in fields(AnalysisType)}
    assert "result_filters" not in names
    assert "filters" not in names
    assert "filter_types" not in names
    assert "result_filter_types" not in names
    # monitors remains the wired bag pattern (land5); filters have none yet
    assert "monitors" in names


def test_load_all_registers_filter_keys():
    hub = load_all()
    reg = get_registry("filter")
    assert set(reg.keys()) == EXPECTED_FILTER_KEYS
    assert hub.registry("filter") is reg
    assert analysis_has_filter_bags(hub) is False


def test_filter_specs_shape_and_tools():
    load_all()
    reg = get_registry("filter")

    cut = reg.get("cut_plane")
    assert isinstance(cut, ResultFilterType)
    assert cut.label == "Cutting Plane"
    assert cut.tool == "export_cut_plane.py"
    assert cut.cache_scope == "case_time"
    assert cut.output == "vtp"
    assert cut.model is rf.CutPlaneFilter
    assert len(cut.params_schema) >= 4
    assert any(f.key == "field" for f in cut.params_schema)

    stream = reg.get("streamlines")
    assert stream.label == "Particle Trace"
    assert stream.tool == "export_particle_trace.py"
    assert stream.model is rf.StreamlineFilter

    pop = reg.get("plot_over_path")
    assert pop.label == "Plot-over-path"
    assert pop.tool == "export_plot_over_path.py"
    assert pop.output == "json"
    assert pop.model is rf.PlotOverPathFilter

    iso = reg.get("iso_surface")
    assert iso.tool == "export_iso_surface.py"
    assert iso.model is rf.IsoSurfaceFilter

    isovol = reg.get("iso_volume")
    assert isovol.tool == "export_iso_volume.py"
    assert isovol.model is rf.IsoVolumeFilter

    inspect = reg.get("inspect_point")
    assert inspect.tool == "export_inspect_point.py"
    assert inspect.output == "json"
    assert inspect.model is None

    surface = reg.get("surface_field")
    assert surface.tool == "export_case_field.py"
    assert surface.model is None

    mesh_s = reg.get("mesh_surface")
    assert mesh_s.tool == "export_mesh_surface_vtp.py"
    assert mesh_s.cache_scope == "case"
    assert mesh_s.output == "vtp"

    mesh_sec = reg.get("mesh_section")
    assert mesh_sec.tool == "export_mesh_section_vtp.py"
    assert mesh_sec.cache_scope == "case"


def test_export_tools_exist_on_disk():
    """Every registered tool basename must exist under python/tools/."""
    tools_dir = Path(__file__).resolve().parents[2] / "tools"
    load_all()
    for spec in get_registry("filter").items():
        path = tools_dir / spec.tool
        assert path.is_file(), f"missing export tool {spec.tool} for key {spec.key}"


def test_animation_field_calculator_not_registered_without_export():
    """Do not invent registry keys for FilterType entries lacking export_*.py."""
    load_all()
    keys = set(get_registry("filter").keys())
    assert FILTERTYPE_WITHOUT_EXPORT.isdisjoint(keys)


def test_describe_filter_includes_plugin():
    load_all()
    desc = {d["key"]: d for d in get_registry("filter").describe()}
    assert desc["cut_plane"]["plugin"] == "builtin"
    assert desc["streamlines"]["label"] == "Particle Trace"


def test_load_all_idempotent_filters():
    load_all()
    load_all()
    load_all(force=True)
    assert set(get_registry("filter").keys()) == EXPECTED_FILTER_KEYS


def test_fo_monitor_kind_flow_vs_flow_rate_unchanged():
    """Carry: FO MonitorKind still 'flow'; registry monitor key still flow_rate.
    No third name invented this land.
    """
    from cfddesk.case import function_objects as fo

    assert fo.MonitorKind.__args__ == ("area_average", "flow")
    load_all()
    assert "flow_rate" in get_registry("monitor").keys()
    assert "flow" not in get_registry("monitor").keys()
