"""CAD / STEP import via OCP (cadquery-ocp)."""

from cfddesk.cad.normals import face_outward_normal, inlet_velocity_from_face
from cfddesk.cad.step import (
    FaceRecord,
    LoadedSolid,
    extract_cad_edges,
    load_step,
    mesh_deflection,
    tessellate_faces,
)
from cfddesk.cad.stl_quality import (
    check_stl_vs_cells,
    measure_role_tessellation,
    verify_stl_chordal_deviation,
)
from cfddesk.cad.io import LoadedCad, load_cad, write_step
from cfddesk.cad.units import UnitResolution, resolve_units
from cfddesk.cad.volume import estimate_cell_count, solid_volume_native

__all__ = [
    "FaceRecord",
    "LoadedCad",
    "LoadedSolid",
    "UnitResolution",
    "check_stl_vs_cells",
    "estimate_cell_count",
    "extract_cad_edges",
    "face_outward_normal",
    "inlet_velocity_from_face",
    "load_cad",
    "load_step",
    "measure_role_tessellation",
    "mesh_deflection",
    "resolve_units",
    "solid_volume_native",
    "tessellate_faces",
    "verify_stl_chordal_deviation",
    "write_step",
]
