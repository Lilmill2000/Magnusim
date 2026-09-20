"""SnappyHexMesh geometry policy shared by writer + mesh fingerprint.

SimScale-aligned idea: sharp edges get *preferential* hex refinement that
scales with fineness, then snap is given enough feature iterations to lock
onto those edges. Surface refinement alone chamfers industrial shoulders.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from cfddesk.project.mesh_sizing import clamp_fineness

# Bump when emitted castellated/snap geometry controls change (invalidates meshes).
# rev 1: features = min(3, walls+1) — Fine walls=3 → feature=3 (no edge preference)
# rev 2: features = min(4, walls+1) — Fine walls=3 → feature=4
# rev 3: features = max(walls+1, fineness ladder); snapControls scale with fineness
SNAPPY_GEOMETRY_REV = 3

# Fineness → minimum explicit feature level (distance = 0 m, single ``level``).
#   F 1–3 (Coarse)  → 2
#   F 4–6 (Standard)→ 3
#   F 7–10 (Fine)   → 4
# Final level = min(4, max(fineness_floor, walls+1)) so features always beat
# the wall surface level when physics raises walls.
_FEATURE_LEVEL_CAP = 4


@dataclass(frozen=True)
class SnapControlsPolicy:
    """Values written into ``snapControls`` when CAD features are present."""

    n_smooth_patch: int
    tolerance: float
    n_solve_iter: int
    n_relax_iter: int
    n_feature_snap_iter: int

    def to_dict(self) -> dict:
        return asdict(self)


def feature_level_from_fineness(fineness: int) -> int:
    """Minimum feature level from the fineness ladder alone."""
    f = clamp_fineness(fineness)
    return min(_FEATURE_LEVEL_CAP, 2 + (f - 1) // 3)


def feature_refinement_level(
    walls_level: int,
    *,
    fineness: int = 5,
) -> int:
    """Explicit CAD feature level for ``castellatedMeshControls.features``.

    Preferential edge cells require ``feature_level > walls``. The fineness
    ladder raises the floor so Manual + physics-off still gets Fine edges.
    """
    from_walls = int(walls_level) + 1
    from_fineness = feature_level_from_fineness(fineness)
    return min(_FEATURE_LEVEL_CAP, max(2, from_walls, from_fineness))


def snap_controls_for_fineness(
    fineness: int, *, has_features: bool
) -> SnapControlsPolicy:
    """Conservative snap strength; stronger when features exist and F is high.

    Without features, keep stock-ish defaults. With features:
      F≤3  → tolerance 1.5, nFeatureSnapIter 15, nSolveIter 100
      F4–6 → tolerance 1.0, nFeatureSnapIter 20, nSolveIter 150, nSmoothPatch 5
      F≥7  → tolerance 1.0, nFeatureSnapIter 25, nSolveIter 200, nSmoothPatch 5
    """
    if not has_features:
        return SnapControlsPolicy(
            n_smooth_patch=3,
            tolerance=2.0,
            n_solve_iter=100,
            n_relax_iter=5,
            n_feature_snap_iter=10,
        )
    f = clamp_fineness(fineness)
    if f <= 3:
        return SnapControlsPolicy(
            n_smooth_patch=3,
            tolerance=1.5,
            n_solve_iter=100,
            n_relax_iter=5,
            n_feature_snap_iter=15,
        )
    if f <= 6:
        return SnapControlsPolicy(
            n_smooth_patch=5,
            tolerance=1.0,
            n_solve_iter=150,
            n_relax_iter=5,
            n_feature_snap_iter=20,
        )
    return SnapControlsPolicy(
        n_smooth_patch=5,
        tolerance=1.0,
        n_solve_iter=200,
        n_relax_iter=5,
        n_feature_snap_iter=25,
    )


def snappy_geometry_fingerprint_payload(
    *,
    walls_level: int,
    fineness: int,
    has_features: bool = True,
) -> dict:
    """Subset of emitted snappy knobs that affect mesh geometry (for hashing)."""
    feat = feature_refinement_level(walls_level, fineness=fineness)
    snap = snap_controls_for_fineness(fineness, has_features=has_features)
    return {
        "snappy_geometry_rev": int(SNAPPY_GEOMETRY_REV),
        "feature_level": int(feat),
        "snap": snap.to_dict(),
    }
