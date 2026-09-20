"""Host-side Hex-dominant (snappyHexMesh) prep for w21 (Phase 1 Step 6).

Moves Body1 STL scaling + dict writes out of the former JS GENERATE_SH_TEMPLATE
Python-inside-bash heredocs. Bash template only runs OpenFOAM tools.
"""

from __future__ import annotations

import math
import re
import struct
from pathlib import Path
from typing import Any

from cfddesk.mesh.snappy_policy import (
    SNAPPY_GEOMETRY_REV,
    feature_refinement_level,
    snap_controls_for_fineness,
)
from cfddesk.project.mesh_sizing import (
    cells_across,
    clamp_fineness,
    physics_refinement_for_fineness,
)

_PAD = 1.33


def walls_level_for_settings(fineness: int, *, physics_based: bool = True) -> int:
    f = clamp_fineness(fineness)
    if not physics_based or f <= 3:
        return 1
    return int(physics_refinement_for_fineness(f).walls)


def block_from_fineness(fineness: int, bounds_m: dict[str, float] | None) -> str:
    f = clamp_fineness(fineness)
    if bounds_m and all(k in bounds_m for k in ("xmin", "xmax", "ymin", "ymax", "zmin", "zmax")):
        dx = abs(float(bounds_m["xmax"]) - float(bounds_m["xmin"]))
        dy = abs(float(bounds_m["ymax"]) - float(bounds_m["ymin"]))
        dz = abs(float(bounds_m["zmax"]) - float(bounds_m["zmin"]))
        diag = math.sqrt(dx * dx + dy * dy + dz * dz) or 1.0
        base = max(1e-5, min(1.0, diag / cells_across(f)))
        nx = max(8, round((dx * _PAD) / base))
        ny = max(8, round((dy * _PAD) / base))
        nz = max(12, round((dz * _PAD) / base))
        return f"({nx} {ny} {nz})"
    if f <= 3:
        return "(10 10 20)"
    if f <= 6:
        return "(18 18 48)"
    if f <= 8:
        return "(24 24 64)"
    return "(32 32 80)"


def fineness_params(
    fineness: int,
    *,
    physics_based: bool = True,
    bounds_m: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Python replacement for w21 finenessParams (uses snappy_policy)."""
    f = clamp_fineness(fineness)
    walls_level = walls_level_for_settings(f, physics_based=physics_based)
    feature_level = feature_refinement_level(walls_level, fineness=f)
    snap = snap_controls_for_fineness(f, has_features=True)
    block = block_from_fineness(f, bounds_m)
    return {
        "block": block,
        "feature_level": int(feature_level),
        "walls_level": int(walls_level),
        "snap": snap.to_dict(),
        "snappy_geometry_rev": int(SNAPPY_GEOMETRY_REV),
        "fineness": f,
    }


def scale_body1_stl(body1_src: Path, body1_dst: Path, *, scale: float = 0.001) -> dict[str, Any]:
    """Scale Body1 STL mm->m into case triSurface; return bounds_m + bytes."""
    body1_src = Path(body1_src)
    body1_dst = Path(body1_dst)
    body1_dst.parent.mkdir(parents=True, exist_ok=True)
    raw = body1_src.read_bytes()
    is_bin = len(raw) >= 84 and not raw[:5].lower().startswith(b"solid")

    def scale_bounds_from_binary(buf: bytes):
        ntri = struct.unpack_from("<I", buf, 80)[0]
        xmin = ymin = zmin = float("inf")
        xmax = ymax = zmax = float("-inf")
        off = 84
        hdr = b"W23 Body1 from project source.step (mm->m)"[:80].ljust(80, b"\\0")
        out = bytearray(hdr)
        out += struct.pack("<I", ntri)
        for _ in range(ntri):
            chunk = buf[off : off + 50]
            if len(chunk) < 50:
                break
            vals = list(struct.unpack("<12fH", chunk))
            for j in range(12):
                vals[j] = vals[j] * scale
            out += struct.pack("<12fH", *vals)
            xs = vals[3], vals[6], vals[9]
            ys = vals[4], vals[7], vals[10]
            zs = vals[5], vals[8], vals[11]
            xmin = min(xmin, *xs)
            xmax = max(xmax, *xs)
            ymin = min(ymin, *ys)
            ymax = max(ymax, *ys)
            zmin = min(zmin, *zs)
            zmax = max(zmax, *zs)
            off += 50
        return bytes(out), {
            "xmin": xmin,
            "xmax": xmax,
            "ymin": ymin,
            "ymax": ymax,
            "zmin": zmin,
            "zmax": zmax,
            "ntri": ntri,
            "scale": scale,
        }

    if is_bin:
        scaled, bounds = scale_bounds_from_binary(raw)
    else:
        text = raw.decode("utf-8", errors="ignore")
        out_lines = ["solid Body1_W23"]
        xmin = ymin = zmin = float("inf")
        xmax = ymax = zmax = float("-inf")
        for line in text.splitlines():
            s = line.strip()
            if s.startswith("vertex"):
                parts = s.split()
                x, y, z = float(parts[1]) * scale, float(parts[2]) * scale, float(parts[3]) * scale
                out_lines.append(f"  vertex {x} {y} {z}")
                xmin = min(xmin, x)
                xmax = max(xmax, x)
                ymin = min(ymin, y)
                ymax = max(ymax, y)
                zmin = min(zmin, z)
                zmax = max(zmax, z)
            elif s.startswith("facet normal"):
                parts = s.split()
                nx, ny, nz = float(parts[2]), float(parts[3]), float(parts[4])
                n = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
                out_lines.append(f"facet normal {nx / n} {ny / n} {nz / n}")
            elif s.startswith("outer") or s.startswith("endloop") or s.startswith("endfacet"):
                out_lines.append(s)
        out_lines.append("endsolid Body1_W23")
        scaled = ("\\n".join(out_lines) + "\\n").encode("ascii")
        bounds = {
            "xmin": xmin,
            "xmax": xmax,
            "ymin": ymin,
            "ymax": ymax,
            "zmin": zmin,
            "zmax": zmax,
            "ntri": None,
            "scale": scale,
        }

    body1_dst.write_bytes(scaled)
    return {"bounds_m": bounds, "body1_bytes": len(scaled), "path": str(body1_dst)}


def _padded_box(bounds: dict[str, float]):
    cx = 0.5 * (bounds["xmin"] + bounds["xmax"])
    cy = 0.5 * (bounds["ymin"] + bounds["ymax"])
    cz = 0.5 * (bounds["zmin"] + bounds["zmax"])
    hx = 0.5 * (bounds["xmax"] - bounds["xmin"]) * _PAD
    hy = 0.5 * (bounds["ymax"] - bounds["ymin"]) * _PAD
    hz = 0.5 * (bounds["zmax"] - bounds["zmin"]) * _PAD
    verts = [
        (cx - hx, cy - hy, cz - hz),
        (cx + hx, cy - hy, cz - hz),
        (cx + hx, cy + hy, cz - hz),
        (cx - hx, cy + hy, cz - hz),
        (cx - hx, cy - hy, cz + hz),
        (cx + hx, cy - hy, cz + hz),
        (cx + hx, cy + hy, cz + hz),
        (cx - hx, cy + hy, cz + hz),
    ]
    loc = (cx, cy, cz - 0.15 * hz)
    return verts, loc


def _foam_header(object_name: str) -> str:
    return (
        "FoamFile\\n{\\n    version     2.0;\\n    format      ascii;\\n"
        f"    class       dictionary;\\n    object      {object_name};\\n}}\\n"
    )


def write_hexdominant_dicts(
    case_dir: Path,
    *,
    block: str,
    feature_level: int,
    walls_level: int,
    add_layers: bool,
    snap: dict[str, Any],
    bounds_m: dict[str, float],
) -> dict[str, Any]:
    """Write blockMeshDict / snappyHexMeshDict / surfaceFeatureExtractDict on host."""
    case_dir = Path(case_dir)
    system = case_dir / "system"
    system.mkdir(parents=True, exist_ok=True)
    (case_dir / "constant" / "triSurface").mkdir(parents=True, exist_ok=True)

    verts, loc = _padded_box(bounds_m)
    vert_lines = "\\n".join(f"    ({v[0]:.8f} {v[1]:.8f} {v[2]:.8f})" for v in verts)
    bm = (
        _foam_header("blockMeshDict")
        + "convertToMeters 1;\\n\\n"
        + f"vertices\\n(\\n{vert_lines}\\n);\\n\\n"
        + "blocks\\n(\\n"
        + f"    hex (0 1 2 3 4 5 6 7) {block} simpleGrading (1 1 1)\\n"
        + ");\\n\\nedges\\n(\\n);\\n\\nboundary\\n(\\n);\\n\\nmergePatchPairs\\n(\\n);\\n"
    )
    (system / "blockMeshDict").write_text(bm, encoding="utf-8")

    snap_nsmooth = int(snap.get("n_smooth_patch", 3))
    snap_tol = float(snap.get("tolerance", 2.0))
    snap_nsolve = int(snap.get("n_solve_iter", 100))
    snap_nrelax = int(snap.get("n_relax_iter", 5))
    snap_nfeat = int(snap.get("n_feature_snap_iter", 10))
    layer_block = (
        "        Body1\\n        {\\n            nSurfaceLayers 2;\\n        }\\n"
        if add_layers
        else ""
    )
    snap_txt = "\\n".join(
        [
            _foam_header("snappyHexMeshDict").rstrip("\\n"),
            "// Hex-dominant Body1 + snappy_policy (host-written)",
            "castellatedMesh true;",
            "snap            true;",
            f"addLayers       {'true' if add_layers else 'false'};",
            "",
            "geometry",
            "{",
            "    Body1.stl",
            "    {",
            "        type triSurfaceMesh;",
            "        name Body1;",
            "    }",
            "}",
            "",
            "castellatedMeshControls",
            "{",
            "    maxLocalCells 2000000;",
            "    maxGlobalCells 4000000;",
            "    minRefinementCells 0;",
            "    maxLoadUnbalance 0.10;",
            "    nCellsBetweenLevels 2;",
            "",
            "    features",
            "    (",
            "        {",
            '            file "cadFeatures.eMesh";',
            f"            level {int(feature_level)};",
            "        }",
            "    );",
            "",
            "    refinementSurfaces",
            "    {",
            "        Body1",
            "        {",
            f"            level ({int(walls_level)} {int(walls_level)});",
            "            patchInfo { type wall; }",
            "        }",
            "    }",
            "",
            "    resolveFeatureAngle 20;",
            "    refinementRegions {}",
            f"    locationInMesh ({loc[0]:.8f} {loc[1]:.8f} {loc[2]:.8f});",
            "    allowFreeStandingZoneFaces true;",
            "}",
            "",
            "snapControls",
            "{",
            f"    nSmoothPatch {snap_nsmooth};",
            f"    tolerance {snap_tol};",
            f"    nSolveIter {snap_nsolve};",
            f"    nRelaxIter {snap_nrelax};",
            f"    nFeatureSnapIter {snap_nfeat};",
            "    implicitFeatureSnap false;",
            "    explicitFeatureSnap true;",
            "    multiRegionFeatureSnap false;",
            "}",
            "",
            "addLayersControls",
            "{",
            "    relativeSizes true;",
            "    layers",
            "    {",
            layer_block.rstrip("\\n"),
            "    }",
            f"    expansionRatio {1.1 if add_layers else 1.0};",
            "    finalLayerThickness 0.3;",
            f"    minThickness {0.2 if add_layers else 0.1};",
            "    nGrow 0;",
            f"    featureAngle {130 if add_layers else 60};",
            "    slipFeatureAngle 30;",
            f"    nRelaxIter {5 if add_layers else 3};",
            f"    nSmoothSurfaceNormals {3 if add_layers else 1};",
            f"    nSmoothNormals {10 if add_layers else 3};",
            "    nSmoothThickness 10;",
            "    maxFaceThicknessRatio 0.5;",
            "    maxThicknessToMedialRatio 0.3;",
            "    minMedialAxisAngle 90;",
            "    nBufferCellsNoExtrude 0;",
            "    nLayerIter 50;",
            "}",
            "",
            "meshQualityControls",
            "{",
            "    maxNonOrtho 65;",
            "    maxBoundarySkewness 20;",
            "    maxInternalSkewness 4;",
            "    maxConcave 80;",
            "    minVol 1e-13;",
            "    minTetQuality 1e-30;",
            "    minArea -1;",
            "    minTwist 0.02;",
            "    minDeterminant 0.001;",
            "    minFaceWeight 0.05;",
            "    minVolRatio 0.01;",
            "    minTriangleTwist -1;",
            "    nSmoothScale 4;",
            "    errorReduction 0.75;",
            "    relaxed",
            "    {",
            "        maxNonOrtho 75;",
            "    }",
            "}",
            "",
            "debug 0;",
            "mergeTolerance 1e-6;",
            "",
        ]
    )
    (system / "snappyHexMeshDict").write_text(snap_txt, encoding="utf-8")

    sfe = (
        _foam_header("surfaceFeatureExtractDict")
        + "Body1.stl\\n{\\n    extractionMethod    extractFromSurface;\\n"
        + "    includedAngle       150;\\n    writeObj            yes;\\n}\\n"
    )
    (system / "surfaceFeatureExtractDict").write_text(sfe, encoding="utf-8")

    # Minimal controlDict so OF tools start.
    ctrl = (
        _foam_header("controlDict")
        + "application     snappyHexMesh;\\nstartFrom       startTime;\\n"
        + "startTime       0;\\nstopAt          endTime;\\nendTime         0;\\n"
        + "deltaT          1;\\nwriteControl    timeStep;\\nwriteInterval   1;\\n"
    )
    (system / "controlDict").write_text(ctrl, encoding="utf-8")
    (system / "fvSchemes").write_text(
        _foam_header("fvSchemes")
        + "ddtSchemes { default Euler; }\\n"
        + "gradSchemes { default Gauss linear; }\\n"
        + "divSchemes { default none; }\\n"
        + "laplacianSchemes { default Gauss linear corrected; }\\n"
        + "interpolationSchemes { default linear; }\\n"
        + "snGradSchemes { default corrected; }\\n",
        encoding="utf-8",
    )
    (system / "fvSolution").write_text(
        _foam_header("fvSolution") + "solvers {}\\n",
        encoding="utf-8",
    )

    return {
        "locationInMesh": list(loc),
        "block": block,
        "feature_level": int(feature_level),
        "walls_level": int(walls_level),
        "add_layers": bool(add_layers),
        "snap": {
            "n_smooth_patch": snap_nsmooth,
            "tolerance": snap_tol,
            "n_solve_iter": snap_nsolve,
            "n_relax_iter": snap_nrelax,
            "n_feature_snap_iter": snap_nfeat,
        },
        "snappy_geometry_rev": int(SNAPPY_GEOMETRY_REV),
    }


def read_polymesh_counts(case_dir: Path) -> dict[str, Any]:
    """Read n_points/n_cells/n_faces from constant/polyMesh (host)."""
    pm = Path(case_dir) / "constant" / "polyMesh"

    def first_int(path: Path):
        if not path.is_file():
            return None
        lines = path.read_text(errors="ignore").splitlines()
        past = False
        for i, line in enumerate(lines):
            s = line.strip()
            if not past:
                if s == "}" or s.startswith("// *****"):
                    past = True
                continue
            if s.isdigit() and i > 5:
                return int(s)
        return None

    def n_cells_owner(path: Path):
        if not path.is_file():
            return None, None
        lines = path.read_text(errors="ignore").splitlines()
        mode = "seek"
        vals: list[int] = []
        nfaces = None
        for i, line in enumerate(lines):
            s = line.strip()
            if mode == "seek":
                if s.isdigit() and i > 10:
                    nfaces = int(s)
                    mode = "paren"
                continue
            if mode == "paren":
                if s == "(":
                    mode = "vals"
                continue
            if mode == "vals":
                if s == ")":
                    break
                if s.lstrip("-").isdigit():
                    vals.append(int(s))
        return (max(vals) + 1 if vals else None), (nfaces if nfaces is not None else len(vals))

    n_points = first_int(pm / "points")
    n_cells, n_faces = n_cells_owner(pm / "owner")
    return {
        "n_points": n_points,
        "n_cells": n_cells,
        "n_faces": n_faces,
        "source": "polyMesh/points+owner",
        "polyMesh": str(pm.resolve()) if pm.is_dir() else str(pm),
    }


def read_feature_marks(log_path: Path) -> dict[str, Any]:
    text = Path(log_path).read_text(errors="ignore") if Path(log_path).is_file() else ""
    marks = [
        int(x)
        for x in re.findall(r"Marked for refinement due to explicit features\\s*:\\s*(\\d+)", text)
    ]
    total = sum(marks) if marks else 0
    return {"marks": marks, "total": total}
