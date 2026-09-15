"""Built-in ResultFilterType specs (Phase 2 land6).

Keys align to results.filters.FilterType product strings + vite export tools.
streamlines persists as type "streamlines" but exports via export_particle_trace.py
(Particle Trace product label). animation / field_calculator have no export_*.py
wrapper this land — not registered (do not invent).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from cfddesk.registry.result_filter import ResultFilterType
from cfddesk.results.filters import (
    CutPlaneFilter,
    IsoSurfaceFilter,
    IsoVolumeFilter,
    PlotOverPathFilter,
    StreamlineFilter,
)

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub


def build_cut_plane() -> ResultFilterType:
    return ResultFilterType(
        key="cut_plane",
        label="Cutting Plane",
        params_schema=(),  # NOT_yet_done: full SchemaField from CutPlaneFilter
        tool="export_cut_plane.py",
        cache_scope="case_time",
        output="vtp",
        model=CutPlaneFilter,
    )


def build_streamlines() -> ResultFilterType:
    return ResultFilterType(
        key="streamlines",
        label="Particle Trace",
        params_schema=(),
        tool="export_particle_trace.py",
        cache_scope="case_time",
        output="vtp",
        model=StreamlineFilter,
    )


def build_plot_over_path() -> ResultFilterType:
    return ResultFilterType(
        key="plot_over_path",
        label="Plot-over-path",
        params_schema=(),
        tool="export_plot_over_path.py",
        cache_scope="case_time",
        output="json",
        model=PlotOverPathFilter,
    )


def build_iso_surface() -> ResultFilterType:
    return ResultFilterType(
        key="iso_surface",
        label="Iso Surface",
        params_schema=(),
        tool="export_iso_surface.py",
        cache_scope="case_time",
        output="vtp",
        model=IsoSurfaceFilter,
    )


def build_iso_volume() -> ResultFilterType:
    return ResultFilterType(
        key="iso_volume",
        label="Iso Volume",
        params_schema=(),
        tool="export_iso_volume.py",
        cache_scope="case_time",
        output="vtp",
        model=IsoVolumeFilter,
    )


def build_inspect_point() -> ResultFilterType:
    return ResultFilterType(
        key="inspect_point",
        label="Inspect point",
        params_schema=(),
        tool="export_inspect_point.py",
        cache_scope="case_time",
        output="json",
        model=None,  # VIEW probe — not in FilterSpec union
    )


def build_surface_field() -> ResultFilterType:
    return ResultFilterType(
        key="surface_field",
        label="Surface field",
        params_schema=(),
        tool="export_case_field.py",
        cache_scope="case_time",
        output="vtp",
        model=None,  # case-tree field export — not a FilterSpec stack entry
    )


def build_mesh_surface() -> ResultFilterType:
    return ResultFilterType(
        key="mesh_surface",
        label="Mesh surface",
        params_schema=(),
        tool="export_mesh_surface_vtp.py",
        cache_scope="case",
        output="vtp",
        model=None,
    )


def build_mesh_section() -> ResultFilterType:
    return ResultFilterType(
        key="mesh_section",
        label="Mesh section",
        params_schema=(),
        tool="export_mesh_section_vtp.py",
        cache_scope="case",
        output="vtp",
        model=None,
    )


def register_filters(hub: "RegistryHub") -> None:
    """Register product export-backed filter keys (idempotent same-plugin)."""
    reg = hub.registry("filter")
    reg.register(build_cut_plane(), plugin="builtin")
    reg.register(build_streamlines(), plugin="builtin")
    reg.register(build_plot_over_path(), plugin="builtin")
    reg.register(build_iso_surface(), plugin="builtin")
    reg.register(build_iso_volume(), plugin="builtin")
    reg.register(build_inspect_point(), plugin="builtin")
    reg.register(build_surface_field(), plugin="builtin")
    reg.register(build_mesh_surface(), plugin="builtin")
    reg.register(build_mesh_section(), plugin="builtin")
