"""gmsh leftover defaultFaces must be type wall for RAS wall functions."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from cfddesk.case.writer import parse_boundary_patch_types
from cfddesk.mesh.gmsh_standard import apply_boundary_patch_types, coerce_gmsh_leftover_walls

_BOUNDARY = """\
FoamFile
{
    version     2.0;
    format      ascii;
    class       polyBoundaryMesh;
    object      boundary;
}
3
(
    walls
    {
        type            wall;
        nFaces          10;
        startFace       0;
    }
    velocity_inlet_1
    {
        type            patch;
        nFaces          4;
        startFace       10;
    }
    defaultFaces
    {
        type            patch;
        nFaces          6;
        startFace       14;
    }
)
"""


class TestDefaultFacesWall(unittest.TestCase):
    def test_coerce_leftover_default_faces_to_wall(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "boundary"
            path.write_text(_BOUNDARY, encoding="utf-8")
            n = coerce_gmsh_leftover_walls(path)
            self.assertEqual(n, 1)
            types = parse_boundary_patch_types(path)
            self.assertEqual(types["defaultFaces"], "wall")
            self.assertEqual(types["velocity_inlet_1"], "patch")
            self.assertEqual(types["walls"], "wall")

    def test_wall_function_patches_are_rewritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "boundary"
            path.write_text(_BOUNDARY, encoding="utf-8")
            n = apply_boundary_patch_types(path, {"defaultFaces": "wall", "walls": "wall"})
            self.assertEqual(n, 1)
            self.assertEqual(parse_boundary_patch_types(path)["defaultFaces"], "wall")


if __name__ == "__main__":
    unittest.main()
