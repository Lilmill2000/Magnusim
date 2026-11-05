"""Mesh facts (run health, RH2): what the pre-run check and the Mesh panel know of a
generated mesh, in one file beside it (``mesh-facts.json``), the same for every mesher.

- ``quality``: checkMesh's report as numbers (:func:`parse_checkmesh`): whether it is
  known, the failed checks (each with its count and whether the meshers accept it), the
  worst non-orthogonality, skewness and aspect ratio, and the cell volumes. The mesh
  record keeps it too, as ``live_mesh_result.quality`` (:func:`record_quality`).
- ``bbox_m`` (the mesh's own box), ``part_size_m``, ``surface_cell_m`` and ``layers``
  (asked, applied, and the first layer on each wall patch that got layers), normalised
  from the mesher's own record: Standard's ``standard-meta.json``, cfMesh's
  ``w28-cfmesh-meta.json`` and Hex-dominant's ``w23-geometry-meta.json``, with
  snappyHexMesh's layer report (``log.snappyHexMesh``, :func:`parse_snappy_layers`).
- ``refined`` (a Hex-dominant mesh with Surface custom sizing, only then): each custom size's
  band as the mesher wrote it: its level, the cell size there, how far from its faces it
  reaches (``distance_m``) and the Refine out to asked (``reach_m``, when there was one).
- ``courant_rates``: the summary of the mesh's Courant-rate table
  (:mod:`magnusim_sdk.courant_rates`; the table itself is ``courant-rates.json``).
- ``two_d`` (a Hex-dominant mesh made one cell across, only then): ``axis`` (the depth's,
  ``x``, ``y`` or ``z``), ``depth_m``, ``cells_across`` (1) and the two ends (``front``,
  ``back``: their faces, boundary condition and patch). Its ``quality`` is checkMesh's on the
  2D mesh (its ends ``empty``), so aspect ratios are the section's.

The meshers write it when a mesh is done (:func:`write_mesh_facts`); :func:`load_mesh_facts`
reads it, or builds it for a mesh made before it existed. Both files carry the mesh
files' stamp, so a mesh generated again never reads the facts of the one before.

Standard library only (numpy only for the Courant-rate table).
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

from . import courant_rates

FACTS_FILE = "mesh-facts.json"
FACTS_VERSION = 1
CHECKMESH_LOG = "log.checkMesh"
SNAPPY_LOG = "log.snappyHexMesh"
# The meshers' own records, and the mesher each one names.
MESHER_META = {
    "standard": "standard-meta.json",
    "cfmesh": "w28-cfmesh-meta.json",
    "hexdominant": "w23-geometry-meta.json",
}
# Other files only one mesher leaves in its case: Hex-dominant writes its feature-edge marks
# after its WSL script, which empties the case folder and copies back only the mesh, its
# dictionaries and its logs (snappy_hexdominant.sh), so they mark its meshes even where its
# meta file did not come back (meshes made before generate_snappy.py wrote it again).
MESHER_MARKS = {
    "hexdominant": ("w21-feature-marks.json",),
}
# The mesher keeps a mesh whose only failures are these (cfddesk.wsl.mesh_run): skewed
# faces, and up to this many cells of high aspect ratio.
ACCEPTED_ASPECT_CELLS = 8
# At most this many failed checks are kept in the mesh record.
RECORD_FAILED_MAX = 8

_NUM = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"


def _f(text: str | None) -> float | None:
    try:
        v = float(text) if text is not None else None
    except ValueError:
        return None
    return v if v is not None and math.isfinite(v) else None


def _search(pattern: str, text: str, group: int = 1) -> str | None:
    m = re.search(pattern, text)
    return m.group(group) if m else None


# What each failed check ("***" line) is: (name, how to find it, its count, what it counts).
_FAILED_CHECKS: tuple[tuple[str, str, str | None, str | None], ...] = (
    ("negative_volume", r"negative (?:cell )?volume", r"negative volume cells:\s*(\d+)", "cells"),
    ("aspect_ratio", r"high aspect ratio", r"number of cells\s*:?\s*(\d+)", "cells"),
    ("skewness", r"skew", r"(\d+)\s+highly skew", "faces"),
    ("non_orthogonality", r"non-orthogonality errors", r"errors:\s*(\d+)", "faces"),
    ("face_pyramids", r"face pyramids", r"(\d+)\s+faces are incorrectly oriented", "faces"),
    ("face_area", r"(?:zero|negative) (?:or negative )?face area", r"faces?:\s*(\d+)", "faces"),
    ("open_cells", r"open cells|cell openness", r"(\d+)\s+(?:open )?cells", "cells"),
    ("boundary_openness", r"boundary openness", None, None),
    ("non_aligned_edges", r"edges not aligned", r":\s*(\d+)", "edges"),
    ("face_order", r"upper triangular", r"(\d+)", "faces"),
)


def _failed_check(line: str) -> dict[str, Any]:
    text = line.strip().lstrip("*").strip()
    low = text.lower()
    for name, find, count_re, unit in _FAILED_CHECKS:
        if re.search(find, low):
            count = _search(count_re, text if name != "open_cells" else low) if count_re else None
            n = int(count) if count is not None else None
            accepted = name == "skewness" or (name == "aspect_ratio" and n is not None and n <= ACCEPTED_ASPECT_CELLS)
            return {"check": name, "count": n, "unit": unit if n is not None else None, "accepted": accepted}
    return {"check": "other", "count": None, "unit": None, "accepted": False, "text": text[:120]}


def parse_checkmesh(text: str | None) -> dict[str, Any]:
    """checkMesh's report (``log.checkMesh``, OpenFOAM v2606) as numbers.

    ``known`` is True when the report reached its verdict ("Mesh OK." or "Failed N mesh
    checks."); then ``ok``, ``n_failed`` and ``failed`` (one entry per "***" line: ``check``
    a short name, ``count`` and ``unit`` when the line says how many, ``accepted`` when the
    meshers keep a mesh with it: skewed faces, and up to 8 cells of high aspect ratio), and
    the worst cells: ``max_non_orthogonality`` (degrees), ``max_skewness``,
    ``max_aspect_ratio``, with the counts behind the warnings (``severe_non_orthogonal_faces``
    over 70°, ``skewed_faces``) and the volumes (m³). A number the report lacks is None.
    """
    t = text or ""
    verdict_ok = re.search(r"^\s*Mesh OK\.", t, re.M) is not None
    failed_n = _search(r"Failed\s+(\d+)\s+mesh checks", t)
    known = verdict_ok or failed_n is not None
    if not known:
        return {"known": False}
    stars = [ln for ln in t.splitlines() if ln.lstrip().startswith("***")]
    failed = [_failed_check(ln) for ln in stars]
    aspect = _search(r"Max aspect ratio\s*[=:]\s*(" + _NUM + ")", t)
    skew = _search(r"Max skewness\s*=\s*(" + _NUM + ")", t)
    skewed = _search(r"(\d+)\s+highly skew faces", t)
    severe = _search(r"severely non-orthogonal \(> \d+ degrees\) faces:\s*(\d+)", t)
    neg = _search(r"Minimum negative volume:\s*(" + _NUM + ")", t)
    out: dict[str, Any] = {
        "known": True,
        "ok": failed_n is None or int(failed_n) == 0,
        "n_failed": int(failed_n) if failed_n is not None else 0,
        "failed": failed,
        "max_non_orthogonality": _f(_search(r"non-orthogonality Max:\s*(" + _NUM + ")", t)),
        "avg_non_orthogonality": _f(_search(r"non-orthogonality Max:\s*" + _NUM + r"\s+average:\s*(" + _NUM + ")", t)),
        "severe_non_orthogonal_faces": int(severe) if severe else 0,
        "max_skewness": _f(skew),
        "skewed_faces": int(skewed) if skewed else 0,
        "max_aspect_ratio": _f(aspect),
        "min_volume_m3": _f(neg) if neg is not None else _f(_search(r"Min volume\s*=\s*(" + _NUM + r")\.?\s", t)),
        "max_volume_m3": _f(_search(r"Max volume\s*=\s*(" + _NUM + r")\.?\s", t)),
        "total_volume_m3": _f(_search(r"Total volume\s*=\s*(" + _NUM + r")\.?\s", t)),
        "n_cells": int(c) if (c := _search(r"(?m)^\s*cells:\s*(\d+)", _stats(t))) else None,
    }
    return out


def _stats(text: str) -> str:
    """The "Mesh stats" block (its counts), so a later "cells:" line is not taken."""
    i = text.find("Mesh stats")
    return text[i : i + 800] if i >= 0 else ""


def checkmesh_bbox(text: str | None) -> dict[str, list[float]] | None:
    """checkMesh's "Overall domain bounding box (x y z) (x y z)" as {min, max, size} (m)."""
    m = re.search(r"Overall domain bounding box\s*\(([^)]*)\)\s*\(([^)]*)\)", text or "")
    if not m:
        return None
    try:
        lo = [float(v) for v in m.group(1).split()]
        hi = [float(v) for v in m.group(2).split()]
    except ValueError:
        return None
    if len(lo) != 3 or len(hi) != 3:
        return None
    return {"min": lo, "max": hi, "size": [float(f"{h - a:.6g}") for a, h in zip(lo, hi, strict=True)]}


def record_quality(quality: dict[str, Any] | None) -> dict[str, Any]:
    """The quality the mesh record keeps (``live_mesh_result.quality``): ``known``, and when
    known ``ok``, ``n_failed``, at most 8 ``failed`` checks, the worst cells and the counts
    behind the warnings. The Mesh panel's quality line and the Assistant's ``read_setup
    mesh`` read it."""
    q = quality if isinstance(quality, dict) else {}
    if not q.get("known"):
        return {"known": False}
    keep = (
        "ok",
        "n_failed",
        "max_non_orthogonality",
        "avg_non_orthogonality",
        "severe_non_orthogonal_faces",
        "max_skewness",
        "skewed_faces",
        "max_aspect_ratio",
        "min_volume_m3",
    )
    out: dict[str, Any] = {"known": True, **{k: q.get(k) for k in keep}}
    out["failed"] = [dict(f) for f in (q.get("failed") or [])[:RECORD_FAILED_MAX] if isinstance(f, dict)]
    return out


# ---------------------------------------------------------------------------
# Boundary layers
# ---------------------------------------------------------------------------


def parse_snappy_layers(text: str | None) -> list[dict[str, Any]] | None:
    """snappyHexMesh's last layer report as rows ``{patch, faces, layers_asked, layers,
    total_m}``: ``layers`` is the mean number of layers it made on the patch's faces and
    ``total_m`` their mean overall thickness. None when the log has no report."""
    t = text or ""
    starts = [m.end() for m in re.finditer(r"^patch\s+faces\s+layers.*overall thickness.*$", t, re.M)]
    if not starts:
        return None
    rows: list[dict[str, Any]] = []
    for line in t[starts[-1] :].splitlines()[1:]:
        s = line.strip()
        if not s:
            if rows:
                break
            continue
        if s.startswith("-") or s.startswith("[") or s.startswith("target"):
            continue
        parts = s.split()
        try:
            if len(parts) >= 6:  # patch faces target mesh [m] [%]
                rows.append({"patch": parts[0], "faces": int(parts[1]), "layers_asked": float(parts[2]), "layers": float(parts[3]), "total_m": float(parts[4])})
            elif len(parts) == 5:  # patch faces layers [m] [%] (older reports)
                rows.append({"patch": parts[0], "faces": int(parts[1]), "layers_asked": None, "layers": float(parts[2]), "total_m": float(parts[3])})
            else:
                break
        except ValueError:
            break
    return rows


def _block(text: str, key: str, start: int = 0) -> tuple[int, int] | None:
    """(open, close) of the ``key { ... }`` block at or after ``start``."""
    m = re.compile(r"(?:^|[\s;{])" + re.escape(key) + r"\s*\{", re.M).search(text, start)
    if not m:
        return None
    pos = m.end() - 1
    depth = 0
    for i in range(pos, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return pos, i
    return None


def snappy_layer_expansions(dict_text: str | None) -> tuple[float | None, dict[str, float]]:
    """(the global expansion ratio, each patch's own) of a snappyHexMeshDict's
    ``addLayersControls``."""
    t = re.sub(r"//[^\n]*|/\*.*?\*/", "", dict_text or "", flags=re.S)
    ctl = _block(t, "addLayersControls")
    if not ctl:
        return None, {}
    body = t[ctl[0] + 1 : ctl[1]]
    per: dict[str, float] = {}
    lay = _block(body, "layers")
    outside = body
    if lay:
        inner = body[lay[0] + 1 : lay[1]]
        for m in re.finditer(r"([A-Za-z_\"][^\s{}]*)\s*\{([^{}]*)\}", inner):
            r = _f(_search(r"expansionRatio\s+(" + _NUM + ")", m.group(2)))
            if r:
                per[m.group(1).strip('"')] = r
        outside = body[: lay[0]] + body[lay[1] + 1 :]
    return _f(_search(r"expansionRatio\s+(" + _NUM + ")", outside)), per


def first_layer_m(total_m: float | None, layers: float | None, expansion: float | None) -> float | None:
    """The first layer's thickness of ``layers`` layers growing by ``expansion`` to ``total_m``."""
    if not total_m or total_m <= 0 or layers is None or layers < 0.5:
        return None
    n = max(1, int(round(layers)))
    r = expansion if expansion and expansion > 0 else 1.0
    if abs(r - 1.0) < 1e-9:
        return total_m / n
    return total_m * (r - 1.0) / (r**n - 1.0)


_BAND = re.compile(r"^(?P<parent>.+?)_bl\d+_*$")


def _wall_rows(rows: list[dict[str, Any]], expansions: tuple[float | None, dict[str, float]], fallback_r: dict[str, float]) -> list[dict[str, Any]]:
    """Layer rows per wall patch: Standard's size bands (``<patch>_blK``) join their patch."""
    glob, per = expansions
    acc: dict[str, dict[str, Any]] = {}
    for row in rows:
        m = _BAND.match(row["patch"])
        parent = m.group("parent") if m else row["patch"]
        r = per.get(row["patch"]) or per.get(parent) or fallback_r.get(parent) or glob
        first = first_layer_m(row["total_m"], row["layers"], r)
        a = acc.setdefault(parent, {"patch": parent, "faces": 0, "_l": 0.0, "_t": 0.0, "_f": 0.0, "_fn": 0, "layers_asked": row["layers_asked"], "first_min_m": None})
        n = max(0, int(row["faces"]))
        a["faces"] += n
        a["_l"] += n * row["layers"]
        a["_t"] += n * row["total_m"]
        if first is not None:
            a["_f"] += n * first
            a["_fn"] += n
            a["first_min_m"] = first if a["first_min_m"] is None else min(a["first_min_m"], first)
        if row["layers_asked"] is not None:
            a["layers_asked"] = max(a["layers_asked"] or 0.0, row["layers_asked"])
    out = []
    for a in acc.values():
        n = a["faces"] or 1
        out.append(
            {
                "patch": a["patch"],
                "faces": a["faces"],
                "layers_asked": a["layers_asked"],
                "layers": round(a["_l"] / n, 3),
                "total_m": _sig(a["_t"] / n),
                "first_m": _sig(a["_f"] / a["_fn"]) if a["_fn"] else None,
                "first_min_m": _sig(a["first_min_m"]),
            }
        )
    return out


def _sig(v: float | None, digits: int = 4) -> float | None:
    return float(f"{v:.{digits}g}") if v is not None and math.isfinite(v) else None


# ---------------------------------------------------------------------------
# The facts
# ---------------------------------------------------------------------------


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def _dict(v: Any) -> dict[str, Any]:
    return v if isinstance(v, dict) else {}


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def mesher_of(case_dir: Path | str) -> str | None:
    """The mesher whose record is in ``case_dir`` (the newest of them): ``standard``,
    ``cfmesh`` or ``hexdominant``; None for a mesh with none (a plugin's mesher). A mesher's
    record is its meta file or another file only it leaves (``MESHER_MARKS``)."""
    case = Path(case_dir)
    best: tuple[int, str] | None = None
    for name, file in MESHER_META.items():
        for f in (file, *MESHER_MARKS.get(name, ())):
            p = case / f
            if p.is_file():
                t = p.stat().st_mtime_ns
                if best is None or t > best[0]:
                    best = (t, name)
    return best[1] if best else None


def _hexdominant_base_cell(case: Path, meta: dict[str, Any]) -> float | None:
    """The background block's cell (blockMeshDict, the mean of its three sizes); a 2D mesh's
    from its section's background cell (its block is one cell of the depth deep)."""
    two = _dict(meta.get("two_d"))
    if two:
        return _f(str(two.get("base_m"))) if two.get("base_m") is not None else None
    t = _read_text(case / "system" / "blockMeshDict")
    verts = re.search(r"vertices\s*\((.*?)\)\s*;", t, re.S)
    hexm = re.search(r"hex\s*\([^)]*\)\s*\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\)", t)
    if not verts or not hexm:
        return None
    pts = [[float(v) for v in p.split()] for p in re.findall(r"\(([^()]*)\)", verts.group(1))]
    pts = [p for p in pts if len(p) == 3]
    if not pts:
        return None
    size = [max(p[i] for p in pts) - min(p[i] for p in pts) for i in range(3)]
    counts = [int(hexm.group(i)) for i in (1, 2, 3)]
    cells = [s / c for s, c in zip(size, counts, strict=True) if s > 0 and c > 0]
    if not cells:
        return None
    return math.prod(cells) ** (1.0 / len(cells))


def _hexdominant_surface_cell(case: Path, meta: dict[str, Any]) -> float | None:
    """The background block's cell over 2^level of the wall refinement."""
    level = meta.get("walls_level")
    if not isinstance(level, (int, float)):
        return None
    base = _hexdominant_base_cell(case, meta)
    return _sig(base / 2.0 ** int(level)) if base else None


def _hexdominant_refined(case: Path, meta: dict[str, Any]) -> list[dict[str, Any]]:
    """Each Surface custom sizing's band as the mesher wrote it (its refinement region): its
    level, the cell size there, how far from its faces (``distance_m``) and, when it had one,
    the Refine out to asked (``reach_m``; the band is never shorter than three cells)."""
    base = _hexdominant_base_cell(case, meta)
    out: list[dict[str, Any]] = []
    for r in meta.get("refinement_regions") or []:
        if not isinstance(r, dict) or not isinstance(r.get("level"), (int, float)):
            continue
        row: dict[str, Any] = {
            "level": int(r["level"]),
            "cell_m": _sig(base / 2.0 ** int(r["level"])) if base else None,
            "distance_m": _sig(_f(str(r.get("distance_m")))),
        }
        if r.get("reach_m"):
            row["reach_m"] = _sig(_f(str(r["reach_m"])))
        out.append(row)
    return out


def build_mesh_facts(case_dir: Path | str, *, mesher: str | None = None) -> dict[str, Any]:
    """The facts of the mesh in ``case_dir`` from its files (no Courant rates).

    ``layers``: ``asked`` (Automatic boundary layers or an Inflate boundary layer),
    ``applied`` (the mesher kept layers; None when unknown), ``first_m`` (the mean first
    layer over the wall patches that got layers) and ``walls`` (each such patch from
    snappyHexMesh's report: ``layers`` made on average, ``total_m``, ``first_m`` and the
    thinnest band's ``first_min_m``). cfMesh reports no patches: its ``first_m`` is the
    first layer it was given.
    """
    case = Path(case_dir)
    kind = mesher if mesher in MESHER_META else mesher_of(case)
    meta: dict[str, Any] = (_read_json(case / MESHER_META[kind]) if kind else None) or {}
    check_text = _read_text(case / CHECKMESH_LOG)
    quality = parse_checkmesh(check_text)
    facts: dict[str, Any] = {
        "v": FACTS_VERSION,
        "mesher": kind,
        "quality": quality,
        "n_cells": quality.get("n_cells"),
        "bbox_m": checkmesh_bbox(check_text),
        "part_size_m": None,
        "surface_cell_m": None,
        "layers": {"asked": False, "applied": None, "first_m": None, "walls": []},
    }
    counts = _read_json(case / "w21-counts.json") or {}
    if facts["n_cells"] is None and isinstance(counts.get("n_cells"), int):
        facts["n_cells"] = counts["n_cells"]
    snappy_rows = parse_snappy_layers(_read_text(case / SNAPPY_LOG))
    expansions = snappy_layer_expansions(_read_text(case / "system" / "snappyHexMeshDict"))
    layers = facts["layers"]
    if kind == "standard":
        sizing = _dict(meta.get("sizing"))
        bbox = sizing.get("bbox_m")
        if isinstance(bbox, list) and len(bbox) == 3:
            facts["part_size_m"] = [float(v) for v in bbox]
        facts["surface_cell_m"] = _f(str(sizing.get("surface_size_m"))) if sizing.get("surface_size_m") is not None else None
        inflate = [n for n in meta.get("inflate_boundary_layer") or [] if isinstance(n, dict) and not n.get("skipped")]
        layers["asked"] = bool(meta.get("add_layers")) or bool(inflate)
        layers["applied"] = bool(meta.get("layers_applied")) if meta.get("layers_applied") is not None else None
        lay = _dict(sizing.get("layers"))
        fallback = {str(n.get("patch")): float(n["expansion"]) for n in inflate if n.get("patch") and n.get("expansion")}
        auto_r = _f(str(lay.get("expansion"))) if lay.get("expansion") is not None else None
        exp = (expansions[0] or auto_r, expansions[1])
        if snappy_rows:
            layers["walls"] = _wall_rows(snappy_rows, exp, fallback)
    elif kind == "cfmesh":
        prep = _dict(meta.get("prep"))
        cell = prep.get("skin_cell_m") or prep.get("boundary_cell_m")
        facts["surface_cell_m"] = _sig(float(cell)) if isinstance(cell, (int, float)) and cell > 0 else None
        inflate = [n for n in meta.get("inflate_boundary_layer") or [] if isinstance(n, dict) and not n.get("skipped")]
        layers["asked"] = bool(meta.get("add_layers")) or bool(inflate)
        layers["applied"] = bool(meta.get("layers_applied")) if meta.get("layers_applied") is not None else None
        first = meta.get("first_layer_m")
        if layers["applied"] and isinstance(first, (int, float)) and first > 0:
            layers["first_m"] = _sig(float(first))
    elif kind == "hexdominant":
        b = meta.get("bounds_m")
        if isinstance(b, dict) and all(k in b for k in ("xmin", "xmax", "ymin", "ymax", "zmin", "zmax")):
            facts["part_size_m"] = [_sig(abs(float(b[f"{a}max"]) - float(b[f"{a}min"]))) for a in "xyz"]
        facts["surface_cell_m"] = _hexdominant_surface_cell(case, meta)
        refined = _hexdominant_refined(case, meta)
        if refined:
            facts["refined"] = refined
        asked = [x for x in meta.get("layers") or [] if isinstance(x, dict) and int(x.get("n_layers") or 0) > 0]
        layers["asked"] = bool(meta.get("add_layers")) or bool(asked)
        if snappy_rows is not None:
            layers["walls"] = _wall_rows(snappy_rows, expansions, {})
            layers["applied"] = any(w["layers"] >= 0.5 for w in layers["walls"])
        elif layers["asked"]:
            layers["applied"] = None
        else:
            layers["applied"] = False
        two = _dict(meta.get("two_d"))
        if two:
            axis = two.get("axis")
            facts["two_d"] = {
                "axis": "xyz"[axis] if isinstance(axis, int) and 0 <= axis < 3 else str(axis or ""),
                "depth_m": _f(str(two.get("depth_m"))) if two.get("depth_m") is not None else None,
                "cells_across": 1,
                "front": _dict(two.get("front")),
                "back": _dict(two.get("back")),
            }
    walls = [w for w in layers["walls"] if w.get("first_m")]
    if walls and layers["first_m"] is None:
        n = sum(w["faces"] for w in walls) or 1
        layers["first_m"] = _sig(sum(w["first_m"] * w["faces"] for w in walls) / n)
    if kind in ("standard", "hexdominant") and layers["asked"] and layers["walls"] and not any(w["layers"] >= 0.5 for w in layers["walls"]):
        layers["applied"] = False
    return facts


def write_mesh_facts(case_dir: Path | str, *, mesher: str | None = None, rates: bool = True) -> dict[str, Any]:
    """Build the facts of the mesh in ``case_dir``, make its Courant-rate table (with
    ``rates``) and keep both beside it. Returns the facts. A mesher calls this when its
    mesh is done; nothing here fails a mesh (an unreadable part is left out and says why)."""
    case = Path(case_dir)
    try:
        (case / FACTS_FILE).unlink()
    except OSError:
        pass
    facts = build_mesh_facts(case, mesher=mesher)
    facts["courant_rates"] = courant_rates.write_rates(case) if rates else None
    summary = facts["courant_rates"]
    if facts.get("bbox_m") is None and isinstance(summary, dict) and isinstance(summary.get("bbox_m"), dict):
        facts["bbox_m"] = summary["bbox_m"]
    facts["stamp"] = courant_rates.mesh_stamp(case / "constant" / "polyMesh")
    (case / FACTS_FILE).write_text(json.dumps(facts, indent=1) + "\n", encoding="utf-8")
    return facts


def read_mesh_facts(case_dir: Path | str) -> dict[str, Any] | None:
    """The facts kept beside the mesh in ``case_dir``; None when there are none or the mesh
    changed since they were written."""
    case = Path(case_dir)
    facts = _read_json(case / FACTS_FILE)
    if not facts or facts.get("v") != FACTS_VERSION:
        return None
    if facts.get("stamp") != courant_rates.mesh_stamp(case / "constant" / "polyMesh"):
        return None
    return facts


def load_mesh_facts(case_dir: Path | str | None, *, build: bool = False, rates: bool = True) -> dict[str, Any] | None:
    """The facts of the mesh in ``case_dir``: as kept, else (with ``build``) made now and
    kept, as for a mesh generated before they existed. None without a mesh."""
    if not case_dir:
        return None
    case = Path(case_dir)
    facts = read_mesh_facts(case)
    if facts is not None or not build:
        return facts
    if not (case / "constant" / "polyMesh").is_dir():
        return None
    try:
        return write_mesh_facts(case, rates=rates)
    except OSError:
        return build_mesh_facts(case)
