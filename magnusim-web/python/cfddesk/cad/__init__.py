"""CAD / STEP import via OCP (cadquery-ocp)."""

from cfddesk.cad.io import LoadedCad, load_cad, write_step
from cfddesk.cad.preview import export_preview, write_com_into_meta, write_faces_into_meta
from cfddesk.cad.step import (
    FaceRecord,
    LoadedSolid,
    load_step,
    mesh_deflection,
    tessellate_faces,
)
from cfddesk.cad.units import UnitResolution, resolve_units

__all__ = [
    "FaceRecord",
    "LoadedCad",
    "LoadedSolid",
    "UnitResolution",
    "load_cad",
    "load_step",
    "mesh_deflection",
    "resolve_units",
    "tessellate_faces",
    "write_step",
    "export_preview",
    "write_com_into_meta",
    "write_faces_into_meta",
]
