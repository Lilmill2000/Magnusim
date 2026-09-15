"""Built-in MeshBackend specs (Phase 2 land4)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from cfddesk.project.mesh_refinements import REFINEMENT_MENU_BY_ALGORITHM
from cfddesk.registry.mesher import MeshBackend
from cfddesk.registry.requirements import Requirement

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub

# Product keys match w20 MESH_ENGINES + w21 hex-dominant path (snappy).
# Labels match plan Step 4 / product copy.
_STANDARD_REFINEMENTS = REFINEMENT_MENU_BY_ALGORITHM["standard"]
_HEX_REFINEMENTS = REFINEMENT_MENU_BY_ALGORITHM["hex-dominant"]


def build_standard() -> MeshBackend:
    return MeshBackend(
        key="standard",
        label="Standard",
        settings_schema=(),  # NOT_yet_done: full MeshSettings schema later
        refinement_types=_STANDARD_REFINEMENTS,
        tool="generate_standard.py",
        fingerprint_payload=None,  # NOT_yet_done: stays in project model fingerprint
        supports_hex_core=True,
        requires=(),
        frozen=False,
        multi_region=False,
    )


def build_cfmesh() -> MeshBackend:
    """Legacy cartesianMesh path — stays registered/callable; backup tree untouched."""
    return MeshBackend(
        key="cfmesh",
        label="cfMesh cartesianMesh (legacy)",
        settings_schema=(),
        # cfmesh is Standard's advanced engine; same refinement menu as standard.
        refinement_types=_STANDARD_REFINEMENTS,
        tool="generate_cfmesh_standard.py",
        fingerprint_payload=None,
        supports_hex_core=True,
        requires=(Requirement("wsl_tool", "cartesianMesh"),),
        frozen=True,
        multi_region=False,
    )


def build_snappy_hexdominant() -> MeshBackend:
    return MeshBackend(
        key="snappy_hexdominant",
        label="Hex-dominant",
        settings_schema=(),
        refinement_types=_HEX_REFINEMENTS,
        tool="generate_snappy.py",
        fingerprint_payload=None,
        supports_hex_core=False,
        requires=(Requirement("wsl_tool", "snappyHexMesh"),),
        frozen=False,
        multi_region=False,
    )


def register_meshers(hub: "RegistryHub") -> None:
    """Register standard / cfmesh / snappy_hexdominant (idempotent same-plugin)."""
    reg = hub.registry("mesher")
    reg.register(build_standard(), plugin="builtin")
    reg.register(build_cfmesh(), plugin="builtin")
    reg.register(build_snappy_hexdominant(), plugin="builtin")
