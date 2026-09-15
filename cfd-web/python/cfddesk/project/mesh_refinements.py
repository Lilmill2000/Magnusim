"""Algorithm-gated mesh refinement menu catalog (Inc 7a–11b).

Labels match SimScale / Coordinator DA evidence. Inc 7a stubs persist
type+name; Inc 7b adds Inflate boundary layer for Hex-dominant parametric
(form + snappy addLayers); Inc 7c adds Hex-dominant Inflate (different
fields: Surface layer relative thickness, min thickness 0); Inc 7d adds
Standard Inflate (UI + persist only: Layer gradation control, Number of
layers, Overall relative thickness, Growth rate — no snappy invent).
Inc 8a adds Surface refinement for Hex-dominant parametric only
(Min/Max level, Cell zone Without cell zone, Assigned Faces or Volumes;
snappy refinementSurfaces levels). Inc 8b adds Hex-dominant Surface
(Min/Max length in m, Cell zone, Assigned Faces or Volumes; UI + persist
only — do NOT invent snappy levels from meters).

Inc 9a adds Feature refinement for Hex-dominant parametric only
(Included angle 150°, Distance refinement levels table distance/level;
snappy features.levels when mapped. Included angle persist-only —
no clean map to CAD eMesh extraction or resolveFeatureAngle).
Inc 9b adds Feature refinement for Hex-dominant only
(Distance refinement lengths table Distance / Maximum edge length in m,
defaults 1/1; Assigned Faces or Volumes required; UI + persist only —
do NOT invent Included angle / Level onto Hex, and do NOT invent snappy
features.levels from max edge length).

Inc 10a adds Surface custom sizing for Standard only
(Sizing Automatic, Fineness 5, Curvature Automatic, Assigned Faces
required; UI + persist only — do NOT invent snappy/cfMesh local sizing
from Fineness).

Inc 10b adds Volume custom sizing for Standard only
(Sizing mode Inside, Sizing Automatic, Fineness 5, Curvature Automatic,
Assigned Volumes required, Refinement regions empty list + add affordance
only; UI + persist only — do NOT invent snappy/cfMesh from Fineness, and
do NOT invent region-row fields/forms this slice).

Inc 11a adds Region refinement for Hex-dominant parametric only
(Refinement mode Inside, Level 1, Assigned Volumes required,
Geometry primitives empty list + add affordance only, Background Mesh Box
off; UI + persist. Write Level into snappy refinementRegions only if a real
assignment path exists — CAD volumes / empty primitives do not map to
searchable geometry entries yet, so Level is persist-only this slice.
Inc 11b adds Region refinement for Hex-dominant only
(Refinement mode Inside, Maximum edge length 1 m, Assigned Volumes required,
Geometry primitives empty list + add affordance only; UI + persist.
Do NOT invent Background Mesh Box / Level onto Hex (those are parametric 11a).
Do NOT invent snappy levels / refinementRegions write from max edge length.
Standard has no Region in menu.)

Inc 12a adds Bounding box layer addition for Hex-dominant parametric only
(Face combo Min X/Max X/Min Y/Max Y/Min Z/Max Z default Min X, Layers 5,
Expansion ratio 1.3, Min thickness 0.01, Final thickness 0.3 ? label is
Final thickness, not Final layer thickness).
UI + persist. Face combo is the six BB faces (default Min X).
Write only if a real BB-layer mesher path exists ? do NOT invent by copying
Inflate addLayers. Standard / Hex menus have no Bounding box layer addition.

Inc 13a adds Extrusion mesh refinement for Standard only
(Sweep sizing type Element thickness along sweep | Number of elements along
sweep default Element thickness along sweep; Thickness 0.1 m in Element
thickness mode; Number of elements 10 when Number mode — Thickness hidden;
Surface element type Triangular | Quad dominant default Triangular;
Specify start/end mesh size Off; Enable Grading Off; Start faces + End faces
required). UI + persist only — do NOT invent OpenFOAM/snappy write.
ABSENT on Hex-dominant and Hex-dominant parametric menus.

Inc 15a extends Standard Extrusion On-toggle fields (persist-only):
When Specify start/end mesh size = On → Maximum edge length 0.1 m.
When Enable Grading = On → First element thickness 0.01, Growth rate 1.2,
Side Start face | End face | Both (default Both).
Off keeps 13a Off behavior (On fields hidden). Do NOT invent OpenFOAM/
snappy/cfMesh extrusion grading write.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import uuid

from cfddesk.project.settings import MeshAlgorithm


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


# Stable type keys (slug) -> SimScale display label.
# Shared keys (e.g. inflate_boundary_layer) may appear under multiple algorithms.
REFINEMENT_TYPE_LABELS: dict[str, str] = {
    "surface_custom_sizing": "Surface custom sizing",
    "volume_custom_sizing": "Volume custom sizing",
    "inflate_boundary_layer": "Inflate boundary layer",
    "extrusion_mesh_refinement": "Extrusion mesh refinement",
    "region_refinement": "Region refinement",
    "surface_refinement": "Surface refinement",
    "feature_refinement": "Feature refinement",
    "bounding_box_layer_addition": "Bounding box layer addition",
}

# Exact menu order per algorithm (Coordinator / DA GO 7a).
REFINEMENT_MENU_BY_ALGORITHM: dict[str, tuple[str, ...]] = {
    "standard": (
        "surface_custom_sizing",
        "volume_custom_sizing",
        "inflate_boundary_layer",
        "extrusion_mesh_refinement",
    ),
    "hex-dominant": (
        "region_refinement",
        "surface_refinement",
        "feature_refinement",
        "inflate_boundary_layer",
    ),
    "hex-dominant-parametric": (
        "bounding_box_layer_addition",
        "feature_refinement",
        "inflate_boundary_layer",
        "region_refinement",
        "surface_refinement",
    ),
}

# Inc 7b DA defaults for Inflate boundary layer (parametric only).
INFLATE_TYPE = "inflate_boundary_layer"
INFLATE_DEFAULT_LAYERS = 5
INFLATE_DEFAULT_EXPANSION_RATIO = 1.3
INFLATE_DEFAULT_MIN_THICKNESS = 0.01
INFLATE_DEFAULT_FINAL_LAYER_THICKNESS = 0.3

# Inc 7c DA defaults for Inflate boundary layer (hex-dominant only).
# Do NOT invent Final layer thickness onto Hex — that is parametric 7b.
HEX_INFLATE_DEFAULT_LAYERS = 5
HEX_INFLATE_DEFAULT_EXPANSION_RATIO = 1.3
HEX_INFLATE_DEFAULT_MIN_THICKNESS = 0.0
HEX_INFLATE_DEFAULT_SURFACE_LAYER_RELATIVE_THICKNESS = 0.055

# Inc 7d DA defaults for Inflate boundary layer (Standard only).
# UI + persist only — do NOT invent snappy addLayers for Standard.
STD_INFLATE_DEFAULT_LAYER_GRADATION = "Specify growth rate"
STD_INFLATE_DEFAULT_LAYERS = 3  # Number of layers
STD_INFLATE_DEFAULT_OVERALL_RELATIVE_THICKNESS = 0.4
STD_INFLATE_DEFAULT_GROWTH_RATE = 1.5  # stored in expansion_ratio

# Inc 8a DA defaults for Surface refinement (hex-dominant-parametric only).
SURFACE_REFINEMENT_TYPE = "surface_refinement"
SURFACE_DEFAULT_MIN_LEVEL = 1
SURFACE_DEFAULT_MAX_LEVEL = 2
SURFACE_DEFAULT_CELL_ZONE = "Without cell zone"

# Inc 8b DA defaults for Surface refinement (hex-dominant only).
# Lengths are SI meters. Persist-only — do NOT invent snappy levels from m.
HEX_SURFACE_DEFAULT_MIN_LENGTH = 1.0
HEX_SURFACE_DEFAULT_MAX_LENGTH = 1.0

# Inc 9a DA defaults for Feature refinement (hex-dominant-parametric only).
FEATURE_REFINEMENT_TYPE = "feature_refinement"
FEATURE_DEFAULT_INCLUDED_ANGLE = 150.0
FEATURE_DEFAULT_DISTANCE_LEVELS: list[dict[str, float | int]] = [
    {"distance": 1.0, "level": 1},
]

# Inc 9b DA defaults for Feature refinement (hex-dominant only).
# Lengths are SI meters. Persist-only — do NOT invent snappy features.levels
# from Maximum edge length, and do NOT invent Included angle / Level onto Hex.
HEX_FEATURE_DEFAULT_DISTANCE_LENGTHS: list[dict[str, float]] = [
    {"distance": 1.0, "max_edge_length": 1.0},
]

# Inc 10a DA defaults for Surface custom sizing (Standard only).
# Persist-only — do NOT invent snappy/cfMesh sizing from Fineness.
SURFACE_CUSTOM_SIZING_TYPE = "surface_custom_sizing"
VOLUME_CUSTOM_SIZING_TYPE = "volume_custom_sizing"
STD_SURFACE_SIZING_DEFAULT = "Automatic"
STD_SURFACE_FINENESS_DEFAULT = 5
STD_SURFACE_CURVATURE_DEFAULT = "Automatic"

# Inc 10b DA defaults for Volume custom sizing (Standard only).
# Persist-only — do NOT invent snappy/cfMesh from Fineness; refinement_regions
# is an empty list only (add affordance, no region-row field invent).
STD_VOLUME_SIZING_MODE_DEFAULT = "Inside"
STD_VOLUME_SIZING_DEFAULT = "Automatic"
STD_VOLUME_FINENESS_DEFAULT = 5
STD_VOLUME_CURVATURE_DEFAULT = "Automatic"

# Inc 11a DA defaults for Region refinement (hex-dominant-parametric only).
# Persist Level/mode; snappy refinementRegions write only when a real
# searchable-geometry assignment path exists (not invented this slice).
REGION_REFINEMENT_TYPE = "region_refinement"
REGION_DEFAULT_MODE = "Inside"  # Refinement mode
REGION_DEFAULT_LEVEL = 1
REGION_DEFAULT_BACKGROUND_MESH_BOX = False

# Inc 11b DA defaults for Region refinement (hex-dominant only).
# Length is SI meters. Persist-only — do NOT invent snappy levels /
# refinementRegions from Maximum edge length, and do NOT invent
# Background Mesh Box / Level onto Hex (those are parametric 11a).
HEX_REGION_DEFAULT_MAX_EDGE_LENGTH = 1.0

# Inc 12a DA defaults for Bounding box layer addition (hex-dominant-parametric only).
# Persist Face/layers/thicknesses; mesher write only if a real BB-layer path exists ?
# do NOT invent by copying Inflate addLayers. Face combo = six BB faces (default Min X).
# UI label is "Final thickness" (not "Final layer thickness").
BB_LAYER_TYPE = "bounding_box_layer_addition"
BB_LAYER_FACE_ITEMS = ("Min X", "Max X", "Min Y", "Max Y", "Min Z", "Max Z")
BB_LAYER_DEFAULT_FACE = "Min X"
BB_LAYER_DEFAULT_LAYERS = 5
BB_LAYER_DEFAULT_EXPANSION_RATIO = 1.3
BB_LAYER_DEFAULT_MIN_THICKNESS = 0.01
BB_LAYER_DEFAULT_FINAL_THICKNESS = 0.3


# Inc 13a/15a DA defaults for Extrusion mesh refinement (Standard only).
# Persist-only — do NOT invent OpenFOAM/snappy/cfMesh extrusion write.
# Element thickness mode: show Thickness 0.1 m.
# Number of elements mode: show Number of elements 10; hide Thickness.
# Inc 15a On-toggles (persist-only; Off hides On fields):
#   Specify start/end On → Maximum edge length 0.1 m
#   Enable Grading On → First element thickness 0.01, Growth rate 1.2,
#   Side Start face | End face | Both (default Both).
EXTRUSION_TYPE = "extrusion_mesh_refinement"
EXTRUSION_SWEEP_ELEMENT_THICKNESS = "Element thickness along sweep"
EXTRUSION_SWEEP_NUMBER_OF_ELEMENTS = "Number of elements along sweep"
EXTRUSION_SWEEP_SIZING_ITEMS = (
    EXTRUSION_SWEEP_ELEMENT_THICKNESS,
    EXTRUSION_SWEEP_NUMBER_OF_ELEMENTS,
)
EXTRUSION_DEFAULT_SWEEP_SIZING = EXTRUSION_SWEEP_ELEMENT_THICKNESS
EXTRUSION_DEFAULT_THICKNESS = 0.1  # metres; Element thickness mode
EXTRUSION_DEFAULT_NUMBER_OF_ELEMENTS = 10  # Number of elements mode (still)
EXTRUSION_SURFACE_TRIANGULAR = "Triangular"
EXTRUSION_SURFACE_QUAD_DOMINANT = "Quad dominant"
EXTRUSION_SURFACE_ELEMENT_ITEMS = (
    EXTRUSION_SURFACE_TRIANGULAR,
    EXTRUSION_SURFACE_QUAD_DOMINANT,
)
EXTRUSION_DEFAULT_SURFACE_ELEMENT = EXTRUSION_SURFACE_TRIANGULAR
EXTRUSION_DEFAULT_SPECIFY_START_END_MESH_SIZE = "Off"
EXTRUSION_DEFAULT_ENABLE_GRADING = "Off"
EXTRUSION_OFF_ON_ITEMS = ("Off", "On")
# Inc 15a On-toggle defaults (shown only when parent toggle is On).
EXTRUSION_DEFAULT_MAXIMUM_EDGE_LENGTH = 0.1  # metres; Specify start/end On
EXTRUSION_DEFAULT_FIRST_ELEMENT_THICKNESS = 0.01  # Enable Grading On
EXTRUSION_DEFAULT_GROWTH_RATE = 1.2  # Enable Grading On
EXTRUSION_SIDE_START_FACE = "Start face"
EXTRUSION_SIDE_END_FACE = "End face"
EXTRUSION_SIDE_BOTH = "Both"
EXTRUSION_SIDE_ITEMS = (
    EXTRUSION_SIDE_START_FACE,
    EXTRUSION_SIDE_END_FACE,
    EXTRUSION_SIDE_BOTH,
)  # DA Side amend: Start face | End face | Both, default Both
EXTRUSION_DEFAULT_SIDE = EXTRUSION_SIDE_BOTH


def menu_labels_for_algorithm(algorithm: str | None) -> list[str]:
    """Return exact SimScale labels for the Refinements `+` menu."""
    algo = str(algorithm or "standard").strip() or "standard"
    if algo not in REFINEMENT_MENU_BY_ALGORITHM:
        algo = "standard"
    return [REFINEMENT_TYPE_LABELS[k] for k in REFINEMENT_MENU_BY_ALGORITHM[algo]]


def menu_entries_for_algorithm(algorithm: str | None) -> list[tuple[str, str]]:
    """Return `(type_key, label)` pairs for the Refinements `+` menu."""
    algo = str(algorithm or "standard").strip() or "standard"
    if algo not in REFINEMENT_MENU_BY_ALGORITHM:
        algo = "standard"
    return [
        (k, REFINEMENT_TYPE_LABELS[k]) for k in REFINEMENT_MENU_BY_ALGORITHM[algo]
    ]


def label_for_type(type_key: str) -> str:
    return REFINEMENT_TYPE_LABELS.get(type_key, type_key.replace("_", " ").title())


def is_parametric_inflate(type_key: str, algorithm: str | None) -> bool:
    """True when Inflate form/write applies (Hex-dominant parametric only)."""
    return (
        str(type_key) == INFLATE_TYPE
        and str(algorithm or "").strip() == "hex-dominant-parametric"
    )


def is_hex_inflate(type_key: str, algorithm: str | None) -> bool:
    """True when Hex-dominant Inflate form/write applies (Inc 7c)."""
    return (
        str(type_key) == INFLATE_TYPE
        and str(algorithm or "").strip() == "hex-dominant"
    )


def is_standard_inflate(type_key: str, algorithm: str | None) -> bool:
    """True when Standard Inflate form applies (Inc 7d, persist-only)."""
    return (
        str(type_key) == INFLATE_TYPE
        and str(algorithm or "").strip() == "standard"
    )


def is_configured_inflate(type_key: str, algorithm: str | None) -> bool:
    """True when any configured Inflate form applies (7b/7c/7d)."""
    return (
        is_parametric_inflate(type_key, algorithm)
        or is_hex_inflate(type_key, algorithm)
        or is_standard_inflate(type_key, algorithm)
    )


def is_parametric_surface_refinement(type_key: str, algorithm: str | None) -> bool:
    """True when parametric Surface refinement form/write applies (Inc 8a)."""
    return (
        str(type_key) == SURFACE_REFINEMENT_TYPE
        and str(algorithm or "").strip() == "hex-dominant-parametric"
    )


def is_hex_surface_refinement(type_key: str, algorithm: str | None) -> bool:
    """True when Hex-dominant Surface refinement form applies (Inc 8b)."""
    return (
        str(type_key) == SURFACE_REFINEMENT_TYPE
        and str(algorithm or "").strip() == "hex-dominant"
    )


def is_configured_surface_refinement(type_key: str, algorithm: str | None) -> bool:
    """True when any configured Surface form applies (8a parametric or 8b hex)."""
    return is_parametric_surface_refinement(
        type_key, algorithm
    ) or is_hex_surface_refinement(type_key, algorithm)


def is_parametric_feature_refinement(type_key: str, algorithm: str | None) -> bool:
    """True when parametric Feature refinement form applies (Inc 9a)."""
    return (
        str(type_key) == FEATURE_REFINEMENT_TYPE
        and str(algorithm or "").strip() == "hex-dominant-parametric"
    )


def is_hex_feature_refinement(type_key: str, algorithm: str | None) -> bool:
    """True when Hex-dominant Feature refinement form applies (Inc 9b)."""
    return (
        str(type_key) == FEATURE_REFINEMENT_TYPE
        and str(algorithm or "").strip() == "hex-dominant"
    )


def is_configured_feature_refinement(type_key: str, algorithm: str | None) -> bool:
    """True when any configured Feature form applies (9a parametric or 9b hex)."""
    return is_parametric_feature_refinement(
        type_key, algorithm
    ) or is_hex_feature_refinement(type_key, algorithm)


def is_standard_surface_custom_sizing(type_key: str, algorithm: str | None) -> bool:
    """True when Standard Surface custom sizing form applies (Inc 10a)."""
    return (
        str(type_key) == SURFACE_CUSTOM_SIZING_TYPE
        and str(algorithm or "").strip() == "standard"
    )


def is_standard_volume_custom_sizing(type_key: str, algorithm: str | None) -> bool:
    """True when Standard Volume custom sizing form applies (Inc 10b)."""
    return (
        str(type_key) == VOLUME_CUSTOM_SIZING_TYPE
        and str(algorithm or "").strip() == "standard"
    )


def is_parametric_region_refinement(type_key: str, algorithm: str | None) -> bool:
    """True when parametric Region refinement form applies (Inc 11a)."""
    return (
        str(type_key) == REGION_REFINEMENT_TYPE
        and str(algorithm or "").strip() == "hex-dominant-parametric"
    )


def is_hex_region_refinement(type_key: str, algorithm: str | None) -> bool:
    """True when Hex-dominant Region refinement form applies (Inc 11b)."""
    return (
        str(type_key) == REGION_REFINEMENT_TYPE
        and str(algorithm or "").strip() == "hex-dominant"
    )


def is_parametric_bb_layer(type_key: str, algorithm: str | None) -> bool:
    """True when parametric Bounding box layer addition form applies (Inc 12a)."""
    return (
        str(type_key) == BB_LAYER_TYPE
        and str(algorithm or "").strip() == "hex-dominant-parametric"
    )



def is_standard_extrusion(type_key: str, algorithm: str | None) -> bool:
    """True when Standard Extrusion mesh refinement form applies (Inc 13a)."""
    return (
        str(type_key) == EXTRUSION_TYPE
        and str(algorithm or "").strip() == "standard"
    )


def is_configured_refinement(type_key: str, algorithm: str | None) -> bool:
    """True when a configured refinement form applies (…/11a/11b/12a/13a)."""
    return (
        is_configured_inflate(type_key, algorithm)
        or is_configured_surface_refinement(type_key, algorithm)
        or is_configured_feature_refinement(type_key, algorithm)
        or is_standard_surface_custom_sizing(type_key, algorithm)
        or is_standard_volume_custom_sizing(type_key, algorithm)
        or is_parametric_region_refinement(type_key, algorithm)
        or is_hex_region_refinement(type_key, algorithm)
        or is_parametric_bb_layer(type_key, algorithm)
        or is_standard_extrusion(type_key, algorithm)
    )


@dataclass
class MeshRefinementStub:
    """Named child under Mesh → Refinements.

    Inc 7a: type+name for all algorithms.
    Inc 7b: Inflate numeric fields + face_ids for parametric inflate.
    Inc 7c: Hex-dominant Inflate uses surface_layer_relative_thickness
    (not final_layer_thickness) with min thickness default 0.
    Inc 7d: Standard Inflate uses layer_gradation_control, layers as
    Number of layers, overall_relative_thickness, expansion_ratio as
    Growth rate (UI + persist only; no mesher write invent).
    Inc 8a: Surface refinement (parametric): min/max level, cell_zone,
    face_ids and/or volume_ids (Assigned Faces or Volumes).
    Inc 8b: Surface refinement (hex-dominant): min/max length (m), cell_zone,
    face_ids and/or volume_ids (persist-only; no snappy level invent).
    Inc 9a: Feature refinement (parametric): included_angle + distance_levels
    table (distance m / level). No Assigned Faces / Max edge length.
    Inc 9b: Feature refinement (hex-dominant): distance_lengths table
    (distance m / max_edge_length m) + face_ids/volume_ids. Persist-only;
    no Included angle / Level / snappy features.levels invent.
    
    Inc 10a: Surface custom sizing (standard): sizing, fineness, curvature,
    face_ids. Persist-only; no snappy/cfMesh invent from Fineness.
    Inc 10b: Volume custom sizing (standard): sizing_mode, sizing, fineness,
    curvature, volume_ids, refinement_regions (empty list only). Persist-only;
    no snappy/cfMesh invent from Fineness; no region-row field invent.
    Inc 11a: Region refinement (parametric): mode (Inside), level (1),
    volume_ids, geometry_primitives (empty list only), background_mesh_box
    (off). Persist Level; snappy refinementRegions write only if mapped —
    no invent from CAD volumes / empty primitives this slice.
    Inc 11b: Region refinement (hex-dominant): mode (Inside),
    max_edge_length (1 m), volume_ids, geometry_primitives (empty list only).
    Persist-only; do NOT invent Level / Background Mesh Box onto Hex;
    do NOT invent snappy levels / refinementRegions from max edge length.
    Inc 12a: Bounding box layer addition (parametric): bb_face (Min X/Max X/Min Y/Max Y/Min Z/Max Z, default Min X),
    layers (5), expansion_ratio (1.3), min_thickness (0.01),
    final_thickness (0.3). Persist; write only if a real BB-layer path
    exists ? do NOT invent by copying Inflate addLayers. Face combo is
    the six BB faces. UI label Final thickness (not
    Final layer thickness).
    Inc 13a/15a: Extrusion mesh refinement (standard): sweep_sizing_type
    (Element thickness along sweep default), thickness (0.1 m) OR
    number_of_elements (10) by mode, surface_element_type (Triangular),
    specify_start_end_mesh_size (Off), enable_grading (Off),
    start_face_ids + end_face_ids (both required).
    Inc 15a On fields (persist-only): max_edge_length (Maximum edge length
    0.1 m when Specify On), first_element_thickness (0.01), growth_rate
    (1.2), side (Start face | End face | Both, default Both) when Enable Grading On. Do NOT invent
    OpenFOAM/snappy/cfMesh extrusion write.
    """

    id: str
    type: str  # stable type key
    name: str  # display name (label, numbered on duplicates)
    layers: int = INFLATE_DEFAULT_LAYERS
    expansion_ratio: float = INFLATE_DEFAULT_EXPANSION_RATIO
    min_thickness: float = INFLATE_DEFAULT_MIN_THICKNESS
    final_layer_thickness: float = INFLATE_DEFAULT_FINAL_LAYER_THICKNESS
    surface_layer_relative_thickness: float = (
        HEX_INFLATE_DEFAULT_SURFACE_LAYER_RELATIVE_THICKNESS
    )
    layer_gradation_control: str = STD_INFLATE_DEFAULT_LAYER_GRADATION
    overall_relative_thickness: float = STD_INFLATE_DEFAULT_OVERALL_RELATIVE_THICKNESS
    face_ids: list[int] = field(default_factory=list)
    min_level: int = SURFACE_DEFAULT_MIN_LEVEL
    max_level: int = SURFACE_DEFAULT_MAX_LEVEL
    cell_zone: str = SURFACE_DEFAULT_CELL_ZONE
    volume_ids: list[str] = field(default_factory=list)
    min_length: float = HEX_SURFACE_DEFAULT_MIN_LENGTH
    max_length: float = HEX_SURFACE_DEFAULT_MAX_LENGTH
    included_angle: float = FEATURE_DEFAULT_INCLUDED_ANGLE
    distance_levels: list[dict[str, float | int]] = field(
        default_factory=lambda: [
            {"distance": float(r["distance"]), "level": int(r["level"])}
            for r in FEATURE_DEFAULT_DISTANCE_LEVELS
        ]
    )
    distance_lengths: list[dict[str, float]] = field(
        default_factory=lambda: [
            {
                "distance": float(r["distance"]),
                "max_edge_length": float(r["max_edge_length"]),
            }
            for r in HEX_FEATURE_DEFAULT_DISTANCE_LENGTHS
        ]
    )
    sizing: str = STD_SURFACE_SIZING_DEFAULT
    fineness: int = STD_SURFACE_FINENESS_DEFAULT
    curvature: str = STD_SURFACE_CURVATURE_DEFAULT
    sizing_mode: str = STD_VOLUME_SIZING_MODE_DEFAULT
    refinement_regions: list[dict[str, Any]] = field(default_factory=list)
    mode: str = REGION_DEFAULT_MODE
    level: int = REGION_DEFAULT_LEVEL
    max_edge_length: float = HEX_REGION_DEFAULT_MAX_EDGE_LENGTH
    geometry_primitives: list[dict[str, Any]] = field(default_factory=list)
    background_mesh_box: bool = REGION_DEFAULT_BACKGROUND_MESH_BOX
    bb_face: str = BB_LAYER_DEFAULT_FACE
    final_thickness: float = BB_LAYER_DEFAULT_FINAL_THICKNESS
    sweep_sizing_type: str = EXTRUSION_DEFAULT_SWEEP_SIZING
    thickness: float = EXTRUSION_DEFAULT_THICKNESS
    number_of_elements: int = EXTRUSION_DEFAULT_NUMBER_OF_ELEMENTS
    surface_element_type: str = EXTRUSION_DEFAULT_SURFACE_ELEMENT
    specify_start_end_mesh_size: str = EXTRUSION_DEFAULT_SPECIFY_START_END_MESH_SIZE
    enable_grading: str = EXTRUSION_DEFAULT_ENABLE_GRADING
    # Inc 15a On-toggle fields (defaults always stored; UI shows when On).
    # max_edge_length reused as Maximum edge length (extrusion default 0.1).
    first_element_thickness: float = EXTRUSION_DEFAULT_FIRST_ELEMENT_THICKNESS
    growth_rate: float = EXTRUSION_DEFAULT_GROWTH_RATE
    side: str = EXTRUSION_DEFAULT_SIDE
    start_face_ids: list[int] = field(default_factory=list)
    end_face_ids: list[int] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"id": self.id, "type": self.type, "name": self.name}
        if self.type == INFLATE_TYPE:
            d["layers"] = int(self.layers)
            d["expansion_ratio"] = float(self.expansion_ratio)
            d["min_thickness"] = float(self.min_thickness)
            d["final_layer_thickness"] = float(self.final_layer_thickness)
            d["surface_layer_relative_thickness"] = float(
                self.surface_layer_relative_thickness
            )
            d["layer_gradation_control"] = str(self.layer_gradation_control)
            d["overall_relative_thickness"] = float(self.overall_relative_thickness)
            d["face_ids"] = [int(x) for x in self.face_ids]
        if self.type == SURFACE_REFINEMENT_TYPE:
            d["min_level"] = int(self.min_level)
            d["max_level"] = int(self.max_level)
            d["min_length"] = float(self.min_length)
            d["max_length"] = float(self.max_length)
            d["cell_zone"] = str(self.cell_zone)
            d["face_ids"] = [int(x) for x in self.face_ids]
            d["volume_ids"] = [str(x) for x in self.volume_ids]
        if self.type == FEATURE_REFINEMENT_TYPE:
            d["included_angle"] = float(self.included_angle)
            d["distance_levels"] = [
                {
                    "distance": float(r.get("distance", 0.0)),
                    "level": int(r.get("level", 0)),
                }
                for r in (self.distance_levels or [])
            ]
            d["distance_lengths"] = [
                {
                    "distance": float(r.get("distance", 0.0)),
                    "max_edge_length": float(r.get("max_edge_length", 0.0)),
                }
                for r in (self.distance_lengths or [])
            ]
            d["face_ids"] = [int(x) for x in self.face_ids]
            d["volume_ids"] = [str(x) for x in self.volume_ids]
        if self.type == SURFACE_CUSTOM_SIZING_TYPE:
            d["sizing"] = str(self.sizing)
            d["fineness"] = int(self.fineness)
            d["curvature"] = str(self.curvature)
            d["face_ids"] = [int(x) for x in self.face_ids]
        if self.type == VOLUME_CUSTOM_SIZING_TYPE:
            d["sizing_mode"] = str(self.sizing_mode)
            d["sizing"] = str(self.sizing)
            d["fineness"] = int(self.fineness)
            d["curvature"] = str(self.curvature)
            d["volume_ids"] = [str(x) for x in self.volume_ids]
            # Empty list only this slice — do not invent region-row fields.
            d["refinement_regions"] = [
                dict(r) for r in (self.refinement_regions or []) if isinstance(r, dict)
            ]
        if self.type == REGION_REFINEMENT_TYPE:
            d["mode"] = str(self.mode)
            d["level"] = int(self.level)
            d["max_edge_length"] = float(self.max_edge_length)
            d["volume_ids"] = [str(x) for x in self.volume_ids]
            # Empty list only this slice — do not invent primitive-row fields.
            d["geometry_primitives"] = [
                dict(r) for r in (self.geometry_primitives or []) if isinstance(r, dict)
            ]
            d["background_mesh_box"] = bool(self.background_mesh_box)
        if self.type == BB_LAYER_TYPE:
            d["face"] = str(self.bb_face)
            d["layers"] = int(self.layers)
            d["expansion_ratio"] = float(self.expansion_ratio)
            d["min_thickness"] = float(self.min_thickness)
            # Persist key matches DA / UI label "Final thickness".
            d["final_thickness"] = float(self.final_thickness)
        if self.type == EXTRUSION_TYPE:
            d["sweep_sizing_type"] = str(self.sweep_sizing_type)
            d["thickness"] = float(self.thickness)
            d["number_of_elements"] = int(self.number_of_elements)
            d["surface_element_type"] = str(self.surface_element_type)
            d["specify_start_end_mesh_size"] = str(self.specify_start_end_mesh_size)
            d["enable_grading"] = str(self.enable_grading)
            # Inc 15a On-toggle persist (Maximum edge length / grading).
            d["max_edge_length"] = float(self.max_edge_length)
            d["first_element_thickness"] = float(self.first_element_thickness)
            d["growth_rate"] = float(self.growth_rate)
            d["side"] = str(self.side)
            d["start_face_ids"] = [int(x) for x in self.start_face_ids]
            d["end_face_ids"] = [int(x) for x in self.end_face_ids]
        return d

    @staticmethod
    def from_dict(data: dict | None) -> MeshRefinementStub | None:
        if not data:
            return None
        type_key = str(data.get("type") or "").strip()
        name = str(data.get("name") or "").strip()
        if not type_key or not name:
            return None
        face_raw = data.get("face_ids") or []
        face_ids: list[int] = []
        if isinstance(face_raw, list):
            for x in face_raw:
                try:
                    face_ids.append(int(x))
                except (TypeError, ValueError):
                    continue
        vol_raw = data.get("volume_ids") or []
        volume_ids: list[str] = []
        if isinstance(vol_raw, list):
            for x in vol_raw:
                s = str(x).strip()
                if s:
                    volume_ids.append(s)
        grad = str(
            data.get("layer_gradation_control", STD_INFLATE_DEFAULT_LAYER_GRADATION)
            or STD_INFLATE_DEFAULT_LAYER_GRADATION
        ).strip() or STD_INFLATE_DEFAULT_LAYER_GRADATION
        cell_zone = str(
            data.get("cell_zone", SURFACE_DEFAULT_CELL_ZONE)
            or SURFACE_DEFAULT_CELL_ZONE
        ).strip() or SURFACE_DEFAULT_CELL_ZONE
        dist_raw = data.get("distance_levels")
        distance_levels: list[dict[str, float | int]] = []
        if isinstance(dist_raw, list) and dist_raw:
            for item in dist_raw:
                if not isinstance(item, dict):
                    continue
                try:
                    distance_levels.append(
                        {
                            "distance": float(item.get("distance", 0.0)),
                            "level": int(item.get("level", 0)),
                        }
                    )
                except (TypeError, ValueError):
                    continue
        if not distance_levels:
            distance_levels = [
                {
                    "distance": float(r["distance"]),
                    "level": int(r["level"]),
                }
                for r in FEATURE_DEFAULT_DISTANCE_LEVELS
            ]
        len_raw = data.get("distance_lengths")
        distance_lengths: list[dict[str, float]] = []
        if isinstance(len_raw, list) and len_raw:
            for item in len_raw:
                if not isinstance(item, dict):
                    continue
                try:
                    distance_lengths.append(
                        {
                            "distance": float(item.get("distance", 0.0)),
                            "max_edge_length": float(
                                item.get("max_edge_length", 0.0)
                            ),
                        }
                    )
                except (TypeError, ValueError):
                    continue
        if not distance_lengths:
            distance_lengths = [
                {
                    "distance": float(r["distance"]),
                    "max_edge_length": float(r["max_edge_length"]),
                }
                for r in HEX_FEATURE_DEFAULT_DISTANCE_LENGTHS
            ]
        sizing = str(
            data.get("sizing", STD_SURFACE_SIZING_DEFAULT)
            or STD_SURFACE_SIZING_DEFAULT
        ).strip() or STD_SURFACE_SIZING_DEFAULT
        curvature = str(
            data.get("curvature", STD_SURFACE_CURVATURE_DEFAULT)
            or STD_SURFACE_CURVATURE_DEFAULT
        ).strip() or STD_SURFACE_CURVATURE_DEFAULT
        sizing_mode = str(
            data.get("sizing_mode", STD_VOLUME_SIZING_MODE_DEFAULT)
            or STD_VOLUME_SIZING_MODE_DEFAULT
        ).strip() or STD_VOLUME_SIZING_MODE_DEFAULT
        rr_raw = data.get("refinement_regions")
        refinement_regions: list[dict[str, Any]] = []
        if isinstance(rr_raw, list):
            for item in rr_raw:
                if isinstance(item, dict):
                    # Persist opaque dicts only — no region-row field invent.
                    refinement_regions.append(dict(item))
        mode = str(
            data.get("mode", REGION_DEFAULT_MODE) or REGION_DEFAULT_MODE
        ).strip() or REGION_DEFAULT_MODE
        gp_raw = data.get("geometry_primitives")
        geometry_primitives: list[dict[str, Any]] = []
        if isinstance(gp_raw, list):
            for item in gp_raw:
                if isinstance(item, dict):
                    # Persist opaque dicts only — no primitive-row field invent.
                    geometry_primitives.append(dict(item))
        bg_raw = data.get("background_mesh_box", REGION_DEFAULT_BACKGROUND_MESH_BOX)
        if isinstance(bg_raw, str):
            background_mesh_box = bg_raw.strip().lower() in ("1", "true", "yes", "on")
        else:
            background_mesh_box = bool(bg_raw)
        bb_face = str(
            data.get("face", data.get("bb_face", BB_LAYER_DEFAULT_FACE))
            or BB_LAYER_DEFAULT_FACE
        ).strip() or BB_LAYER_DEFAULT_FACE
        if bb_face not in BB_LAYER_FACE_ITEMS:
            bb_face = BB_LAYER_DEFAULT_FACE
        # Accept legacy key if present; prefer final_thickness (DA label).
        if "final_thickness" in data:
            final_thickness = float(data.get("final_thickness"))
        else:
            final_thickness = float(
                data.get("final_thickness", BB_LAYER_DEFAULT_FINAL_THICKNESS)
            )
        sweep_sizing_type = str(
            data.get("sweep_sizing_type", EXTRUSION_DEFAULT_SWEEP_SIZING)
            or EXTRUSION_DEFAULT_SWEEP_SIZING
        ).strip() or EXTRUSION_DEFAULT_SWEEP_SIZING
        if sweep_sizing_type not in EXTRUSION_SWEEP_SIZING_ITEMS:
            sweep_sizing_type = EXTRUSION_DEFAULT_SWEEP_SIZING
        surface_element_type = str(
            data.get("surface_element_type", EXTRUSION_DEFAULT_SURFACE_ELEMENT)
            or EXTRUSION_DEFAULT_SURFACE_ELEMENT
        ).strip() or EXTRUSION_DEFAULT_SURFACE_ELEMENT
        if surface_element_type not in EXTRUSION_SURFACE_ELEMENT_ITEMS:
            surface_element_type = EXTRUSION_DEFAULT_SURFACE_ELEMENT
        specify_start_end_mesh_size = str(
            data.get(
                "specify_start_end_mesh_size",
                EXTRUSION_DEFAULT_SPECIFY_START_END_MESH_SIZE,
            )
            or EXTRUSION_DEFAULT_SPECIFY_START_END_MESH_SIZE
        ).strip() or EXTRUSION_DEFAULT_SPECIFY_START_END_MESH_SIZE
        if specify_start_end_mesh_size not in EXTRUSION_OFF_ON_ITEMS:
            specify_start_end_mesh_size = EXTRUSION_DEFAULT_SPECIFY_START_END_MESH_SIZE
        enable_grading = str(
            data.get("enable_grading", EXTRUSION_DEFAULT_ENABLE_GRADING)
            or EXTRUSION_DEFAULT_ENABLE_GRADING
        ).strip() or EXTRUSION_DEFAULT_ENABLE_GRADING
        if enable_grading not in EXTRUSION_OFF_ON_ITEMS:
            enable_grading = EXTRUSION_DEFAULT_ENABLE_GRADING
        side = str(
            data.get("side", EXTRUSION_DEFAULT_SIDE) or EXTRUSION_DEFAULT_SIDE
        ).strip() or EXTRUSION_DEFAULT_SIDE
        if side not in EXTRUSION_SIDE_ITEMS:
            # Unknown Side -> Both (exact DA labels only; no invent).
            side = EXTRUSION_DEFAULT_SIDE

        def _parse_id_list(key: str) -> list[int]:
            raw = data.get(key) or []
            out: list[int] = []
            if isinstance(raw, list):
                for x in raw:
                    try:
                        out.append(int(x))
                    except (TypeError, ValueError):
                        continue
            return out

        start_face_ids = _parse_id_list("start_face_ids")
        end_face_ids = _parse_id_list("end_face_ids")
        return MeshRefinementStub(
            id=str(data.get("id") or _new_id()),
            type=type_key,
            name=name,
            layers=max(0, int(data.get("layers", INFLATE_DEFAULT_LAYERS))),
            expansion_ratio=float(
                data.get("expansion_ratio", INFLATE_DEFAULT_EXPANSION_RATIO)
            ),
            min_thickness=float(
                data.get("min_thickness", INFLATE_DEFAULT_MIN_THICKNESS)
            ),
            final_layer_thickness=float(
                data.get(
                    "final_layer_thickness",
                    INFLATE_DEFAULT_FINAL_LAYER_THICKNESS,
                )
            ),
            surface_layer_relative_thickness=float(
                data.get(
                    "surface_layer_relative_thickness",
                    HEX_INFLATE_DEFAULT_SURFACE_LAYER_RELATIVE_THICKNESS,
                )
            ),
            layer_gradation_control=grad,
            overall_relative_thickness=float(
                data.get(
                    "overall_relative_thickness",
                    STD_INFLATE_DEFAULT_OVERALL_RELATIVE_THICKNESS,
                )
            ),
            face_ids=face_ids,
            min_level=max(0, int(data.get("min_level", SURFACE_DEFAULT_MIN_LEVEL))),
            max_level=max(0, int(data.get("max_level", SURFACE_DEFAULT_MAX_LEVEL))),
            cell_zone=cell_zone,
            volume_ids=volume_ids,
            min_length=float(
                data.get("min_length", HEX_SURFACE_DEFAULT_MIN_LENGTH)
            ),
            max_length=float(
                data.get("max_length", HEX_SURFACE_DEFAULT_MAX_LENGTH)
            ),
            included_angle=float(
                data.get("included_angle", FEATURE_DEFAULT_INCLUDED_ANGLE)
            ),
            distance_levels=distance_levels,
            distance_lengths=distance_lengths,
            sizing=sizing,
            fineness=max(
                1,
                min(10, int(data.get("fineness", STD_SURFACE_FINENESS_DEFAULT))),
            ),
            curvature=curvature,
            sizing_mode=sizing_mode,
            refinement_regions=refinement_regions,
            mode=mode,
            level=max(0, int(data.get("level", REGION_DEFAULT_LEVEL))),
            max_edge_length=float(
                data.get(
                    "max_edge_length",
                    EXTRUSION_DEFAULT_MAXIMUM_EDGE_LENGTH
                    if type_key == EXTRUSION_TYPE
                    else HEX_REGION_DEFAULT_MAX_EDGE_LENGTH,
                )
            ),
            geometry_primitives=geometry_primitives,
            background_mesh_box=background_mesh_box,
            bb_face=bb_face,
            final_thickness=final_thickness,
            sweep_sizing_type=sweep_sizing_type,
            thickness=float(
                data.get("thickness", EXTRUSION_DEFAULT_THICKNESS)
            ),
            number_of_elements=max(
                1,
                int(
                    data.get(
                        "number_of_elements",
                        EXTRUSION_DEFAULT_NUMBER_OF_ELEMENTS,
                    )
                ),
            ),
            surface_element_type=surface_element_type,
            specify_start_end_mesh_size=specify_start_end_mesh_size,
            enable_grading=enable_grading,
            first_element_thickness=float(
                data.get(
                    "first_element_thickness",
                    EXTRUSION_DEFAULT_FIRST_ELEMENT_THICKNESS,
                )
            ),
            growth_rate=float(
                data.get("growth_rate", EXTRUSION_DEFAULT_GROWTH_RATE)
            ),
            side=side,
            start_face_ids=start_face_ids,
            end_face_ids=end_face_ids,
        )

    def inflate_complete(self) -> bool:
        """Assigned Faces required — empty list is incomplete."""
        return self.type == INFLATE_TYPE and bool(self.face_ids)



    def surface_complete(self) -> bool:
        """Assigned Faces or Volumes required — both empty is incomplete."""
        return self.type == SURFACE_REFINEMENT_TYPE and (
            bool(self.face_ids) or bool(self.volume_ids)
        )

    def feature_complete(self) -> bool:
        """Parametric Feature needs at least one distance/level row (no faces)."""
        return self.type == FEATURE_REFINEMENT_TYPE and bool(self.distance_levels)

    def hex_feature_complete(self) -> bool:
        """Hex Feature requires Assigned Faces or Volumes (Inc 9b)."""
        return self.type == FEATURE_REFINEMENT_TYPE and (
            bool(self.face_ids) or bool(self.volume_ids)
        )

    def surface_custom_sizing_complete(self) -> bool:
        """Assigned Faces required — empty list is incomplete (Inc 10a)."""
        return self.type == SURFACE_CUSTOM_SIZING_TYPE and bool(self.face_ids)

    def volume_custom_sizing_complete(self) -> bool:
        """Assigned Volumes required — empty list is incomplete (Inc 10b)."""
        return self.type == VOLUME_CUSTOM_SIZING_TYPE and bool(self.volume_ids)

    def region_complete(self) -> bool:
        """Assigned Volumes required — empty list is incomplete (Inc 11a/11b)."""
        return self.type == REGION_REFINEMENT_TYPE and bool(self.volume_ids)

    def bb_layer_complete(self) -> bool:
        """Face from BB_LAYER_FACE_ITEMS (default Min X) ? complete when type matches (Inc 12a)."""
        return self.type == BB_LAYER_TYPE and bool(str(self.bb_face or "").strip())

    def extrusion_complete(self) -> bool:
        """Start faces AND End faces required — either empty is incomplete (Inc 13a)."""
        return (
            self.type == EXTRUSION_TYPE
            and bool(self.start_face_ids)
            and bool(self.end_face_ids)
        )


def next_refinement_display_name(
    existing_names: set[str] | list[str], base_label: str
) -> str:
    """`Surface refinement`, then `Surface refinement 2`, …"""
    existing = set(existing_names)
    if base_label not in existing:
        return base_label
    n = 2
    while f"{base_label} {n}" in existing:
        n += 1
    return f"{base_label} {n}"


def parse_refinement_stubs(raw: Any) -> list[MeshRefinementStub]:
    out: list[MeshRefinementStub] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if not isinstance(item, dict):
            continue
        stub = MeshRefinementStub.from_dict(item)
        if stub is not None:
            out.append(stub)
    return out


def inflate_fingerprint_payload(stubs: list[MeshRefinementStub]) -> list[dict[str, Any]]:
    """Stable payload for mesh fingerprint (configured inflate stubs)."""
    out: list[dict[str, Any]] = []
    for stub in stubs:
        if stub.type != INFLATE_TYPE:
            continue
        out.append(
            {
                "id": stub.id,
                "layers": int(stub.layers),
                "expansion_ratio": float(stub.expansion_ratio),
                "min_thickness": float(stub.min_thickness),
                "final_layer_thickness": float(stub.final_layer_thickness),
                "surface_layer_relative_thickness": float(
                    stub.surface_layer_relative_thickness
                ),
                "layer_gradation_control": str(stub.layer_gradation_control),
                "overall_relative_thickness": float(stub.overall_relative_thickness),
                "face_ids": sorted(int(x) for x in stub.face_ids),
            }
        )
    return out



def surface_refinement_fingerprint_payload(
    stubs: list[MeshRefinementStub],
) -> list[dict[str, Any]]:
    """Stable payload for mesh fingerprint (surface stubs, 8a levels + 8b lengths)."""
    out: list[dict[str, Any]] = []
    for stub in stubs:
        if stub.type != SURFACE_REFINEMENT_TYPE:
            continue
        out.append(
            {
                "id": stub.id,
                "min_level": int(stub.min_level),
                "max_level": int(stub.max_level),
                "min_length": float(stub.min_length),
                "max_length": float(stub.max_length),
                "cell_zone": str(stub.cell_zone),
                "face_ids": sorted(int(x) for x in stub.face_ids),
                "volume_ids": sorted(str(x) for x in stub.volume_ids),
            }
        )
    return out


def make_surface_refinement_stub(
    *,
    name: str,
    stub_id: str | None = None,
) -> MeshRefinementStub:
    """Create a Surface refinement stub with Inc 8a/8b DA defaults.

    Both level (8a) and length (8b) defaults are stored; the active algorithm
    selects which form fields are shown. Hex length write remains persist-only.
    """
    return MeshRefinementStub(
        id=stub_id or _new_id(),
        type=SURFACE_REFINEMENT_TYPE,
        name=name,
        min_level=SURFACE_DEFAULT_MIN_LEVEL,
        max_level=SURFACE_DEFAULT_MAX_LEVEL,
        min_length=HEX_SURFACE_DEFAULT_MIN_LENGTH,
        max_length=HEX_SURFACE_DEFAULT_MAX_LENGTH,
        cell_zone=SURFACE_DEFAULT_CELL_ZONE,
    )


def feature_refinement_fingerprint_payload(
    stubs: list[MeshRefinementStub],
) -> list[dict[str, Any]]:
    """Stable payload for mesh fingerprint (Feature stubs, 9a levels + 9b lengths)."""
    out: list[dict[str, Any]] = []
    for stub in stubs:
        if stub.type != FEATURE_REFINEMENT_TYPE:
            continue
        out.append(
            {
                "id": stub.id,
                "included_angle": float(stub.included_angle),
                "distance_levels": [
                    {
                        "distance": float(r.get("distance", 0.0)),
                        "level": int(r.get("level", 0)),
                    }
                    for r in (stub.distance_levels or [])
                ],
                "distance_lengths": [
                    {
                        "distance": float(r.get("distance", 0.0)),
                        "max_edge_length": float(r.get("max_edge_length", 0.0)),
                    }
                    for r in (stub.distance_lengths or [])
                ],
                "face_ids": sorted(int(x) for x in stub.face_ids),
                "volume_ids": sorted(str(x) for x in stub.volume_ids),
            }
        )
    return out


def make_feature_refinement_stub(
    *,
    name: str,
    stub_id: str | None = None,
) -> MeshRefinementStub:
    """Create a Feature refinement stub with Inc 9a/9b DA defaults.

    Both distance_levels (9a) and distance_lengths (9b) defaults are stored;
    the active algorithm selects which form fields are shown. Hex length write
    remains persist-only (no snappy features.levels invent from max edge).
    """
    return MeshRefinementStub(
        id=stub_id or _new_id(),
        type=FEATURE_REFINEMENT_TYPE,
        name=name,
        included_angle=FEATURE_DEFAULT_INCLUDED_ANGLE,
        distance_levels=[
            {"distance": float(r["distance"]), "level": int(r["level"])}
            for r in FEATURE_DEFAULT_DISTANCE_LEVELS
        ],
        distance_lengths=[
            {
                "distance": float(r["distance"]),
                "max_edge_length": float(r["max_edge_length"]),
            }
            for r in HEX_FEATURE_DEFAULT_DISTANCE_LENGTHS
        ],
    )


def surface_custom_sizing_fingerprint_payload(
    stubs: list[MeshRefinementStub],
) -> list[dict[str, Any]]:
    """Stable payload for mesh fingerprint (Standard Surface custom sizing)."""
    out: list[dict[str, Any]] = []
    for stub in stubs:
        if stub.type != SURFACE_CUSTOM_SIZING_TYPE:
            continue
        out.append(
            {
                "id": stub.id,
                "sizing": str(stub.sizing),
                "fineness": int(stub.fineness),
                "curvature": str(stub.curvature),
                "face_ids": sorted(int(x) for x in stub.face_ids),
            }
        )
    return out


def make_surface_custom_sizing_stub(
    *,
    name: str,
    stub_id: str | None = None,
) -> MeshRefinementStub:
    """Create a Surface custom sizing stub with Inc 10a DA defaults."""
    return MeshRefinementStub(
        id=stub_id or _new_id(),
        type=SURFACE_CUSTOM_SIZING_TYPE,
        name=name,
        sizing=STD_SURFACE_SIZING_DEFAULT,
        fineness=STD_SURFACE_FINENESS_DEFAULT,
        curvature=STD_SURFACE_CURVATURE_DEFAULT,
    )


def volume_custom_sizing_fingerprint_payload(
    stubs: list[MeshRefinementStub],
) -> list[dict[str, Any]]:
    """Stable payload for mesh fingerprint (Standard Volume custom sizing)."""
    out: list[dict[str, Any]] = []
    for stub in stubs:
        if stub.type != VOLUME_CUSTOM_SIZING_TYPE:
            continue
        out.append(
            {
                "id": stub.id,
                "sizing_mode": str(stub.sizing_mode),
                "sizing": str(stub.sizing),
                "fineness": int(stub.fineness),
                "curvature": str(stub.curvature),
                "volume_ids": sorted(str(x) for x in stub.volume_ids),
                "refinement_regions": list(stub.refinement_regions or []),
            }
        )
    return out


def make_volume_custom_sizing_stub(
    *,
    name: str,
    stub_id: str | None = None,
) -> MeshRefinementStub:
    """Create a Volume custom sizing stub with Inc 10b DA defaults."""
    return MeshRefinementStub(
        id=stub_id or _new_id(),
        type=VOLUME_CUSTOM_SIZING_TYPE,
        name=name,
        sizing_mode=STD_VOLUME_SIZING_MODE_DEFAULT,
        sizing=STD_VOLUME_SIZING_DEFAULT,
        fineness=STD_VOLUME_FINENESS_DEFAULT,
        curvature=STD_VOLUME_CURVATURE_DEFAULT,
        refinement_regions=[],
    )


def region_refinement_fingerprint_payload(
    stubs: list[MeshRefinementStub],
) -> list[dict[str, Any]]:
    """Stable payload for mesh fingerprint (Region stubs, 11a level + 11b length)."""
    out: list[dict[str, Any]] = []
    for stub in stubs:
        if stub.type != REGION_REFINEMENT_TYPE:
            continue
        out.append(
            {
                "id": stub.id,
                "mode": str(stub.mode),
                "level": int(stub.level),
                "max_edge_length": float(stub.max_edge_length),
                "volume_ids": sorted(str(x) for x in stub.volume_ids),
                "geometry_primitives": list(stub.geometry_primitives or []),
                "background_mesh_box": bool(stub.background_mesh_box),
            }
        )
    return out


def make_region_refinement_stub(
    *,
    name: str,
    stub_id: str | None = None,
) -> MeshRefinementStub:
    """Create a Region refinement stub with Inc 11a/11b DA defaults.

    Both level/background_mesh_box (11a) and max_edge_length (11b) defaults are
    stored; the active algorithm selects which form fields are shown. Hex length
    write remains persist-only (no snappy levels invent from max edge).
    """
    return MeshRefinementStub(
        id=stub_id or _new_id(),
        type=REGION_REFINEMENT_TYPE,
        name=name,
        mode=REGION_DEFAULT_MODE,
        level=REGION_DEFAULT_LEVEL,
        max_edge_length=HEX_REGION_DEFAULT_MAX_EDGE_LENGTH,
        geometry_primitives=[],
        background_mesh_box=REGION_DEFAULT_BACKGROUND_MESH_BOX,
    )


def bb_layer_fingerprint_payload(
    stubs: list[MeshRefinementStub],
) -> list[dict[str, Any]]:
    """Stable payload for mesh fingerprint (parametric BB layer stubs, Inc 12a)."""
    out: list[dict[str, Any]] = []
    for stub in stubs:
        if stub.type != BB_LAYER_TYPE:
            continue
        out.append(
            {
                "id": stub.id,
                "face": str(stub.bb_face),
                "layers": int(stub.layers),
                "expansion_ratio": float(stub.expansion_ratio),
                "min_thickness": float(stub.min_thickness),
                "final_thickness": float(stub.final_thickness),
            }
        )
    return out


def make_bb_layer_stub(
    *,
    name: str,
    stub_id: str | None = None,
) -> MeshRefinementStub:
    """Create a Bounding box layer addition stub with Inc 12a DA defaults."""
    return MeshRefinementStub(
        id=stub_id or _new_id(),
        type=BB_LAYER_TYPE,
        name=name,
        bb_face=BB_LAYER_DEFAULT_FACE,
        layers=BB_LAYER_DEFAULT_LAYERS,
        expansion_ratio=BB_LAYER_DEFAULT_EXPANSION_RATIO,
        min_thickness=BB_LAYER_DEFAULT_MIN_THICKNESS,
        final_thickness=BB_LAYER_DEFAULT_FINAL_THICKNESS,
    )


def extrusion_fingerprint_payload(
    stubs: list[MeshRefinementStub],
) -> list[dict[str, Any]]:
    """Stable payload for mesh fingerprint (Standard Extrusion stubs, Inc 13a/15a)."""
    out: list[dict[str, Any]] = []
    for stub in stubs:
        if stub.type != EXTRUSION_TYPE:
            continue
        out.append(
            {
                "id": stub.id,
                "sweep_sizing_type": str(stub.sweep_sizing_type),
                "thickness": float(stub.thickness),
                "number_of_elements": int(stub.number_of_elements),
                "surface_element_type": str(stub.surface_element_type),
                "specify_start_end_mesh_size": str(stub.specify_start_end_mesh_size),
                "enable_grading": str(stub.enable_grading),
                "max_edge_length": float(stub.max_edge_length),
                "first_element_thickness": float(stub.first_element_thickness),
                "growth_rate": float(stub.growth_rate),
                "side": str(stub.side),
                "start_face_ids": sorted(int(x) for x in stub.start_face_ids),
                "end_face_ids": sorted(int(x) for x in stub.end_face_ids),
            }
        )
    return out


def make_extrusion_stub(
    *,
    name: str,
    stub_id: str | None = None,
) -> MeshRefinementStub:
    """Create an Extrusion mesh refinement stub with Inc 13a/15a DA defaults."""
    return MeshRefinementStub(
        id=stub_id or _new_id(),
        type=EXTRUSION_TYPE,
        name=name,
        sweep_sizing_type=EXTRUSION_DEFAULT_SWEEP_SIZING,
        thickness=EXTRUSION_DEFAULT_THICKNESS,
        number_of_elements=EXTRUSION_DEFAULT_NUMBER_OF_ELEMENTS,
        surface_element_type=EXTRUSION_DEFAULT_SURFACE_ELEMENT,
        specify_start_end_mesh_size=EXTRUSION_DEFAULT_SPECIFY_START_END_MESH_SIZE,
        enable_grading=EXTRUSION_DEFAULT_ENABLE_GRADING,
        max_edge_length=EXTRUSION_DEFAULT_MAXIMUM_EDGE_LENGTH,
        first_element_thickness=EXTRUSION_DEFAULT_FIRST_ELEMENT_THICKNESS,
        growth_rate=EXTRUSION_DEFAULT_GROWTH_RATE,
        side=EXTRUSION_DEFAULT_SIDE,
        start_face_ids=[],
        end_face_ids=[],
    )


def make_inflate_stub(
    *,
    name: str,
    algorithm: str | None,
    stub_id: str | None = None,
) -> MeshRefinementStub:
    """Create an Inflate stub with algorithm-appropriate DA defaults."""
    algo = str(algorithm or "").strip()
    rid = stub_id or _new_id()
    if algo == "hex-dominant":
        return MeshRefinementStub(
            id=rid,
            type=INFLATE_TYPE,
            name=name,
            layers=HEX_INFLATE_DEFAULT_LAYERS,
            expansion_ratio=HEX_INFLATE_DEFAULT_EXPANSION_RATIO,
            min_thickness=HEX_INFLATE_DEFAULT_MIN_THICKNESS,
            surface_layer_relative_thickness=(
                HEX_INFLATE_DEFAULT_SURFACE_LAYER_RELATIVE_THICKNESS
            ),
            # final_layer_thickness kept at parametric default; unused by hex UI
            final_layer_thickness=INFLATE_DEFAULT_FINAL_LAYER_THICKNESS,
        )
    if algo == "standard":
        return MeshRefinementStub(
            id=rid,
            type=INFLATE_TYPE,
            name=name,
            layers=STD_INFLATE_DEFAULT_LAYERS,
            expansion_ratio=STD_INFLATE_DEFAULT_GROWTH_RATE,
            layer_gradation_control=STD_INFLATE_DEFAULT_LAYER_GRADATION,
            overall_relative_thickness=(
                STD_INFLATE_DEFAULT_OVERALL_RELATIVE_THICKNESS
            ),
            # parametric/hex-only fields kept at their defaults; unused by std UI
            min_thickness=INFLATE_DEFAULT_MIN_THICKNESS,
            final_layer_thickness=INFLATE_DEFAULT_FINAL_LAYER_THICKNESS,
            surface_layer_relative_thickness=(
                HEX_INFLATE_DEFAULT_SURFACE_LAYER_RELATIVE_THICKNESS
            ),
        )
    # Parametric uses 7b parametric defaults.
    return MeshRefinementStub(id=rid, type=INFLATE_TYPE, name=name)


# Re-export for type checkers / callers that want MeshAlgorithm literals.
__all__ = [
    "MeshRefinementStub",
    "REFINEMENT_MENU_BY_ALGORITHM",
    "REFINEMENT_TYPE_LABELS",
    "INFLATE_TYPE",
    "INFLATE_DEFAULT_LAYERS",
    "INFLATE_DEFAULT_EXPANSION_RATIO",
    "INFLATE_DEFAULT_MIN_THICKNESS",
    "INFLATE_DEFAULT_FINAL_LAYER_THICKNESS",
    "HEX_INFLATE_DEFAULT_LAYERS",
    "HEX_INFLATE_DEFAULT_EXPANSION_RATIO",
    "HEX_INFLATE_DEFAULT_MIN_THICKNESS",
    "HEX_INFLATE_DEFAULT_SURFACE_LAYER_RELATIVE_THICKNESS",
    "STD_INFLATE_DEFAULT_LAYER_GRADATION",
    "STD_INFLATE_DEFAULT_LAYERS",
    "STD_INFLATE_DEFAULT_OVERALL_RELATIVE_THICKNESS",
    "STD_INFLATE_DEFAULT_GROWTH_RATE",
    "SURFACE_REFINEMENT_TYPE",
    "SURFACE_DEFAULT_MIN_LEVEL",
    "SURFACE_DEFAULT_MAX_LEVEL",
    "SURFACE_DEFAULT_CELL_ZONE",
    "HEX_SURFACE_DEFAULT_MIN_LENGTH",
    "HEX_SURFACE_DEFAULT_MAX_LENGTH",
    "FEATURE_REFINEMENT_TYPE",
    "FEATURE_DEFAULT_INCLUDED_ANGLE",
    "FEATURE_DEFAULT_DISTANCE_LEVELS",
    "HEX_FEATURE_DEFAULT_DISTANCE_LENGTHS",
    "SURFACE_CUSTOM_SIZING_TYPE",
    "VOLUME_CUSTOM_SIZING_TYPE",
    "STD_SURFACE_SIZING_DEFAULT",
    "STD_SURFACE_FINENESS_DEFAULT",
    "STD_SURFACE_CURVATURE_DEFAULT",
    "STD_VOLUME_SIZING_MODE_DEFAULT",
    "STD_VOLUME_SIZING_DEFAULT",
    "STD_VOLUME_FINENESS_DEFAULT",
    "STD_VOLUME_CURVATURE_DEFAULT",
    "label_for_type",
    "is_parametric_inflate",
    "is_hex_inflate",
    "is_standard_inflate",
    "is_configured_inflate",
    "is_parametric_surface_refinement",
    "is_hex_surface_refinement",
    "is_configured_surface_refinement",
    "is_parametric_feature_refinement",
    "is_hex_feature_refinement",
    "is_configured_feature_refinement",
    "is_standard_surface_custom_sizing",
    "is_standard_volume_custom_sizing",
    "is_parametric_region_refinement",
    "is_hex_region_refinement",
    "is_parametric_bb_layer",
    "is_standard_extrusion",
    "is_configured_refinement",
    "REGION_REFINEMENT_TYPE",
    "REGION_DEFAULT_MODE",
    "REGION_DEFAULT_LEVEL",
    "REGION_DEFAULT_BACKGROUND_MESH_BOX",
    "HEX_REGION_DEFAULT_MAX_EDGE_LENGTH",
    "BB_LAYER_TYPE",
    "BB_LAYER_DEFAULT_FACE",
    "BB_LAYER_DEFAULT_LAYERS",
    "BB_LAYER_DEFAULT_EXPANSION_RATIO",
    "BB_LAYER_DEFAULT_MIN_THICKNESS",
    "BB_LAYER_DEFAULT_FINAL_THICKNESS",
    "EXTRUSION_TYPE",
    "EXTRUSION_SWEEP_ELEMENT_THICKNESS",
    "EXTRUSION_SWEEP_NUMBER_OF_ELEMENTS",
    "EXTRUSION_SWEEP_SIZING_ITEMS",
    "EXTRUSION_DEFAULT_SWEEP_SIZING",
    "EXTRUSION_DEFAULT_THICKNESS",
    "EXTRUSION_DEFAULT_NUMBER_OF_ELEMENTS",
    "EXTRUSION_SURFACE_TRIANGULAR",
    "EXTRUSION_SURFACE_QUAD_DOMINANT",
    "EXTRUSION_SURFACE_ELEMENT_ITEMS",
    "EXTRUSION_DEFAULT_SURFACE_ELEMENT",
    "EXTRUSION_DEFAULT_SPECIFY_START_END_MESH_SIZE",
    "EXTRUSION_DEFAULT_ENABLE_GRADING",
    "EXTRUSION_OFF_ON_ITEMS",
    "EXTRUSION_DEFAULT_MAXIMUM_EDGE_LENGTH",
    "EXTRUSION_DEFAULT_FIRST_ELEMENT_THICKNESS",
    "EXTRUSION_DEFAULT_GROWTH_RATE",
    "EXTRUSION_SIDE_START_FACE",
    "EXTRUSION_SIDE_END_FACE",
    "EXTRUSION_SIDE_BOTH",
    "EXTRUSION_SIDE_ITEMS",
    "EXTRUSION_DEFAULT_SIDE",
    "make_inflate_stub",
    "make_surface_refinement_stub",
    "make_feature_refinement_stub",
    "make_surface_custom_sizing_stub",
    "make_volume_custom_sizing_stub",
    "make_region_refinement_stub",
    "make_bb_layer_stub",
    "make_extrusion_stub",
    "menu_entries_for_algorithm",
    "menu_labels_for_algorithm",
    "next_refinement_display_name",
    "parse_refinement_stubs",
    "inflate_fingerprint_payload",
    "surface_refinement_fingerprint_payload",
    "feature_refinement_fingerprint_payload",
    "surface_custom_sizing_fingerprint_payload",
    "volume_custom_sizing_fingerprint_payload",
    "region_refinement_fingerprint_payload",
    "bb_layer_fingerprint_payload",
    "extrusion_fingerprint_payload",
    "MeshAlgorithm",
]
