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
