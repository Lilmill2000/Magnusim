import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[2] / "tools"
sys.path.insert(0, str(TOOLS))

import numpy as np  # noqa: E402
import pytest  # noqa: E402
from export_case_field import parse_foam_scalar_or_vector, series_field_range  # noqa: E402


def _write_uniform_u(case: Path, time: str, vec: tuple[float, float, float]) -> None:
    d = case / time
    d.mkdir(parents=True, exist_ok=True)
    (d / "U").write_text(
        f"internalField   uniform ({vec[0]} {vec[1]} {vec[2]});\n",
        encoding="utf-8",
    )


def test_series_range_is_overall_min_max(tmp_path: Path):
    _write_uniform_u(tmp_path, "0", (0.0, 0.0, 0.0))
    _write_uniform_u(tmp_path, "0.5", (3.0, 0.0, 0.0))
    _write_uniform_u(tmp_path, "1", (1.0, 0.0, 0.0))
    out = series_field_range(tmp_path, "magU")
    assert out["n_times"] == 3
    assert out["min"] == 0.0
    assert out["max"] == 3.0
    assert [f["time"] for f in out["frames"]] == ["0", "0.5", "1"]


def _foam(fmt: str, cls: str, obj: str, body: bytes, scalar_bits: int = 64) -> bytes:
    head = (
        "FoamFile\n{\n    version     2.0;\n    format      " + fmt + ";\n"
        f'    arch        "LSB;label=32;scalar={scalar_bits}";\n'
        f"    class       {cls};\n    object      {obj};\n}}\n\n"
        "dimensions      [0 2 -2 0 0 0 0];\n\n"
    ).encode("latin1")
    tail = b";\n\nboundaryField\n{\n    walls\n    {\n        type            zeroGradient;\n    }\n}\n"
    return head + body + tail


def _binary_field(case: Path, time: str, name: str, values: np.ndarray, scalar_bits: int = 64) -> None:
    vec = values.ndim == 2
    kind = "vector" if vec else "scalar"
    dtype = "<f4" if scalar_bits == 32 else "<f8"
    n = values.shape[0]
    body = (
        f"internalField   nonuniform List<{kind}> {n}(".encode("latin1")
        + np.asarray(values, dtype=dtype).tobytes()
        + b")"
    )
    d = case / time
    d.mkdir(parents=True, exist_ok=True)
    cls = "volVectorField" if vec else "volScalarField"
    (d / name).write_bytes(_foam("binary", cls, name, body, scalar_bits))


def _ascii_field(case: Path, time: str, name: str, values: np.ndarray) -> None:
    vec = values.ndim == 2
    kind = "vector" if vec else "scalar"
    rows = (
        [f"({float(a)!r} {float(b)!r} {float(c)!r})" for a, b, c in values]
        if vec
        else [repr(float(v)) for v in values]
    )
    body = f"internalField   nonuniform List<{kind}> \n{len(rows)}\n(\n" + "\n".join(rows) + "\n)\n"
    d = case / time
    d.mkdir(parents=True, exist_ok=True)
    cls = "volVectorField" if vec else "volScalarField"
    (d / name).write_bytes(_foam("ascii", cls, name, body.encode("latin1")))


def test_binary_and_ascii_fields_give_the_same_stats(tmp_path: Path):
    # Solves write fields in binary (smaller, faster); old runs are ascii. Same numbers.
    rng = np.random.default_rng(3)
    u = rng.normal(size=(500, 3))
    p = rng.normal(size=500) * 50.0
    _binary_field(tmp_path / "bin", "1", "U", u)
    _binary_field(tmp_path / "bin", "1", "p", p)
    _ascii_field(tmp_path / "asc", "1", "U", u)
    _ascii_field(tmp_path / "asc", "1", "p", p)
    for name, kind in (("U", "vector"), ("p", "scalar")):
        b = parse_foam_scalar_or_vector(tmp_path / "bin" / "1" / name, kind)
        a = parse_foam_scalar_or_vector(tmp_path / "asc" / "1" / name, kind)
        for key in ("n_cells_internal", "sample_checksum_sha256", "sample_head", "sample_tail", "nonzero"):
            assert a[key] == b[key], (name, key)
        lo, hi = ("umin", "umax") if kind == "vector" else ("pmin", "pmax")
        assert a[lo] == b[lo] and a[hi] == b[hi]
    assert parse_foam_scalar_or_vector(tmp_path / "bin" / "1" / "U", "vector")["umax"] == pytest.approx(
        float(np.linalg.norm(u, axis=1).max())
    )


def test_single_precision_binary_field(tmp_path: Path):
    p = np.array([1.5, -2.25, 8.0, 0.0], dtype=np.float32)
    _binary_field(tmp_path, "1", "p", p, scalar_bits=32)
    stats = parse_foam_scalar_or_vector(tmp_path / "1" / "p", "scalar")
    assert (stats["pmin"], stats["pmax"], stats["n_cells_internal"]) == (-2.25, 8.0, 4)


def test_truncated_binary_field_is_an_error(tmp_path: Path):
    _binary_field(tmp_path, "1", "p", np.arange(10, dtype=float))
    f = tmp_path / "1" / "p"
    raw = f.read_bytes()
    start = raw.index(b"List<scalar> 10(") + len(b"List<scalar> 10(")
    f.write_bytes(raw[: start + 40])  # 5 of the 10 values
    with pytest.raises(RuntimeError):
        parse_foam_scalar_or_vector(f, "scalar")


def test_series_range_over_binary_frames(tmp_path: Path):
    _binary_field(tmp_path, "0.5", "U", np.array([[1.0, 0, 0], [0, 2.0, 0]]))
    _binary_field(tmp_path, "1", "U", np.array([[0, 0, 4.0], [0.5, 0, 0]]))
    out = series_field_range(tmp_path, "magU")
    assert (out["min"], out["max"], out["n_times"]) == (0.5, 4.0, 2)
