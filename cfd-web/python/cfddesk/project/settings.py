"""Project-level mesh/boundary/solver/paths settings (Slice-2 schema v4).

Disk-usage note (Gate B0 measurement): Windows-local ``results/`` copy-back
costs ~411 MB per ~1M mesh cells, i.e. roughly ~4 GB Windows-local disk for a
single 10M-cell run. Not a Slice-2 blocker on its own, but it becomes a real
concern once parameter sweeps exist (many stored results trees) — revisit
local retention/cleanup policy at that point.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Literal

InletDirectionMode = Literal["normal", "vector"]
SolverBackend = Literal["cpu", "amgx"]
SolverEndCondition = Literal["residual", "iterations"]
SolverMode = Literal["steady", "transient"]
LocationSource = Literal["auto", "manual"]
SizingMode = Literal["automatic", "manual"]
# Hex-dominant = snappyHexMesh; Standard = gmsh BREP → gmshToFoam (Phase 5b).
MeshAlgorithm = Literal["hex-dominant", "hex-dominant-parametric", "standard"]
# cfmesh = cartesianMesh (bulk hex + poly skin). bodyfit = OCC surface +
# Cartesian flood + Delaunay peel (nodes on STEP faces). Default stays
# cfmesh until the body-fit gates pass on the user's mesh.
HexcoreBackend = Literal["cfmesh", "bodyfit"]
TurbulenceModel = Literal["laminar", "kEpsilon", "kOmegaSST", "LRR", "SSG"]
TURBULENCE_MODELS: tuple[TurbulenceModel, ...] = (
    "laminar",
    "kEpsilon",
    "kOmegaSST",
    "LRR",
    "SSG",
)


@dataclass
class MeshRefinement:
    """Per-role snappyHexMesh surface refinement levels."""

    inlet: int = 2
    outlet: int = 2
    walls: int = 1

    def to_dict(self) -> dict:
        return {"inlet": self.inlet, "outlet": self.outlet, "walls": self.walls}

    @staticmethod
    def from_dict(data: dict | None) -> MeshRefinement:
        if not data:
            return MeshRefinement()
        return MeshRefinement(
            inlet=int(data.get("inlet", 2)),
            outlet=int(data.get("outlet", 2)),
            walls=int(data.get("walls", 1)),
        )


# locationInMesh only needs to land inside the fluid; hashing raw float64 made
# sub-nm OCCT/bbox noise look like a mesh-input change. 1 nm on a ~1 m part.
LOCATION_FINGERPRINT_QUANTUM_M = 1e-9


def _parse_hexcore_backend(value: object) -> HexcoreBackend:
    raw = str(value or "cfmesh").strip().lower()
    if raw == "bodyfit":
        return "bodyfit"
    return "cfmesh"


def quantize_location_m(
    loc: tuple[float, ...] | list[float] | None,
    *,
    quantum_m: float = LOCATION_FINGERPRINT_QUANTUM_M,
) -> list[float] | None:
    """Round locationInMesh metres for fingerprint stability."""
    if loc is None:
        return None
    q = float(quantum_m)
    if q <= 0:
        raise ValueError("location fingerprint quantum must be > 0")
    return [round(float(c) / q) * q for c in loc]


@dataclass
class MeshSettings:
    """Mesh-generation controls persisted under each ``MeshNode.settings``."""

    base_cell_m: float = 0.025
    refinement: MeshRefinement = field(default_factory=MeshRefinement)
    location_in_mesh: tuple[float, float, float] | None = None
    location_source: LocationSource = "auto"
    min_cells_across_passage: float = 3.0
    # Target STL facet edge / finest cell on that role (export deflection).
    # Default 1/3 keeps snappy from inheriting CAD-as-prism faceting.
    stl_facet_to_cell_ratio: float = 1.0 / 3.0
    # Phase 5 / schema v13 — SimScale-aligned primary controls.
    fineness: int = 5
    sizing_mode: SizingMode = "automatic"
    physics_based: bool = True
    add_layers: bool = False
    max_meshing_runtime_s: float = 18_000.0
    # Phase 5b — Standard (gmsh BREP) is the default; Hex-dominant = snappy.
    # from_dict still defaults missing keys to hex-dominant so stamped legacy
    # projects do not look stale after upgrade.
    algorithm: MeshAlgorithm = "standard"
    # Standard only: cfMesh cartesianMesh (bulk hex + poly transition).
    # Off = all-tet gmsh. Ignored when algorithm != "standard".
    # Not the retired gmsh inscribed-box ~27-hex path.
    hex_element_core: bool = True
    # Ignored unless algorithm=standard and hex_element_core.
    hexcore_backend: HexcoreBackend = "cfmesh"
    # Hex-dominant parametric Level-0 UI fields (SimScale "Bounding box
    # resolution" labels). Inc 14a.2-ship: product Level-0 is geometry-derived
    # via the Hex helper at write time ? these defaults are 0 (auto), NOT the
    # old SimScale seed 67/62/24. Writer ignores stored values and recomputes.
    # Ignored for other algorithms.
    bbox_resolution_x: int = 0
    bbox_resolution_y: int = 0
    bbox_resolution_z: int = 0
    # Hex-dominant parametric only: snappy castellatedMeshControls (SimScale).
    # Ignored for Standard / Hex-dominant (those keep stock writer defaults).
    max_local_cells: int = 40_000_000
    max_global_cells: int = 100_000_000
    min_refinement_cells: int = 1
    max_load_unbalance: float = 0.2
    cells_between_levels: int = 3
    resolve_feature_angle: float = 30.0
    allow_free_standing_zone_faces: bool = False

    def to_dict(self) -> dict:
        return {
            "base_cell_m": self.base_cell_m,
            "refinement": self.refinement.to_dict(),
            "location_in_mesh": (
                list(self.location_in_mesh) if self.location_in_mesh is not None else None
            ),
            "location_source": self.location_source,
            "min_cells_across_passage": self.min_cells_across_passage,
            "stl_facet_to_cell_ratio": self.stl_facet_to_cell_ratio,
            "fineness": int(self.fineness),
            "sizing_mode": self.sizing_mode,
            "physics_based": bool(self.physics_based),
            "add_layers": bool(self.add_layers),
            "max_meshing_runtime_s": float(self.max_meshing_runtime_s),
            "algorithm": self.algorithm,
            "hex_element_core": bool(self.hex_element_core),
            "hexcore_backend": self.hexcore_backend,
            "bbox_resolution_x": int(self.bbox_resolution_x),
            "bbox_resolution_y": int(self.bbox_resolution_y),
            "bbox_resolution_z": int(self.bbox_resolution_z),
            "max_local_cells": int(self.max_local_cells),
            "max_global_cells": int(self.max_global_cells),
            "min_refinement_cells": int(self.min_refinement_cells),
            "max_load_unbalance": float(self.max_load_unbalance),
            "cells_between_levels": int(self.cells_between_levels),
            "resolve_feature_angle": float(self.resolve_feature_angle),
            "allow_free_standing_zone_faces": bool(
                self.allow_free_standing_zone_faces
            ),
        }

    @staticmethod
    def from_dict(data: dict | None) -> MeshSettings:
        if not data:
            return MeshSettings()
        loc = data.get("location_in_mesh")
        location_source = data.get("location_source", "auto")
        if location_source not in ("auto", "manual"):
            location_source = "auto"
        sizing_mode = data.get("sizing_mode", "automatic")
        if sizing_mode not in ("automatic", "manual"):
            sizing_mode = "automatic"
        algorithm = data.get("algorithm", "hex-dominant")
        if algorithm not in (
            "hex-dominant",
            "hex-dominant-parametric",
            "standard",
        ):
            algorithm = "hex-dominant"
        fineness = int(data.get("fineness", 5))
        fineness = max(1, min(10, fineness))
        return MeshSettings(
            base_cell_m=float(data.get("base_cell_m", 0.025)),
            refinement=MeshRefinement.from_dict(data.get("refinement")),
            location_in_mesh=(
                (float(loc[0]), float(loc[1]), float(loc[2])) if loc is not None else None
            ),
            location_source=location_source,  # type: ignore[arg-type]
            min_cells_across_passage=float(data.get("min_cells_across_passage", 3.0)),
            stl_facet_to_cell_ratio=float(
                data.get("stl_facet_to_cell_ratio", 1.0 / 3.0)
            ),
            fineness=fineness,
            sizing_mode=sizing_mode,  # type: ignore[arg-type]
            physics_based=bool(data.get("physics_based", True)),
            add_layers=bool(data.get("add_layers", False)),
            max_meshing_runtime_s=float(data.get("max_meshing_runtime_s", 18_000.0)),
            algorithm=algorithm,  # type: ignore[arg-type]
            # Missing key → True (current Standard default). Explicit False kept.
            hex_element_core=bool(data.get("hex_element_core", True)),
            hexcore_backend=_parse_hexcore_backend(data.get("hexcore_backend")),
            # 0 = auto / geometry-derived (14a.2-ship). Missing key -> 0, not SimScale 67/62/24.
            bbox_resolution_x=max(0, int(data.get("bbox_resolution_x", 0))),
            bbox_resolution_y=max(0, int(data.get("bbox_resolution_y", 0))),
            bbox_resolution_z=max(0, int(data.get("bbox_resolution_z", 0))),
            max_local_cells=max(1, int(data.get("max_local_cells", 40_000_000))),
            max_global_cells=max(1, int(data.get("max_global_cells", 100_000_000))),
            min_refinement_cells=max(0, int(data.get("min_refinement_cells", 1))),
            max_load_unbalance=float(data.get("max_load_unbalance", 0.2)),
            cells_between_levels=max(1, int(data.get("cells_between_levels", 3))),
            resolve_feature_angle=float(data.get("resolve_feature_angle", 30.0)),
            allow_free_standing_zone_faces=bool(
                data.get("allow_free_standing_zone_faces", False)
            ),
        )

    def hexcore_recipe_token(self) -> str:
        """Fingerprint token for Standard + hex element core."""
        if self.hexcore_backend == "bodyfit":
            return "bodyfit_v3"
        return "cfmesh_gap_aware_v1"

    def fingerprint(self, *, quantize_location: bool = True) -> str:
        """Stable hash of fields that change the *generated mesh geometry*.

        Included: ``base_cell_m``, per-role ``refinement``, resolved
        ``location_in_mesh``, ``stl_facet_to_cell_ratio``, and ``add_layers``
        (plus layer scalars when layers are on). Non-default ``algorithm``
        (``standard``) is hashed; default Hex-dominant is omitted so existing
        stamped projects stay fresh.

        Excluded: ``location_source``, ``min_cells_across_passage``,
        ``fineness`` / ``sizing_mode`` (UI drivers of ``base_cell_m``),
        ``physics_based`` (drives refinement integers already hashed),
        ``max_meshing_runtime_s`` and Preferred CPUs (runtime only).
        """
        if self.location_in_mesh is None:
            loc_payload = None
        elif quantize_location:
            loc_payload = quantize_location_m(self.location_in_mesh)
        else:
            loc_payload = list(self.location_in_mesh)
        payload: dict = {
            "base_cell_m": self.base_cell_m,
            "refinement": self.refinement.to_dict(),
            "location_in_mesh": loc_payload,
            "stl_facet_to_cell_ratio": self.stl_facet_to_cell_ratio,
        }
        if self.algorithm == "standard":
            payload["algorithm"] = "standard"
            # Always hash so toggling core on/off invalidates the mesh stamp.
            payload["hex_element_core"] = bool(self.hex_element_core)
            if self.hex_element_core:
                payload["hexcore_recipe"] = self.hexcore_recipe_token()
        elif self.algorithm == "hex-dominant-parametric":
            payload["algorithm"] = "hex-dominant-parametric"
            # Level-0 is geometry-derived at write (same Hex helper); do not hash
            # stale SimScale UI seeds (67/62/24) that no longer drive blockMesh.
            payload["bbox_resolution"] = "geometry_derived_hex_helper"
            payload["castellated"] = {
                "max_local_cells": int(self.max_local_cells),
                "max_global_cells": int(self.max_global_cells),
                "min_refinement_cells": int(self.min_refinement_cells),
                "max_load_unbalance": float(self.max_load_unbalance),
                "cells_between_levels": int(self.cells_between_levels),
                "resolve_feature_angle": float(self.resolve_feature_angle),
                "allow_free_standing_zone_faces": bool(
                    self.allow_free_standing_zone_faces
                ),
            }
            from cfddesk.mesh.snappy_policy import snappy_geometry_fingerprint_payload

            payload.update(
                snappy_geometry_fingerprint_payload(
                    walls_level=int(self.refinement.walls),
                    fineness=int(self.fineness),
                    has_features=True,
                )
            )
        else:
            # Writer geometry policy (feature level + snap strength). Includes the
            # derived levels so Manual fineness changes still invalidate the mesh
            # even when base_cell is frozen.
            from cfddesk.mesh.snappy_policy import snappy_geometry_fingerprint_payload

            payload.update(
                snappy_geometry_fingerprint_payload(
                    walls_level=int(self.refinement.walls),
                    fineness=int(self.fineness),
                    has_features=True,
                )
            )
        if self.add_layers and self.algorithm != "standard":
            # Layer scalars land here when MeshSettings grows them (5.4).
            # Standard v1 has no layers — ignore add_layers for staleness.
            payload["add_layers"] = True
        blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


@dataclass
class BoundarySettings:
    """Boundary-condition inputs persisted in ``project.json`` under ``boundary``."""

    inlet_speed_m_s: float = 0.5
    inlet_direction_mode: InletDirectionMode = "normal"
    # Used verbatim as the flow direction when mode == "vector". When
    # mode == "normal", direction instead comes from the inlet face's
    # geometric normal (see cfddesk.cad.normals.inlet_velocity_from_face);
    # this field is then just the last resolved/fallback direction.
    inlet_vector: tuple[float, float, float] = (-1.0, 0.0, 0.0)
    outlet_p: float = 0.0
    walls_type: str = "noSlip"

    def to_dict(self) -> dict:
        return {
            "inlet_speed_m_s": self.inlet_speed_m_s,
            "inlet_direction_mode": self.inlet_direction_mode,
            "inlet_vector": list(self.inlet_vector),
            "outlet_p": self.outlet_p,
            "walls_type": self.walls_type,
        }

    @staticmethod
    def from_dict(data: dict | None) -> BoundarySettings:
        if not data:
            return BoundarySettings()
        mode = data.get("inlet_direction_mode", "normal")
        if mode not in ("normal", "vector"):
            mode = "normal"
        vec = data.get("inlet_vector", [-1.0, 0.0, 0.0])
        return BoundarySettings(
            inlet_speed_m_s=float(data.get("inlet_speed_m_s", 0.5)),
            inlet_direction_mode=mode,  # type: ignore[arg-type]
            inlet_vector=(float(vec[0]), float(vec[1]), float(vec[2])),
            outlet_p=float(data.get("outlet_p", 0.0)),
            walls_type=str(data.get("walls_type", "noSlip")),
        )


@dataclass
class SolverSettings:
    """Solver run controls persisted in ``project.json`` under ``solver``."""

    mode: SolverMode = "steady"
    backend: SolverBackend = "amgx"
    end_condition: SolverEndCondition = "residual"
    end_time: int = 1000  # still / Simulation control End time (inc21a)
    residual_u: float = 1e-6  # still Numerics Abs tol (inc21b)
    # Ignored on the amgx branch when writing fvSolution: AmgX reports the p
    # residual as 0 (TRANSLATION §3), so residualControl keys on U only —
    # see cfddesk.case.writer.write_fv_solution_amgx / write_simplefoam_case.
    residual_p: float = 1e-6  # still Numerics Abs tol (inc21b)
    turbulence: TurbulenceModel = "laminar"
    turbulence_intensity_pct: float = 5.0
    # Copy internalField from latest WSL time into 0/ before solve (RSM warm-start).
    warm_start: bool = False
    # Energy equation (thermal BCs / 0/T). Off by default — registry stubs only.
    energy: bool = False

    def to_dict(self) -> dict:
        return {
            "mode": self.mode,
            "backend": self.backend,
            "end_condition": self.end_condition,
            "end_time": self.end_time,
            "residual_u": self.residual_u,
            "residual_p": self.residual_p,
            "turbulence": self.turbulence,
            "turbulence_intensity_pct": self.turbulence_intensity_pct,
            "warm_start": self.warm_start,
            "energy": self.energy,
        }

    @staticmethod
    def from_dict(data: dict | None) -> SolverSettings:
        if not data:
            return SolverSettings()
        backend = data.get("backend", "amgx")
        if backend not in ("cpu", "amgx"):
            backend = "amgx"
        end_condition = data.get("end_condition", "residual")
        if end_condition not in ("residual", "iterations"):
            end_condition = "residual"
        turb = data.get("turbulence", "laminar")
        if turb not in TURBULENCE_MODELS:
            turb = "laminar"
        mode = data.get("mode", "steady")
        if mode not in ("steady", "transient"):
            mode = "steady"
        return SolverSettings(
            mode=mode,  # type: ignore[arg-type]
            backend=backend,  # type: ignore[arg-type]
            end_condition=end_condition,  # type: ignore[arg-type]
            end_time=int(data.get("end_time", 1000)),
            residual_u=float(data.get("residual_u", 1e-6)),
            residual_p=float(data.get("residual_p", 1e-6)),
            turbulence=turb,  # type: ignore[arg-type]
            turbulence_intensity_pct=float(
                data.get("turbulence_intensity_pct", 5.0)
            ),
            warm_start=bool(data.get("warm_start", False)),
            energy=bool(data.get("energy", False)),
        )

@dataclass
class PathsSettings:
    """WSL/local case-directory bookkeeping persisted in ``project.json`` under ``paths``."""

    wsl_case_id: str = ""
    local_case: str = "case"
    local_results: str = "results"

    def to_dict(self) -> dict:
        return {
            "wsl_case_id": self.wsl_case_id,
            "local_case": self.local_case,
            "local_results": self.local_results,
        }

    @staticmethod
    def from_dict(data: dict | None) -> PathsSettings:
        if not data:
            return PathsSettings()
        return PathsSettings(
            wsl_case_id=str(data.get("wsl_case_id", "")),
            local_case=str(data.get("local_case", "case")),
            local_results=str(data.get("local_results", "results")),
        )
