"""Serializable results filter stack (SimScale-style)."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

FilterType = Literal["cut_plane", "streamlines", "plot_over_path", "iso_surface", "iso_volume", "animation", "field_calculator"]
AxisName = Literal["X", "Y", "Z"]
OrientationName = Literal["X", "Y", "Z", "Inverse"]
BoundaryMode = Literal["surface", "wireframe", "translucent", "hidden"]
GeometryRep = Literal["step_solid", "stl", "mesh"]
ParticleRep = Literal["Cylinders", "Spheres", "Comets"]

# Inc 16b Particle Trace — Researcher stills + DA unlock defaults.
REPRESENTATION_ITEMS: tuple[str, ...] = ("Cylinders", "Spheres", "Comets")
PARTICLE_TRACE_DEFAULT_REPRESENTATION: ParticleRep = "Cylinders"
PARTICLE_TRACE_DEFAULT_SEEDS_H: int = 10
PARTICLE_TRACE_DEFAULT_SEEDS_V: int = 10
PARTICLE_TRACE_DEFAULT_SPACING: float = 1.5e-2
PARTICLE_TRACE_DEFAULT_COLORING: str = "Velocity Magnitude"
PARTICLE_TRACE_DEFAULT_SIZE: float = 3.7e-3
PARTICLE_TRACE_DEFAULT_BOTH_DIRECTIONS: bool = True
# Inc 22a Daniel multi-face seed UX (product add-on; not SimScale chrome).
PARTICLE_TRACE_DEFAULT_SEED_MODE: str = "grid"  # grid | faces
PARTICLE_TRACE_DEFAULT_SEED_QUANTITY_MODE: str = "count"  # count | density
PARTICLE_TRACE_DEFAULT_SEED_DENSITY: float = 5000.0  # seeds / m^2
SEED_MODE_ITEMS: tuple[str, ...] = ("grid", "faces")
SEED_QUANTITY_MODE_ITEMS: tuple[str, ...] = ("count", "density")
# Pick Position: empty until picked (None). Persist as [x,y,z] or null.


def normalize_representation(rep: str | None) -> ParticleRep:
    """Map persist / legacy lowercase reps to Researcher display labels."""
    key = (rep or "").strip()
    legacy = {
        "lines": "Cylinders",
        "spheres": "Spheres",
        "comets": "Comets",
        "cylinders": "Cylinders",
        "Cylinders": "Cylinders",
        "Spheres": "Spheres",
        "Comets": "Comets",
    }
    return legacy.get(key, PARTICLE_TRACE_DEFAULT_REPRESENTATION)  # type: ignore[return-value]


def representation_to_live(rep: str | None) -> str:
    """Map Researcher Representation → live pipeline token (tubes/spheres/comets)."""
    canon = normalize_representation(rep)
    return {"Cylinders": "tubes", "Spheres": "spheres", "Comets": "comets"}[canon]


def parse_pick_position(raw: object) -> list[float] | None:
    """Empty / missing → None; else three floats [x, y, z]."""
    if raw is None or raw == "" or raw == []:
        return None
    if isinstance(raw, (list, tuple)) and len(raw) >= 3:
        try:
            return [float(raw[0]), float(raw[1]), float(raw[2])]
        except (TypeError, ValueError):
            return None
    if isinstance(raw, str):
        text = raw.strip().replace("(", "").replace(")", "")
        if not text:
            return None
        parts = [p.strip() for p in text.replace(";", ",").split(",") if p.strip()]
        if len(parts) < 3:
            return None
        try:
            return [float(parts[0]), float(parts[1]), float(parts[2])]
        except (TypeError, ValueError):
            return None
    return None


def format_pick_position(pos: list[float] | None) -> str:
    """Display string for Pick Position control (empty until picked)."""
    if not pos or len(pos) < 3:
        return ""
    return f"{pos[0]:.6g}, {pos[1]:.6g}, {pos[2]:.6g}"

# Inc 16a Cutting Plane — Researcher stills + DA unlock defaults.
ORIENTATION_ITEMS: tuple[str, ...] = ("X", "Y", "Z", "Inverse")
CUTTING_PLANE_DEFAULT_ORIENTATION: OrientationName = "Y"
CUTTING_PLANE_DEFAULT_COLORING: str = "Velocity Magnitude"
CUTTING_PLANE_DEFAULT_VECTORS: bool = False
CUTTING_PLANE_DEFAULT_OPACITY: float = 0.9
CUTTING_PLANE_DEFAULT_CLIP_MODEL: bool = False
# Position: slider only in still (no numeric shown). Persist float 0–1; mid default.
CUTTING_PLANE_DEFAULT_POSITION: float = 0.5


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def coloring_to_scalar_field(coloring: str) -> str:
    """Map persist Coloring label to a prepared scalar name when known."""
    key = (coloring or "").strip().lower()
    if key in (
        "velocity magnitude",
        "magu",
        "|u|",
        "u magnitude",
        "velocity",
    ):
        return "magU"
    return coloring.strip() or "magU"


@dataclass
class CutPlaneFilter:
    """Cutting Plane post filter (Inc 16a form + project persist)."""

    id: str = field(default_factory=_new_id)
    type: Literal["cut_plane"] = "cut_plane"
    visible: bool = True
    orientation: OrientationName = CUTTING_PLANE_DEFAULT_ORIENTATION
    position: float = CUTTING_PLANE_DEFAULT_POSITION  # 0–1 along inset span
    coloring: str = CUTTING_PLANE_DEFAULT_COLORING
    vectors: bool = CUTTING_PLANE_DEFAULT_VECTORS
    opacity: float = CUTTING_PLANE_DEFAULT_OPACITY
    clip_model: bool = CUTTING_PLANE_DEFAULT_CLIP_MODEL
    # Legacy mesh-edge diagnose flag (not on 16a Cutting Plane form).
    show_edges: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "visible": self.visible,
            "orientation": self.orientation,
            "position": float(self.position),
            "coloring": self.coloring,
            "vectors": bool(self.vectors),
            "opacity": float(self.opacity),
            "clip_model": bool(self.clip_model),
            "show_edges": bool(self.show_edges),
        }

    @staticmethod
    def from_dict(data: dict) -> CutPlaneFilter:
        raw_orient = data.get("orientation", data.get("normal", CUTTING_PLANE_DEFAULT_ORIENTATION))
        if raw_orient not in ORIENTATION_ITEMS:
            raw_orient = CUTTING_PLANE_DEFAULT_ORIENTATION
        pos = data.get("position", data.get("fraction", CUTTING_PLANE_DEFAULT_POSITION))
        try:
            position = float(pos)
        except (TypeError, ValueError):
            position = CUTTING_PLANE_DEFAULT_POSITION
        position = max(0.0, min(1.0, position))
        coloring = data.get("coloring")
        if coloring is None:
            legacy_field = data.get("field", "magU")
            if legacy_field in ("magU", "U", "", None):
                coloring = CUTTING_PLANE_DEFAULT_COLORING
            else:
                coloring = str(legacy_field)
        else:
            coloring = str(coloring) or CUTTING_PLANE_DEFAULT_COLORING
        try:
            opacity = float(data.get("opacity", CUTTING_PLANE_DEFAULT_OPACITY))
        except (TypeError, ValueError):
            opacity = CUTTING_PLANE_DEFAULT_OPACITY
        opacity = max(0.0, min(1.0, opacity))
        return CutPlaneFilter(
            id=str(data.get("id") or _new_id()),
            visible=bool(data.get("visible", True)),
            orientation=raw_orient,
            position=position,
            coloring=coloring,
            vectors=bool(data.get("vectors", CUTTING_PLANE_DEFAULT_VECTORS)),
            opacity=opacity,
            clip_model=bool(data.get("clip_model", CUTTING_PLANE_DEFAULT_CLIP_MODEL)),
            show_edges=bool(data.get("show_edges", False)),
        )

    @property
    def normal(self) -> AxisName:
        """Axis used for live plane placement (Inverse → Y, flipped sign)."""
        if self.orientation in ("X", "Y", "Z"):
            return self.orientation
        return "Y"

    @normal.setter
    def normal(self, value: str) -> None:
        if value in ("X", "Y", "Z"):
            self.orientation = value  # type: ignore[assignment]
        elif value == "Inverse":
            self.orientation = "Inverse"

    @property
    def fraction(self) -> float:
        return float(self.position)

    @fraction.setter
    def fraction(self, value: float) -> None:
        self.position = max(0.0, min(1.0, float(value)))

    @property
    def field(self) -> str:
        return coloring_to_scalar_field(self.coloring)

    @field.setter
    def field(self, value: str) -> None:
        if value in ("magU", "U", ""):
            self.coloring = CUTTING_PLANE_DEFAULT_COLORING
        else:
            self.coloring = str(value)

    def normal_tuple(self) -> tuple[float, float, float]:
        if self.orientation == "X":
            return (1.0, 0.0, 0.0)
        if self.orientation == "Y":
            return (0.0, 1.0, 0.0)
        if self.orientation == "Z":
            return (0.0, 0.0, 1.0)
        # Inverse: flipped default axis (Y)
        return (0.0, -1.0, 0.0)


@dataclass
class StreamlineFilter:
    """Particle Trace post filter (Inc 16b form + project persist).

    type remains "streamlines" for project JSON compatibility with 16a / slice5.
    """

    id: str = field(default_factory=_new_id)
    type: Literal["streamlines"] = "streamlines"
    visible: bool = True
    # Researcher still fields (16b)
    pick_position: list[float] | None = None  # empty until picked
    seeds_u: int = PARTICLE_TRACE_DEFAULT_SEEDS_H  # UI: # Seeds horizontally
    seeds_v: int = PARTICLE_TRACE_DEFAULT_SEEDS_V  # UI: # Seeds vertically
    seed_spacing: float = PARTICLE_TRACE_DEFAULT_SPACING
    coloring: str = PARTICLE_TRACE_DEFAULT_COLORING
    representation: ParticleRep = PARTICLE_TRACE_DEFAULT_REPRESENTATION
    seed_size: float = PARTICLE_TRACE_DEFAULT_SIZE  # Size
    both_directions: bool = PARTICLE_TRACE_DEFAULT_BOTH_DIRECTIONS
    # Inc 22a Daniel multi-face seed UX (product add-on)
    seed_mode: str = PARTICLE_TRACE_DEFAULT_SEED_MODE  # grid | faces
    seed_patches: list[str] = field(default_factory=list)  # inlet/outlet assortment
    seed_face_ids: list[int] = field(default_factory=list)  # optional CAD face ids
    seed_quantity_mode: str = PARTICLE_TRACE_DEFAULT_SEED_QUANTITY_MODE  # count | density
    seed_density: float = PARTICLE_TRACE_DEFAULT_SEED_DENSITY  # seeds / m^2
    # Legacy live-pipeline fields (not on 16b Particle Trace form)
    seed_patch: str = "inlet"
    n_seeds: int = 40
    num_pulses: int = 5
    relative_comet_length: float = 0.15
    tube_radius: float = 0.0
    max_propagation_diag_mult: float = 10.0
    max_steps: int = 50000

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "visible": self.visible,
            "pick_position": (
                list(self.pick_position) if self.pick_position is not None else None
            ),
            "seeds_u": int(self.seeds_u),
            "seeds_v": int(self.seeds_v),
            "seed_spacing": float(self.seed_spacing),
            "coloring": self.coloring,
            "representation": self.representation,
            "seed_size": float(self.seed_size),
            "both_directions": bool(self.both_directions),
            "seed_mode": str(self.seed_mode or "grid"),
            "seed_patches": list(self.seed_patches or []),
            "seed_face_ids": [int(x) for x in (self.seed_face_ids or [])],
            "seed_quantity_mode": str(self.seed_quantity_mode or "count"),
            "seed_density": float(self.seed_density),
            "seed_patch": self.seed_patch,
            "n_seeds": int(self.n_seeds),
            "num_pulses": int(self.num_pulses),
            "relative_comet_length": float(self.relative_comet_length),
            "tube_radius": float(self.tube_radius),
            "max_propagation_diag_mult": float(self.max_propagation_diag_mult),
            "max_steps": int(self.max_steps),
            # Legacy alias for older readers
            "field": coloring_to_scalar_field(self.coloring),
        }

    @staticmethod
    def from_dict(data: dict) -> StreamlineFilter:
        rep = normalize_representation(data.get("representation"))
        coloring = data.get("coloring")
        if coloring is None:
            legacy_field = data.get("field", "magU")
            if legacy_field in ("magU", "U", "", None):
                coloring = PARTICLE_TRACE_DEFAULT_COLORING
            else:
                coloring = str(legacy_field)
        else:
            coloring = str(coloring) or PARTICLE_TRACE_DEFAULT_COLORING
        try:
            seeds_u = int(data.get("seeds_u", PARTICLE_TRACE_DEFAULT_SEEDS_H))
        except (TypeError, ValueError):
            seeds_u = PARTICLE_TRACE_DEFAULT_SEEDS_H
        try:
            seeds_v = int(data.get("seeds_v", PARTICLE_TRACE_DEFAULT_SEEDS_V))
        except (TypeError, ValueError):
            seeds_v = PARTICLE_TRACE_DEFAULT_SEEDS_V
        try:
            seed_spacing = float(
                data.get("seed_spacing", PARTICLE_TRACE_DEFAULT_SPACING)
            )
        except (TypeError, ValueError):
            seed_spacing = PARTICLE_TRACE_DEFAULT_SPACING
        try:
            seed_size = float(data.get("seed_size", PARTICLE_TRACE_DEFAULT_SIZE))
        except (TypeError, ValueError):
            seed_size = PARTICLE_TRACE_DEFAULT_SIZE
        both = data.get("both_directions", PARTICLE_TRACE_DEFAULT_BOTH_DIRECTIONS)
        return StreamlineFilter(
            id=str(data.get("id") or _new_id()),
            visible=bool(data.get("visible", True)),
            pick_position=parse_pick_position(data.get("pick_position")),
            seeds_u=seeds_u,
            seeds_v=seeds_v,
            seed_spacing=seed_spacing,
            coloring=coloring,
            representation=rep,
            seed_size=seed_size,
            both_directions=bool(both),
            seed_mode=str(data.get("seed_mode", PARTICLE_TRACE_DEFAULT_SEED_MODE) or "grid"),
            seed_patches=[
                str(x) for x in (data.get("seed_patches") or []) if str(x).strip()
            ],
            seed_face_ids=[
                int(x) for x in (data.get("seed_face_ids") or [])
            ],
            seed_quantity_mode=str(
                data.get("seed_quantity_mode", PARTICLE_TRACE_DEFAULT_SEED_QUANTITY_MODE)
                or "count"
            ),
            seed_density=float(
                data.get("seed_density", PARTICLE_TRACE_DEFAULT_SEED_DENSITY)
            ),
            seed_patch=str(data.get("seed_patch", "inlet")),
            n_seeds=int(data.get("n_seeds", 40)),
            num_pulses=int(data.get("num_pulses", 5)),
            relative_comet_length=float(data.get("relative_comet_length", 0.15)),
            tube_radius=float(data.get("tube_radius", 0.0)),
            max_propagation_diag_mult=float(
                data.get("max_propagation_diag_mult", 10.0)
            ),
            max_steps=int(data.get("max_steps", 50000)),
        )

    @property
    def field(self) -> str:
        return coloring_to_scalar_field(self.coloring)

    @field.setter
    def field(self, value: str) -> None:
        if value in ("magU", "U", ""):
            self.coloring = PARTICLE_TRACE_DEFAULT_COLORING
        else:
            self.coloring = str(value)



# Inc 16c Plot-over-path — Researcher stills + DA unlock defaults.
PLOT_OVER_PATH_DEFAULT_SUBDIVISIONS: int = 0
PLOT_OVER_PATH_DEFAULT_FIELD_VARIABLE: str = "Velocity Magnitude"
# Pick points / Selected points: empty until picked. Persist as list of [x,y,z].


def parse_points_list(raw: object) -> list[list[float]]:
    """Empty / missing → []; else list of [x,y,z] points."""
    if raw is None or raw == "" or raw == []:
        return []
    if not isinstance(raw, (list, tuple)):
        return []
    out: list[list[float]] = []
    for item in raw:
        pt = parse_pick_position(item)
        if pt is not None:
            out.append(pt)
    return out


@dataclass
class PlotOverPathFilter:
    """Plot-over-path post filter (Inc 16c form + Inc 30a live sample).

    Persist points/subdivisions/field_variable; live Generate samples the bound
    session field along the polyline via live_plot_over_path.
    """

    id: str = field(default_factory=_new_id)
    type: Literal["plot_over_path"] = "plot_over_path"
    visible: bool = True
    # Researcher still fields (16c)
    points: list[list[float]] = field(default_factory=list)  # empty until picked
    subdivisions: int = PLOT_OVER_PATH_DEFAULT_SUBDIVISIONS
    field_variable: str = PLOT_OVER_PATH_DEFAULT_FIELD_VARIABLE

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "visible": self.visible,
            "points": [list(p) for p in self.points],
            "subdivisions": int(self.subdivisions),
            "field_variable": self.field_variable,
            # Legacy alias for scalar mapping readers
            "field": coloring_to_scalar_field(self.field_variable),
        }

    @staticmethod
    def from_dict(data: dict) -> PlotOverPathFilter:
        field_variable = data.get("field_variable")
        if field_variable is None:
            legacy_field = data.get("field", "magU")
            if legacy_field in ("magU", "U", "", None):
                field_variable = PLOT_OVER_PATH_DEFAULT_FIELD_VARIABLE
            else:
                field_variable = str(legacy_field)
        else:
            field_variable = str(field_variable) or PLOT_OVER_PATH_DEFAULT_FIELD_VARIABLE
        try:
            subdivisions = int(
                data.get("subdivisions", PLOT_OVER_PATH_DEFAULT_SUBDIVISIONS)
            )
        except (TypeError, ValueError):
            subdivisions = PLOT_OVER_PATH_DEFAULT_SUBDIVISIONS
        subdivisions = max(0, subdivisions)
        return PlotOverPathFilter(
            id=str(data.get("id") or _new_id()),
            visible=bool(data.get("visible", True)),
            points=parse_points_list(data.get("points")),
            subdivisions=subdivisions,
            field_variable=field_variable,
        )

    @property
    def field(self) -> str:
        return coloring_to_scalar_field(self.field_variable)

    @field.setter
    def field(self, value: str) -> None:
        if value in ("magU", "U", ""):
            self.field_variable = PLOT_OVER_PATH_DEFAULT_FIELD_VARIABLE
        else:
            self.field_variable = str(value)



# Inc 16d Iso Surface — Researcher stills + DA unlock defaults.
ISO_SURFACE_DEFAULT_ISO_SCALAR: str = "Velocity Magnitude"
ISO_SURFACE_DEFAULT_ISO_VALUE: float = 11.1  # m/s (SI); UI shows sibling unit label
ISO_SURFACE_DEFAULT_COLORING: str = "Pressure"
ISO_SURFACE_DEFAULT_VECTORS: bool = False
ISO_SURFACE_DEFAULT_OPACITY: float = 1.0


@dataclass
class IsoSurfaceFilter:
    """Iso Surface post filter (Inc 16d form + project persist).

    UI+persist + live contour (Inc 28a). Vectors remain persist-only.
    """

    id: str = field(default_factory=_new_id)
    type: Literal["iso_surface"] = "iso_surface"
    visible: bool = True
    iso_scalar: str = ISO_SURFACE_DEFAULT_ISO_SCALAR
    iso_value: float = ISO_SURFACE_DEFAULT_ISO_VALUE
    coloring: str = ISO_SURFACE_DEFAULT_COLORING
    vectors: bool = ISO_SURFACE_DEFAULT_VECTORS
    opacity: float = ISO_SURFACE_DEFAULT_OPACITY

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "visible": self.visible,
            "iso_scalar": self.iso_scalar,
            "iso_value": float(self.iso_value),
            "coloring": self.coloring,
            "vectors": bool(self.vectors),
            "opacity": float(self.opacity),
            # Legacy alias for scalar mapping readers (iso contour field)
            "field": coloring_to_scalar_field(self.iso_scalar),
        }

    @staticmethod
    def from_dict(data: dict) -> IsoSurfaceFilter:
        iso_scalar = data.get("iso_scalar")
        if iso_scalar is None:
            legacy_field = data.get("field", "magU")
            if legacy_field in ("magU", "U", "", None):
                iso_scalar = ISO_SURFACE_DEFAULT_ISO_SCALAR
            else:
                iso_scalar = str(legacy_field)
        else:
            iso_scalar = str(iso_scalar) or ISO_SURFACE_DEFAULT_ISO_SCALAR
        coloring = data.get("coloring")
        if coloring is None:
            coloring = ISO_SURFACE_DEFAULT_COLORING
        else:
            coloring = str(coloring) or ISO_SURFACE_DEFAULT_COLORING
        try:
            iso_value = float(data.get("iso_value", ISO_SURFACE_DEFAULT_ISO_VALUE))
        except (TypeError, ValueError):
            iso_value = ISO_SURFACE_DEFAULT_ISO_VALUE
        try:
            opacity = float(data.get("opacity", ISO_SURFACE_DEFAULT_OPACITY))
        except (TypeError, ValueError):
            opacity = ISO_SURFACE_DEFAULT_OPACITY
        opacity = max(0.0, min(1.0, opacity))
        return IsoSurfaceFilter(
            id=str(data.get("id") or _new_id()),
            visible=bool(data.get("visible", True)),
            iso_scalar=iso_scalar,
            iso_value=iso_value,
            coloring=coloring,
            vectors=bool(data.get("vectors", ISO_SURFACE_DEFAULT_VECTORS)),
            opacity=opacity,
        )

    @property
    def field(self) -> str:
        return coloring_to_scalar_field(self.iso_scalar)

    @field.setter
    def field(self, value: str) -> None:
        if value in ("magU", "U", ""):
            self.iso_scalar = ISO_SURFACE_DEFAULT_ISO_SCALAR
        else:
            self.iso_scalar = str(value)



# Inc 16e Iso Volume — Researcher stills + DA unlock defaults.
ISO_VOLUME_DEFAULT_ISO_SCALAR: str = "Velocity Magnitude"
# Iso value: two-handle range; slider-only UI (no numeric endpoints). Persist 0–1.
ISO_VOLUME_DEFAULT_ISO_VALUE_LOW: float = 0.25
ISO_VOLUME_DEFAULT_ISO_VALUE_HIGH: float = 0.75
ISO_VOLUME_DEFAULT_COLORING: str = "Pressure"
ISO_VOLUME_DEFAULT_VECTORS: bool = False
ISO_VOLUME_DEFAULT_OPACITY: float = 1.0


@dataclass
class IsoVolumeFilter:
    """Iso Volume post filter (Inc 16e form + Inc 29a live threshold).

    Form+persist + live volume via live_iso_volume.
    Iso value is a low/high pair (0–1 normalized); UI is dual-handle slider with
    no visible numeric endpoint labels (same spirit as 16a.1 Position).
    """

    id: str = field(default_factory=_new_id)
    type: Literal["iso_volume"] = "iso_volume"
    visible: bool = True
    iso_scalar: str = ISO_VOLUME_DEFAULT_ISO_SCALAR
    iso_value_low: float = ISO_VOLUME_DEFAULT_ISO_VALUE_LOW
    iso_value_high: float = ISO_VOLUME_DEFAULT_ISO_VALUE_HIGH
    coloring: str = ISO_VOLUME_DEFAULT_COLORING
    vectors: bool = ISO_VOLUME_DEFAULT_VECTORS
    opacity: float = ISO_VOLUME_DEFAULT_OPACITY

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "visible": self.visible,
            "iso_scalar": self.iso_scalar,
            "iso_value_low": float(self.iso_value_low),
            "iso_value_high": float(self.iso_value_high),
            "coloring": self.coloring,
            "vectors": bool(self.vectors),
            "opacity": float(self.opacity),
            # Legacy alias for scalar mapping readers (iso volume scalar)
            "field": coloring_to_scalar_field(self.iso_scalar),
        }

    @staticmethod
    def from_dict(data: dict) -> IsoVolumeFilter:
        iso_scalar = data.get("iso_scalar")
        if iso_scalar is None:
            legacy_field = data.get("field", "magU")
            if legacy_field in ("magU", "U", "", None):
                iso_scalar = ISO_VOLUME_DEFAULT_ISO_SCALAR
            else:
                iso_scalar = str(legacy_field)
        else:
            iso_scalar = str(iso_scalar) or ISO_VOLUME_DEFAULT_ISO_SCALAR
        coloring = data.get("coloring")
        if coloring is None:
            coloring = ISO_VOLUME_DEFAULT_COLORING
        else:
            coloring = str(coloring) or ISO_VOLUME_DEFAULT_COLORING
        # Prefer explicit low/high; accept iso_value [lo, hi] as alternate.
        raw_pair = data.get("iso_value")
        lo_raw = data.get("iso_value_low")
        hi_raw = data.get("iso_value_high")
        if lo_raw is None and isinstance(raw_pair, (list, tuple)) and len(raw_pair) >= 2:
            lo_raw, hi_raw = raw_pair[0], raw_pair[1]
        try:
            iso_value_low = float(
                lo_raw if lo_raw is not None else ISO_VOLUME_DEFAULT_ISO_VALUE_LOW
            )
        except (TypeError, ValueError):
            iso_value_low = ISO_VOLUME_DEFAULT_ISO_VALUE_LOW
        try:
            iso_value_high = float(
                hi_raw if hi_raw is not None else ISO_VOLUME_DEFAULT_ISO_VALUE_HIGH
            )
        except (TypeError, ValueError):
            iso_value_high = ISO_VOLUME_DEFAULT_ISO_VALUE_HIGH
        iso_value_low = max(0.0, min(1.0, iso_value_low))
        iso_value_high = max(0.0, min(1.0, iso_value_high))
        if iso_value_high < iso_value_low:
            iso_value_low, iso_value_high = iso_value_high, iso_value_low
        try:
            opacity = float(data.get("opacity", ISO_VOLUME_DEFAULT_OPACITY))
        except (TypeError, ValueError):
            opacity = ISO_VOLUME_DEFAULT_OPACITY
        opacity = max(0.0, min(1.0, opacity))
        return IsoVolumeFilter(
            id=str(data.get("id") or _new_id()),
            visible=bool(data.get("visible", True)),
            iso_scalar=iso_scalar,
            iso_value_low=iso_value_low,
            iso_value_high=iso_value_high,
            coloring=coloring,
            vectors=bool(data.get("vectors", ISO_VOLUME_DEFAULT_VECTORS)),
            opacity=opacity,
        )

    @property
    def field(self) -> str:
        return coloring_to_scalar_field(self.iso_scalar)

    @field.setter
    def field(self, value: str) -> None:
        if value in ("magU", "U", ""):
            self.iso_scalar = ISO_VOLUME_DEFAULT_ISO_SCALAR
        else:
            self.iso_scalar = str(value)




# Inc 16f Animation — Researcher stills + DA unlock defaults.
ANIMATION_TYPE_ITEMS: tuple[str, ...] = ("Time Step", "Particle Trace")
AnimationTypeName = Literal["Time Step", "Particle Trace"]
ANIMATION_DEFAULT_TYPE: AnimationTypeName = "Time Step"
ANIMATION_DEFAULT_START_TIME: int = 0
ANIMATION_DEFAULT_END_TIME: int = 1000
ANIMATION_DEFAULT_SPEED: int = 20  # slider only; range 1–60; no numeric beside slider
ANIMATION_SPEED_MIN: int = 1
ANIMATION_SPEED_MAX: int = 60
ANIMATION_DEFAULT_SKIP_FRAMES: int = 0
ANIMATION_DEFAULT_RANGE_LOW: float = 0.0  # two-handle; no numeric labels
ANIMATION_DEFAULT_RANGE_HIGH: float = 1.0
# Inc 23a Particle Trace animation chrome (Researcher still)
ANIMATION_DEFAULT_STEPS: int = 300
ANIMATION_STEPS_MIN: int = 1
ANIMATION_STEPS_MAX: int = 1000


def normalize_animation_type(raw: str | None) -> AnimationTypeName:
    key = (raw or "").strip()
    if key in ANIMATION_TYPE_ITEMS:
        return key  # type: ignore[return-value]
    legacy = {
        "time step": "Time Step",
        "timestep": "Time Step",
        "time_step": "Time Step",
        "particle trace": "Particle Trace",
        "particle_trace": "Particle Trace",
        "streamlines": "Particle Trace",
    }
    return legacy.get(key.lower(), ANIMATION_DEFAULT_TYPE)  # type: ignore[return-value]


@dataclass
class AnimationFilter:
    """Animation post tool (Inc 16f / 16f.1 form + project persist).

    Inc 16f persist + Inc 23a Particle Trace live animation path.
    Animation speed is slider-only (1–60; default 20); no numeric endpoint label.
    Animation range is two-handle (0–1 frac; default full); no numeric labels.
    Start time / End time are separate numeric fields (0 / 1000).
    Skip frames shows printed default 0 (unlike speed).
    """

    id: str = field(default_factory=_new_id)
    type: Literal["animation"] = "animation"
    visible: bool = True
    animation_type: AnimationTypeName = ANIMATION_DEFAULT_TYPE
    range_low: float = ANIMATION_DEFAULT_RANGE_LOW
    range_high: float = ANIMATION_DEFAULT_RANGE_HIGH
    start_time: int = ANIMATION_DEFAULT_START_TIME
    end_time: int = ANIMATION_DEFAULT_END_TIME
    speed: int = ANIMATION_DEFAULT_SPEED
    skip_frames: int = ANIMATION_DEFAULT_SKIP_FRAMES
    steps: int = ANIMATION_DEFAULT_STEPS

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "visible": self.visible,
            "animation_type": self.animation_type,
            "range_low": float(self.range_low),
            "range_high": float(self.range_high),
            "start_time": int(self.start_time),
            "end_time": int(self.end_time),
            "speed": int(self.speed),
            "skip_frames": int(self.skip_frames),
            "steps": int(self.steps),
        }

    @staticmethod
    def from_dict(data: dict) -> AnimationFilter:
        anim_type = normalize_animation_type(
            data.get("animation_type", data.get("playback_type"))
        )
        try:
            range_low = float(data.get("range_low", ANIMATION_DEFAULT_RANGE_LOW))
        except (TypeError, ValueError):
            range_low = ANIMATION_DEFAULT_RANGE_LOW
        try:
            range_high = float(data.get("range_high", ANIMATION_DEFAULT_RANGE_HIGH))
        except (TypeError, ValueError):
            range_high = ANIMATION_DEFAULT_RANGE_HIGH
        range_low = max(0.0, min(1.0, range_low))
        range_high = max(0.0, min(1.0, range_high))
        if range_high < range_low:
            range_low, range_high = range_high, range_low
        try:
            start_time = int(data.get("start_time", ANIMATION_DEFAULT_START_TIME))
        except (TypeError, ValueError):
            start_time = ANIMATION_DEFAULT_START_TIME
        try:
            end_time = int(data.get("end_time", ANIMATION_DEFAULT_END_TIME))
        except (TypeError, ValueError):
            end_time = ANIMATION_DEFAULT_END_TIME
        try:
            speed = int(data.get("speed", ANIMATION_DEFAULT_SPEED))
        except (TypeError, ValueError):
            speed = ANIMATION_DEFAULT_SPEED
        speed = max(ANIMATION_SPEED_MIN, min(ANIMATION_SPEED_MAX, speed))
        try:
            skip_frames = int(data.get("skip_frames", ANIMATION_DEFAULT_SKIP_FRAMES))
        except (TypeError, ValueError):
            skip_frames = ANIMATION_DEFAULT_SKIP_FRAMES
        skip_frames = max(0, skip_frames)
        try:
            steps = int(data.get("steps", ANIMATION_DEFAULT_STEPS))
        except (TypeError, ValueError):
            steps = ANIMATION_DEFAULT_STEPS
        steps = max(ANIMATION_STEPS_MIN, min(ANIMATION_STEPS_MAX, steps))
        return AnimationFilter(
            id=str(data.get("id") or _new_id()),
            visible=bool(data.get("visible", True)),
            animation_type=anim_type,
            range_low=range_low,
            range_high=range_high,
            start_time=start_time,
            end_time=end_time,
            speed=speed,
            skip_frames=skip_frames,
            steps=steps,
        )

# Inc 18b - VIEW Toggle UI (Researcher stills + DA unlock).
# Default off: left tree + right MESH/ITERATIONS chrome visible.
# On: those chrome gone; toolbar / viewport / legend stay.
# No Inspect point invent this slice.
TOGGLE_UI_DEFAULT: bool = False  # off
TOGGLE_UI_BUTTON_LABEL: str = "Toggle UI"

# Inc 18c - VIEW Filters + Legend toggles (Researcher stills + DA unlock).
# Filters default on: show existing Filters panel (Parts Color / Cutting Plane stack).
# Filters off: hide that panel. No new Filters panel chrome invent.
# Legend default on: show bottom Velocity Magnitude color bar.
# Legend off: hide it. No Legend settings dialog invent.
# No Inspect invent / no live viewport invent this slice.
FILTERS_DEFAULT: bool = True  # on
FILTERS_BUTTON_LABEL: str = "Filters"
LEGEND_DEFAULT: bool = True  # on
LEGEND_BUTTON_LABEL: str = "Legend"

# Inc 26a - VIEW Inspect point (slim: click→magenta marker only).
# Default off. When on: viewport click places magenta marker
# (same chrome family as Pick Position). No probe panel / coords HUD /
# field-value invent — including clicks off PT seeds.
INSPECT_POINT_DEFAULT: bool = False  # off until armed
INSPECT_POINT_BUTTON_LABEL: str = "Inspect point"

# Inc 18a - Import view / Compare (DISABLED chrome only; no dialogs invent).
# Exact still tooltips below — no invent beyond these strings.
# No Inspect point / Toggle UI / Filters/Legend invent this slice.
IMPORT_VIEW_DISABLED_TOOLTIP: str = (
    "You need at least one more successful simulation result to use the Import view functionality."
)
COMPARE_DISABLED_TOOLTIP: str = (
    "You need at least 2 successful simulation results to compare."
)
# Inc 16h - Rotational / Displacement (DISABLED toolbar entries only; no forms invent).
ROTATIONAL_DISABLED_TOOLTIP: str = (
    "The Rotational filter is only available for models with at least one rotation zone."
)
DISPLACEMENT_DISABLED_TOOLTIP: str = (
    "No displacement field available for this result."
)

# Inc 16g Field Calculator (BETA) - Researcher stills + DA unlock (UI+persist only).
FIELD_CALCULATOR_DEFAULT_NAME: str = "Field Calculator 1"
FIELD_CALCULATOR_DEFAULT_FORMULA: str = ""
FIELD_CALCULATOR_BETA_LABEL: str = "BETA"


@dataclass
class FieldCalculatorFilter:
    """Field Calculator (BETA) post tool (Inc 16g form + project persist).

    UI+persist only — no compute engine invent. Compute Formula stays disabled
    while formula is blank (still showed disabled with blank).
    """

    id: str = field(default_factory=_new_id)
    type: Literal["field_calculator"] = "field_calculator"
    visible: bool = True
    name: str = FIELD_CALCULATOR_DEFAULT_NAME
    formula: str = FIELD_CALCULATOR_DEFAULT_FORMULA

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "visible": self.visible,
            "name": self.name,
            "formula": self.formula,
        }

    @staticmethod
    def from_dict(data: dict) -> FieldCalculatorFilter:
        name = str(data.get("name") or FIELD_CALCULATOR_DEFAULT_NAME).strip()
        if not name:
            name = FIELD_CALCULATOR_DEFAULT_NAME
        formula = str(data.get("formula", FIELD_CALCULATOR_DEFAULT_FORMULA))
        return FieldCalculatorFilter(
            id=str(data.get("id") or _new_id()),
            visible=bool(data.get("visible", True)),
            name=name,
            formula=formula,
        )


FilterSpec = CutPlaneFilter | StreamlineFilter | PlotOverPathFilter | IsoSurfaceFilter | IsoVolumeFilter | AnimationFilter | FieldCalculatorFilter


@dataclass
class ResultsDisplay:
    boundary_mode: BoundaryMode = "translucent"
    geometry_rep: GeometryRep = "step_solid"
    density_kg_m3: float | None = None
    field_unit: str = "m/s"  # for active velocity field display

    def to_dict(self) -> dict[str, Any]:
        return {
            "boundary_mode": self.boundary_mode,
            "geometry_rep": self.geometry_rep,
            "density_kg_m3": self.density_kg_m3,
            "field_unit": self.field_unit,
        }

    @staticmethod
    def from_dict(data: dict | None) -> ResultsDisplay:
        if not data:
            return ResultsDisplay()
        mode = data.get("boundary_mode", "translucent")
        if mode not in ("surface", "wireframe", "translucent", "hidden"):
            mode = "translucent"
        # Plan default: step_solid + translucent (never open as hidden by accident
        # when key missing). Persist explicit "hidden" if user chose it.
        if "boundary_mode" not in data:
            mode = "translucent"
        rep = data.get("geometry_rep", "step_solid")
        if rep not in ("step_solid", "stl", "mesh"):
            rep = "step_solid"
        dens = data.get("density_kg_m3")
        return ResultsDisplay(
            boundary_mode=mode,
            geometry_rep=rep,
            density_kg_m3=float(dens) if dens is not None else None,
            field_unit=str(data.get("field_unit", "m/s")),
        )


def default_filter_stack() -> list[FilterSpec]:
    return [CutPlaneFilter()]


def filters_to_list(filters: list[FilterSpec]) -> list[dict]:
    return [f.to_dict() for f in filters]


def filters_from_list(data: list | None) -> list[FilterSpec]:
    if not data:
        return default_filter_stack()
    out: list[FilterSpec] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        t = item.get("type", "cut_plane")
        if t == "streamlines":
            out.append(StreamlineFilter.from_dict(item))
        elif t == "plot_over_path":
            out.append(PlotOverPathFilter.from_dict(item))
        elif t == "iso_surface":
            out.append(IsoSurfaceFilter.from_dict(item))
        elif t == "iso_volume":
            out.append(IsoVolumeFilter.from_dict(item))
        elif t == "animation":
            out.append(AnimationFilter.from_dict(item))
        elif t == "field_calculator":
            out.append(FieldCalculatorFilter.from_dict(item))
        else:
            out.append(CutPlaneFilter.from_dict(item))
    return out or default_filter_stack()

# Inc 16i RESULT Save view ? Researcher stills + DA unlock (persist name+description only).
SAVE_VIEW_DEFAULT_NAME: str = "Incompressible - Run 1"
SAVE_VIEW_DEFAULT_DESCRIPTION: str = ""

# Inc 17d RESULT Manage views empty dialog — Researcher stills + DA unlock.
MANAGE_VIEWS_DIALOG_TITLE: str = "Manage views"
MANAGE_VIEWS_EMPTY_PRIMARY: str = "Saved views will appear here"
MANAGE_VIEWS_EMPTY_SECONDARY: str = "Please save your view, it will appear here"


@dataclass
class SavedView:
    """RESULT Save view (Inc 16i) ? name + description persist only.

    No Import view / Download / Share invent this slice. Manage views empty dialog is Inc 17d.
    Default name matches still; may later derive from run name.
    """

    id: str = field(default_factory=_new_id)
    name: str = SAVE_VIEW_DEFAULT_NAME
    description: str = SAVE_VIEW_DEFAULT_DESCRIPTION

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
        }

    @staticmethod
    def from_dict(data: dict | None) -> SavedView:
        if not data:
            return SavedView()
        name = str(data.get("name") or SAVE_VIEW_DEFAULT_NAME)
        if not name.strip():
            name = SAVE_VIEW_DEFAULT_NAME
        description = str(data.get("description", SAVE_VIEW_DEFAULT_DESCRIPTION))
        return SavedView(
            id=str(data.get("id") or _new_id()),
            name=name,
            description=description,
        )


def views_to_list(views: list[SavedView]) -> list[dict]:
    return [v.to_dict() for v in views]


def views_from_list(data: list | None) -> list[SavedView]:
    if not data:
        return []
    out: list[SavedView] = []
    for item in data:
        if isinstance(item, dict):
            out.append(SavedView.from_dict(item))
    return out


# Inc 17a CAPTURE Screenshot — Researcher still post-capture-screenshot (persist-only).
SCREENSHOT_DEFAULT_NAME: str = "Screenshot 1"
SCREENSHOT_DEFAULT_BACKGROUND_OPACITY: bool = False  # off
SCREENSHOT_DEFAULT_BACKGROUND_LOGO: bool = True  # on
SCREENSHOT_DEFAULT_WIDTH: int = 1280
SCREENSHOT_DEFAULT_HEIGHT: int = 900


@dataclass
class ScreenshotSettings:
    """CAPTURE Screenshot panel (Inc 17a) — persist-only; no real capture invent.

    Take screenshot button may exist as no-op / persist intent only.
    No Compare invent this slice (Record is Inc 17b).
    """

    id: str = field(default_factory=_new_id)
    name: str = SCREENSHOT_DEFAULT_NAME
    background_opacity: bool = SCREENSHOT_DEFAULT_BACKGROUND_OPACITY
    background_logo: bool = SCREENSHOT_DEFAULT_BACKGROUND_LOGO
    width: int = SCREENSHOT_DEFAULT_WIDTH
    height: int = SCREENSHOT_DEFAULT_HEIGHT

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "background_opacity": bool(self.background_opacity),
            "background_logo": bool(self.background_logo),
            "width": int(self.width),
            "height": int(self.height),
        }

    @staticmethod
    def from_dict(data: dict | None) -> ScreenshotSettings:
        if not data:
            return ScreenshotSettings()
        name = str(data.get("name") or SCREENSHOT_DEFAULT_NAME)
        if not name.strip():
            name = SCREENSHOT_DEFAULT_NAME
        try:
            width = int(data.get("width", SCREENSHOT_DEFAULT_WIDTH))
        except (TypeError, ValueError):
            width = SCREENSHOT_DEFAULT_WIDTH
        try:
            height = int(data.get("height", SCREENSHOT_DEFAULT_HEIGHT))
        except (TypeError, ValueError):
            height = SCREENSHOT_DEFAULT_HEIGHT
        return ScreenshotSettings(
            id=str(data.get("id") or _new_id()),
            name=name,
            background_opacity=bool(
                data.get("background_opacity", SCREENSHOT_DEFAULT_BACKGROUND_OPACITY)
            ),
            background_logo=bool(
                data.get("background_logo", SCREENSHOT_DEFAULT_BACKGROUND_LOGO)
            ),
            width=width,
            height=height,
        )


def screenshots_to_list(items: list[ScreenshotSettings]) -> list[dict]:
    return [s.to_dict() for s in items]


def screenshots_from_list(data: list | None) -> list[ScreenshotSettings]:
    if not data:
        return []
    out: list[ScreenshotSettings] = []
    for item in data:
        if isinstance(item, dict):
            out.append(ScreenshotSettings.from_dict(item))
    return out


# Inc 17b CAPTURE Record - Researcher still post-capture-record (persist-only).
RECORD_DEFAULT_NAME: str = "Animation 1"
RECORD_BETA_LABEL: str = "BETA"
RECORD_FORMAT_ITEMS: tuple[str, ...] = ("MP4", "GIF")
RecordFormatName = Literal["MP4", "GIF"]
RECORD_DEFAULT_FORMAT: RecordFormatName = "MP4"
RECORD_DEFAULT_WIDTH: int = 1440
RECORD_DEFAULT_HEIGHT: int = 1080


def normalize_record_format(raw: str | None) -> RecordFormatName:
    key = str(raw or "").strip()
    if key in RECORD_FORMAT_ITEMS:
        return key  # type: ignore[return-value]
    upper = key.upper()
    if upper in RECORD_FORMAT_ITEMS:
        return upper  # type: ignore[return-value]
    return RECORD_DEFAULT_FORMAT


@dataclass
class RecordSettings:
    """CAPTURE Record / Animation 1 panel (Inc 17b) - persist-only; no encode invent.

    Record animation button may exist as no-op / persist intent only.
    No Compare invent this slice.
    """

    id: str = field(default_factory=_new_id)
    name: str = RECORD_DEFAULT_NAME
    format: RecordFormatName = RECORD_DEFAULT_FORMAT
    width: int = RECORD_DEFAULT_WIDTH
    height: int = RECORD_DEFAULT_HEIGHT

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "format": self.format,
            "width": int(self.width),
            "height": int(self.height),
        }

    @staticmethod
    def from_dict(data: dict | None) -> RecordSettings:
        if not data:
            return RecordSettings()
        name = str(data.get("name") or RECORD_DEFAULT_NAME)
        if not name.strip():
            name = RECORD_DEFAULT_NAME
        fmt = normalize_record_format(data.get("format"))
        try:
            width = int(data.get("width", RECORD_DEFAULT_WIDTH))
        except (TypeError, ValueError):
            width = RECORD_DEFAULT_WIDTH
        try:
            height = int(data.get("height", RECORD_DEFAULT_HEIGHT))
        except (TypeError, ValueError):
            height = RECORD_DEFAULT_HEIGHT
        return RecordSettings(
            id=str(data.get("id") or _new_id()),
            name=name,
            format=fmt,
            width=width,
            height=height,
        )


def records_to_list(items: list[RecordSettings]) -> list[dict]:
    return [r.to_dict() for r in items]


def records_from_list(data: list | None) -> list[RecordSettings]:
    if not data:
        return []
    out: list[RecordSettings] = []
    for item in data:
        if isinstance(item, dict):
            out.append(RecordSettings.from_dict(item))
    return out



# Inc 17e VIEW Statistics panel - Researcher stills + DA unlock.
STATISTICS_DIALOG_TITLE: str = "Statistics"
STATISTICS_DEFAULT_FIELD: str = "Velocity Magnitude"
STATISTICS_ROW_SURFACE_AREA: str = "Surface Area"
STATISTICS_ROW_MAXIMUM: str = "Maximum"
STATISTICS_ROW_AVERAGE: str = "Average"
STATISTICS_ROW_MINIMUM: str = "Minimum"
STATISTICS_ROW_INTEGRAL: str = "Integral"
STATISTICS_ROW_VOLUMETRIC_FLOW_RATE: str = "Volumetric Flow Rate"
STATISTICS_HIGHLIGHT_IN_MODEL_DEFAULT: bool = False  # off
STATISTICS_DOWNLOAD_CSV_LABEL: str = "Download regions as CSV*"
STATISTICS_FOOTER_NOTE: str = "*Statistics are based on interpolated data. Learn more."
STATISTICS_CUTTING_PLANES_PREFIX: str = "Cutting planes:"
# Values are run-specific; do NOT hardcode still numerics (e.g. 2.502e-1, 11.01) as defaults.
STATISTICS_VALUE_PLACEHOLDER: str = ""


@dataclass
class StatisticsSettings:
    """VIEW Statistics panel (Inc 17e) - structure + defaults only.

    Download regions as CSV* may exist as no-op / present-only.
    No real CSV export invent. No Compare invent this slice.
    Numeric values are run-specific placeholders (never still defaults).
    """

    field: str = STATISTICS_DEFAULT_FIELD
    highlight_in_model: bool = STATISTICS_HIGHLIGHT_IN_MODEL_DEFAULT
    cutting_planes_count: int = 0
    surface_area: str = STATISTICS_VALUE_PLACEHOLDER
    maximum: str = STATISTICS_VALUE_PLACEHOLDER
    average: str = STATISTICS_VALUE_PLACEHOLDER
    minimum: str = STATISTICS_VALUE_PLACEHOLDER
    integral: str = STATISTICS_VALUE_PLACEHOLDER
    volumetric_flow_rate: str = STATISTICS_VALUE_PLACEHOLDER

    def to_dict(self) -> dict:
        return {
            "field": self.field,
            "highlight_in_model": bool(self.highlight_in_model),
            "cutting_planes_count": int(self.cutting_planes_count),
            "surface_area": self.surface_area,
            "maximum": self.maximum,
            "average": self.average,
            "minimum": self.minimum,
            "integral": self.integral,
            "volumetric_flow_rate": self.volumetric_flow_rate,
        }

    @staticmethod
    def from_dict(data: dict | None) -> StatisticsSettings:
        if not data:
            return StatisticsSettings()
        field = str(data.get("field") or STATISTICS_DEFAULT_FIELD)
        if not field:
            field = STATISTICS_DEFAULT_FIELD
        try:
            count = int(data.get("cutting_planes_count", 0))
        except (TypeError, ValueError):
            count = 0
        count = max(0, count)
        return StatisticsSettings(
            field=field,
            highlight_in_model=bool(
                data.get("highlight_in_model", STATISTICS_HIGHLIGHT_IN_MODEL_DEFAULT)
            ),
            cutting_planes_count=count,
            surface_area=str(data.get("surface_area", STATISTICS_VALUE_PLACEHOLDER)),
            maximum=str(data.get("maximum", STATISTICS_VALUE_PLACEHOLDER)),
            average=str(data.get("average", STATISTICS_VALUE_PLACEHOLDER)),
            minimum=str(data.get("minimum", STATISTICS_VALUE_PLACEHOLDER)),
            integral=str(data.get("integral", STATISTICS_VALUE_PLACEHOLDER)),
            volumetric_flow_rate=str(
                data.get("volumetric_flow_rate", STATISTICS_VALUE_PLACEHOLDER)
            ),
        )
