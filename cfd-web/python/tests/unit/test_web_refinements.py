"""Unit tests for Inflate / surface-custom loaders and snappy layer dicts."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from cfddesk.mesh.cfmesh_standard import boundary_layers_dict_text
from cfddesk.mesh.standard_hexcore import (
    LayerPatchSpec,
    StandardSizing,
    cumulative_layer_heights,
    write_layers_case,
)
from cfddesk.mesh.web_refinements import (
    INFLATE_MAX_TOTAL_VS_LOCAL,
    expansion_from_first_total,
    face_ids_from_web_bc,
    first_layer_from_total,
    inflate_from_record,
    layer_specs_for_generate,
    load_inflate_refs,
    load_surface_custom_sizes,
    size_to_metres,
    web_face_to_cfddesk,
)


class TestUnitsAndFaces(unittest.TestCase):
    def test_size_to_metres(self):
        self.assertAlmostEqual(size_to_metres(2, "mm"), 0.002)
        self.assertAlmostEqual(size_to_metres(1, "m"), 1.0)
        self.assertAlmostEqual(size_to_metres(1, "in"), 0.0254)

    def test_web_face(self):
        self.assertEqual(web_face_to_cfddesk("face 10@Body1"), 9)

    def test_face_ids_from_web_bc_skips_faces_the_cad_does_not_have(self):
        fids = face_ids_from_web_bc(
            {"faces": ["face 6@Body1", "face 8@Body1"], "face": "face 8@Body1"},
            7,
        )
        self.assertEqual(fids, [5])

    def test_expansion_from_first_total(self):
        first, n, r = 0.1, 3, 1.5
        total = first * (r**n - 1.0) / (r - 1.0)
        self.assertAlmostEqual(expansion_from_first_total(first, total, n), r, places=4)

    def test_first_layer_from_total(self):
        self.assertAlmostEqual(first_layer_from_total(0.0254, 1.2, 10) * 25.958353, 0.0254, places=5)

    def test_cumulative_layer_heights_inward_ends_at_total(self):
        hs = cumulative_layer_heights(0.0254, 1.2, 10, -1.0)
        self.assertEqual(len(hs), 10)
        self.assertTrue(all(h < 0 for h in hs))
        self.assertAlmostEqual(hs[-1], -0.0254, places=9)
        self.assertLess(abs(hs[0]), abs(hs[1]))


class TestLoaders(unittest.TestCase):
    def _proj(self, refinements):
        d = Path(tempfile.mkdtemp())
        (d / "mesh_refinements.json").write_text(
            json.dumps({"refinements": refinements}), encoding="utf-8"
        )
        return d

    def test_surface_custom_min_size_raises_target(self):
        d = self._proj(
            [
                {
                    "type": "Surface custom sizing",
                    "mesh_id": "m1",
                    "faces": ["face 2@Body1"],
                    "sizing": "Custom",
                    "default_size": 1,
                    "default_size_unit": "mm",
                    "min_size": 3,
                    "min_size_unit": "mm",
                }
            ]
        )
        extra, mins, notes = load_surface_custom_sizes(d, "m1", 10, 0.1)
        self.assertAlmostEqual(extra[1], 0.003)
        self.assertAlmostEqual(mins[1], 0.003)
        self.assertEqual(notes[0]["min_size_m"], 0.003)

    def test_inflate_total_uses_n_and_thickness(self):
        rec = {
            "type": "Inflate boundary layer",
            "faces": ["face 1@Body1"],
            "n_layers": 4,
            "gradation": "total",
            "total_thickness": 2,
            "total_thickness_unit": "mm",
        }
        spec = inflate_from_record(rec, 0.05, 5)
        self.assertIsNotNone(spec)
        self.assertEqual(spec.n_layers, 4)
        self.assertAlmostEqual(spec.thickness_m, 0.002)
        self.assertAlmostEqual(spec.expansion, 1.2)
        self.assertIsNone(spec.first_layer_m)

    def test_inflate_total_does_not_cap_to_local_cell(self):
        rec = {
            "type": "Inflate boundary layer",
            "faces": ["face 1@Body1"],
            "n_layers": 10,
            "gradation": "total",
            "total_thickness": 25.4,
            "total_thickness_unit": "mm",
        }
        spec = inflate_from_record(rec, 0.01015, 5, extra_face_sizes={0: 0.0032})
        self.assertIsNotNone(spec)
        self.assertEqual(spec.n_layers, 10)
        self.assertAlmostEqual(spec.thickness_m, 0.0254)
        self.assertFalse(spec.capped)
        self.assertAlmostEqual(spec.expansion, 1.2)
        self.assertLess(spec.min_thickness_m, 0.001)
        self.assertLess(spec.min_thickness_m, spec.thickness_m / 10.0)

    def test_inflate_growth_rate(self):
        rec = {
            "type": "Inflate boundary layer",
            "name": "Inflate 1",
            "faces": ["face 4@Body1"],
            "n_layers": 5,
            "gradation": "growth_rate",
            "growth_rate": 1.4,
            "overall_relative_thickness": 0.5,
        }
        spec = inflate_from_record(rec, 0.01, 20)
        self.assertIsNotNone(spec)
        self.assertEqual(spec.n_layers, 5)
        self.assertAlmostEqual(spec.thickness_m, 0.005)
        self.assertAlmostEqual(spec.expansion, 1.4)
        self.assertIsNone(spec.first_layer_m)

    def test_inflate_first_and_total(self):
        rec = {
            "type": "Inflate boundary layer",
            "faces": ["face 1@Body1"],
            "n_layers": 3,
            "gradation": "first_and_total",
            "first_layer_thickness": 0.1,
            "first_layer_unit": "mm",
            "total_thickness": 0.35,
            "total_thickness_unit": "mm",
        }
        spec = inflate_from_record(rec, 0.01, 5)
        self.assertAlmostEqual(spec.first_layer_m, 0.0001)
        self.assertAlmostEqual(spec.thickness_m, 0.00035)
        self.assertGreaterEqual(spec.expansion, 1.0)

    def test_inflate_growth_rate_uses_local_surface_size(self):
        rec = {
            "type": "Inflate boundary layer",
            "faces": ["face 1@Body1"],
            "n_layers": 3,
            "gradation": "growth_rate",
            "growth_rate": 1.5,
            "overall_relative_thickness": 0.4,
        }
        spec = inflate_from_record(rec, 0.01015, 5, extra_face_sizes={0: 0.0032})
        self.assertAlmostEqual(spec.local_h_m, 0.0032)
        self.assertAlmostEqual(spec.thickness_m, 0.4 * 0.0032)
        self.assertLess(spec.thickness_m, 0.004)

    def test_first_layer_ignores_hidden_growth_and_caps_to_local(self):
        """Ball Test: 1 mm first × hidden 1.5 × 5 must not request 13 mm."""
        rec = {
            "type": "Inflate boundary layer",
            "faces": ["face 1@Body1"],
            "n_layers": 5,
            "gradation": "first_layer",
            "growth_rate": 1.5,
            "first_layer_thickness": 1,
            "first_layer_unit": "mm",
        }
        local = 0.0032
        spec = inflate_from_record(rec, 0.01015, 5, extra_face_sizes={0: local})
        self.assertIsNotNone(spec)
        self.assertAlmostEqual(spec.expansion, 1.0)
        self.assertAlmostEqual(spec.first_layer_m, 0.001)
        self.assertLessEqual(spec.thickness_m, INFLATE_MAX_TOTAL_VS_LOCAL * local + 1e-12)
        self.assertLess(spec.thickness_m, 0.007)
        self.assertNotAlmostEqual(spec.thickness_m, 0.0131875, places=4)

    def test_first_layer_shrinks_when_stack_exceeds_two_cells(self):
        rec = {
            "type": "Inflate boundary layer",
            "faces": ["face 1@Body1"],
            "n_layers": 20,
            "gradation": "first_layer",
            "growth_rate": 1.5,
            "first_layer_thickness": 1,
            "first_layer_unit": "mm",
        }
        spec = inflate_from_record(rec, 0.01, 5, extra_face_sizes={0: 0.0032})
        self.assertTrue(spec.capped)
        self.assertLessEqual(spec.n_layers, 6)
        self.assertLessEqual(spec.thickness_m, INFLATE_MAX_TOTAL_VS_LOCAL * 0.0032 + 1e-12)

    def test_mesh_id_scope(self):
        d = self._proj(
            [
                {
                    "type": "Inflate boundary layer",
                    "mesh_id": "other",
                    "faces": ["face 1@Body1"],
                    "n_layers": 7,
                }
            ]
        )
        self.assertEqual(load_inflate_refs(d, "mine", 5, 0.01), [])

    def test_loaders_read_per_mesh_file(self):
        from cfddesk.project.paths import (
            create_geometry_folder,
            create_mesh_folder,
            create_study_folder,
        )

        d = Path(tempfile.mkdtemp())
        (d / "mesh_refinements.json").write_text(
            json.dumps({"refinements": []}), encoding="utf-8"
        )
        create_geometry_folder(
            d, {"id": "g1", "name": "part.step", "original_filename": "part.step"}
        )
        create_study_folder(d, "g1", {"id": "s1", "name": "Study 1"})
        mesh = create_mesh_folder(d, "s1", {"id": "m2", "name": "Mesh 2"})
        (Path(mesh["dir"]) / "refinements.json").write_text(
            json.dumps(
                {
                    "refinements": [
                        {
                            "type": "Surface custom sizing",
                            "mesh_id": "m2",
                            "faces": ["face 13@Body1"],
                            "sizing": "Automatic",
                            "fineness": 10,
                        },
                        {
                            "type": "Inflate boundary layer",
                            "mesh_id": "m2",
                            "faces": ["face 4@Body1"],
                            "n_layers": 8,
                            "gradation": "growth_rate",
                            "growth_rate": 1.2,
                            "overall_relative_thickness": 0.6,
                        },
                    ]
                }
            ),
            encoding="utf-8",
        )
        extra, _mins, notes = load_surface_custom_sizes(d, "m2", 20, 0.1)
        self.assertIn(12, extra)
        self.assertEqual(notes[0]["faces"], ["face 13@Body1"])
        inflates = load_inflate_refs(d, "m2", 20, 0.01, extra_face_sizes=extra)
        self.assertEqual(len(inflates), 1)
        self.assertEqual(inflates[0].n_layers, 8)
        self.assertEqual(inflates[0].face_ids, [3])

    def test_loaders_read_folder_ref_when_leftover_empty(self):
        from cfddesk.project.paths import (
            create_geometry_folder,
            create_mesh_folder,
            create_study_folder,
            persist_child_item,
        )

        d = Path(tempfile.mkdtemp())
        create_geometry_folder(
            d, {"id": "g1", "name": "part.step", "original_filename": "part.step"}
        )
        create_study_folder(d, "g1", {"id": "s1", "name": "Study 1"})
        mesh = create_mesh_folder(d, "s1", {"id": "m2", "name": "Mesh 2"})
        (Path(mesh["dir"]) / "refinements.json").write_text(
            json.dumps({"refinements": []}), encoding="utf-8"
        )
        persist_child_item(
            Path(mesh["dir"]) / "refinements",
            "refinement",
            {
                "id": "ref-1",
                "type": "Surface custom sizing",
                "mesh_id": "m2",
                "faces": ["face 13@Body1"],
                "sizing": "Automatic",
                "fineness": 8,
            },
        )
        extra, _mins, notes = load_surface_custom_sizes(d, "m2", 20, 0.1)
        self.assertIn(12, extra)
        self.assertEqual(notes[0]["faces"], ["face 13@Body1"])


class TestWriteLayers(unittest.TestCase):
    def test_per_patch_inflate_dict(self):
        d = Path(tempfile.mkdtemp())
        sizing = StandardSizing.automatic((0.1, 0.1, 0.1), fineness=5)
        specs = [
            LayerPatchSpec(name="walls", n_layers=3, thickness_m=0.001, expansion=1.5),
            LayerPatchSpec(
                name="inflate_1",
                n_layers=5,
                thickness_m=0.002,
                first_layer_m=0.0002,
                expansion=1.4,
                min_thickness_m=0.0004,
                specify="first",
            ),
        ]
        write_layers_case(
            d,
            wall_patches=["walls", "inflate_1"],
            sizing=sizing,
            add_layers=True,
            layer_specs=specs,
        )
        text = (d / "system" / "snappyHexMeshDict").read_text(encoding="utf-8")
        self.assertIn("nSurfaceLayers 3", text)
        self.assertIn("nSurfaceLayers 5", text)
        self.assertIn("inflate_1", text)
        self.assertIn("firstLayerThickness 0.0002", text)
        self.assertIn("addLayers       true", text)
        inflate_block = text.split("inflate_1", 1)[1].split("}", 1)[0]
        self.assertIn("firstLayerThickness", inflate_block)
        self.assertFalse(
            any(ln.strip().startswith("thickness ") for ln in inflate_block.splitlines())
        )

    def test_snappy_first_and_total_omits_expansion(self):
        d = Path(tempfile.mkdtemp())
        sizing = StandardSizing.automatic((0.1, 0.1, 0.1), fineness=5)
        write_layers_case(
            d,
            wall_patches=["inflate_1"],
            sizing=sizing,
            add_layers=True,
            layer_specs=[
                LayerPatchSpec(
                    name="inflate_1",
                    n_layers=3,
                    thickness_m=0.00035,
                    first_layer_m=0.0001,
                    expansion=1.3,
                    specify="first_and_total",
                )
            ],
        )
        block = (d / "system" / "snappyHexMeshDict").read_text(encoding="utf-8")
        patch = block.split("inflate_1", 1)[1].split("}", 1)[0]
        self.assertIn("firstLayerThickness", patch)
        self.assertIn("thickness", patch)
        self.assertNotIn("expansionRatio", patch)

    def test_layer_specs_first_layer_specify(self):
        specs = layer_specs_for_generate(
            wall_patches=["inflate_1"],
            inflate=[
                type(
                    "I",
                    (),
                    {
                        "patch_name": "inflate_1",
                        "n_layers": 5,
                        "thickness_m": 0.005,
                        "first_layer_m": 0.001,
                        "expansion": 1.0,
                        "min_thickness_m": 0.001,
                        "gradation": "first_layer",
                    },
                )()
            ],
            add_layers=False,
            default_n=3,
            default_thickness_m=0.001,
            default_expansion=1.5,
            default_min_m=0.0002,
        )
        self.assertEqual(specs[0].specify, "first")

    def test_layer_specs_total_honors_absolute(self):
        specs = layer_specs_for_generate(
            wall_patches=["inflate_1"],
            inflate=[
                type(
                    "I",
                    (),
                    {
                        "patch_name": "inflate_1",
                        "n_layers": 10,
                        "thickness_m": 0.0254,
                        "first_layer_m": None,
                        "expansion": 1.2,
                        "min_thickness_m": 0.005,
                        "gradation": "total",
                    },
                )()
            ],
            add_layers=False,
            default_n=3,
            default_thickness_m=0.001,
            default_expansion=1.5,
            default_min_m=0.0002,
        )
        self.assertEqual(specs[0].n_layers, 10)
        self.assertAlmostEqual(specs[0].thickness_m, 0.0254)
        self.assertEqual(specs[0].specify, "total")
        self.assertTrue(specs[0].honor_absolute)

    def test_inflate_only_when_auto_off(self):
        specs = layer_specs_for_generate(
            wall_patches=["walls", "inflate_1"],
            inflate=[
                type(
                    "I",
                    (),
                    {
                        "patch_name": "inflate_1",
                        "n_layers": 4,
                        "thickness_m": 0.002,
                        "first_layer_m": None,
                        "expansion": 1.5,
                        "min_thickness_m": 0.0004,
                    },
                )()
            ],
            add_layers=False,
            default_n=3,
            default_thickness_m=0.001,
            default_expansion=1.5,
            default_min_m=0.0002,
        )
        self.assertEqual([s.name for s in specs], ["inflate_1"])
        self.assertEqual(specs[0].n_layers, 4)

    def test_cfmesh_named_inflate_not_star(self):
        text = boundary_layers_dict_text(
            wall_layers=0,
            extra_patch_layers={"inflate_1": 5},
        )
        self.assertIn("inflate_1", text)
        self.assertIn("nLayers 5", text)
        self.assertNotIn('".*"', text)

    def test_no_snappy_when_nothing_requested(self):
        d = Path(tempfile.mkdtemp())
        sizing = StandardSizing.automatic((0.1, 0.1, 0.1), fineness=5)
        write_layers_case(d, wall_patches=["walls"], sizing=sizing, add_layers=False)
        self.assertFalse((d / "system" / "snappyHexMeshDict").exists())

    def test_typed_total_relaxes_snappy_stop_ratios(self):
        d = Path(tempfile.mkdtemp())
        sizing = StandardSizing.automatic((0.1, 0.1, 0.1), fineness=5)
        write_layers_case(
            d,
            wall_patches=["inflate_1"],
            sizing=sizing,
            add_layers=True,
            layer_specs=[
                LayerPatchSpec(
                    name="inflate_1",
                    n_layers=10,
                    thickness_m=0.0254,
                    expansion=1.2,
                    specify="total",
                    honor_absolute=True,
                )
            ],
        )
        text = (d / "system" / "snappyHexMeshDict").read_text(encoding="utf-8")
        self.assertIn("thickness 0.0254", text)
        self.assertIn("nSurfaceLayers 10", text)
        self.assertIn("maxFaceThicknessRatio 10", text)
        self.assertIn("maxThicknessToMedialRatio 3", text)

    def test_auto_layers_keep_conservative_stop_ratios(self):
        d = Path(tempfile.mkdtemp())
        sizing = StandardSizing.automatic((0.1, 0.1, 0.1), fineness=5)
        write_layers_case(
            d,
            wall_patches=["walls"],
            sizing=sizing,
            add_layers=True,
            layer_specs=[
                LayerPatchSpec(
                    name="walls",
                    n_layers=3,
                    thickness_m=0.004,
                    expansion=1.5,
                    specify="total",
                )
            ],
        )
        text = (d / "system" / "snappyHexMeshDict").read_text(encoding="utf-8")
        self.assertIn("maxFaceThicknessRatio 0.5", text)
        self.assertIn("maxThicknessToMedialRatio 0.3", text)


if __name__ == "__main__":
    unittest.main()
