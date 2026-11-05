"""Built-in MeshBackend specs (Phase 2 land4)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from cfddesk.registry.mesher import MeshBackend
from cfddesk.registry.requirements import Requirement
from cfddesk.registry.schema import SchemaField

if TYPE_CHECKING:
    from cfddesk.registry.discovery import RegistryHub

# What all three generators apply (web_refinements.load_surface_custom_sizes and
# load_inflate_refs); the panel offers these and nothing else.
_REFINEMENTS = ("surface_custom_sizing", "inflate_boundary_layer")

# Progress stages each generator reports, as the Mesh panel names them.
_READ = (("load_step", "Reading geometry"), ("step_loaded", "Reading geometry"))
_COPY_BACK = (("copy_back", "Copying the mesh into the project"),)
# After the mesh is done: its quality, boundary layers and Courant rates (mesh-facts.json, RH2).
_FACTS = (("mesh_facts", "Reading the mesh quality"),)
_STANDARD_STAGES = (
    *_READ,
    ("surface_mesh", "Meshing the surface"),
    ("gmsh", "Preparing the geometry"),
    ("gmshToFoam", "Building the OpenFOAM mesh and boundary layers"),
    ("boundary_layers_retry", "Retrying without boundary layers"),
    *_COPY_BACK,
    *_FACTS,
)
# generate_standard.py's gmsh lines (log.gmsh_host.txt), first match wins.
_STANDARD_DETAILS = (
    ("gmsh", r"^surface \(gap", "Refining gaps"),
    ("gmsh", r"^surface", "Meshing the surface"),
    ("gmsh", r"^gap refinement", "Refining gaps"),
    ("gmsh", r"^hexcore|^hex element core", "Building the hex element core"),
    ("gmsh", r"^tets:", "Filling the volume with tetrahedra"),
    ("gmsh", r"^tet (shell|volume)|^msh written|^volume check", "Writing the volume mesh"),
)
_CFMESH_STAGES = (
    *_READ,
    ("write_case", "Writing the case"),
    ("cartesianMesh", "Running cartesianMesh"),
    *_COPY_BACK,
    *_FACTS,
)
_HEX_STAGES = (
    # A linked or display-budgeted geometry: the mesh job builds Body1.stl first (LINK 5.9).
    ("prepare_input", "Building the mesh input"),
    ("load_geometry", "Reading geometry"),
    ("sync_to_wsl", "Copying the case to WSL"),
    ("snappy_pipeline", "Starting the mesh in WSL"),
    ("start", "Starting the mesh in WSL"),
    ("surfaceFeatureExtract", "Finding feature edges"),
    ("blockMesh", "Building the background mesh"),
    ("snappyHexMesh", "Snapping the mesh to the surface"),
    # One cell across (2D): the 3D slab becomes one cell deep (cfddesk.mesh.two_d).
    ("extrudeMesh", "Making the mesh one cell across (2D)"),
    ("checkMesh", "Checking the mesh quality"),
    ("createPatch", "Putting the 2D mesh's ends on their Symmetry"),
    *_FACTS,
)


def _report(name: str, *, two_d: bool = False) -> tuple[tuple[str, str, str], ...]:
    """The finished-mesh summary: engine, then what the run applied."""
    return (
        ("", name, ""),
        *((("one_cell_across", "one cell across (2D)", ""),) if two_d else ()),
        ("hex_core_applied", "hex element core", ""),
        ("layers_applied", "boundary layers", "no boundary layers"),
        ("surface_size_m", "surface size {length}", ""),
    )


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


_HEX_CORE_HELP = "Fill the interior with hexahedra and keep tetrahedra to a thin skin at the surface."
# cfMesh always makes a hex core: with the toggle off, Generate meshes with
# Standard instead (w21 resolveMeshBackend, as V0.1.0 did).
_CFMESH_HEX_CORE_HELP = (
    "On: cfMesh fills the interior with hexahedra. Off: the Standard mesher builds this mesh "
    "instead, without a hex core (cfMesh always makes one)."
)


_ONE_CELL_ACROSS_HELP = (
    "Mesh the part one cell deep between its two parallel flat end faces, which must carry a "
    "Symmetry boundary condition: the flow is exactly 2D, with far fewer cells. The part must "
    "be a straight extrusion between them, along x, y or z."
)


def _live_mesh_schema(
    *, hex_core: bool, advanced: bool = True, hex_core_help: str = _HEX_CORE_HELP, one_cell_across: bool = False
) -> tuple[SchemaField, ...]:
    """The mesh panel, in the row order the V0.1.0 chrome used.

    Fineness, the three toggles, then the advanced disclosure. Algorithm and
    Sizing are fixed rows the panel draws itself (only automatic sizing is
    implemented). Keys stay as the panel already saves them (add_layers,
    physics_based); advanced keys match settings.advanced on disk. A mesher
    lists only what its generator reads: ``advanced`` adds small feature
    suppression, gap refinement and gradation, which only Standard's run gets.
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
    if one_cell_across:
        # Hex-dominant's own setting (validation gap G5): a mesher's own keys are saved under
        # settings.mesher_settings, and the generator reads it (--one-cell-across).
        fields.append(
            SchemaField(
                "one_cell_across",
                "One cell across (2D)",
                "bool",
                default=False,
                group="mesh",
                description=_ONE_CELL_ACROSS_HELP,
            )
        )
    if hex_core:
        fields.append(
            SchemaField(
                "hex_element_core",
                "Hex element core",
                "bool",
                default=True,
                group="mesh",
                description=hex_core_help,
            )
        )
    if not advanced:
        return tuple(fields)
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
        refinement_types=_REFINEMENTS,
        tool="mesh",
        fingerprint_payload=_mesh_fingerprint,
        generate=_bind_generate("generate_standard.py"),
        supports_hex_core=True,
        requires=(),
        frozen=False,
        # Host API 1.8: one cellZone per region (a study's materials, heat transfer).
        multi_region=True,
        engine="standard",
        stage_labels=_STANDARD_STAGES,
        stage_details=_STANDARD_DETAILS,
        report=_report("Standard"),
    )


def build_cfmesh() -> MeshBackend:
    """Legacy cartesianMesh path — stays registered/callable; backup tree untouched."""
    return MeshBackend(
        key="cfmesh",
        label="cfMesh cartesianMesh (legacy)",
        # What its run reads: fineness, layers, physics-based, and the hex core
        # it needs (generate_cfmesh_standard.py; no advanced flags).
        settings_schema=_live_mesh_schema(hex_core=True, advanced=False, hex_core_help=_CFMESH_HEX_CORE_HELP),
        refinement_types=_REFINEMENTS,
        tool="mesh",
        fingerprint_payload=_mesh_fingerprint,
        generate=_bind_generate("generate_cfmesh_standard.py"),
        supports_hex_core=True,
        requires=(Requirement("wsl_tool", "cartesianMesh"),),
        frozen=True,
        multi_region=False,
        engine="cfmesh",
        stage_labels=_CFMESH_STAGES,
        report=_report("cfMesh"),
    )


def build_snappy_hexdominant() -> MeshBackend:
    return MeshBackend(
        key="snappy_hexdominant",
        label="Hex-dominant",
        # generate_snappy.py reads fineness, layers, physics-based and one cell across.
        settings_schema=_live_mesh_schema(hex_core=False, advanced=False, one_cell_across=True),
        refinement_types=_REFINEMENTS,
        tool="mesh",
        fingerprint_payload=_mesh_fingerprint,
        generate=_bind_generate("generate_snappy.py"),
        supports_hex_core=False,
        requires=(Requirement("wsl_tool", "snappyHexMesh"),),
        frozen=False,
        # Host API 1.8: one cellZone per region (locationsInMesh).
        multi_region=True,
        engine="snappy_hexdominant",
        stage_labels=_HEX_STAGES,
        report=_report("Hex-dominant", two_d=True),
    )


def register_meshers(hub: RegistryHub) -> None:
    """Register standard / cfmesh / snappy_hexdominant (idempotent same-plugin)."""
    reg = hub.registry("mesher")
    reg.register(build_standard(), plugin="builtin")
    reg.register(build_cfmesh(), plugin="builtin")
    reg.register(build_snappy_hexdominant(), plugin="builtin")
