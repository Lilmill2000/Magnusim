"""Short facet edges collapse; edges of a real face stay."""
import numpy as np

from cfddesk.mesh.standard_hexcore import _collapse_short_edges


def test_short_edge_collapses_and_keeps_patch():
    nodes = np.array(
        [
            [0.0, 0.0, 0.0],
            [1.0e-5, 0.0, 0.0],  # 0.01 mm from node 0
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
        ]
    )
    tris = np.array([[0, 1, 2], [0, 3, 4]])
    phys = np.array([7, 3])
    out_nodes, out_tris, out_phys, n = _collapse_short_edges(nodes, tris, phys, 1.0e-4)
    assert n == 1
    assert len(out_tris) == 1
    assert list(out_phys) == [3]


def test_long_edges_are_unchanged():
    nodes = np.array([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
    tris = np.array([[0, 1, 2]])
    phys = np.array([1])
    out_nodes, out_tris, out_phys, n = _collapse_short_edges(nodes, tris, phys, 1.0e-4)
    assert n == 0
    assert len(out_nodes) == 3
    assert len(out_tris) == 1
    assert list(out_phys) == [1]


def _has(points, xyz) -> bool:
    return bool(np.any(np.all(np.isclose(points, xyz, rtol=0.0, atol=1e-12), axis=1)))


def test_rim_node_stays_when_an_inner_node_collapses_onto_it():
    # Node 1 is on patches 7 and 3 (a port rim); node 0 is inside patch 7, 0.05 mm away.
    # The rim must not move into patch 7: node 0 merges onto node 1, not the reverse.
    nodes = np.array(
        [
            [5.0e-5, 0.0, 0.0],  # 0 inner, patch 7
            [0.0, 0.0, 0.0],  # 1 rim, patches 7 and 3
            [0.0, 1.0, 0.0],  # 2 patch 7
            [-1.0, 0.0, 0.0],  # 3 patch 3
            [-1.0, -1.0, 0.0],  # 4 patch 3
        ]
    )
    tris = np.array([[0, 1, 2], [1, 3, 4]])
    phys = np.array([7, 3])
    out_nodes, out_tris, out_phys, n = _collapse_short_edges(nodes, tris, phys, 1.0e-4)
    assert n == 1
    assert _has(out_nodes, [0.0, 0.0, 0.0])
    assert not _has(out_nodes, [5.0e-5, 0.0, 0.0])
    assert list(out_phys) == [3]


def test_nodes_on_different_patch_pairs_are_not_merged():
    # Node 0 is on patches 7 and 3, node 1 on patches 7 and 5: merging them would
    # fold patch 3 into patch 5 at that corner, so the short edge is left alone.
    nodes = np.array(
        [
            [0.0, 0.0, 0.0],  # 0 patches 7, 3
            [5.0e-5, 0.0, 0.0],  # 1 patches 7, 5
            [0.0, 1.0, 0.0],  # 2 patch 7
            [-1.0, 0.0, 0.0],  # 3 patch 3
            [-1.0, -1.0, 0.0],  # 4 patch 3
            [1.0, 0.0, 0.0],  # 5 patch 5
            [1.0, -1.0, 0.0],  # 6 patch 5
        ]
    )
    tris = np.array([[0, 1, 2], [0, 3, 4], [1, 5, 6]])
    phys = np.array([7, 3, 5])
    out_nodes, out_tris, out_phys, n = _collapse_short_edges(nodes, tris, phys, 1.0e-4)
    assert n == 0
    assert len(out_tris) == 3
    # Without the patch rule the old behaviour (merge) is still available.
    _, _, _, n_any = _collapse_short_edges(nodes, tris, phys, 1.0e-4, respect_patches=False)
    assert n_any == 1
