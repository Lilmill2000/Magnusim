"""The validation report (validation/report.py): VALIDATION.md is what the committed results
give, every result row is complete, and the report lists every row with its error."""

from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[1]


def _report():
    spec = importlib.util.spec_from_file_location("ht_validation_report", PLUGIN / "validation" / "report.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_validation_md_is_what_the_results_give():
    report = _report()
    assert report.main(["--check"]) == 0, "VALIDATION.md is out of date: run python validation/report.py"


def test_every_result_row_is_complete():
    report = _report()
    rows = json.loads((PLUGIN / "validation" / "results.json").read_text(encoding="utf-8"))["rows"]
    assert rows
    for r in rows:
        assert all(k in r for k in report.REQUIRED), r
        assert r["mesher"] in ("Hex-dominant", "Standard"), r
        assert math.isfinite(float(r["value"])) and float(r["reference"]) != 0, r
        assert abs(100 * (float(r["value"]) / float(r["reference"]) - 1) - float(r["error_pct"])) < 0.01, r
    # Hex-dominant for every case, Standard on the pipes as well (the validation scope).
    cases = {r["case"] for r in rows}
    hex_cases = {r["case"] for r in rows if r["mesher"] == "Hex-dominant"}
    assert hex_cases == cases
    assert {r["case"] for r in rows if r["mesher"] == "Standard"} == {c for c in cases if "pipe" in c}


def test_the_report_lists_each_row():
    report = _report()
    doc = {"rows": [
        {"case": "A case", "group": "Natural convection", "quantity": "Nu", "reference": 4.519, "value": 4.5, "error_pct": -0.42,
         "uncertainty_pct": 0.5, "mesher": "Hex-dominant", "cells": 105518, "iterations": 2500, "source": "A paper",
         "setup": "A slab", "mesh": "fineness 4", "detail": "settled", "layers": {"hot": "3.8 of 4 layers, 92 % of the thickness"}},
        {"case": "A case", "group": "Natural convection", "quantity": "Nu_max", "reference": 7.717, "value": 7.6, "error_pct": -1.5,
         "peak_y": 0.2, "peak_y_ref": 0.081, "peak_y_flag": True, "mesher": "Hex-dominant", "iterations": 2500,
         "source": "A paper", "setup": "A slab"},
        {"case": "B case", "group": "Conduction (CHT)", "quantity": "Q", "reference": 10, "value": 10, "error_pct": 0,
         "mesher": "Hex-dominant", "iterations": 800, "source": "a balance", "setup": "A block"},
        {"case": "B case", "group": "Conduction (CHT)", "quantity": "T", "reference": 14.6, "value": 14.6, "error_pct": 0,
         "mesher": "Hex-dominant", "iterations": 800, "source": "1D conduction", "setup": "A block"},
    ]}
    text = report.build(doc)
    assert "| A case | Nu | 4.519 | 4.500 ± 0.50 % | -0.42 % | Hex-dominant | 105 518 | 2500 |" in text
    assert "| A case | Nu_max | 7.717 | 7.600 | -1.50 % (peak at y/L 0.200, the reference's at 0.081) |" in text
    assert ("- Nu on Hex-dominant: 4.500 ± 0.50 % against 4.519 (-0.42 %); mesh: fineness 4; settled; layers: hot 3.8 of 4 "
            "layers, 92 % of the thickness.") in text
    # One setup and one reference line for a case whose rows share them; each row's own
    # reference when they differ.
    assert text.count("A slab.") == 1 and "Reference: A paper." in text
    assert "Reference: a balance" not in text
    assert "- Q on Hex-dominant: 10.00 against 10.00 (+0.00 %); reference: a balance." in text
    assert "- T on Hex-dominant: 14.60 against 14.60 (+0.00 %); reference: 1D conduction." in text


def test_the_study_panel_note_states_what_standard_meshes_read():
    """The note a study on a Standard mesh shows ("up to about N % high next to a laminar
    flow and about M % low with wall functions") is what the validation set's pipes read on
    Standard."""
    import re

    ui = (PLUGIN / "ui" / "StudySettings.tsx").read_text(encoding="utf-8")
    high = float(re.search(r"STANDARD_LAMINAR_HIGH_PCT = (\d+(?:\.\d+)?)", ui).group(1))  # type: ignore[union-attr]
    low = float(re.search(r"STANDARD_TURBULENT_LOW_PCT = (\d+(?:\.\d+)?)", ui).group(1))  # type: ignore[union-attr]
    rows = json.loads((PLUGIN / "validation" / "results.json").read_text(encoding="utf-8"))["rows"]
    laminar = [float(r["error_pct"]) for r in rows if r["mesher"] == "Standard" and r["case"].startswith("Laminar pipe")]
    turbulent = [float(r["error_pct"]) for r in rows if r["mesher"] == "Standard" and r["case"].startswith("Turbulent pipe")]
    assert len(laminar) == 2 and len(turbulent) == 1
    assert 0 < max(laminar) <= high + 1.0 and max(laminar) > high - 2.0, (laminar, high)
    assert abs(-turbulent[0] - low) < 3.0, (turbulent, low)
