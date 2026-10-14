"""HT3: the SDK's multi-region helpers (host API 1.8), generic for any analysis.

- ``RegionProgressParser``: a chtMultiRegion* log (HT0's log samples) gives residual
  events keyed ``<region>:<field>``, the first residual per field per region per
  step, and the largest Courant number of the regions (transient).
- ``function_object_files``: a function object's files in both multi-region path
  shapes (``postProcessing/<region>/<fo>/<t>/`` and ``postProcessing/<fo>/<region>/<t>/``)
  and in each start-time folder of a continued run.
"""

from __future__ import annotations

from pathlib import Path

from magnusim_sdk.foam import (
    function_object_files,
    function_object_folder,
    read_surface_field_value,
)
from magnusim_sdk.progress import ProgressParser, RegionProgressParser, region_key, split_region_key

STEADY = """\
Time = 1

Solving for fluid region air
DILUPBiCGStab:  Solving for Ux, Initial residual = 1, Final residual = 0.0097, No Iterations 1
DILUPBiCGStab:  Solving for h, Initial residual = 0.99, Final residual = 0.03, No Iterations 1
Min/max T:299.99978 381.75826
GAMG:  Solving for p_rgh, Initial residual = 0.26, Final residual = 0.001, No Iterations 7
GAMG:  Solving for p_rgh, Initial residual = 0.33, Final residual = 0.002, No Iterations 7
time step continuity errors : sum local = 0.0297, global = 0.0006, cumulative = -0.0017
Min/max rho:0.91237954 1.1610289

Solving for solid region heater
DICPCG:  Solving for h, Initial residual = 0.36, Final residual = 0.0035, No Iterations 62
Min/max T:381.31858 394.62659

Solving for solid region heater
DICPCG:  Solving for h, Initial residual = 0.34, Final residual = 0.003, No Iterations 60
Min/max T:394.03962 394.62937
ExecutionTime = 0.96 s  ClockTime = 1 s

Time = 2

Solving for fluid region air
DILUPBiCGStab:  Solving for Ux, Initial residual = 0.4, Final residual = 0.0097, No Iterations 1
DILUPBiCGStab:  Solving for h, Initial residual = 0.5, Final residual = 0.03, No Iterations 1
Solving for solid region heater
DICPCG:  Solving for h, Initial residual = 0.2, Final residual = 0.0035, No Iterations 62
"""

TRANSIENT = """\
Region: air Courant Number mean: 0.06 max: 0.81
Region: heater Diffusion Number mean: 0.045 max: 0.57
Region: fan Courant Number mean: 0.02 max: 0.3
deltaT = 0.00025
Time = 0.00025

Solving for fluid region air
diagonal:  Solving for rho, Initial residual = 0, Final residual = 0, No Iterations 0
DILUPBiCGStab:  Solving for h, Initial residual = 0.9, Final residual = 0.03, No Iterations 1
time step continuity errors (air): sum local = 1e-9, global = 1e-10, cumulative = 1e-10
Solving for solid region heater
DICPCG:  Solving for h, Initial residual = 0.95, Final residual = 0.0035, No Iterations 62
"""


def _feed(parser: ProgressParser, text: str) -> list:
    parser.feed('MAGNUSIM_EVENT {"event":"stage","stage":"solve"}')
    out = []
    for line in text.splitlines():
        out.extend(parser.feed(line))
    return out


def test_region_keys():
    assert region_key("air", "h") == "air:h"
    assert split_region_key("air:h") == ("air", "h")
    assert split_region_key("Ux") == ("", "Ux")


def test_a_steady_multi_region_log():
    parser = RegionProgressParser()
    evs = _feed(parser, STEADY)
    res = [(e.fields["time"], e.fields["field"], e.fields["initial"]) for e in evs if e.event == "residual"]
    assert res == [
        (1.0, "air:Ux", 1.0),
        (1.0, "air:h", 0.99),
        (1.0, "air:p_rgh", 0.26),  # the first p_rgh of the step, not the corrector's
        (1.0, "heater:h", 0.36),  # the first solid pass, not the repeat
        (2.0, "air:Ux", 0.4),
        (2.0, "air:h", 0.5),
        (2.0, "heater:h", 0.2),
    ]
    snap = parser.snapshot()
    assert snap["residuals"][0] == {"t": 1.0, "air:Ux": 1.0, "air:h": 0.99, "air:p_rgh": 0.26, "heater:h": 0.36}
    assert [e.fields["time"] for e in evs if e.event == "progress"] == [1.0, 2.0]
    # No "Solving for fluid region" text reaches the log as a field.
    assert not any(e.event == "residual" and e.fields["field"] in ("fluid", "solid") for e in evs)


def test_a_transient_multi_region_log():
    parser = RegionProgressParser()
    evs = _feed(parser, TRANSIENT)
    courant = [e.fields for e in evs if e.event == "courant" and "max" in e.fields]
    # Each region's Courant line in turn; the step keeps the largest (air 0.81, not fan 0.3).
    assert courant == [{"mean": 0.06, "max": 0.81}]
    prog = [e.fields for e in evs if e.event == "progress"]
    assert prog == [{"time": 0.00025, "sim_time": 0.00025, "delta_t": 0.00025, "co_max": 0.81, "co_mean": 0.06}]
    res = [(e.fields["field"], e.fields["initial"]) for e in evs if e.event == "residual"]
    assert res == [("air:rho", 0.0), ("air:h", 0.9), ("heater:h", 0.95)]


def test_a_one_region_log_reads_as_before():
    text = "Time = 1\nsmoothSolver:  Solving for Ux, Initial residual = 0.5, Final residual = 1e-3, No Iterations 2\n"
    a = [(e.event, e.fields) for e in _feed(ProgressParser(), text)]
    b = [(e.event, e.fields) for e in _feed(RegionProgressParser(), text)]
    assert a == b
    assert ("residual", {"time": 1.0, "field": "Ux", "initial": 0.5, "fields": {"Ux": 0.5}}) in a


def _dat(path: Path, rows: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("# Region type : patch outlet\n# Time  weightedSum(h)\n" + rows, encoding="utf-8")


def test_function_object_paths_in_a_multi_region_case(tmp_path: Path):
    pp = tmp_path / "postProcessing"
    _dat(pp / "air" / "hflux_outlet" / "0" / "surfaceFieldValue.dat", "1 10\n2 11\n3 12\n")
    _dat(pp / "air" / "hflux_outlet" / "2" / "surfaceFieldValue.dat", "3 13\n4 14\n")
    (pp / "probes_heater" / "heater" / "0").mkdir(parents=True)
    (pp / "probes_heater" / "heater" / "0" / "T").write_text("# Probe 0\n1 300\n", encoding="utf-8")
    (pp / "probes_heater" / "heater" / "300").mkdir(parents=True)
    (pp / "probes_heater" / "heater" / "300" / "T").write_text("301 310\n", encoding="utf-8")
    assert function_object_folder(tmp_path, "hflux_outlet", "air") == pp / "air" / "hflux_outlet"
    assert function_object_folder(tmp_path, "probes_heater", "heater") == pp / "probes_heater" / "heater"
    assert function_object_folder(tmp_path, "hflux_outlet") is None
    assert function_object_folder(tmp_path, "hflux_outlet", "heater") is None
    assert function_object_files(tmp_path, "probes_heater", "T", "heater") == [
        pp / "probes_heater" / "heater" / "0" / "T",
        pp / "probes_heater" / "heater" / "300" / "T",
    ]
    assert [p.parent.name for p in function_object_files(tmp_path, "hflux_outlet", "surfaceFieldValue.dat", "air")] == ["0", "2"]
    merged = read_surface_field_value(tmp_path, "hflux_outlet", "air")
    assert merged is not None and [r[:2] for r in merged["rows"]] == [[1.0, 10.0], [2.0, 11.0], [3.0, 13.0], [4.0, 14.0]]


def test_function_object_paths_in_a_one_region_case(tmp_path: Path):
    _dat(tmp_path / "postProcessing" / "mon" / "0" / "surfaceFieldValue.dat", "1 2\n")
    _dat(tmp_path / "postProcessing" / "mon" / "0" / "surfaceFieldValue_0.dat", "2 3\n")
    assert [p.name for p in function_object_files(tmp_path, "mon", "surfaceFieldValue.dat")] == [
        "surfaceFieldValue.dat",
        "surfaceFieldValue_0.dat",
    ]
    merged = read_surface_field_value(tmp_path, "mon")
    assert merged is not None and [r[:2] for r in merged["rows"]] == [[1.0, 2.0], [2.0, 3.0]]
