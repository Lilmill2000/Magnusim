"""Face outward-normal + inlet velocity vector construction.

Simple, documented approach: sample the surface's geometric normal
(``dU x dV`` from ``BRepAdaptor_Surface.D1``) at the UV midpoint of the
face's parameter range, then flip it if the face's topological orientation
is ``REVERSED`` — this matches the ``TopAbs`` orientation handling already
used for tessellation in ``cfddesk.cad.step``. The result is the outward
normal of the *solid this face bounds* (assumes a single closed, coherently
oriented solid, as produced by ``load_step``/OCCT for a STEP body).
"""

from __future__ import annotations

from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.gp import gp_Pnt, gp_Vec
from OCP.TopAbs import TopAbs_REVERSED
from OCP.TopoDS import TopoDS_Face


def face_outward_normal(face: TopoDS_Face) -> tuple[float, float, float]:
    """Unit outward normal of ``face`` at its UV midpoint (direction only;
    scale-invariant, so no unit/metres conversion is needed).
    """
    adaptor = BRepAdaptor_Surface(face)
    u_mid = 0.5 * (adaptor.FirstUParameter() + adaptor.LastUParameter())
    v_mid = 0.5 * (adaptor.FirstVParameter() + adaptor.LastVParameter())

    point = gp_Pnt()
    d1u = gp_Vec()
    d1v = gp_Vec()
    adaptor.D1(u_mid, v_mid, point, d1u, d1v)

    normal = d1u.Crossed(d1v)
    if normal.Magnitude() <= 0.0:
        raise RuntimeError("degenerate face normal at UV midpoint (dU x dV == 0)")
    normal.Normalize()

    nx, ny, nz = normal.X(), normal.Y(), normal.Z()
    if face.Orientation() == TopAbs_REVERSED:
        nx, ny, nz = -nx, -ny, -nz
    return (nx, ny, nz)


def inlet_velocity_from_face(
    face: TopoDS_Face,
    speed_m_s: float,
    scale_to_metres: float,
) -> tuple[float, float, float]:
    """Inlet ``U`` (m/s) that drives flow INTO the fluid solid across ``face``.

    ``face`` must belong to the fluid solid (the CFD domain), not the
    surrounding void. Its outward normal therefore points OUT of the fluid
    domain across the opening; flow entering the domain is the opposite
    direction:

        U = -outward_normal(face) * speed_m_s

    ``scale_to_metres`` is accepted for interface symmetry with the rest of
    the units-explicit CAD pipeline; a face normal is a pure direction
    vector (scale-invariant), so it does not affect the returned components
    — only ``speed_m_s`` sets the magnitude, which is already in m/s.
    """
    if speed_m_s < 0:
        raise ValueError(f"speed_m_s must be >= 0, got {speed_m_s}")
    if scale_to_metres <= 0:
        raise ValueError(f"scale_to_metres must be > 0, got {scale_to_metres}")
    nx, ny, nz = face_outward_normal(face)
    return (-nx * speed_m_s, -ny * speed_m_s, -nz * speed_m_s)
