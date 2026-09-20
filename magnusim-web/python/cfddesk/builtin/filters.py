"""Built-in ResultFilterType specs (Phase 2 land6).

Keys align to results.filters.FilterType product strings + vite export tools.
streamlines persists as type "streamlines" but exports via export_particle_trace.py
(Particle Trace product label). animation / field_calculator have no export_*.py
wrapper this land — not registered (do not invent).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from cfddesk.registry.result_filter import ResultFilterType
from cfddesk.registry.schema import SchemaField
from cfddesk.results.filters import (
    CUTTING_PLANE_DEFAULT_OPACITY,
    CUTTING_PLANE_DEFAULT_ORIENTATION,
    CUTTING_PLANE_DEFAULT_POSITION,
    ISO_SURFACE_DEFAULT_ISO_SCALAR,
    ISO_SURFACE_DEFAULT_ISO_VALUE,
    ISO_VOLUME_DEFAULT_ISO_VALUE_HIGH,
    ISO_VOLUME_DEFAULT_ISO_VALUE_LOW,
    ORIENTATION_ITEMS,
    PARTICLE_TRACE_DEFAULT_SEED_DENSITY,
    PARTICLE_TRACE_DEFAULT_SEEDS_H,
    PARTICLE_TRACE_DEFAULT_SEEDS_V,
    PARTICLE_TRACE_DEFAULT_SIZE,
    PLOT_OVER_PATH_DEFAULT_FIELD_VARIABLE,
    PLOT_OVER_PATH_DEFAULT_SUBDIVISIONS,
    REPRESENTATION_ITEMS,
    SEED_MODE_ITEMS,
    SEED_QUANTITY_MODE_ITEMS,
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
        params_schema=(
            SchemaField("orientation", "Orientation", "choice", default=CUTTING_PLANE_DEFAULT_ORIENTATION, choices=ORIENTATION_ITEMS),
            SchemaField("position", "Position", "float", default=CUTTING_PLANE_DEFAULT_POSITION, min=0, max=1),
            SchemaField("ox", "Origin X", "float", default=0.0),
            SchemaField("oy", "Origin Y", "float", default=0.0),
            SchemaField("oz", "Origin Z", "float", default=0.0),
            SchemaField("nx", "Normal X", "float", default=0.0),
            SchemaField("ny", "Normal Y", "float", default=1.0),
            SchemaField("nz", "Normal Z", "float", default=0.0),
            SchemaField("field", "Field", "choice", default="magU", choices=("magU", "p")),
            SchemaField("opacity", "Opacity", "float", default=CUTTING_PLANE_DEFAULT_OPACITY, min=0, max=1),
            SchemaField("case", "Case directory", "text", default=""),
            SchemaField("time", "Time", "text", default="50"),
        ),
        tool="export_cut_plane.py",
        cache_scope="case_time",
        output="vtp",
        model=CutPlaneFilter,
    )


def build_streamlines() -> ResultFilterType:
    return ResultFilterType(
        key="streamlines",
        label="Particle Trace",
        params_schema=(
            SchemaField("seed_mode", "Seed mode", "choice", default="grid", choices=SEED_MODE_ITEMS),
            SchemaField("faces", "Faces", "text", default=""),
            SchemaField("quantity_mode", "Quantity mode", "choice", default="count", choices=SEED_QUANTITY_MODE_ITEMS),
            SchemaField("n_seeds", "Seed count", "int", default=40, min=1),
            SchemaField("density", "Density", "float", default=PARTICLE_TRACE_DEFAULT_SEED_DENSITY, min=0),
            SchemaField("seeds_h", "Seeds H", "int", default=PARTICLE_TRACE_DEFAULT_SEEDS_H, min=1),
            SchemaField("seeds_v", "Seeds V", "int", default=PARTICLE_TRACE_DEFAULT_SEEDS_V, min=1),
            SchemaField("size", "Size", "float", default=PARTICLE_TRACE_DEFAULT_SIZE, min=0),
            SchemaField("representation", "Representation", "choice", default="Cylinders", choices=REPRESENTATION_ITEMS),
            SchemaField("case", "Case directory", "text", default=""),
            SchemaField("time", "Time", "text", default="50"),
        ),
        tool="export_particle_trace.py",
        cache_scope="case_time",
        output="vtp",
        model=StreamlineFilter,
    )


def build_plot_over_path() -> ResultFilterType:
    return ResultFilterType(
        key="plot_over_path",
        label="Plot-over-path",
        params_schema=(
            SchemaField("points", "Points", "text", default=""),
            SchemaField("subdivisions", "Subdivisions", "int", default=PLOT_OVER_PATH_DEFAULT_SUBDIVISIONS, min=0),
            SchemaField("field_variable", "Field", "text", default=PLOT_OVER_PATH_DEFAULT_FIELD_VARIABLE),
            SchemaField("case", "Case directory", "text", default=""),
            SchemaField("time", "Time", "text", default="50"),
        ),
        tool="export_plot_over_path.py",
        cache_scope="case_time",
        output="json",
        model=PlotOverPathFilter,
    )


def build_iso_surface() -> ResultFilterType:
    return ResultFilterType(
        key="iso_surface",
        label="Iso Surface",
        params_schema=(
            SchemaField("iso_scalar", "Iso scalar", "text", default=ISO_SURFACE_DEFAULT_ISO_SCALAR),
            SchemaField("iso_value", "Iso value", "float", default=ISO_SURFACE_DEFAULT_ISO_VALUE),
            SchemaField("coloring", "Coloring", "text", default="Pressure"),
            SchemaField("opacity", "Opacity", "float", default=1.0, min=0, max=1),
            SchemaField("vectors", "Vectors", "bool", default=False),
            SchemaField("case", "Case directory", "text", default=""),
            SchemaField("time", "Time", "text", default="50"),
        ),
        tool="export_iso_surface.py",
        cache_scope="case_time",
        output="vtp",
        model=IsoSurfaceFilter,
    )


def build_iso_volume() -> ResultFilterType:
    return ResultFilterType(
        key="iso_volume",
        label="Iso Volume",
        params_schema=(
            SchemaField("iso_scalar", "Iso scalar", "text", default="Velocity Magnitude"),
            SchemaField("iso_value_low", "Iso low", "float", default=ISO_VOLUME_DEFAULT_ISO_VALUE_LOW, min=0, max=1),
            SchemaField("iso_value_high", "Iso high", "float", default=ISO_VOLUME_DEFAULT_ISO_VALUE_HIGH, min=0, max=1),
            SchemaField("coloring", "Coloring", "text", default="Pressure"),
            SchemaField("opacity", "Opacity", "float", default=1.0, min=0, max=1),
            SchemaField("vectors", "Vectors", "bool", default=False),
            SchemaField("case", "Case directory", "text", default=""),
            SchemaField("time", "Time", "text", default="50"),
        ),
        tool="export_iso_volume.py",
        cache_scope="case_time",
        output="vtp",
        model=IsoVolumeFilter,
    )


def build_inspect_point() -> ResultFilterType:
    return ResultFilterType(
        key="inspect_point",
        label="Inspect point",
        params_schema=(
            SchemaField("x", "X", "float"),
            SchemaField("y", "Y", "float"),
            SchemaField("z", "Z", "float"),
            SchemaField("case", "Case directory", "text", default=""),
            SchemaField("time", "Time", "text", default="50"),
        ),
        tool="export_inspect_point.py",
        cache_scope="case_time",
        output="json",
        model=None,  # VIEW probe — not in FilterSpec union
    )


def build_surface_field() -> ResultFilterType:
    return ResultFilterType(
        key="surface_field",
        label="Surface field",
        params_schema=(
            SchemaField("field", "Field", "choice", default="magU", choices=("magU", "p")),
            SchemaField("case", "Case directory", "text", default=""),
            SchemaField("time", "Time", "text", default="50"),
        ),
        tool="export_case_field.py",
        cache_scope="case_time",
        output="vtp",
        model=None,  # case-tree field export — not a FilterSpec stack entry
    )


def build_mesh_surface() -> ResultFilterType:
    return ResultFilterType(
        key="mesh_surface",
        label="Mesh surface",
        params_schema=(
            SchemaField("case", "Case directory", "text", default=""),
        ),
        tool="export_mesh_surface_vtp.py",
        cache_scope="case",
        output="vtp",
        model=None,
    )


def build_mesh_section() -> ResultFilterType:
    return ResultFilterType(
        key="mesh_section",
        label="Mesh section",
        params_schema=(
            SchemaField("axis", "Axis", "choice", default="x", choices=("x", "y", "z")),
            SchemaField("frac", "Fraction", "float", default=0.5, min=0, max=1),
            SchemaField("case", "Case directory", "text", default=""),
        ),
        tool="export_mesh_section_vtp.py",
        cache_scope="case",
        output="vtp",
        model=None,
    )


def register_filters(hub: RegistryHub) -> None:
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
