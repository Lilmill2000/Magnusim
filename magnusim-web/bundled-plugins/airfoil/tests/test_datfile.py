"""Reading .dat files: Selig and Lednicer layouts, what is fixed on the way, and what is refused."""

from __future__ import annotations

import pytest

from airfoil import datfile, geometry, naca


def _selig_text(sec, name="NACA 2412"):
    return datfile.write(name, sec.x, sec.y)


def _closed():
    return naca.generate("2412", 61, closed_te=True)


def test_selig_round_trip():
    sec = naca.generate("2412", 61)
    got = datfile.parse(_selig_text(sec))
    assert got.name == "NACA 2412"
    assert got.layout == "selig"
    assert got.x == pytest.approx(sec.x, abs=1e-8)
    assert got.y == pytest.approx(sec.y, abs=1e-8)
    # The section's own ends sit a hair past x = 1 (cambered, open TE): within 1e-3 nothing is changed.
    assert got.warnings == []


def test_lednicer_is_joined_in_selig_order():
    sec = _closed()
    le = geometry.leading_edge_index(sec.x)
    upper = list(zip(sec.x[: le + 1], sec.y[: le + 1], strict=True))[::-1]  # leading edge to trailing edge
    lower = list(zip(sec.x[le:], sec.y[le:], strict=True))
    lines = ["NACA 2412 (Lednicer)", f"{len(upper)}.  {len(lower)}.", ""]
    lines += [f"{x:.8f} {y:.8f}" for x, y in upper] + [""]
    lines += [f"{x:.8f} {y:.8f}" for x, y in lower]
    got = datfile.parse("\n".join(lines))
    assert got.layout == "lednicer"
    assert got.name == "NACA 2412 (Lednicer)"
    assert len(got.x) == len(sec.x)
    assert got.x == pytest.approx(sec.x, abs=1e-7)
    assert got.y == pytest.approx(sec.y, abs=1e-7)
    assert any("Lednicer" in w for w in got.warnings)


def test_lednicer_count_mismatch_names_the_line():
    with pytest.raises(datfile.DatError, match=r"Line 2: the file says 30 upper and 30 lower points, but it has 3"):
        datfile.parse("X\n30. 30.\n0 0\n0.5 0.05\n1 0\n")


def test_lower_surface_first_is_reversed():
    sec = _closed()
    got = datfile.parse(datfile.write("Backwards", sec.x[::-1], sec.y[::-1]))
    assert got.x == pytest.approx(sec.x, abs=1e-8)
    assert got.y == pytest.approx(sec.y, abs=1e-8)
    assert any("reversed" in w for w in got.warnings)


def test_other_chord_is_scaled_and_moved():
    sec = _closed()
    x = [0.3 + 0.25 * v for v in sec.x]
    y = [0.1 + 0.25 * v for v in sec.y]
    got = datfile.parse(datfile.write("Big", x, y))
    assert got.x == pytest.approx(sec.x, abs=1e-7)
    assert got.y == pytest.approx(sec.y, abs=1e-7)
    assert "Scaled to chord 1 (it was 0.25)." in got.warnings


def test_no_name_line_takes_the_file_name_and_commas_work():
    sec = _closed()
    text = "\n".join(f"{x:.6f}, {y:.6f}" for x, y in zip(sec.x, sec.y, strict=True))
    got = datfile.parse(text, "C:\\foils\\my-foil.dat")
    assert got.name == "my-foil"
    assert len(got.x) == len(sec.x)


def test_repeated_points_are_dropped():
    sec = _closed()
    x = sec.x[:10] + [sec.x[9]] + sec.x[10:]
    y = sec.y[:10] + [sec.y[9]] + sec.y[10:]
    got = datfile.parse(datfile.write("Dup", x, y))
    assert len(got.x) == len(sec.x)
    assert "Removed 1 repeated point." in got.warnings


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("Name\n1 0\n0.5 abc\n", r"Line 3: expected two numbers \(x and y\), found “0.5 abc”"),
        ("Name\n1 0 0\n", r"Line 2: expected two numbers \(x and y\), found 3"),
        ("Name\n", "no coordinates"),
        ("Name\n1 0\n0 0\n1 0.01\n", "needs at least 10"),
        ("Name\n" + "\n".join(f"{i / 10} 0.0{i}" for i in range(12)), "start at the trailing edge"),
    ],
)
def test_refused_with_the_reason(text, message):
    with pytest.raises(datfile.DatError, match=message):
        datfile.parse(text)


def test_crossing_outline_is_refused():
    sec = _closed()
    x, y = list(sec.x), list(sec.y)
    # One upper-surface point pulled down below the lower surface: the outline folds over itself.
    y[20] = -0.1
    with pytest.raises(datfile.DatError, match="crosses itself"):
        datfile.parse(datfile.write("Folded", x, y))


def test_flat_plate_is_refused():
    x = [1 - i / 20 for i in range(21)] + [i / 20 for i in range(1, 21)]
    y = [0.0001] * 21 + [-0.0001] * 20
    with pytest.raises(datfile.DatError, match="thinner than 0.2 %"):
        datfile.parse(datfile.write("Plate", x, y))


def test_too_big_file_is_refused():
    with pytest.raises(datfile.DatError, match="larger than 256 KB"):
        datfile.parse("x" * (300 * 1024))
