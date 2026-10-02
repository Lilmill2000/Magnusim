"""API 1.4 result fields: one checked list for describe rows and the case sidecar.

A row carries its unit label (``unit``, '' = from ``unit_quantity``), a
vector's magnitude label and ``shown``, the name a view colours by (``None``
for a tensor, which is never offered).
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from cfddesk.registry.analysis import AnalysisType, ResultField, _stamp_case
from cfddesk.registry.contract import ContractError, describe_extra, result_fields


def _spec(*rows) -> SimpleNamespace:
    return SimpleNamespace(key="x_steady", result_fields=tuple(rows))


def test_positional_result_field_still_builds():
    f = ResultField("T", "Temperature", "temperature", "scalar")
    assert (f.key, f.label, f.unit_quantity, f.kind, f.unit, f.magnitude_label) == (
        "T", "Temperature", "temperature", "scalar", "", ""
    )


def test_rows_say_what_each_field_is_shown_as():
    rows = result_fields(
        _spec(
            ResultField("U", "Velocity", "velocity", "vector", magnitude_label="Speed"),
            ResultField("p", "Pressure", "pressure", "scalar", unit="Pa"),
            ResultField("R", "Reynolds stress", "specific_energy", "symm_tensor"),
            ResultField("gradU", "Velocity gradient", "", "tensor"),
        )
    )
    assert [(r["key"], r["shown"]) for r in rows] == [("U", "magU"), ("p", "p"), ("R", None), ("gradU", None)]
    assert rows[0] == {
        "key": "U",
        "label": "Velocity",
        "unit_quantity": "velocity",
        "kind": "vector",
        "unit": "",
        "magnitude_label": "Speed",
        "shown": "magU",
    }
    assert rows[1]["unit"] == "Pa"


def test_describe_keeps_the_old_keys_first():
    spec = AnalysisType(
        "x_steady", "X", "TEST", "steady", ("T",),
        result_fields=(ResultField("T", "Temperature", "temperature", "scalar"),),
    )
    row = describe_extra(spec)["result_fields"][0]
    assert list(row) == ["key", "label", "unit_quantity", "kind", "unit", "magnitude_label", "shown"]
    assert row["unit"] == "" and row["shown"] == "T"


@pytest.mark.parametrize(
    "bad",
    [
        ResultField("1T", "T", "temperature", "scalar"),
        ResultField("a__b", "T", "temperature", "scalar"),
        ResultField("T", "T", "temperature", "matrix"),  # type: ignore[arg-type]
        ResultField("T", "T", "temperature", "scalar", unit="K\n"),
        ResultField("T", "T", "temperature", "scalar", unit="x" * 33),
        ResultField("U", "U", "velocity", "vector", magnitude_label="a\tb"),
    ],
)
def test_a_bad_row_is_a_contract_error(bad):
    with pytest.raises(ContractError):
        result_fields(_spec(bad))


def test_a_key_listed_twice_is_a_contract_error():
    with pytest.raises(ContractError, match="twice"):
        result_fields(_spec(ResultField("T", "T", "", "scalar"), ResultField("T", "T2", "", "scalar")))


def test_the_case_sidecar_gets_the_rows_and_a_writers_own_list_wins(tmp_path: Path):
    spec = SimpleNamespace(
        key="x_steady",
        frame_fields=("T",),
        result_fields=(ResultField("T", "Temperature", "temperature", "scalar", unit="K"),),
    )
    fresh = tmp_path / "fresh"
    fresh.mkdir()
    _stamp_case(fresh, "x_steady", spec)
    doc = json.loads((fresh / "w27-case.json").read_text(encoding="utf-8"))
    assert doc["result_fields"] == result_fields(spec)
    assert doc["result_fields"][0]["unit"] == "K"

    own = tmp_path / "own"
    own.mkdir()
    (own / "w27-case.json").write_text(json.dumps({"result_fields": [{"key": "Q", "kind": "scalar"}]}), encoding="utf-8")
    _stamp_case(own, "x_steady", spec)
    assert json.loads((own / "w27-case.json").read_text(encoding="utf-8"))["result_fields"] == [
        {"key": "Q", "kind": "scalar"}
    ]

    # An analysis that declares none leaves the key out.
    none = tmp_path / "none"
    none.mkdir()
    _stamp_case(none, "x_steady", SimpleNamespace(key="x_steady", frame_fields=("T",)))
    assert "result_fields" not in json.loads((none / "w27-case.json").read_text(encoding="utf-8"))
