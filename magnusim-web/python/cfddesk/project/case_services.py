"""Services the core offers an analysis while it writes a case.

An analysis may not import the core's geometry code (OCP, meshers), so what
it needs from the study's geometry comes through here.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any


class CaseServices:
    """Geometry services for one run's case (the study's CAD, loaded once)."""

    def __init__(self, project_dir: Path | str, simulation_id: str | None, mesh_id: str | None) -> None:
        self.project_dir = Path(project_dir)
        self.simulation_id = simulation_id
        self.mesh_id = mesh_id
        self._tess: Any = None
        self._face_index: Any = None

    def nearest_face_numbers(self, points: Any) -> Any:
        """The CAD face each point (metres) lies on: its web face number (``face 12``
        is 12), by the nearest triangle of the study's tessellation; 0 for every
        point when the study has no CAD (host API 1.8, Force result controls)."""
        import numpy as np

        query = np.asarray(points, dtype=np.float64).reshape(-1, 3)
        tess = self._tessellation()
        if not tess or not len(query):
            return np.zeros(len(query), dtype=np.int64)
        if self._face_index is None:
            from cfddesk.cad.nearest_face import FaceIndex

            pts_m, tri, fid = tess
            self._face_index = FaceIndex(pts_m, tri, fid)
        return self._face_index.nearest(query) + 1

    def face_bounds(self, numbers: Any) -> Any:
        """The box ``(lo, hi)`` (metres) around the CAD faces with these web face
        numbers, or None when none of them is on this geometry."""
        import numpy as np

        tess = self._tessellation()
        if not tess:
            return None
        pts_m, tri, fid = tess
        want = np.asarray([int(n) - 1 for n in numbers or []], dtype=np.int64)
        sel = tri[np.isin(fid, want)]
        if not len(sel):
            return None
        corners = pts_m[sel].reshape(-1, 3)
        return corners.min(axis=0), corners.max(axis=0)

    def _tessellation(self) -> Any:
        if self._tess is None:
            import numpy as np

            from cfddesk.cad.step import load_step, tessellate_faces
            from cfddesk.project.paths import resolve_step_for_study

            step = resolve_step_for_study(self.project_dir, self.simulation_id, self.mesh_id)
            if not step:
                self._tess = False
                return self._tess
            solid = load_step(step)
            units = solid.units
            scale = float(
                getattr(units, "proposed_scale_to_metres", None) or getattr(units, "scale_to_metres", None) or 0.001
            )
            pts, tris, fids = tessellate_faces(solid)
            self._tess = (
                np.asarray(pts, dtype=np.float64) * scale,
                np.asarray(tris, dtype=np.int64),
                np.asarray(fids, dtype=np.int64),
            )
        return self._tess

    def faces_to_stl(self, face_labels: list[str], path: Path | str, title: str) -> float | None:
        """Write the study's CAD faces (web labels like ``face 12@Body1``) as a binary
        STL in metres, cut with the mesher's scale so it lies on the mesh boundary.

        Returns the surface area in m², or None when none of the faces is on
        this geometry (nothing written).
        """
        import numpy as np

        from cfddesk.mesh.snappy_hexdominant import write_binary_stl
        from cfddesk.mesh.web_refinements import web_face_to_cfddesk

        tess = self._tessellation()
        if not tess:
            return None
        pts_m, tri, fid = tess
        ids: list[int] = []
        for lab in face_labels or []:
            try:
                ids.append(web_face_to_cfddesk(str(lab)))
            except ValueError:
                continue
        sel = tri[np.isin(fid, np.asarray(ids, dtype=np.int64))] if ids else tri[:0]
        if not len(sel):
            return None
        out = Path(path)
        out.parent.mkdir(parents=True, exist_ok=True)
        write_binary_stl(out, pts_m, sel, title)
        c = pts_m[sel]
        return float(0.5 * np.linalg.norm(np.cross(c[:, 1] - c[:, 0], c[:, 2] - c[:, 0]), axis=1).sum())
