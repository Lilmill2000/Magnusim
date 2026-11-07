"""A saved time's wall entries (RH3, the validation set's pipes, 2026-11-06): a run continued with
the study's new numerics starts from its latest saved time, whose field files hold the walls it
saved, so the case writer's new wall treatment (k-omega SST's Spalding's law and stepwise omega)
would not reach the solver. ``magnusim_sdk.foam.sync_wall_entries`` gives the saved file the
writer's new entries for the wall patches, keeping each entry's saved value byte for byte, and
leaves every other patch as it was. The saved files are binary (``writeFormat binary``): a list's
values are raw bytes after its count, so a value holding ``{``, ``}`` or ``;`` bytes must not end
an entry."""

from __future__ import annotations

from pathlib import Path

import pytest
from magnusim_sdk.foam import (
    FoamFieldError,
    boundary_entries,
    boundary_entry_types,
    restart_wall_entries,
    sync_wall_entries,
)

# Raw values that read as the text that ends an entry or a statement: only the list's count
# tells where they end.
TRICKY = b"{};(){}\n"


def _head(name: str, fmt: str = "binary") -> bytes:
    return (
        b"/*--------------------------------*- C++ -*----------------------------------*\\\n"
        b"| =========                 |                                                 |\n"
        b"\\*---------------------------------------------------------------------------*/\n"
        b"FoamFile\n{\n    version     2.0;\n    format      " + fmt.encode() + b";\n"
        b'    arch        "LSB;label=32;scalar=64";\n    class       volScalarField;\n    location    "100";\n'
        b"    object      " + name.encode() + b";\n}\n"
        b"// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //\n\n"
    )


def _list(n: int) -> bytes:
    return b"nonuniform List<scalar> \n%d\n(" % n + TRICKY * n + b")\n"


def _saved_nut(wall_type: bytes = b"nutkWallFunction") -> bytes:
    """A binary saved nut: the walls with ``wall_type`` and the coefficients OpenFOAM writes."""
    return (
        _head("nut")
        + b"dimensions      [0 2 -1 0 0 0 0];\n\ninternalField   " + _list(5) + b";\n\nboundaryField\n{\n"
        + b"    inlet\n    {\n        type            calculated;\n        value           " + _list(2) + b";\n    }\n"
        + b"    walls\n    {\n        type            " + wall_type + b";\n        Cmu             0.09;\n"
        + b"        kappa           0.41;\n        E               9.8;\n        value           " + _list(3) + b";\n    }\n"
        + b"    frontAndBack\n    {\n        type            empty;\n    }\n}\n\n\n"
        + b"// ************************************************************************* //\n"
    )


FRESH_NUT = (
    "FoamFile\n{\n    version     2.0;\n    format      ascii;\n    class       volScalarField;\n    object      nut;\n}\n\n"
    "dimensions      [0 2 -1 0 0 0 0];\n\ninternalField   uniform 0;\n\nboundaryField\n{\n"
    "    inlet\n    {\n        type          calculated;\n        value          uniform 0;\n    }\n"
    "    walls\n    {\n        type          nutUSpaldingWallFunction;\n        value          uniform 0;\n    }\n"
    "    frontAndBack\n    {\n        type          empty;\n    }\n}\n"
)

FRESH_OMEGA = FRESH_NUT.replace("object      nut;", "object      omega;").replace(
    "type          nutUSpaldingWallFunction;\n", "type          omegaWallFunction;\n        blending          stepwise;\n"
)


def _value_of(b: bytes, patch: str) -> bytes:
    s, e = boundary_entries(b)[patch]
    body = b[s:e]
    return body[body.index(b"value") : body.rindex(b";") + 1]


def test_a_binary_fields_entries_are_found_by_their_lists_counts_not_their_bytes():
    b = _saved_nut()
    entries = boundary_entries(b)
    assert list(entries) == ["inlet", "walls", "frontAndBack"]
    for s, e in entries.values():
        assert b[s : s + 1] == b"{" and b[e - 1 : e] == b"}"
    assert _value_of(b, "walls").startswith(b"value           nonuniform List<scalar> \n3\n(" + TRICKY)


def test_the_walls_get_the_writers_new_entry_with_the_value_the_run_saved(tmp_path: Path):
    saved = tmp_path / "nut"
    saved.write_bytes(_saved_nut())
    fresh = tmp_path / "0nut"
    fresh.write_text(FRESH_NUT, encoding="utf-8")
    before = saved.read_bytes()
    assert sync_wall_entries(saved, fresh, ["walls", "inlet"]) == ["walls"]
    after = saved.read_bytes()
    assert boundary_entry_types(saved) == {"inlet": "calculated", "walls": "nutUSpaldingWallFunction", "frontAndBack": "empty"}
    # The saved value, byte for byte; nutkWallFunction's coefficients gone with it.
    assert _value_of(after, "walls") == _value_of(before, "walls")
    s, e = boundary_entries(after)["walls"]
    assert b"Cmu" not in after[s:e] and b"kappa" not in after[s:e]
    # Everything else as it was: the header, the internal field and the other patches.
    ws, _ = boundary_entries(before)["walls"]
    assert after[:ws] == before[:ws]
    assert after[boundary_entries(after)["walls"][1] :] == before[boundary_entries(before)["walls"][1] :]
    # Done once: a second pass finds nothing to change and leaves the file alone.
    assert sync_wall_entries(saved, fresh, ["walls"]) == []
    assert saved.read_bytes() == after


def test_a_key_the_writer_adds_counts_as_a_change(tmp_path: Path):
    saved = tmp_path / "omega"
    saved.write_bytes(_saved_nut(b"omegaWallFunction").replace(b"object      nut;", b"object      omega;"))
    # The saved omega walls carry OpenFOAM's coefficients and no blending: the writer's carries
    # blending stepwise, so they differ.
    fresh = tmp_path / "0omega"
    fresh.write_text(FRESH_OMEGA, encoding="utf-8")
    assert sync_wall_entries(saved, fresh, ["walls"]) == ["walls"]
    s, e = boundary_entries(saved.read_bytes())["walls"]
    assert b"blending stepwise;" in b" ".join(saved.read_bytes()[s:e].split())


def test_an_ascii_saved_field_works_the_same(tmp_path: Path):
    text = (
        _head("nut", "ascii").decode()
        + "dimensions [0 2 -1 0 0 0 0];\ninternalField nonuniform List<scalar> \n3\n(\n1\n2\n3\n)\n;\n"
        + "boundaryField\n{\n    walls\n    {\n        type nutkWallFunction;\n        value nonuniform List<scalar> 2(0.5 0.25);\n    }\n}\n"
    )
    saved = tmp_path / "nut"
    saved.write_text(text, encoding="utf-8")
    fresh = tmp_path / "0nut"
    fresh.write_text(FRESH_NUT, encoding="utf-8")
    assert sync_wall_entries(saved, fresh, ["walls"]) == ["walls"]
    out = saved.read_text(encoding="utf-8")
    assert "type          nutUSpaldingWallFunction;" in out and "value nonuniform List<scalar> 2(0.5 0.25);" in out


def test_a_binary_list_shorter_than_its_count_is_refused_and_the_file_left_as_it_was(tmp_path: Path):
    saved = tmp_path / "nut"
    bad = _saved_nut().replace(b"\n3\n(" + TRICKY * 3, b"\n4\n(" + TRICKY * 3, 1)
    saved.write_bytes(bad)
    fresh = tmp_path / "0nut"
    fresh.write_text(FRESH_NUT, encoding="utf-8")
    with pytest.raises(FoamFieldError, match="does not match its count"):
        sync_wall_entries(saved, fresh, ["walls"])
    assert saved.read_bytes() == bad


def _case(tmp_path: Path) -> Path:
    case = tmp_path / "case"
    poly = case / "constant" / "polyMesh"
    poly.mkdir(parents=True)
    (poly / "boundary").write_text(
        "FoamFile\n{\n    version 2.0;\n    format ascii;\n    class polyBoundaryMesh;\n    object boundary;\n}\n3\n(\n"
        "    inlet\n    {\n        type            patch;\n        nFaces 2;\n        startFace 10;\n    }\n"
        "    walls\n    {\n        type            wall;\n        nFaces 3;\n        startFace 12;\n    }\n"
        "    frontAndBack\n    {\n        type            empty;\n        nFaces 4;\n        startFace 15;\n    }\n)\n",
        encoding="utf-8",
    )
    (case / "0").mkdir()
    (case / "0" / "nut").write_text(FRESH_NUT, encoding="utf-8")
    (case / "0" / "omega").write_text(FRESH_OMEGA, encoding="utf-8")
    (case / "100").mkdir()
    (case / "100" / "nut").write_bytes(_saved_nut())
    (case / "100" / "omega").write_bytes(_saved_nut(b"omegaWallFunction").replace(b"object      nut;", b"object      omega;"))
    return case


def test_restart_wall_entries_gives_the_saved_times_wall_patches_the_writers_entries(tmp_path: Path):
    case = _case(tmp_path)
    (case / "100" / "k").write_text("saved, not a field file\n", encoding="utf-8")
    (case / "0" / "k").write_text(FRESH_NUT, encoding="utf-8")
    assert restart_wall_entries(case, 100.0, ["nut", "omega", "k", "epsilon"]) == {"nut": ["walls"], "omega": ["walls"]}
    assert boundary_entry_types(case / "100" / "nut")["walls"] == "nutUSpaldingWallFunction"
    # Only wall patches: the inlet keeps what the run saved there.
    assert boundary_entry_types(case / "100" / "nut")["inlet"] == "calculated"
    assert (case / "100" / "k").read_text(encoding="utf-8") == "saved, not a field file\n"
    # A saved time that is not there: nothing to do.
    assert restart_wall_entries(case, 50.0, ["nut"]) == {}


def test_a_saved_field_the_reader_cannot_follow_names_its_file(tmp_path: Path):
    case = _case(tmp_path)
    (case / "100" / "nut").write_bytes(_saved_nut().replace(b"List<scalar>", b"List<thing>", 1))
    with pytest.raises(FoamFieldError, match=r"^100/nut: a list of 'thing'"):
        restart_wall_entries(case, 100.0, ["nut"])
