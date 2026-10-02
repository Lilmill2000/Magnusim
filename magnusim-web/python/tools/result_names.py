"""Result field names shared by every results tool.

A results tool never names a physics field. It works on the fields a saved
frame shows: a scalar by its own name, a vector ``X`` by its magnitude
``magX`` (docs/plugins/compatibility.md, contract 1.1). Tensors are never
shown. The case sidecar (``w27-case.json``) may list the analysis's
``result_fields`` in order (``key``, ``kind``, ``unit_quantity``, ``label``);
a tool asked for no field opens on the first of those the frame wrote.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from case_units import case_sidecar  # noqa: E402

FIELD_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")

# Tensor fields (e.g. R from a Reynolds-stress model) cannot be coloured as a
# scalar or a vector magnitude, so no view offers them.
TENSOR_KINDS = ("symm_tensor", "tensor")


def foam_kind(path: Path) -> str:
    """'vector', 'symm_tensor', 'tensor' or 'scalar' from the file's FoamFile class
    (or its internalField)."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(4096).decode("latin1", errors="replace")
    except OSError:
        return "scalar"
    m = re.search(r"\bclass\s+(\w+)", head)
    if m:
        cls = m.group(1)
        if "SymmTensor" in cls:
            return "symm_tensor"
        if "Tensor" in cls:
            return "tensor"
        return "vector" if "Vector" in cls else "scalar"
    if "List<symmTensor>" in head:
        return "symm_tensor"
    if "List<tensor>" in head:
        return "tensor"
    if re.search(r"internalField\s+uniform\s*\(", head) or "List<vector>" in head:
        return "vector"
    return "scalar"


def mag_base(name: str) -> str:
    """``X`` for a shown name ``magX``, else ''."""
    return name[3:] if name.startswith("mag") and len(name) > 3 else ""


def foam_source(time_dir: Path, field: str) -> tuple[str, str] | None:
    """(file, kind) a shown field reads: the field's own file, or for ``mag<X>`` the vector ``X``.

    None for a tensor field (or its ``mag``): it is never shown.
    """
    if (time_dir / field).is_file():
        kind = foam_kind(time_dir / field)
        return None if kind in TENSOR_KINDS else (field, kind)
    base = mag_base(field)
    if base and (time_dir / base).is_file():
        if foam_kind(time_dir / base) in TENSOR_KINDS:
            return None
        return base, "vector"
    return None


def shown_fields(time_dir: Path) -> list[str]:
    """Every field a time folder can colour by: scalars by name, vectors as ``mag<name>``.
    Tensors are left out."""
    out: list[str] = []
    try:
        entries = sorted(Path(time_dir).iterdir())
    except OSError:
        return out
    for f in entries:
        if not f.is_file() or not FIELD_NAME.match(f.name):
            continue
        kind = foam_kind(f)
        if kind in TENSOR_KINDS:
            continue
        out.append(("mag" + f.name) if kind == "vector" else f.name)
    return out


def _is_vector(arr: Any) -> bool:
    a = np.asarray(arr)
    return a.ndim == 2 and a.shape[1] == 3


def dataset_vectors(dataset: Any) -> list[str]:
    """Names of the 3-component arrays on a dataset (point data first, then cells)."""
    out: list[str] = []
    for attr in ("point_data", "cell_data"):
        data = getattr(dataset, attr, None)
        if data is None:
            continue
        for name in data.keys():
            if str(name).startswith("vtk") or name in out:
                continue
            if _is_vector(data[name]):
                out.append(str(name))
    return out


def dataset_shown_fields(dataset: Any) -> list[str]:
    """What a dataset can show: scalar arrays by name, vectors as ``mag<name>``."""
    out: list[str] = []
    for attr in ("point_data", "cell_data"):
        data = getattr(dataset, attr, None)
        if data is None:
            continue
        for name in data.keys():
            name = str(name)
            if name.startswith("vtk") or not FIELD_NAME.match(name):
                continue
            arr = np.asarray(data[name])
            if _is_vector(arr):
                shown = "mag" + name
            elif arr.ndim == 1 or (arr.ndim == 2 and arr.shape[1] == 1):
                shown = name
            else:
                continue
            if shown not in out:
                out.append(shown)
    return out


def _derive_mag(data: Any, name: str, base: str) -> bool:
    if base not in data:
        return False
    vec = np.asarray(data[base], dtype=float)
    if vec.ndim != 2 or vec.shape[1] < 3:
        return False
    data[name] = np.linalg.norm(vec[:, :3], axis=1)
    return True


def has_shown_field(dataset: Any, name: str) -> bool:
    """True when ``name`` is on the dataset or is ``mag<X>`` of a vector on it."""
    if name in dataset.point_data or name in dataset.cell_data:
        return True
    base = mag_base(name)
    return bool(base) and any(
        base in data and _is_vector(data[base]) for data in (dataset.point_data, dataset.cell_data)
    )


def resolve_shown_field(dataset: Any, name: str, default: str = "") -> str:
    """The shown field a tool works on. A named field must be on the dataset (a
    vector's own name means its magnitude); '' means ``default``, else the first
    field the dataset shows. '' when nothing fits."""
    name = str(name or "").strip()
    if name:
        for data in (dataset.point_data, dataset.cell_data):
            if name in data and _is_vector(data[name]):
                name = "mag" + name
                break
        return name if has_shown_field(dataset, name) else ""
    for cand in (default, *dataset_shown_fields(dataset)):
        if cand and has_shown_field(dataset, cand):
            return cand
    return ""


def ensure_shown_field(dataset: Any, name: str) -> None:
    """Put shown field ``name`` on the dataset: as read, or for ``mag<X>`` the
    magnitude of vector ``X`` on the point data and the cell data wherever ``X`` is."""
    if name in dataset.point_data or name in dataset.cell_data:
        return
    base = mag_base(name)
    found = False
    if base:
        for data in (dataset.point_data, dataset.cell_data):
            found = _derive_mag(data, name, base) or found
    if not found:
        raise RuntimeError(f"mesh missing {name}")


def point_shown_field(dataset: Any, name: str, *, pass_cell_data: bool = True) -> Any:
    """The dataset with ``name`` on its point data. Cell data is promoted to the
    points when needed (a new dataset); a vector's magnitude is taken after its
    components reach the points."""
    if name in dataset.point_data:
        return dataset
    base = mag_base(name)
    if base and _derive_mag(dataset.point_data, name, base):
        return dataset
    if name in dataset.cell_data or (base and base in dataset.cell_data):
        out = dataset.cell_data_to_point_data(pass_cell_data=pass_cell_data)
        if name in out.point_data or (base and _derive_mag(out.point_data, name, base)):
            return out
    raise RuntimeError(f"mesh missing {name}")


def filter_fields(
    grid: Any, *, field: str, color_field: str = "", vector: str = "", default: str = "", what: str = "field"
) -> tuple[Any, str, str, str]:
    """For a volume filter (contour, threshold): ``(dataset, field, color, vector)``
    with the filtered field, the colour field and the vector on the points (cells
    promoted when needed). The colour falls back to the filtered field when it is
    not on the dataset; the vector is dropped when it is not."""
    name = resolve_shown_field(grid, field, default)
    if not name:
        if field:
            raise RuntimeError(f"{what} {field!r} is not in this result")
        raise RuntimeError(f"this result has no field for the {what}")
    src = point_shown_field(grid, name, pass_cell_data=False)
    vec = vector if vector and (vector in src.point_data or vector in src.cell_data) else ""
    if vec and vec not in src.point_data:
        try:
            src = src.cell_data_to_point_data()
        except Exception:
            vec = ""
    color = resolve_shown_field(src, color_field, default) or name
    if color != name:
        try:
            src = point_shown_field(src, color, pass_cell_data=False)
        except RuntimeError:
            color = name
    return src, name, color, vec


def case_result_fields(case_dir: Path) -> list[dict[str, str]] | None:
    """The analysis's result fields from the case sidecar, in order; None when it lists none.

    Each row is ``{key, kind, unit_quantity, label}``; ``kind`` is '' when the
    sidecar does not say (the time folder's file tells then).
    """
    rows = case_sidecar(case_dir).get("result_fields")
    if not isinstance(rows, list):
        return None
    out: list[dict[str, str]] = []
    for row in rows:
        if isinstance(row, str):
            row = {"key": row}
        if not isinstance(row, dict):
            continue
        key = str(row.get("key") or "").strip()
        if not FIELD_NAME.match(key):
            continue
        out.append({
            "key": key,
            "kind": str(row.get("kind") or "").strip().lower(),
            "unit_quantity": str(row.get("unit_quantity") or "").strip().lower(),
            "label": str(row.get("label") or ""),
        })
    return out


def _row_shown_name(time_dir: Path, row: dict[str, str]) -> str:
    key = row["key"]
    kind = row.get("kind") or ""
    if not kind and (time_dir / key).is_file():
        kind = foam_kind(time_dir / key)
    return "mag" + key if kind == "vector" else key


def default_shown_field(case_dir: Path, time: str) -> str:
    """The field a tool shows when asked for none: the first sidecar result field
    the frame wrote, else the first the time folder holds ('' when it holds none)."""
    time_dir = Path(case_dir) / str(time)
    for row in case_result_fields(case_dir) or []:
        name = _row_shown_name(time_dir, row)
        if foam_source(time_dir, name) is not None:
            return name
    shown = shown_fields(time_dir)
    return shown[0] if shown else ""


def _vector_file(time_dir: Path, name: str) -> bool:
    return bool(FIELD_NAME.match(name)) and (time_dir / name).is_file() and foam_kind(time_dir / name) == "vector"


def velocity_vector(case_dir: Path, time: str, requested: str = "") -> str | None:
    """The vector field particles follow: ``requested`` when the frame wrote it;
    else the sidecar's first vector result field measured as a velocity that the
    frame wrote; else the frame's only vector; else None."""
    time_dir = Path(case_dir) / str(time)
    requested = str(requested or "").strip()
    if requested and _vector_file(time_dir, requested):
        return requested
    for row in case_result_fields(case_dir) or []:
        if row.get("kind") not in ("", "vector") or row.get("unit_quantity") != "velocity":
            continue
        if _vector_file(time_dir, row["key"]):
            return row["key"]
    try:
        names = sorted(f.name for f in time_dir.iterdir() if f.is_file())
    except OSError:
        return None
    vectors = [n for n in names if _vector_file(time_dir, n)]
    return vectors[0] if len(vectors) == 1 else None


def dataset_vector(case_dir: Path, time: str, dataset: Any, requested: str = "") -> str:
    """The vector a tool carries on ``dataset``: ``velocity_vector`` when the dataset
    holds it, else the dataset's only vector; '' when neither."""
    vectors = dataset_vectors(dataset)
    vec = velocity_vector(case_dir, time, requested)
    if vec in vectors:
        return str(vec)
    return vectors[0] if len(vectors) == 1 else ""


def foam_sources(time_dir: Path, names) -> dict[str, str]:
    """{shown name: the OpenFOAM file it reads} for the names the time folder holds."""
    out: dict[str, str] = {}
    for name in names:
        if not name or name in out:
            continue
        src = foam_source(Path(time_dir), name)
        if src is not None:
            out[name] = str(Path(time_dir) / src[0])
    return out
