"""Compound two solids without losing either one."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.gp import gp_Pnt
from OCP.TopAbs import TopAbs_SOLID

from cfddesk.cad.io import (
    compound_shapes,
    compound_step_files,
    count_sub,
    write_step,
)


class TestCompound(unittest.TestCase):
    def test_two_boxes_stay_two_solids(self):
        a = BRepPrimAPI_MakeBox(10, 10, 10).Shape()
        b = BRepPrimAPI_MakeBox(gp_Pnt(20, 0, 0), 5, 5, 5).Shape()
        comp = compound_shapes([a, b])
        self.assertEqual(count_sub(comp, TopAbs_SOLID), 2)

    def test_roundtrip_step_keeps_both(self):
        a = BRepPrimAPI_MakeBox(8, 8, 8).Shape()
        b = BRepPrimAPI_MakeBox(gp_Pnt(30, 0, 0), 4, 4, 4).Shape()
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            p1 = write_step(a, d / "a.step")
            p2 = write_step(b, d / "b.step")
            loaded = compound_step_files([p1, p2])
            self.assertEqual(loaded.n_solids, 2)
            out = write_step(loaded.shape, d / "assembly.step")
            again = compound_step_files([out])
            self.assertEqual(again.n_solids, 2)


if __name__ == "__main__":
    unittest.main()
