"""Body-fitted hexcore: OCC surface + Cartesian hex flood + Delaunay peel."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from cfddesk.cad.gaps import hexcore_gap_controls
from cfddesk.cad.step import LoadedSolid
from cfddesk.cad.surface_fit import (
    distances_to_faces_m,
    summarize_vertex_distances,
)
from cfddesk.cad.volume import solid_volume_native
from cfddesk.mesh.bodyfit_prisms import (
    build_prism_skin,
    count_twisted_prisms,
    prism_height_budget_m,
)
from cfddesk.mesh.cfmesh_standard import sizing_from_base_cell, skin_thickness_m
from cfddesk.mesh.gmsh_standard import run_gmsh_surface_mesh, write_scaled_step
from cfddesk.mesh.msh22 import HEX, PRISM, PYR, TET, TRI, write_msh22
from cfddesk.mesh.octree_hex import (
    HexCore,
    build_hex_core,
    hex_boundary_quads,
    hex_volume_m3,
)
from cfddesk.project.model import Project
from cfddesk.project.settings import MeshRefinement

MIN_HEX_VOLUME_FRAC = 0.50
# Peel measured from the prism *caps* (or CAD if prisms fail), in tet-cell units.
# 2–3 layers is the target wrap; deeper values are fallbacks.
PEEL_TET_MULTS = (2.0, 2.5, 3.0, 4.0, 5.0)
# Cube half-diagonal is 0.866×pitch. Peel from caps must beat that plus the
# pyramid tent or TetGen reports "segment and facet intersect".
PEEL_HEX_MULTS_PRISM = (1.15, 1.35, 1.60, 2.00)
TET_LC_OF_SKIN = 1.0 / 3.0
PRISM_LAYERS = 3
PRISM_GROWTH = 1.2


def _peel_schedule(hex_pitch: float, tet_lc: float, *, prisms: bool) -> list[float]:
    pitch = max(float(hex_pitch), 1e-6)
    lc = max(float(tet_lc), 1e-6)
    if prisms:
        floor = 1.15 * pitch
        raw = [max(m * lc, floor) for m in PEEL_TET_MULTS]
        raw.extend(m * pitch for m in PEEL_HEX_MULTS_PRISM)
    else:
        raw = [max(m * lc, 0.65 * pitch) for m in PEEL_TET_MULTS]
    out: list[float] = []
    for p in sorted(raw):
        if not out or p > out[-1] * 1.04:
            out.append(p)
    return out


@dataclass(frozen=True)
class BodyfitResult:
    msh_path: Path
    surface_msh_path: Path
    n_hex: int
    n_pyr: int
    n_prism: int
    n_tet: int
    n_nodes: int
    hex_volume_frac: float
    peel_m: float
    cell_m: float
    surface_gate_ok: bool
    surface_gate_msg: str
    watertight: bool
    log_text: str


def _extra_face_sizes(solid: LoadedSolid, project: Project, skin_cell_m: float) -> dict[int, float]:
    refs, _objs, _thin = hexcore_gap_controls(
        solid, project, skin_cell_m=float(skin_cell_m)
    )
    out: dict[int, float] = {}
    for ref in refs:
        for fid in ref.face_ids:
            prev = out.get(int(fid))
            if prev is None or ref.cell_size_m < prev:
                out[int(fid)] = float(ref.cell_size_m)
    return out


def _pyramid_on_quads(
    hex_nodes: np.ndarray,
    quads: np.ndarray,
    *,
    offset_m: float,
    solid: LoadedSolid,
    scale_to_metres: float,
    surface_points: np.ndarray,
    min_standoff_m: float = 0.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (apex_points, pyramids 5-node, side_tris) in hex-node index space.

    Apex indices start at ``len(hex_nodes)``. Side tris use those combined ids.
    Every peel quad gets a pyramid so the inner tent surface stays watertight.
    """
    from scipy.spatial import cKDTree

    from cfddesk.mesh.octree_hex import SolidIn

    tree = cKDTree(np.asarray(surface_points, dtype=float))
    inside = SolidIn(solid, scale_to_metres)
    apices: list[np.ndarray] = []
    pyrs: list[list[int]] = []
    sides: list[list[int]] = []
    n0 = len(hex_nodes)
    for q in quads:
        q = tuple(int(x) for x in q)
        pts = hex_nodes[np.asarray(q, dtype=np.int64)]
        center = pts.mean(axis=0)
        e1 = pts[1] - pts[0]
        e2 = pts[3] - pts[0]
        nrm = np.cross(e1, e2)
        ln = float(np.linalg.norm(nrm))
        if ln < 1e-18:
            continue
        nrm /= ln
        d_cad = float(tree.query(center, k=1)[0])
        stand = max(float(min_standoff_m), 1.35 * float(offset_m), 1e-6)
        if d_cad < stand:
            raise RuntimeError(
                "body-fit: pyramid apex could not sit in the peel cavity — "
                "need a deeper peel"
            )
        off0 = min(float(offset_m), 0.35 * max(d_cad, 1e-6))
        apex = None
        for frac in (1.0, 0.6, 0.35, 0.2, 0.1, 0.05):
            off = max(off0 * frac, 1e-6)
            cand = center + nrm * off
            if not inside.inside(cand):
                cand = center + nrm * (0.5 * off)
            if not inside.inside(cand):
                continue
            d_apex = float(tree.query(cand, k=1)[0])
            if d_apex < max(0.15 * off, 0.5 * min_standoff_m, 1e-6):
                continue
            apex = cand
            break
        if apex is None:
            raise RuntimeError(
                "body-fit: pyramid apex could not sit in the peel cavity — "
                "need a deeper peel"
            )
        if float(np.dot(nrm, apex - center)) < 0:
            q = (q[0], q[3], q[2], q[1])
            pts = hex_nodes[np.asarray(q, dtype=np.int64)]
        ai = n0 + len(apices)
        apices.append(np.asarray(apex, dtype=float))
        base = [int(q[0]), int(q[1]), int(q[2]), int(q[3])]
        pyrs.append(base + [ai])
        for i in range(4):
            a, b = base[i], base[(i + 1) % 4]
            ctri = (hex_nodes[a] + hex_nodes[b] + apex) / 3.0
            sn = np.cross(hex_nodes[b] - apex, hex_nodes[a] - apex)
            if float(np.dot(sn, center - ctri)) < 0:
                sides.append([ai, b, a])
            else:
                sides.append([ai, a, b])
    if not apices:
        raise RuntimeError("body-fit: no pyramids on hex peel (offset collapsed)")
    return np.vstack(apices), np.asarray(pyrs, dtype=np.int64), np.asarray(sides, dtype=np.int64)


def _extract_tets(gmsh) -> tuple[np.ndarray, np.ndarray]:
    ntags, ncoords, _ = gmsh.model.mesh.getNodes()
    out_nodes = np.asarray(ncoords, dtype=float).reshape(-1, 3)
    tag_to_idx = {int(t): i for i, t in enumerate(ntags)}
    tets: list[list[int]] = []
    etypes, _etags, conn = gmsh.model.mesh.getElements(3)
    for etype, cflat in zip(etypes, conn):
        cflat = np.asarray(cflat, dtype=np.int64)
        if int(etype) != TET:
            continue
        for row in cflat.reshape(-1, 4):
            tets.append([tag_to_idx[int(x)] for x in row])
    return out_nodes, np.asarray(tets, dtype=np.int64) if tets else np.zeros((0, 4), dtype=np.int64)


def _fill_cavity_tets(
    cad_nodes: np.ndarray,
    cad_tris: np.ndarray,
    inner_nodes: np.ndarray,
    inner_tris: np.ndarray,
    *,
    lc_m: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Delaunay-fill the peel cavity (CAD shell minus hex+pyramid core)."""
    try:
        import gmsh
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("Python package 'gmsh' is required") from exc

    from cfddesk.mesh.gmsh_standard import surface_mesh_watertight

    cad_nodes = np.asarray(cad_nodes, dtype=float)
    inner_nodes = np.asarray(inner_nodes, dtype=float)
    cad_tris = np.asarray(cad_tris, dtype=np.int64)
    inner_tris = np.asarray(inner_tris, dtype=np.int64)
    if not surface_mesh_watertight(cad_tris):
        raise RuntimeError("body-fit: CAD surface is not watertight")
    if not surface_mesh_watertight(inner_tris):
        raise RuntimeError("body-fit: pyramid tent surface is not watertight")

    n_cad = len(cad_nodes)
    nodes = np.vstack([cad_nodes, inner_nodes])
    inner_shift = inner_tris + n_cad
    lc = max(float(lc_m), 1e-6)

    def _try(flip_inner: bool) -> tuple[np.ndarray, np.ndarray]:
        tris_in = inner_shift[:, [0, 2, 1]] if flip_inner else inner_shift
        all_tris = np.vstack([cad_tris, tris_in])
        gmsh.initialize(interruptible=False)
        try:
            gmsh.model.add("cfddesk_cavity")
            gmsh.option.setNumber("General.Terminal", 1)
            gmsh.option.setNumber("Mesh.MshFileVersion", 2.2)
            gmsh.option.setNumber("Mesh.Binary", 0)
            gmsh.option.setNumber("Mesh.Algorithm3D", 1)
            gmsh.option.setNumber("Mesh.CharacteristicLengthMax", lc)
            gmsh.option.setNumber("Mesh.CharacteristicLengthMin", max(lc * 0.25, 1e-6))
            gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 1)
            gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
            gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
            # Keep the prescribed triangulation; only fill the volume.
            gmsh.option.setNumber("Mesh.MeshOnlyEmpty", 1)

            s = gmsh.model.addDiscreteEntity(2)
            tags = list(range(1, len(nodes) + 1))
            gmsh.model.mesh.addNodes(2, s, tags, nodes.reshape(-1).tolist())
            gmsh.model.mesh.addElementsByType(
                s, TRI, [], (all_tris + 1).reshape(-1).tolist()
            )

            # π → do not split on dihedral. Skip createGeometry so gmsh
            # does not remesh the BREP triangulation (would leave the STEP).
            import math

            gmsh.model.mesh.classifySurfaces(math.pi, True, False, math.pi)

            surfs = [t for _d, t in gmsh.model.getEntities(2)]
            if not surfs:
                raise RuntimeError("body-fit: classifySurfaces produced no surfaces")

            def _bbox_vol(tag: int) -> float:
                bb = gmsh.model.getBoundingBox(2, tag)
                return max(bb[3] - bb[0], 0.0) * max(bb[4] - bb[1], 0.0) * max(
                    bb[5] - bb[2], 0.0
                )

            order = sorted(surfs, key=_bbox_vol, reverse=True)
            loops = [gmsh.model.geo.addSurfaceLoop([t]) for t in order]
            gmsh.model.geo.addVolume(loops)
            gmsh.model.geo.synchronize()
            gmsh.model.mesh.generate(3)
            out_nodes, tets = _extract_tets(gmsh)
        finally:
            gmsh.finalize()
        return out_nodes, tets

    last: Exception | None = None
    for flip in (False, True):
        try:
            out_nodes, tets = _try(flip)
        except Exception as exc:  # noqa: BLE001
            last = exc
            continue
        if len(tets) > 0:
            return out_nodes, tets
        last = RuntimeError("body-fit: cavity Delaunay produced no tets")
    raise RuntimeError(
        "body-fit: cavity Delaunay produced no tets"
        + (f" ({last})" if last is not None else "")
    )


def _positive_tets(nodes: np.ndarray, tets: np.ndarray) -> np.ndarray:
    out = []
    for t in tets:
        a, b, c, d = nodes[t]
        vol = float(np.dot(np.cross(b - a, c - a), d - a))
        if vol < 0:
            out.append([int(t[0]), int(t[2]), int(t[1]), int(t[3])])
        elif vol > 0:
            out.append([int(x) for x in t])
    return np.asarray(out, dtype=np.int64)


def _weld_points(*blocks: np.ndarray, quant: float = 1e-8) -> tuple[np.ndarray, list[np.ndarray]]:
    """Weld coordinate blocks to a shared 0-based index space (10 nm bins)."""
    mapping: dict[tuple[int, int, int], int] = {}
    unique: list[np.ndarray] = []
    remapped: list[np.ndarray] = []

    def mid(p: np.ndarray) -> int:
        key = (
            int(round(float(p[0]) / quant)),
            int(round(float(p[1]) / quant)),
            int(round(float(p[2]) / quant)),
        )
        i = mapping.get(key)
        if i is None:
            i = len(unique)
            mapping[key] = i
            unique.append(np.asarray(p, dtype=float))
        return i

    for blk in blocks:
        blk = np.asarray(blk, dtype=float)
        if blk.size == 0:
            remapped.append(np.zeros((0,), dtype=np.int64))
            continue
        remapped.append(np.asarray([mid(p) for p in blk], dtype=np.int64))
    nodes = np.vstack(unique) if unique else np.zeros((0, 3))
    return nodes, remapped


def _assemble_conformal(
    *,
    surf_nodes: np.ndarray,
    surf_tris: np.ndarray,
    hex_nodes: np.ndarray,
    hexes: np.ndarray,
    apices: np.ndarray,
    pyramids: np.ndarray,
    cav_nodes: np.ndarray,
    cav_tets: np.ndarray,
    prism_nodes: np.ndarray | None = None,
    prisms: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """One welded node table for hex + pyramid + prism + tet + CAD boundary."""
    inner = np.vstack([hex_nodes, apices])
    blocks = [surf_nodes, hex_nodes, inner, cav_nodes]
    if prism_nodes is not None and len(prism_nodes):
        blocks.append(prism_nodes)
    nodes, maps = _weld_points(*blocks)
    surf_map, hex_map, inner_map, cav_map = maps[0], maps[1], maps[2], maps[3]
    hex_out = hex_map[np.asarray(hexes, dtype=np.int64)]
    pyr_out = inner_map[np.asarray(pyramids, dtype=np.int64)]
    tet_out = cav_map[np.asarray(cav_tets, dtype=np.int64)]
    cad_out = surf_map[np.asarray(surf_tris, dtype=np.int64)]
    if prisms is not None and prism_nodes is not None and len(prisms):
        prism_out = maps[-1][np.asarray(prisms, dtype=np.int64)]
    else:
        prism_out = np.zeros((0, 6), dtype=np.int64)
    return nodes, hex_out, pyr_out, tet_out, cad_out, prism_out


def _face_key(ids: np.ndarray) -> tuple[int, ...]:
    return tuple(sorted(int(x) for x in ids))


def _unmatched_boundary_count(
    hexes: np.ndarray,
    pyrs: np.ndarray,
    tets: np.ndarray,
    cad_tris: np.ndarray,
    prisms: np.ndarray | None = None,
) -> int:
    """Faces used by exactly one cell that are not in the CAD patch set."""
    from cfddesk.mesh.octree_hex import HEX_FACES

    use: dict[tuple[int, ...], int] = {}

    def add(ids: np.ndarray) -> None:
        key = _face_key(ids)
        use[key] = use.get(key, 0) + 1

    for hx in hexes:
        for f in HEX_FACES:
            add(hx[np.asarray(f, dtype=np.int64)])
    for py in pyrs:
        add(py[:4])
        add(np.asarray([py[4], py[0], py[1]]))
        add(np.asarray([py[4], py[1], py[2]]))
        add(np.asarray([py[4], py[2], py[3]]))
        add(np.asarray([py[4], py[3], py[0]]))
    for te in tets:
        add(te[[0, 1, 2]])
        add(te[[0, 1, 3]])
        add(te[[0, 2, 3]])
        add(te[[1, 2, 3]])
    if prisms is not None:
        for pr in prisms:
            add(pr[[0, 1, 2]])
            add(pr[[3, 4, 5]])
            add(pr[[0, 1, 4, 3]])
            add(pr[[1, 2, 5, 4]])
            add(pr[[2, 0, 3, 5]])
    cad = {_face_key(t) for t in cad_tris}
    unmatched = 0
    for key, n in use.items():
        if n == 1 and key not in cad:
            unmatched += 1
    return unmatched


def run_hexcore_bodyfit(
    solid: LoadedSolid,
    project: Project,
    *,
    case_dir: Path,
    location_m: tuple[float, float, float],
    base_cell_m: float,
    refinement: MeshRefinement,
) -> BodyfitResult:
    """Host-side body-fit hexcore → ``constant/triSurface/geometry.msh``."""
    case_dir = Path(case_dir)
    tri_dir = case_dir / "constant" / "triSurface"
    tri_dir.mkdir(parents=True, exist_ok=True)
    scale = float(project.scale_to_metres)
    max_cell, boundary, skin = sizing_from_base_cell(float(base_cell_m))
    extra = _extra_face_sizes(solid, project, skin)
    refs, _objs, thin = hexcore_gap_controls(solid, project, skin_cell_m=skin)
    del refs
    tet_lc = max(skin * TET_LC_OF_SKIN, 1e-6)
    prism_h = prism_height_budget_m(skin, [g.gap_m for g in thin] if thin else None)
    log: list[str] = [
        "backend=bodyfit",
        f"maxCell={max_cell:.8g} boundary={boundary:.8g} skin={skin:.8g}",
        f"tet_lc={tet_lc:.8g} prism_h={prism_h:.8g} gap_faces={len(extra)}",
    ]

    step_path = tri_dir / "geometry_metres.step"
    surf_msh = tri_dir / "cad_surface.msh"
    write_scaled_step(solid, step_path, scale_to_metres=scale)
    # Surface lc = skin; gap faces get extra_face_sizes.
    surf = run_gmsh_surface_mesh(
        solid,
        project,
        step_path=step_path,
        msh_path=surf_msh,
        lc_m=skin,
        refinement=refinement,
        extra_face_sizes=extra,
    )
    log.append(surf.log_text.rstrip())
    if not surf.watertight:
        from cfddesk.mesh.gmsh_standard import _count_open_edges

        n_open = _count_open_edges(surf.tris)
        raise RuntimeError(
            f"body-fit Phase 1: CAD surface mesh is not watertight "
            f"(open_or_bad_edges={n_open})\n{surf.log_text.rstrip()}"
        )

    n_gate = None if len(surf.nodes) <= 25000 else 4000
    dists = distances_to_faces_m(
        surf.nodes, solid, scale_to_metres=scale, n_sample=n_gate
    )
    gate = summarize_vertex_distances(dists, n_points=len(surf.nodes))
    log.append(gate.message)
    if not gate.ok:
        raise RuntimeError(gate.message)

    vol_solid = solid_volume_native(solid.shape) * (scale**3)
    last_err: Exception | None = None
    used_peel = skin_thickness_m(skin)
    core: HexCore | None = None
    hex_frac = 0.0
    nodes: np.ndarray | None = None
    hexes: np.ndarray | None = None
    pyrs: np.ndarray | None = None
    tets: np.ndarray | None = None
    cad_tri_global: np.ndarray | None = None
    prism_out: np.ndarray = np.zeros((0, 6), dtype=np.int64)
    prism_skin = None
    try:
        prism_skin = build_prism_skin(
            surf.nodes,
            surf.tris,
            solid,
            scale_to_metres=scale,
            height_m=prism_h,
            n_layers=PRISM_LAYERS,
            growth=PRISM_GROWTH,
        )
        log.append(
            f"prisms={len(prism_skin.prisms)} layers={prism_skin.n_layers} "
            f"h_p50={prism_skin.height_p50_m:.6g} skipped_tri={prism_skin.n_skipped} "
            f"twisted_shrunk={prism_skin.n_twisted_shrunk}"
        )
    except RuntimeError as exc:
        log.append(f"prism skin skipped: {exc}")

    classify_pts = prism_skin.cap_nodes if prism_skin is not None else surf.nodes
    cavity_nodes = prism_skin.cap_nodes if prism_skin is not None else surf.nodes
    cavity_tris = prism_skin.cap_tris if prism_skin is not None else surf.tris
    # With a prism wrap the hex lattice can sit at *skin* pitch — otherwise
    # an 11 mm bulk hex cannot leave a 2–3 tet-layer cavity.
    hex_pitch = skin if prism_skin is not None else boundary
    log.append(f"hex_pitch={hex_pitch:.8g} (skin)" if prism_skin is not None else f"hex_pitch={hex_pitch:.8g}")
    peels = _peel_schedule(hex_pitch, tet_lc, prisms=prism_skin is not None)
    corner_frac = 0.40 if prism_skin is not None else 0.25
    log.append("peel_schedule=" + ",".join(f"{p:.6g}" for p in peels))

    for peel in peels:
        used_peel = peel
        log.append(f"octree peel={peel:.8g} (from caps)")
        try:
            core = build_hex_core(
                solid,
                scale_to_metres=scale,
                location_m=location_m,
                max_cell_m=hex_pitch,
                peel_m=peel,
                surface_points_m=classify_pts,
                min_corner_frac=corner_frac,
            )
        except RuntimeError as exc:
            last_err = exc
            log.append(f"octree fail: {exc}")
            continue
        hex_vol = hex_volume_m3(core)
        hex_frac = hex_vol / vol_solid if vol_solid > 0 else 0.0
        log.append(
            f"hex n={core.n_kept} tested={core.n_tested} "
            f"vol={hex_vol:.6g} frac={hex_frac:.3f}"
        )
        if hex_frac < MIN_HEX_VOLUME_FRAC:
            last_err = RuntimeError(
                f"hex volume fraction {hex_frac:.3f} < {MIN_HEX_VOLUME_FRAC}"
            )
            log.append(str(last_err))
            continue

        quads = hex_boundary_quads(core.hexes)
        log.append(f"peel_quads={len(quads)}")
        if prism_skin is not None:
            from scipy.spatial import cKDTree

            d_faces = cKDTree(classify_pts).query(core.nodes[quads].mean(axis=1), k=1)[0]
            dmin = float(np.min(d_faces))
            need = 0.35 * core.cell_m
            log.append(f"hex_face_to_cap min={dmin:.6g} need={need:.6g}")
            if dmin < need:
                last_err = RuntimeError(
                    f"hex faces too close to prism caps ({dmin:.4g} < {need:.4g})"
                )
                log.append(str(last_err))
                continue
        pyr_off = (
            min(0.12 * peel, 0.12 * core.cell_m)
            if prism_skin is not None
            else min(0.18 * peel, 0.2 * core.cell_m)
        )
        try:
            apices, pyr_conn, side_tris = _pyramid_on_quads(
                core.nodes,
                quads,
                offset_m=pyr_off,
                solid=solid,
                scale_to_metres=scale,
                surface_points=classify_pts,
                min_standoff_m=0.18 * core.cell_m if prism_skin is not None else 0.0,
            )
        except RuntimeError as exc:
            last_err = exc
            log.append(f"pyramid fail: {exc}")
            continue

        # Cavity inner surface = hex *boundary* nodes + pyramid apices only.
        # Interior hex vertices must not be sent to gmsh (they sit in the void).
        peel_ids = np.unique(quads.ravel())
        peel_pts = core.nodes[peel_ids]
        peel_remap = {int(old): i for i, old in enumerate(peel_ids)}
        n_peel = len(peel_ids)
        compact_sides = np.asarray(
            [
                [
                    peel_remap[int(a)] if int(a) in peel_remap else n_peel + (int(a) - len(core.nodes)),
                    peel_remap[int(b)] if int(b) in peel_remap else n_peel + (int(b) - len(core.nodes)),
                    peel_remap[int(c)] if int(c) in peel_remap else n_peel + (int(c) - len(core.nodes)),
                ]
                for a, b, c in side_tris
            ],
            dtype=np.int64,
        )
        inner_for_gmsh = np.vstack([peel_pts, apices])
        try:
            cav_nodes, cav_tets = _fill_cavity_tets(
                cavity_nodes,
                cavity_tris,
                inner_for_gmsh,
                compact_sides,
                lc_m=tet_lc,
            )
        except Exception as exc:  # noqa: BLE001
            last_err = exc if isinstance(exc, Exception) else RuntimeError(str(exc))
            log.append(f"cavity fail: {exc}")
            continue

        cav_tets = _positive_tets(cav_nodes, cav_tets)
        if len(cav_tets) < 10:
            last_err = RuntimeError("cavity produced too few tets")
            log.append(str(last_err))
            continue

        nodes, hexes, pyrs, tets, cad_tri_global, prism_out = _assemble_conformal(
            surf_nodes=surf.nodes,
            surf_tris=surf.tris,
            hex_nodes=core.nodes,
            hexes=core.hexes,
            apices=apices,
            pyramids=pyr_conn,
            cav_nodes=cav_nodes,
            cav_tets=cav_tets,
            prism_nodes=None if prism_skin is None else prism_skin.nodes,
            prisms=None if prism_skin is None else prism_skin.prisms,
        )
        unmatched = _unmatched_boundary_count(
            hexes, pyrs, tets, cad_tri_global, prisms=prism_out
        )
        n_twist = count_twisted_prisms(nodes, prism_out)
        log.append(
            f"combined hex={len(hexes)} pyr={len(pyrs)} prism={len(prism_out)} "
            f"tet={len(tets)} "
            f"nodes={len(nodes)} unmatched_faces={unmatched} twisted_prisms={n_twist}"
        )
        if unmatched > 0:
            last_err = RuntimeError(
                f"body-fit: {unmatched} unmatched boundary faces (non-conformal)"
            )
            log.append(str(last_err))
            continue
        if n_twist > 0:
            last_err = RuntimeError(
                f"body-fit: {n_twist} twisted prisms (gmshToFoam would invert them)"
            )
            log.append(str(last_err))
            continue
        break
    else:
        raise RuntimeError(
            "body-fit failed every peel depth"
            + (f": {last_err}" if last_err is not None else "")
            + "\n"
            + "\n".join(log[-50:])
        )

    assert core is not None and nodes is not None
    assert hexes is not None and pyrs is not None and tets is not None
    assert cad_tri_global is not None

    # Physical tags: 1 = internal volume; 2+ = patches in sorted name order.
    patch_names = sorted(set(surf.tri_patch))
    phys: dict[int, tuple[int, str]] = {1: (3, "internal")}
    name_to_tag = {}
    for i, name in enumerate(patch_names, start=2):
        phys[i] = (2, name)
        name_to_tag[name] = i

    volume_cells: list[tuple[int, np.ndarray, int]] = []
    for hx in hexes:
        volume_cells.append((HEX, np.asarray(hx, dtype=np.int64), 1))
    for py in pyrs:
        volume_cells.append((PYR, np.asarray(py, dtype=np.int64), 1))
    for pr in prism_out:
        volume_cells.append((PRISM, np.asarray(pr, dtype=np.int64), 1))
    for te in tets:
        volume_cells.append((TET, np.asarray(te, dtype=np.int64), 1))

    boundary: list[tuple[int, np.ndarray, int, str]] = []
    for face, pname in zip(cad_tri_global, surf.tri_patch):
        if not pname:
            continue
        boundary.append(
            (TRI, np.asarray(face, dtype=np.int64), name_to_tag[pname], pname)
        )

    msh_path = tri_dir / "geometry.msh"
    write_msh22(
        msh_path,
        nodes,
        volume_cells=volume_cells,
        boundary_faces=boundary,
        physical_names=phys,
    )
    log.append(f"wrote {msh_path}")

    return BodyfitResult(
        msh_path=msh_path,
        surface_msh_path=surf_msh,
        n_hex=int(len(hexes)),
        n_pyr=int(len(pyrs)),
        n_prism=int(len(prism_out)),
        n_tet=int(len(tets)),
        n_nodes=int(len(nodes)),
        hex_volume_frac=float(hex_frac),
        peel_m=float(used_peel),
        cell_m=float(core.cell_m),
        surface_gate_ok=bool(gate.ok),
        surface_gate_msg=gate.message,
        watertight=bool(surf.watertight),
        log_text="\n".join(log) + "\n",
    )
