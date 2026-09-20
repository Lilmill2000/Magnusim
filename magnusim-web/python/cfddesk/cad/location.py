"""locationInMesh via OCCT solid classifier — must be inside."""

from __future__ import annotations

from dataclasses import dataclass

from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.gp import gp_Pnt
from OCP.TopAbs import TopAbs_IN, TopAbs_ON, TopAbs_OUT

from cfddesk.cad.step import LoadedSolid
from cfddesk.cad.units import shape_bbox


@dataclass(frozen=True)
class LocationInMesh:
    point_native: tuple[float, float, float]
    point_metres: tuple[float, float, float]
    state: str
    ok: bool
    method: str


def _classify(solid: LoadedSolid, x: float, y: float, z: float) -> str:
    clf = BRepClass3d_SolidClassifier(solid.shape)
    clf.Perform(gp_Pnt(x, y, z), 1e-7)
    st = clf.State()
    if st == TopAbs_IN:
        return "IN"
    if st == TopAbs_OUT:
        return "OUT"
    if st == TopAbs_ON:
        return "ON"
    return str(st)


def find_location_in_mesh(
    solid: LoadedSolid,
    scale_to_metres: float,
) -> LocationInMesh:
    """Find a point strictly inside the fluid solid (native OCCT coords).

    Tries solid centroid of the bounding box, then walks the Z axis through
    the box centre. Raises if no interior point is found.
    """
    bbox = shape_bbox(solid.shape, unit="native")
    cx = 0.5 * (bbox.xmin + bbox.xmax)
    cy = 0.5 * (bbox.ymin + bbox.ymax)
    cz = 0.5 * (bbox.zmin + bbox.zmax)

    candidates: list[tuple[tuple[float, float, float], str]] = [
        ((cx, cy, cz), "bbox_center"),
    ]
    # Sample along vertical axis (cyclone axis)
    for t in (0.2, 0.35, 0.5, 0.65, 0.8, 0.1, 0.9):
        z = bbox.zmin + t * (bbox.zmax - bbox.zmin)
        candidates.append(((cx, cy, z), f"axis_z_t={t}"))

    for (x, y, z), method in candidates:
        state = _classify(solid, x, y, z)
        if state == "IN":
            return LocationInMesh(
                point_native=(x, y, z),
                point_metres=(x * scale_to_metres, y * scale_to_metres, z * scale_to_metres),
                state=state,
                ok=True,
                method=method,
            )

    raise RuntimeError(
        "locationInMesh: no interior point found via bbox centre / axis search — "
        "block meshing (classifier never returned IN)"
    )
