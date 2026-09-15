"""Prism skin on a body-fitted surface mesh (nodes stay on STEP)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from cfddesk.cad.step import LoadedSolid
from cfddesk.mesh.octree_hex import SolidIn


@dataclass(frozen=True)
class PrismSkin:
    """Stacked prisms. Layer 0 is the CAD surface (on STEP)."""

    nodes: np.ndarray  # (n_surf * (n_layers+1), 3) — layer-major
    prisms: np.ndarray  # (n, 6) into ``nodes``
    cap_nodes: np.ndarray  # last layer, same count/order as layer 0
    cap_tris: np.ndarray  # same connectivity as the input surface tris
    n_layers: int
    height_p50_m: float
    height_min_m: float
    n_skipped: int
    n_twisted_shrunk: int = 0


def _tri_normals(nodes: np.ndarray, tris: np.ndarray) -> np.ndarray:
    p0 = nodes[tris[:, 0]]
    p1 = nodes[tris[:, 1]]
    p2 = nodes[tris[:, 2]]
    n = np.cross(p1 - p0, p2 - p0)
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    ln = np.maximum(ln, 1e-18)
    return n / ln


def _inward_node_normals(
    nodes: np.ndarray,
    tris: np.ndarray,
    solid: LoadedSolid,
    scale_to_metres: float,
) -> np.ndarray:
    """Area-weighted normals flipped so a short step lands inside the solid."""
    fn = _tri_normals(nodes, tris)
    acc = np.zeros_like(nodes)
    wt = np.zeros(len(nodes))
    p0 = nodes[tris[:, 0]]
    p1 = nodes[tris[:, 1]]
    p2 = nodes[tris[:, 2]]
    area = 0.5 * np.linalg.norm(np.cross(p1 - p0, p2 - p0), axis=1)
    for t, a, nrm in zip(tris, area, fn):
        for i in t:
            acc[int(i)] += nrm * float(a)
            wt[int(i)] += float(a)
    wt = np.maximum(wt, 1e-18)
    nrm = acc / wt[:, None]
    ln = np.linalg.norm(nrm, axis=1, keepdims=True)
    nrm = nrm / np.maximum(ln, 1e-18)
    inside = SolidIn(solid, scale_to_metres)
    probe = 1.0e-4
    for i, p in enumerate(nodes):
        cand = p + nrm[i] * probe
        if not inside.inside(cand):
            nrm[i] = -nrm[i]
    return nrm


def _min_edge_per_node(nodes: np.ndarray, tris: np.ndarray) -> np.ndarray:
    mn = np.full(len(nodes), np.inf)
    for a, b, c in tris:
        for i, j in ((int(a), int(b)), (int(b), int(c)), (int(c), int(a))):
            d = float(np.linalg.norm(nodes[i] - nodes[j]))
            if d < mn[i]:
                mn[i] = d
            if d < mn[j]:
                mn[j] = d
    return np.where(np.isfinite(mn), mn, 0.0)


def _relax_heights(
    h: np.ndarray, tris: np.ndarray, *, n_iter: int = 6, mix: float = 0.40
) -> np.ndarray:
    """Blend each height toward its neighbors so ramps cannot invert a prism."""
    out = np.asarray(h, dtype=float).copy()
    adj: list[set[int]] = [set() for _ in range(len(out))]
    for a, b, c in tris:
        ia, ib, ic = int(a), int(b), int(c)
        adj[ia].update((ib, ic))
        adj[ib].update((ia, ic))
        adj[ic].update((ia, ib))
    w = max(min(float(mix), 0.9), 0.0)
    for _ in range(max(int(n_iter), 0)):
        nxt = out.copy()
        for i, nb in enumerate(adj):
            if not nb or out[i] <= 0.0:
                continue
            m = float(np.mean([out[j] for j in nb]))
            nxt[i] = (1.0 - w) * out[i] + w * m
        out = nxt
    return out


def _face_centre_area(face: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Face centre and Newell area (OpenFOAM ``face::area``)."""
    pts = np.asarray(face, dtype=float)
    n = len(pts)
    acc = np.zeros(3)
    for i in range(n):
        a = pts[i]
        b = pts[(i + 1) % n]
        acc[0] += (a[1] - b[1]) * (a[2] + b[2])
        acc[1] += (a[2] - b[2]) * (a[0] + b[0])
        acc[2] += (a[0] - b[0]) * (a[1] + b[1])
    return pts.mean(axis=0), 0.5 * acc


def _prism_of_pyramid_vols(pts: np.ndarray) -> np.ndarray:
    """OpenFOAM-style ``Sf · (Cf − Cc)`` on outward gmsh-prism faces.

    gmshToFoam inverts the cell when any of these is negative.
    """
    p = np.asarray(pts, dtype=float).reshape(6, 3)
    ctr = p.mean(axis=0)
    # Outward: base away from cap, top away from base, quads right-handed.
    faces = (
        p[[0, 2, 1]],
        p[[3, 4, 5]],
        p[[0, 1, 4, 3]],
        p[[1, 2, 5, 4]],
        p[[2, 0, 3, 5]],
    )
    vols = []
    for face in faces:
        cf, sf = _face_centre_area(face)
        vols.append(float(np.dot(sf, cf - ctr)))
    return np.asarray(vols, dtype=float)


def prism_is_twisted(pts: np.ndarray) -> bool:
    """True when gmshToFoam would invert this prism (negative face pyramid)."""
    arr = _prism_of_pyramid_vols(pts)
    scale = float(np.max(np.abs(arr)))
    if scale < 1e-30:
        return True
    return bool(np.min(arr) < -1e-8 * scale)


def count_twisted_prisms(nodes: np.ndarray, prisms: np.ndarray) -> int:
    if prisms is None or len(prisms) == 0:
        return 0
    n = 0
    pts = np.asarray(nodes, dtype=float)
    for pr in prisms:
        if prism_is_twisted(pts[np.asarray(pr, dtype=np.int64)]):
            n += 1
    return n


def _clip_height_spikes(
    h: np.ndarray, tris: np.ndarray, *, n_iter: int = 6, ratio: float = 1.25
) -> np.ndarray:
    """Pull isolated tall nodes down so neighboring offsets cannot cross."""
    out = np.asarray(h, dtype=float).copy()
    for _ in range(max(int(n_iter), 0)):
        neigh_max = np.zeros(len(out))
        for a, b, c in tris:
            ia, ib, ic = int(a), int(b), int(c)
            neigh_max[ia] = max(neigh_max[ia], out[ib], out[ic])
            neigh_max[ib] = max(neigh_max[ib], out[ia], out[ic])
            neigh_max[ic] = max(neigh_max[ic], out[ia], out[ib])
        out = np.minimum(out, neigh_max * float(ratio))
    return out


def _safe_heights(
    nodes: np.ndarray,
    normals: np.ndarray,
    *,
    want_m: float,
    solid: LoadedSolid,
    scale_to_metres: float,
    surface_points: np.ndarray,
) -> np.ndarray:
    """Per-node total height that stays inside and does not punch a thin wall."""
    from scipy.spatial import cKDTree

    tree = cKDTree(np.asarray(surface_points, dtype=float))
    inside = SolidIn(solid, scale_to_metres)
    want = max(float(want_m), 1e-6)
    out = np.zeros(len(nodes))
    samples = (1.0, 0.75, 0.5, 0.35, 0.2)
    for i, (p, n) in enumerate(zip(nodes, normals)):
        ok = 0.0
        for frac in samples:
            h = want * frac
            q = p + n * h
            if not inside.inside(q):
                continue
            d = float(tree.query(q, k=1)[0])
            if d < 0.55 * h:
                continue
            ok = h
            break
        out[i] = ok
    return out


def build_prism_skin(
    nodes: np.ndarray,
    tris: np.ndarray,
    solid: LoadedSolid,
    *,
    scale_to_metres: float,
    height_m: float,
    n_layers: int = 3,
    growth: float = 1.2,
) -> PrismSkin:
    """Extrude every surface triangle inward. Bases stay on the CAD nodes."""
    nodes = np.asarray(nodes, dtype=float)
    tris = np.asarray(tris, dtype=np.int64)
    n_lay = max(int(n_layers), 1)
    g = max(float(growth), 1.0)
    nrm = _inward_node_normals(nodes, tris, solid, scale_to_metres)
    h = _safe_heights(
        nodes,
        nrm,
        want_m=height_m,
        solid=solid,
        scale_to_metres=scale_to_metres,
        surface_points=nodes,
    )
    # Node-normal extrusion folds at sharp corners when h ≳ edge length
    # (physics fields can make surface edges ≪ skin). Cap self-intersections
    # then make TetGen report "segment and a facet intersect".
    edge = _min_edge_per_node(nodes, tris)
    h = np.minimum(h, 0.22 * edge)
    h = _clip_height_spikes(h, tris)
    h = _relax_heights(h, tris)
    h = np.minimum(h, 0.22 * edge)
    cad_n = _tri_normals(nodes, tris)
    for _ in range(4):
        cap_try = nodes + nrm * h[:, None]
        cap_n = _tri_normals(cap_try, tris)
        dots = np.einsum("ij,ij->i", cap_n, cad_n)
        bad = dots < 0.20
        if not bool(np.any(bad)):
            break
        for a, b, c in tris[bad]:
            h[int(a)] *= 0.6
            h[int(b)] *= 0.6
            h[int(c)] *= 0.6
    # Layer fractions 0 .. 1 (inclusive).
    if abs(g - 1.0) < 1e-12:
        fracs = np.linspace(0.0, 1.0, n_lay + 1)
    else:
        raw = np.array([(g**k - 1.0) / (g**n_lay - 1.0) for k in range(n_lay + 1)])
        fracs = raw

    n_s = len(nodes)
    n_shrunk = 0

    def _stack(hh: np.ndarray) -> np.ndarray:
        layers = [nodes]
        for frac in fracs[1:]:
            layers.append(nodes + nrm * (hh[:, None] * float(frac)))
        return np.vstack(layers)

    def lid(i: int, k: int) -> int:
        return int(i) if k == 0 else n_s * k + int(i)

    def _emit(all_nodes: np.ndarray, hh: np.ndarray) -> tuple[list[list[int]], int, list[int]]:
        prisms: list[list[int]] = []
        n_skip = 0
        twisted_nodes: list[int] = []
        for a, b, c in tris:
            ia, ib, ic = int(a), int(b), int(c)
            if max(hh[ia], hh[ib], hh[ic]) < 1e-7:
                n_skip += 1
                continue
            for k in range(n_lay):
                b0, b1, b2 = lid(ia, k), lid(ib, k), lid(ic, k)
                t0, t1, t2 = lid(ia, k + 1), lid(ib, k + 1), lid(ic, k + 1)
                p0, p1, p2 = all_nodes[b0], all_nodes[b1], all_nodes[b2]
                cap = (all_nodes[t0] + all_nodes[t1] + all_nodes[t2]) / 3.0
                base = (p0 + p1 + p2) / 3.0
                ntri = np.cross(p1 - p0, p2 - p0)
                if float(np.dot(ntri, cap - base)) < 0:
                    conn = [b0, b2, b1, t0, t2, t1]
                else:
                    conn = [b0, b1, b2, t0, t1, t2]
                if prism_is_twisted(all_nodes[np.asarray(conn, dtype=np.int64)]):
                    twisted_nodes.extend((ia, ib, ic))
                prisms.append(conn)
        return prisms, n_skip, twisted_nodes

    all_nodes = _stack(h)
    prisms, n_skip, twisted = _emit(all_nodes, h)
    for _ in range(8):
        if not twisted:
            break
        uniq = sorted(set(twisted))
        h[np.asarray(uniq, dtype=np.int64)] *= 0.55
        n_shrunk += len(uniq)
        all_nodes = _stack(h)
        prisms, n_skip, twisted = _emit(all_nodes, h)
    if twisted:
        raise RuntimeError(
            f"body-fit: {len(set(twisted))} nodes still make twisted prisms"
        )
    if not prisms:
        raise RuntimeError("body-fit: prism skin collapsed (thin-wall heights)")
    cap = all_nodes[n_s * n_lay : n_s * (n_lay + 1)]
    nz = h[h > 0]
    return PrismSkin(
        nodes=all_nodes,
        prisms=np.asarray(prisms, dtype=np.int64),
        cap_nodes=cap,
        cap_tris=tris.copy(),
        n_layers=n_lay,
        height_p50_m=float(np.median(nz)) if len(nz) else 0.0,
        height_min_m=float(np.min(h)),
        n_skipped=n_skip,
        n_twisted_shrunk=n_shrunk,
    )


def prism_height_budget_m(skin_m: float, gap_sizes_m: list[float] | None) -> float:
    """Total prism stack: ~0.35×skin, but never more than ~1/3 of a thin gap."""
    want = 0.25 * max(float(skin_m), 1e-6)
    if gap_sizes_m:
        want = min(want, 0.33 * min(max(float(g), 1e-6) for g in gap_sizes_m))
    return max(want, 1e-6)
