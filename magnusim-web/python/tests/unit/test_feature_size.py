"""Standard mesher: automatic refinement around small features, and boundary
layers sized by the local cells (cfddesk.mesh.feature_size, standard_hexcore).

Synthetic parts only: a cube, a box with a thin slot of fluid, a box with a thin
sheet cut out of it, a field of point features. The real part that asked for
this is a perforated plate with louver tabs (6,534 faces); these check the
rules it relies on.
"""

from __future__ import annotations

import math

import numpy as np
import pytest


def _cube_surface(n: int = 4, size: float = 1.0, origin=(0.0, 0.0, 0.0)):
    """A closed triangulated cube (outward normals), n x n quads a side."""
    o = np.asarray(origin, dtype=float)
    nodes: list[tuple[float, float, float]] = []
    index: dict[tuple[int, int, int], int] = {}

    def node(i, j, k):
        key = (i, j, k)
        if key not in index:
            index[key] = len(nodes)
            nodes.append(tuple(o + size * np.array([i, j, k], dtype=float) / n))
        return index[key]

    tris = []
    for axis in range(3):
        for side in (0, n):
            def at(u, v, axis=axis, side=side):
                c = [0, 0, 0]
                c[axis] = side
                c[(axis + 1) % 3] = u
                c[(axis + 2) % 3] = v
                return node(*c)

            for a in range(n):
                for b in range(n):
                    q = [at(a, b), at(a + 1, b), at(a + 1, b + 1), at(a, b + 1)]
                    if side == 0:
                        q = q[::-1]
                    tris += [(q[0], q[1], q[2]), (q[0], q[2], q[3])]
    return np.asarray(nodes, dtype=float), np.asarray(tris, dtype=np.int64)


# --------------------------------------------------------------- the field ----


def test_size_grows_from_a_source_at_the_gradation_rate():
    from cfddesk.mesh.feature_size import GradedSize, SizeSources

    src = SizeSources(np.zeros((1, 3)), np.array([1.0]))
    f = GradedSize(src, h=10.0, floor=0.5, slope=0.2)
    d = np.array([0.0, 1.0, 5.0, 20.0, 45.0, 100.0])
    got = f(np.column_stack([d, np.zeros_like(d), np.zeros_like(d)]))
    want = np.minimum(10.0, 1.0 + 0.2 * d)
    # A source's size is rounded down to a quarter octave above the floor.
    assert np.all(got <= want + 1e-12)
    assert np.all(got >= np.minimum(10.0, 2 ** -0.25 * 1.0 + 0.2 * d) - 1e-12)
    assert got[-1] == pytest.approx(10.0)
    # neighbouring cells differ by at most the gradation
    x = np.linspace(0, 60, 601)
    s = f(np.column_stack([x, np.zeros_like(x), np.zeros_like(x)]))
    assert np.all(np.abs(np.diff(s)) <= 0.2 * np.diff(x) + 1e-9)


def test_floor_and_h_bound_the_field():
    from cfddesk.mesh.feature_size import GradedSize, SizeSources

    src = SizeSources(np.array([[0.0, 0, 0], [5.0, 0, 0]]), np.array([0.01, 50.0]))
    f = GradedSize(src, h=10.0, floor=0.5, slope=0.2)
    s = f(np.array([[0.0, 0, 0], [5.0, 0, 0], [500.0, 0, 0]]))
    assert s[0] == pytest.approx(0.5)  # below the floor -> the floor
    assert s[1] == pytest.approx(min(10.0, 0.5 + 0.2 * 5.0))  # the big source asks for nothing
    assert s[2] == pytest.approx(10.0)
    empty = GradedSize(SizeSources.empty(), h=10.0, floor=0.5, slope=0.2)
    assert not empty
    assert np.all(empty(np.zeros((3, 3))) == 10.0)


def test_points_inside_a_closed_surface():
    from cfddesk.mesh.feature_size import points_inside

    nodes, tris = _cube_surface(5)
    rng = np.random.default_rng(1)
    pts = rng.uniform(-0.5, 1.5, size=(4000, 3))
    want = np.all((pts > 0) & (pts < 1), axis=1)
    got = points_inside(nodes, tris, pts, chunk=777)
    assert np.array_equal(got, want)


def test_octree_boxes_follow_the_size_and_the_estimate_counts_the_fluid():
    from cfddesk.mesh.feature_size import (
        TETS_PER_SIZE3,
        GradedSize,
        SizeSources,
        build_octree,
        estimate_cells,
    )

    nodes, tris = _cube_surface(4)
    h = 0.25
    uniform = GradedSize(SizeSources.empty(), h=h, floor=h, slope=0.22)
    tree = build_octree(uniform, nodes.min(0), nodes.max(0), box_per_size=1.0)
    assert np.allclose(tree.edge, h)
    inside = tree.inside(nodes, tris)
    # the unit cube at size h: 16 boxes of h^3 inside -> 6 tets per h^3 each
    assert estimate_cells(tree, inside) == pytest.approx(TETS_PER_SIZE3 / h**3, rel=0.01)

    pt = SizeSources(np.array([[0.5, 0.5, 0.5]]), np.array([0.01]))
    f = GradedSize(pt, h=h, floor=0.01, slope=0.22)
    tree = build_octree(f, nodes.min(0), nodes.max(0), box_per_size=1.0)
    centre = tree.lo + 0.5 * tree.edge[:, None]
    # every box is no larger than the size at its centre (down to half the floor)
    assert np.all((tree.edge <= tree.centre_size + 1e-12) | (tree.edge <= 0.01))
    near = np.linalg.norm(centre - 0.5, axis=1) < 0.02
    assert tree.edge[near].max() <= 0.02
    assert estimate_cells(tree, tree.inside(nodes, tris)) > estimate_cells(
        build_octree(uniform, nodes.min(0), nodes.max(0)), inside
    )


# ------------------------------------------------------ sources on the CAD ----


def _occ_box_model(gmsh, parts):
    """A gmsh OCC model: the first box minus the others (mm)."""
    gmsh.model.add("t")
    occ = gmsh.model.occ
    boxes = [occ.addBox(*p) for p in parts]
    if len(boxes) > 1:
        occ.cut([(3, boxes[0])], [(3, b) for b in boxes[1:]])
    occ.synchronize()
    vols = gmsh.model.getEntities(3)
    return sorted({int(t) for _d, v in vols for t in gmsh.model.getAdjacencies(3, v)[1]})


@pytest.fixture
def gmsh_session():
    import gmsh

    from cfddesk.mesh.gmsh_standard import initialize_gmsh

    initialize_gmsh(gmsh)
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        yield gmsh
    finally:
        gmsh.finalize()


def _surface(gmsh, surfs, h):
    from cfddesk.mesh.standard_hexcore import _collect_surface

    gmsh.option.setNumber("Mesh.MeshSizeMin", 0.5 * h)
    gmsh.option.setNumber("Mesh.MeshSizeMax", h)
    gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
    gmsh.model.mesh.generate(2)
    nodes, tris, _p = _collect_surface(gmsh, surfs, {s: 1 for s in surfs})
    return nodes, tris


def test_short_curves_and_narrow_faces_are_sources(gmsh_session):
    from cfddesk.mesh.feature_size import cad_sources

    gmsh = gmsh_session
    # a 100 mm box with a 2 mm x 30 mm notch cut into one edge
    surfs = _occ_box_model(gmsh, [(0, 0, 0, 100, 100, 100), (40, -1, 98, 70, 101, 101)])
    src = cad_sources(gmsh, surfs, h=40.0, spacing=2.5)
    assert src.n_curves > 0 and src.n_faces > 0
    # the notch's 2 mm edges and its 2 mm wide faces ask for 2 mm
    assert src.sizes.min() == pytest.approx(2.0, rel=0.03)  # width = 2 area / perimeter
    assert np.all(src.points[:, 2] >= 98.0 - 1e-6)
    # sampled no further apart than the spacing along each feature curve
    assert len(src) >= 30 / 2.5


def test_plain_box_has_no_feature(gmsh_session):
    from cfddesk.mesh.feature_size import cad_sources, fluid_gap_sources

    gmsh = gmsh_session
    surfs = _occ_box_model(gmsh, [(0, 0, 0, 100, 100, 100)])
    assert not len(cad_sources(gmsh, surfs, h=40.0, spacing=2.5))
    nodes, tris = _surface(gmsh, surfs, 40.0)
    assert not len(fluid_gap_sources(nodes, tris, h=40.0))


def test_a_thin_slot_of_fluid_is_a_gap_and_a_thin_sheet_is_not(gmsh_session):
    from cfddesk.mesh.feature_size import fluid_gap_sources

    gmsh = gmsh_session
    h = 40.0
    # fluid: a 200 x 200 x 6 mm slab -- walls 6 mm apart with fluid between
    surfs = _occ_box_model(gmsh, [(0, 0, 0, 200, 200, 6)])
    nodes, tris = _surface(gmsh, surfs, h)
    gaps = fluid_gap_sources(nodes, tris, h=h)
    assert gaps.n_gaps > 0
    assert np.allclose(gaps.sizes, 6.0, rtol=0.02)

    gmsh.model.remove()
    # fluid: a 200 mm box with a 6 mm sheet cut out of it (a baffle): solid between
    surfs = _occ_box_model(gmsh, [(0, 0, 0, 200, 200, 200), (40, 40, 97, 160, 160, 103)])
    nodes, tris = _surface(gmsh, surfs, h)
    assert fluid_gap_sources(nodes, tris, h=h).n_gaps == 0


def test_budget_raises_the_floor(gmsh_session, monkeypatch):
    from cfddesk.mesh import feature_size as fs

    gmsh = gmsh_session
    h = 20.0
    # a 100 mm box with many 1 mm notches along its top edges
    notches = [(x, -1, 99, x + 1, 101, 101) for x in range(5, 95, 6)]
    surfs = _occ_box_model(gmsh, [(0, 0, 0, 100, 100, 100), *notches])
    nodes, tris = _surface(gmsh, surfs, h)
    monkeypatch.setattr(fs, "CELL_BUDGET", 1e9)
    free = fs.plan_feature_refinement(gmsh, surfs, nodes, tris, h=h, gradation=1.22, small_feature_m=0.0)
    assert free is not None
    assert free.floor == pytest.approx(h / 2**fs.FLOOR_HALVINGS)
    budget = 0.5 * free.estimate / free.uniform_estimate
    monkeypatch.setattr(fs, "CELL_BUDGET", budget)
    tight = fs.plan_feature_refinement(gmsh, surfs, nodes, tris, h=h, gradation=1.22, small_feature_m=0.0)
    assert tight is not None
    assert tight.floor > free.floor
    assert tight.estimate <= budget * tight.uniform_estimate or tight.floor * fs.FLOOR_STEP >= fs.FEATURE_FRACTION * h
    assert "raised from" in tight.note


def test_small_feature_suppression_sets_the_floor(gmsh_session, monkeypatch):
    from cfddesk.mesh import feature_size as fs

    gmsh = gmsh_session
    monkeypatch.setattr(fs, "CELL_BUDGET", 1e9)
    surfs = _occ_box_model(gmsh, [(0, 0, 0, 100, 100, 100), (40, -1, 98, 70, 101, 101)])
    nodes, tris = _surface(gmsh, surfs, 40.0)
    plan = fs.plan_feature_refinement(gmsh, surfs, nodes, tris, h=40.0, gradation=1.22, small_feature_m=4.0)
    assert plan is not None and plan.floor == pytest.approx(4.0)
    # suppression above half of h: nothing is refined
    assert fs.plan_feature_refinement(gmsh, surfs, nodes, tris, h=40.0, gradation=1.22, small_feature_m=25.0) is None


# ------------------------------------------------------------ layer bands -----


def test_layer_bands_follow_the_local_triangle_size():
    from cfddesk.mesh.standard_hexcore import layer_band_size, layer_size_bands

    coarse_n, coarse_t = _cube_surface(4, size=1.0)
    fine_n, fine_t = _cube_surface(16, size=1.0, origin=(5.0, 0.0, 0.0))
    nodes = np.vstack([coarse_n, fine_n])
    tris = np.vstack([coarse_t, fine_t + len(coarse_n)])
    h = 0.25
    band = layer_size_bands(nodes, tris, h)
    # mean edge of the coarse cube ~ 0.29 (sides 0.25, diagonals 0.35): band 0
    assert set(band[: len(coarse_t)].tolist()) == {0}
    # the fine cube is 4x smaller: four half-octave bands down
    assert set(band[len(coarse_t):].tolist()) == {4}
    assert layer_band_size(h, 4) == pytest.approx(h / 4)


def test_split_layer_bands_and_their_layer_specs(tmp_path):
    from cfddesk.mesh import standard_hexcore as sh

    coarse_n, coarse_t = _cube_surface(4, size=1.0)
    fine_n, fine_t = _cube_surface(16, size=1.0, origin=(5.0, 0.0, 0.0))
    nodes = np.vstack([coarse_n, fine_n])
    tris = np.vstack([coarse_t, fine_t + len(coarse_n)])
    tri_phys = np.concatenate([np.full(len(coarse_t), 1), np.full(len(fine_t), 2)])
    names = {1: (2, "walls"), 2: (2, "inlet"), 100: (3, "fluid")}
    tri_phys[len(coarse_t):][:10] = 1  # some fine triangles in walls, the rest inlet
    bands = sh.split_layer_bands(nodes, tris, tri_phys, {"walls": 1}, names, h=0.25)
    assert list(bands) == ["walls"]
    [(bname, size)] = bands["walls"]
    assert bname == "walls_bl4" and size == pytest.approx(0.0625)
    bid = next(k for k, v in names.items() if v[1] == bname)
    assert bid > 100
    assert (tri_phys == bid).sum() == 10
    assert (tri_phys == 1).sum() == len(coarse_t)
    assert (tri_phys == 2).sum() == len(fine_t) - 10

    specs = [
        sh.LayerPatchSpec(name="walls", n_layers=3, thickness_m=0.1, expansion=1.5, min_thickness_m=0.02, automatic=True),
        sh.LayerPatchSpec(name="inflated", n_layers=5, thickness_m=0.004, expansion=1.2, honor_absolute=True),
    ]
    out = sh.band_layer_specs(specs, {**bands, "inflated": [("inflated_bl2", 0.1)]})
    by = {s.name: s for s in out}
    assert set(by) == {"walls", "walls_bl4", "inflated"}  # typed Inflate keeps its thickness
    assert by["walls_bl4"].thickness_m == pytest.approx(sh.BL_RELATIVE_THICKNESS * 0.0625)
    assert by["walls_bl4"].min_thickness_m == pytest.approx(sh.BL_MIN_THICKNESS_FRACTION * by["walls_bl4"].thickness_m)
    assert by["walls_bl4"].n_layers == 3 and by["walls_bl4"].expansion == 1.5

    sh.write_band_merge(tmp_path, bands)
    text = (tmp_path / "system" / "createPatchDict").read_text(encoding="ascii")
    assert "name walls;" in text and "patches (walls walls_bl4);" in text
    sh.write_band_merge(tmp_path, {})
    assert not (tmp_path / "system" / "createPatchDict").exists()


def test_uniform_walls_get_no_bands():
    from cfddesk.mesh import standard_hexcore as sh

    nodes, tris = _cube_surface(4)
    tri_phys = np.ones(len(tris), dtype=np.int64)
    names = {1: (2, "walls")}
    assert sh.split_layer_bands(nodes, tris, tri_phys, {"walls": 1}, names, h=0.25) == {}
    assert names == {1: (2, "walls")}


def test_automatic_layers_are_marked_relative():
    from cfddesk.mesh.web_refinements import layer_specs_for_generate

    specs = layer_specs_for_generate(
        wall_patches=["walls"], inflate=[], add_layers=True, default_n=3,
        default_thickness_m=0.01, default_expansion=1.5, default_min_m=0.002,
    )
    assert [s.automatic for s in specs] == [True]
    assert math.isclose(specs[0].thickness_m, 0.01)
