"""Built-in MeshBackend specs (Phase 2 land4)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from cfddesk.project.mesh_refinements import REFINEMENT_MENU_BY_ALGORITHM
from cfddesk.registry.mesher import MeshBackend
from cfddesk.registry.requirements import Requirement
from cfddesk.registry.schema import SchemaField

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub

# Product keys match w20 MESH_ENGINES + w21 hex-dominant path (snappy).
# Labels match plan Step 4 / product copy.
_STANDARD_REFINEMENTS = REFINEMENT_MENU_BY_ALGORITHM["standard"]
_HEX_REFINEMENTS = REFINEMENT_MENU_BY_ALGORITHM["hex-dominant"]


def _mesh_fingerprint(project: Any, mesh_id: str | None = None, **_kwargs: Any) -> dict[str, Any]:
    from cfddesk.project.model import _mesh_fingerprint_payload

    return _mesh_fingerprint_payload(project, mesh_id=mesh_id)


def _bind_generate(script: str):
    def generate(**_kwargs: Any) -> str:
        from cfddesk.registry.base import RegistryError
        from cfddesk.registry.discovery import get_registry, load_all

        load_all()
        job = get_registry("job").get("mesh")
        if job.scope not in ("project", "geometry", "study"):
            raise RegistryError(f"mesh job scope {job.scope!r} is not a host scope")
        if not str(job.tool or "").strip():
            raise RegistryError("mesh job has no tool")
        return script

    return generate


def _live_mesh_schema(*, hex_core: bool) -> tuple[SchemaField, ...]:
    """The mesh panel, in the row order the V0.1.0 chrome used.

    Fineness, the three toggles, then the advanced disclosure. Algorithm and
    Sizing are fixed rows the panel draws itself (only automatic sizing is
    implemented). Keys stay as the panel already saves them (add_layers,
    physics_based); advanced keys match settings.advanced on disk.
    """
    fields: list[SchemaField] = [
        SchemaField(
            "fineness",
            "Fineness",
            "int",
            default=5,
            min=1,
            max=10,
            group="mesh",
            widget="range",
            description="Coarse meshes solve fast; fine meshes resolve more detail. 5 is the default.",
        ),
        SchemaField(
            "add_layers",
            "Automatic boundary layers",
            "bool",
            default=True,
            group="mesh",
            description="Grow thin cell layers along walls to capture the near-wall velocity profile.",
        ),
        SchemaField(
            "physics_based",
            "Physics-based meshing",
            "bool",
            default=True,
            group="mesh",
            description="Refine where the flow needs it: inlets, outlets and narrow gaps.",
        ),
    ]
    if hex_core:
        fields.append(
            SchemaField(
                "hex_element_core",
                "Hex element core",
                "bool",
                default=True,
                group="mesh",
                description="Fill the interior with hexahedra and keep tetrahedra to a thin skin at the surface.",
            )
        )
    fields.extend(
        [
            SchemaField(
                "small_feature_suppression",
                "Small feature suppression",
                "text",
                default="",
                unit="m",
                group="advanced",
                advanced=True,
                description="Edges and sliver faces shorter than this (metres) are merged before meshing. Leave empty for automatic.",
            ),
            SchemaField(
                "gap_refinement_factor",
                "Gap refinement factor",
                "float",
                default=0.05,
                min=0.0,
                group="advanced",
                advanced=True,
                description="Gap thickness divided by the edge length in the gap. Above 1 it is the number of cells across a gap.",
            ),
            SchemaField(
                "global_gradation_rate",
                "Global gradation rate",
                "float",
                default=1.22,
                min=1.0,
                max=3.0,
                group="advanced",
                advanced=True,
                description="Size ratio between neighbouring cells when growing away from the surface.",
            ),
        ]
    )
    return tuple(fields)


def build_standard() -> MeshBackend:
    return MeshBackend(
        key="standard",
        label="Standard",
        settings_schema=_live_mesh_schema(hex_core=True),
        refinement_types=_STANDARD_REFINEMENTS,
        tool="mesh",
        fingerprint_payload=_mesh_fingerprint,
        generate=_bind_generate("generate_standard.py"),
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
        tool="mesh",
        fingerprint_payload=_mesh_fingerprint,
        generate=_bind_generate("generate_cfmesh_standard.py"),
        supports_hex_core=True,
        requires=(Requirement("wsl_tool", "cartesianMesh"),),
        frozen=True,
        multi_region=False,
    )


def build_snappy_hexdominant() -> MeshBackend:
    return MeshBackend(
        key="snappy_hexdominant",
        label="Hex-dominant",
        settings_schema=_live_mesh_schema(hex_core=False),
        refinement_types=_HEX_REFINEMENTS,
        tool="mesh",
        fingerprint_payload=_mesh_fingerprint,
        generate=_bind_generate("generate_snappy.py"),
        supports_hex_core=False,
        requires=(Requirement("wsl_tool", "snappyHexMesh"),),
        frozen=False,
        multi_region=False,
    )


def register_meshers(hub: RegistryHub) -> None:
    """Register standard / cfmesh / snappy_hexdominant (idempotent same-plugin)."""
    reg = hub.registry("mesher")
    reg.register(build_standard(), plugin="builtin")
    reg.register(build_cfmesh(), plugin="builtin")
    reg.register(build_snappy_hexdominant(), plugin="builtin")
