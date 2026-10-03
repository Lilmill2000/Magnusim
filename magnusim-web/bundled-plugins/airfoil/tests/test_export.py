"""The Export buttons' files: the polar CSV (every engine, failed angles kept) and the section .dat."""

from __future__ import annotations

import csv
import io

import pytest

import airfoil_service as svc
from airfoil import datfile, export, naca, settings, store

NF = {
    "engine": "neuralfoil",
    "model_size": "xlarge",
    "name": "NACA 2412",
    "conditions": {**settings.DEFAULT_CONDITIONS},
    "rows": [
        {"alpha": 0.0, "cl": 0.24, "cd": 0.0058, "cm": -0.053, "cl_cd": 41.4, "confidence": 0.93, "xtr_top": 0.61, "xtr_bottom": 0.72},
        {"alpha": -1.0, "cl": 0.13, "cd": 0.0057, "cm": -0.052, "cl_cd": 22.8, "confidence": 0.92, "xtr_top": 0.66, "xtr_bottom": 0.64},
    ],
}
XF = {
    "engine": "xfoil",
    "name": "NACA 2412",
    "conditions": {**settings.DEFAULT_CONDITIONS, "xtr_top": 0.05, "xtr_bottom": 0.1},
    "rows": [{"alpha": 4.0, "cl": 0.7169, "cd": 0.00701, "cdp": 0.0019, "cm": -0.054, "cl_cd": 102.3, "xtr_top": 0.05, "xtr_bottom": 0.1}],
    "not_converged": [2.0],
}


def _read(text: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(text)))


def test_csv_lists_every_engine_with_its_settings_and_keeps_failed_angles():
    text = export.polar_csv({"neuralfoil": NF, "xfoil": XF})
    assert text.splitlines()[0] == ",".join(export.COLUMNS)
    assert "\r" not in text
    rows = _read(text)
    assert [(r["engine"], r["alpha_deg"], r["status"]) for r in rows] == [
        ("NeuralFoil", "-1", ""),
        ("NeuralFoil", "0", ""),
        ("XFOIL", "2", "did not converge"),
        ("XFOIL", "4", "converged"),
    ]
    nf0 = rows[1]
    assert nf0["model"] == "xlarge" and nf0["airfoil"] == "NACA 2412"
    assert (nf0["re"], nf0["mach"], nf0["ncrit"], nf0["trip_top_x_c"]) == ("1000000", "0", "9", "1")
    assert (nf0["cl"], nf0["cd"], nf0["cm"], nf0["confidence"]) == ("0.24", "0.0058", "-0.053", "0.93")
    failed, xf4 = rows[2], rows[3]
    assert failed["cl"] == failed["cd"] == failed["cm"] == ""
    assert (xf4["cl"], xf4["cd"], xf4["model"], xf4["confidence"]) == ("0.7169", "0.00701", "", "")
    assert (xf4["trip_top_x_c"], xf4["trip_bottom_x_c"]) == ("0.05", "0.1")
    assert (xf4["transition_top_x_c"], xf4["transition_bottom_x_c"]) == ("0.05", "0.1")


def test_file_stems_drop_what_windows_refuses():
    assert export.file_stem("NACA 2412") == "NACA 2412"
    assert export.file_stem('E387 <rev:2>/"b"') == "E387 rev2b"
    assert export.file_stem(" ... ") == "Airfoil"


def test_export_csv_reads_the_saved_results(project):
    data, scope, sid = project
    assert svc.export_csv({"study_id": sid}, scope) == {"ok": False, "error": "No polar to export yet."}
    store.write_result(data, sid, "xfoil", XF)
    got = svc.export_csv({"study_id": sid}, scope)
    assert got["ok"] is True and got["filename"] == "NACA 2412 polar.csv"
    assert [r["alpha_deg"] for r in _read(got["text"])] == ["2", "4"]
    store.write_result(data, sid, "neuralfoil", {**NF, "name": "NACA 0012"})
    got = svc.export_csv({"study_id": sid}, scope)
    assert got["filename"] == "Airfoil polar.csv"  # two sections: no single name
    assert {r["engine"] for r in _read(got["text"])} == {"NeuralFoil", "XFOIL"}


def test_export_dat_writes_the_section_selig_and_it_reads_back(project):
    _data, scope, sid = project
    got = svc.export_dat({"study_id": sid, "airfoil": {"source": "naca", "code": "4412", "points_per_side": 61}}, scope)
    assert got["ok"] is True and got["filename"] == "NACA 4412.dat"
    assert got["text"].startswith("NACA 4412\n")
    back = datfile.parse(got["text"])
    sec = naca.generate("4412", 61)
    assert back.x == pytest.approx(sec.x, abs=1e-7) and back.y == pytest.approx(sec.y, abs=1e-7)
    assert len(got["text"].splitlines()) == 1 + 121


def test_export_dat_of_an_imported_section(project):
    _data, scope, sid = project
    sec = naca.generate("0015", 41)
    imported = svc.import_dat({"study_id": sid, "text": datfile.write("Wing root", sec.x, sec.y), "filename": "root.dat"}, scope)
    got = svc.export_dat({"study_id": sid, "airfoil": imported["airfoil"]}, scope)
    assert got["filename"] == "Wing root.dat"
    assert datfile.parse(got["text"]).x == pytest.approx(sec.x, abs=1e-7)
    bad = svc.export_dat({"study_id": sid, "airfoil": {"source": "naca", "code": "12"}}, scope)
    assert bad["ok"] is False and "NACA" in bad["error"]
