"""Project persistence (roles + geometric fingerprints + BC ownership)."""

from cfddesk.project.model import (
    PROJECT_VERSION,
    ROLES,
    BoundaryCondition,
    FaceFingerprint,
    FaceRole,
    FingerprintMismatch,
    Project,
    ProjectLoadResult,
    fingerprints_match,
    load_project_against_solid,
)

__all__ = [
    "BoundaryCondition",
    "FaceFingerprint",
    "FaceRole",
    "FingerprintMismatch",
    "PROJECT_VERSION",
    "Project",
    "ProjectLoadResult",
    "ROLES",
    "fingerprints_match",
    "load_project_against_solid",
]
