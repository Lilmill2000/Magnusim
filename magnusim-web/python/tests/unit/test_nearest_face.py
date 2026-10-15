"""cfddesk.cad.nearest_face: the CAD face a point lies on (Force result controls)."""

from __future__ import annotations

import numpy as np

from cfddesk.cad.nearest_face import FaceIndex, point_triangle_distance2, subdivided
from cfddesk.project.case_services import CaseServices


def _brute(points: np.ndarray, tris: np.ndarray, fids: np.ndarray, query: np.ndarray) -> np.ndarray:
    c = points[tris]
    out = []
    for q in query:
        qq = np.repeat(q[None, :], len(c), axis=0)
        out.append(fids[int(np.argmin(point_triangle_distance2(qq, c[:, 0], c[:, 1], c[:, 2])))])
    return np.array(out)


def _cube() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """A unit cube as two big triangles per face; face ids 0..5 (x0, x1, y0, y1, z0, z1)."""
    v = np.array([[x, y, z] for z in (0, 1) for y in (0, 1) for x in (0, 1)], dtype=float)
    quads = [(0, 2, 6, 4), (1, 3, 7, 5), (0, 1, 5, 4), (2, 3, 7, 6), (0, 1, 3, 2), (4, 5, 7, 6)]
    tris, fids = [], []
    for f, (a, b, c, d) in enumerate(quads):
        tris += [(a, b, c), (a, c, d)]
        fids += [f, f]
    return v, np.array(tris), np.array(fids)


def test_the_distance_to_a_triangle_in_each_region() -> None:
    a, b, c = np.array([[0.0, 0, 0]]), np.array([[1.0, 0, 0]]), np.array([[0.0, 1, 0]])
    cases = {
        (0.2, 0.2, 1.0): 1.0,  # above the face
        (-1.0, -1.0, 0.0): 2.0,  # past corner a
        (2.0, 0.0, 0.0): 1.0,  # past corner b
        (0.0, 3.0, 0.0): 4.0,  # past corner c
        (0.5, -1.0, 0.0): 1.0,  # beside edge ab
        (-2.0, 0.5, 0.0): 4.0,  # beside edge ac
        (1.0, 1.0, 0.0): 0.5,  # beside edge bc
    }
    for p, want in cases.items():
        got = point_triangle_distance2(np.array([p]), a, b, c)[0]
        assert abs(got - want) < 1e-12, (p, got, want)


def test_points_on_a_cube_land_on_their_own_face_even_near_its_edges() -> None:
    points, tris, fids = _cube()
    index = FaceIndex(points, tris, fids)
    eps = 0.01
    query = np.array(
        [
            [0.0, 0.5, 0.5],  # middle of x0
            [eps, eps * 2, 0.5],  # x0, near its edge with y0 (slightly inside the cube)
            [1.0, 0.99, 0.02],
            [0.5, 0.0, 0.98],
            [0.97, 1.0, 0.5],
            [0.5, 0.5, 0.0],
            [0.03, 0.97, 1.0],
        ]
    )
    query[1] = [0.0, eps, 0.5]
    assert index.nearest(query).tolist() == [0, 0, 1, 2, 3, 4, 5]


def test_the_index_agrees_with_brute_force_on_a_curved_part() -> None:
    rng = np.random.default_rng(3)
    # A cylinder's side (fine triangles) and its two flat caps (big triangles).
    n = 48
    ang = np.linspace(0, 2 * np.pi, n, endpoint=False)
    ring0 = np.c_[np.cos(ang), np.sin(ang), np.zeros(n)]
    ring1 = np.c_[np.cos(ang), np.sin(ang), np.full(n, 3.0)]
    points = np.vstack([ring0, ring1, [[0, 0, 0], [0, 0, 3.0]]])
    tris, fids = [], []
    for i in range(n):
        j = (i + 1) % n
        tris += [(i, j, n + j), (i, n + j, n + i)]
        fids += [i % 4, i % 4]  # four side faces
        tris += [(2 * n, j, i), (2 * n + 1, n + i, n + j)]
        fids += [4, 5]
    tris, fids = np.array(tris), np.array(fids)
    # Points near the surface: on it, plus a little noise.
    pick = rng.integers(0, len(tris), 400)
    w = rng.dirichlet([1, 1, 1], 400)
    query = (points[tris[pick]] * w[:, :, None]).sum(1) + rng.normal(0, 0.005, (400, 3))
    index = FaceIndex(points, tris, fids)
    assert index.nearest(query).tolist() == _brute(points, tris, fids, query).tolist()


def test_big_triangles_are_cut_until_each_is_small() -> None:
    points, tris, fids = _cube()
    corners, ids = subdivided(points, tris, fids, 0.1)
    g = corners.mean(axis=1)
    assert np.sqrt(((corners - g[:, None, :]) ** 2).sum(-1)).max() <= 0.1 + 1e-12
    assert sorted(set(ids.tolist())) == [0, 1, 2, 3, 4, 5]
    area = 0.5 * np.linalg.norm(np.cross(corners[:, 1] - corners[:, 0], corners[:, 2] - corners[:, 0]), axis=1)
    assert abs(area.sum() - 6.0) < 1e-9


def test_case_services_give_web_face_numbers(tmp_path) -> None:
    services = CaseServices(tmp_path, None, None)
    points, tris, fids = _cube()
    services._tess = (points, tris, fids)
    assert services.nearest_face_numbers([[0.0, 0.5, 0.5], [0.5, 0.5, 1.0]]).tolist() == [1, 6]
    services._tess = False
    assert services.nearest_face_numbers([[0.0, 0.5, 0.5]]).tolist() == [0]
    services._tess = (points, tris, fids)
    lo, hi = services.face_bounds([2])
    assert lo.tolist() == [1.0, 0.0, 0.0] and hi.tolist() == [1.0, 1.0, 1.0]
    assert services.face_bounds([9]) is None
