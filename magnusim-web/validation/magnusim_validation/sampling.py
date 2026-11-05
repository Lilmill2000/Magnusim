"""What the harness reads from a run's case folder itself, where no route gives it (the design's
``app_sampling`` and ``case_file`` sources):

- ``cells``: the cell values (no interpolation) of the cells whose centres lie in a box, and
  within a radius of the x axis when asked, read by the app's own volume loader
  (``python/tools/case_volume.load_volume``, the code behind Plot over path and Inspect);
- ``patch``: a patch field the run saved (``wallShearStress``) on the faces whose centres lie
  in a box, read from the case folder (``case_file:<time>/<field>``);
- ``app_sampling``: a line (or several) sampled as Plot over path samples it, with a vector's
  components kept where the route gives its magnitude only (the design's gap G2): the same
  loader, the same kinematic scaling, the field on the mesh's points and the route's own
  sampler (``export_plot_over_path.sample_segment``, ``valid_mask``), so a scalar sampled here
  is the route's answer (``tests/test_sampling.py`` checks it against the route's program).

Each read is saved in ``raw/sample_<key>.json`` while the run's case folder is there (the spec
evaluates right after the run), so ``evaluate`` reads the same numbers again from ``raw/``
alone, and the tests give it synthetic ones.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

from .paths import PY_ROOT

SAMPLE_KINDS = ("cells", "patch", "app_sampling")


def _tools() -> None:
    p = str(PY_ROOT / "tools")
    if p not in sys.path:
        sys.path.insert(0, p)


def _round(v: float) -> float:
    return float(f"{v:.7g}") if v and math.isfinite(v) else float(v)


def _in_box(points: Any, box: list[list[float]] | None) -> Any:
    import numpy as np

    keep = np.ones(len(points), dtype=bool)
    if box:
        lo, hi = np.asarray(box[0], dtype=float), np.asarray(box[1], dtype=float)
        keep &= np.all((points >= lo - 1e-12) & (points <= hi + 1e-12), axis=1)
    return keep


def cells(case_dir: Path, time: str, fields: list[str], *, box: list[list[float]] | None = None,
          r_axis_max: float | None = None, use_cache: bool = True) -> dict[str, Any]:
    """The cells of the run's volume at ``time`` whose centres lie in ``box`` ([[x, y, z] low,
    [x, y, z] high], metres) and, with ``r_axis_max``, within that distance of the x axis:
    their centres (``x``, ``y``, ``z``), volumes (``vol``) and each field's cell values
    (a vector as ``<name>_x``, ``<name>_y``, ``<name>_z``)."""
    import numpy as np

    _tools()
    from case_volume import load_volume  # the app's own loader

    grid, source = load_volume(Path(case_dir), str(time), use_cache=use_cache)
    centres = np.asarray(grid.cell_centers().points, dtype=float)
    keep = _in_box(centres, box)
    if r_axis_max is not None:
        keep &= np.hypot(centres[:, 1], centres[:, 2]) <= float(r_axis_max)
    vol = np.asarray(grid.compute_cell_sizes(length=False, area=False, volume=True).cell_data["Volume"], dtype=float)
    out: dict[str, Any] = {
        "source": "app_sampling",
        "loader": "case_volume.load_volume (cell data)",
        "read_from": source.split(":", 1)[0],
        "time": str(time),
        "n": int(keep.sum()),
        "x": [_round(v) for v in centres[keep, 0].tolist()],
        "y": [_round(v) for v in centres[keep, 1].tolist()],
        "z": [_round(v) for v in centres[keep, 2].tolist()],
        "vol": [_round(v) for v in vol[keep].tolist()],
    }
    for name in fields:
        if name not in grid.cell_data:
            raise KeyError(f"the run's volume at {time} has no cell field {name!r}")
        arr = np.asarray(grid.cell_data[name], dtype=float)
        if arr.ndim == 1:
            out[name] = [_round(v) for v in arr[keep].tolist()]
        else:
            for i, c in enumerate("xyz"):
                out[f"{name}_{c}"] = [_round(v) for v in arr[keep, i].tolist()]
    return out


def patch(case_dir: Path, time: str, patch_name: str, field: str, *,
          box: list[list[float]] | None = None) -> dict[str, Any]:
    """A field the run saved on one patch (``<time>/<field>``'s boundary values) on the faces
    whose centres lie in ``box``: face centres, areas and the field's values."""
    import numpy as np
    import pyvista as pv

    case_dir = Path(case_dir)
    foam = case_dir / "case.foam"
    if not foam.is_file():
        foam.write_text("", encoding="ascii")
    reader = pv.OpenFOAMReader(str(foam))
    values = [float(t) for t in (reader.time_values or [])]
    if values:
        reader.set_active_time_value(min(values, key=lambda t: abs(t - float(time))))
    reader.disable_all_patch_arrays()
    reader.enable_patch_array(f"patch/{patch_name}")
    data: Any = reader.read()
    block: Any = None
    boundary: Any = data["boundary"] if "boundary" in data.keys() else None
    if boundary is not None:
        for i in range(boundary.n_blocks):
            if boundary.get_block_name(i) == patch_name:
                block = boundary[i]
    if block is None or field not in block.cell_data:
        names = [str(n).split("/", 1)[-1] for n in (reader.patch_array_names or []) if str(n).startswith("patch/")]
        raise KeyError(f"the run saved no {field} on patch {patch_name!r} at {time} (patches: {', '.join(names)})")
    centres = np.asarray(block.cell_centers().points, dtype=float)
    keep = _in_box(centres, box)
    area = np.asarray(block.compute_cell_sizes(length=False, area=True, volume=False).cell_data["Area"], dtype=float)
    arr = np.asarray(block.cell_data[field], dtype=float)
    out: dict[str, Any] = {
        "source": f"case_file:{time}/{field}",
        "patch": patch_name,
        "time": str(time),
        "n": int(keep.sum()),
        "x": [_round(v) for v in centres[keep, 0].tolist()],
        "area": [_round(v) for v in area[keep].tolist()],
    }
    if arr.ndim == 1:
        out[field] = [_round(v) for v in arr[keep].tolist()]
    else:
        for i, c in enumerate("xyz"):
            out[f"{field}_{c}"] = [_round(v) for v in arr[keep, i].tolist()]
    return out


def _on_points(grid: Any, fields: list[str]) -> Any:
    """The volume with every asked field on its points, as Plot over path puts it there
    (``result_names.point_shown_field``: the reader's point data, or the cell data promoted)."""
    from result_names import point_shown_field

    src = grid
    for name in fields:
        try:
            src = point_shown_field(src, name, pass_cell_data=True)
        except RuntimeError as e:
            raise KeyError(f"the run's volume has no field {name!r}") from e
    return src


def _path(src: Any, points_m: list[list[float]], subdivisions: int, fields: list[str]) -> dict[str, Any]:
    """One polyline sampled as ``export_plot_over_path.sample_over_path`` samples it: each
    segment at ``subdivisions + 1`` steps, the first point of a later segment left out (it is
    the earlier one's last), samples off the mesh left out (``valid_mask``), and a sample
    where an asked field has no finite value left out too."""
    import numpy as np
    from export_plot_over_path import sample_segment, segment_resolution, valid_mask

    pts = [[float(v) for v in p[:3]] for p in points_m]
    if len(pts) < 2:
        raise ValueError("a line needs two points or more")
    res = segment_resolution(int(subdivisions))
    out: dict[str, Any] = {"path_points": pts, "subdivisions": int(subdivisions), "distances": [], "sample_points": []}
    cols: dict[str, list[float]] = {}
    cum = 0.0
    for i in range(len(pts) - 1):
        a, b = np.asarray(pts[i], dtype=float), np.asarray(pts[i + 1], dtype=float)
        seg = float(np.linalg.norm(b - a))
        sampled = sample_segment(src, a, b, res)
        mask = valid_mask(sampled)
        sp = np.asarray(sampled.points, dtype=float)
        local_t = np.linspace(0.0, 1.0, sp.shape[0]) if sp.shape[0] > 1 else np.array([0.0])
        arrs = {name: np.asarray(sampled.point_data[name], dtype=float) for name in fields}
        for j in range(0 if i == 0 else 1, sp.shape[0]):
            if j >= len(mask) or not bool(mask[j]):
                continue
            row: dict[str, float] = {}
            for name, arr in arrs.items():
                if arr.ndim == 1:
                    row[name] = float(arr[j])
                else:
                    for ci, c in enumerate("xyz"):
                        row[f"{name}_{c}"] = float(arr[j, ci])
            if not all(math.isfinite(v) for v in row.values()):
                continue
            out["distances"].append(cum + float(local_t[j]) * seg)
            out["sample_points"].append([float(v) for v in sp[j, :3]])
            for k, v in row.items():
                cols.setdefault(k, []).append(v)
        cum += seg
    out.update(cols)
    out["n_valid"] = len(out["distances"])
    return out


def line(case_dir: Path, time: str, fields: list[str], *, points_m: list[list[float]] | None = None,
         paths_m: list[list[list[float]]] | None = None, subdivisions: int = 100,
         use_cache: bool = True) -> dict[str, Any]:
    """The run's fields at ``time`` sampled along a polyline (``points_m``, metres) or along each
    of several (``paths_m``), as Plot over path samples them, a vector's components kept
    (``U_x``, ``U_y``, ``U_z``) and the kinematic fields in Pa, as the route gives them."""
    _tools()
    from case_units import scale_kinematic
    from case_volume import load_volume

    if (points_m is None) == (paths_m is None):
        raise ValueError("give points_m (one line) or paths_m (several), one of the two")
    grid, source = load_volume(Path(case_dir), str(time), use_cache=use_cache)
    scale_kinematic(grid, Path(case_dir))
    src = _on_points(grid, list(fields))
    head = {
        "source": "app_sampling",
        "loader": "case_volume.load_volume, case_units.scale_kinematic (as /api/plot-over-path)",
        "sampler": "export_plot_over_path.sample_segment on the point data, components kept",
        "read_from": source.split(":", 1)[0],
        "time": str(time),
        "fields": list(fields),
    }
    if points_m is not None:
        return {**head, **_path(src, points_m, subdivisions, list(fields))}
    return {**head, "paths": [_path(src, p, subdivisions, list(fields)) for p in paths_m or []]}


def sample_run(run_dir: Path, plan: dict[str, Any], case_dir: str | None, time: str | None) -> list[str]:
    """Read every ``cells`` and ``patch`` extract of the plan from the run's case folder into
    ``raw/sample_<key>.json`` (an existing file is kept: it was read while the folder was
    there). Returns what could not be read, in words."""
    problems: list[str] = []
    raw = run_dir / "raw"
    for ex in plan.get("extract") or []:
        if ex.get("kind") not in SAMPLE_KINDS:
            continue
        path = raw / f"sample_{ex['key']}.json"
        if path.is_file():
            continue
        if not case_dir or not Path(case_dir).is_dir() or time is None:
            problems.append(f"{ex['key']}: the run's case folder is gone (no {path.name} saved while it was there)")
            continue
        try:
            if ex["kind"] == "cells":
                doc = cells(Path(case_dir), time, list(ex["fields"]), box=ex.get("box_m"),
                            r_axis_max=ex.get("r_axis_max_m"))
            elif ex["kind"] == "app_sampling":
                doc = line(Path(case_dir), time, list(ex["fields"]), points_m=ex.get("points_m"),
                           paths_m=ex.get("paths_m"), subdivisions=int(ex.get("subdivisions") or 100))
            else:
                doc = patch(Path(case_dir), time, ex["patch"], ex["field"], box=ex.get("box_m"))
        except (OSError, KeyError, RuntimeError, ValueError) as e:
            problems.append(f"{ex['key']}: {e}")
            continue
        raw.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(doc) + "\n", encoding="utf-8", newline="\n")
    return problems
