import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[2] / "tools"
sys.path.insert(0, str(TOOLS))

from export_case_field import series_field_range  # noqa: E402


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
