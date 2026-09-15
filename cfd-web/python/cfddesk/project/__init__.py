"""Project persistence (roles + geometric fingerprints + BC ownership)."""

from cfddesk.project.model import (
    BoundaryCondition,
    FaceFingerprint,
    FaceRole,
    FingerprintMismatch,
    PROJECT_VERSION,
    Project,
    ProjectLoadResult,
    ROLES,
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
