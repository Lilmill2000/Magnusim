"""The case a Heat Transfer run writes: goldens for a steady perfect-gas channel and a
transient Boussinesq cavity, and each dictionary's rules (density models, gravity,
dpdt, every BC kind's T / p_rgh / p / alphat, wall types, monitors, restart).

``CFDDESK_UPDATE_GOLDEN=1`` rewrites the goldens.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from ht_inputs import AIR, CAVITY_BCS, GOLDEN, MONITORS, WATER, make_inputs

from heat_transfer.runspec import load_spec
from heat_transfer.writer import write_case

FILES = (
    "0/U",
    "0/T",
    "0/p",
    "0/p_rgh",
    "0/alphat",
    "0/k",
    "0/omega",
    "0/nut",
    "constant/thermophysicalProperties",
    "constant/turbulenceProperties",
    "constant/g",
    "constant/polyMesh/boundary",
    "system/controlDict",
    "system/fvSchemes",
    "system/fvSolution",
)


def _write(tmp_path: Path, **kw) -> Path:
    case = tmp_path / "case"
    spec = load_spec(make_inputs(tmp_path, **kw))
    assert spec.ok, spec.error
    report = write_case(spec, case)
    assert report["ok"], report
    return case


def _text(case: Path, rel: str) -> str:
    return (case / rel).read_text(encoding="utf-8")


def _entry(text: str, patch: str) -> str:
    m = re.search(rf"\n    {re.escape(patch)}\n    \{{\n(.*?)\n    \}}", text, re.S)
    assert m, f"no entry for {patch}"
    return re.sub(r"\s+", " ", m.group(1)).strip()


def _compare(case: Path, name: str, files: tuple[str, ...], update: bool) -> None:
    gold = GOLDEN / name
    for rel in files:
        got = case / rel
        want = gold / rel
        if not got.is_file():
            assert not want.is_file(), f"{rel} was not written"
            continue
        text = got.read_text(encoding="utf-8")
        if update:
            want.parent.mkdir(parents=True, exist_ok=True)
            want.write_bytes(text.encode("utf-8"))
            continue
        assert want.is_file(), f"missing golden {name}/{rel}"
        assert text == want.read_text(encoding="utf-8"), f"{name}/{rel} differs from its golden"


def test_golden_steady_perfect_gas_channel(tmp_path, update_golden):
    case = _write(
        tmp_path,
        study={"gravity": "-z", "turbulence_model": "kOmegaSST", "reference_temperature": 293.15},
        run={"result_controls": MONITORS, "settle": {"id": "mon-q", "quantity": "Q", "tolerance": 0.01, "window": 50}},
    )
    _compare(case, "steady_ipg_channel", FILES, update_golden)


def test_golden_transient_boussinesq_cavity(tmp_path, update_golden):
    case = _write(
        tmp_path,
        materials=[WATER],
        bcs=CAVITY_BCS,
        study={"gravity": "-y", "turbulence_model": "laminar", "reference_temperature": 298.15},
        transient={"end_time": 20, "write_count": 10, "max_co": 0.5},
    )
    _compare(case, "transient_boussinesq_cavity", FILES, update_golden)


def test_thermophysical_properties_per_density_model(tmp_path):
    ipg = _text(_write(tmp_path / "a", study={"operating_pressure": 90000}), "constant/thermophysicalProperties")
    assert "equationOfState incompressiblePerfectGas;" in ipg
    assert "equationOfState { pRef 90000; }" in ipg
    for exact in ("type            heRhoThermo;", "mixture         pureMixture;", "transport       const;",
                  "thermo          hConst;", "specie          specie;", "energy          sensibleEnthalpy;"):
        assert exact in ipg
    assert "molWeight 28.97;" in ipg and "Cp 1007;" in ipg and "mu 1.825e-05;" in ipg
    # Pr = mu cp / k
    pr = float(re.search(r"Pr ([0-9.e-]+);", ipg).group(1))
    assert pr == pytest.approx(1.825e-5 * 1007 / 0.02514, rel=1e-6)
    assert "dpdt" not in ipg
    bq = _text(_write(tmp_path / "b", materials=[WATER], study={"reference_temperature": 300}), "constant/thermophysicalProperties")
    assert "equationOfState Boussinesq;" in bq and "equationOfState { rho0 998; T0 300; beta 0.000207; }" in bq
    const = _text(_write(tmp_path / "c", study={"density_model": "constant", "gravity": "off"}), "constant/thermophysicalProperties")
    assert "equationOfState rhoConst;" in const and "equationOfState { rho 1.204; }" in const


def test_transient_writes_dpdt_no(tmp_path):
    for i, mats in enumerate(([AIR], [WATER])):
        text = _text(_write(tmp_path / str(i), materials=mats, transient={"end_time": 1}), "constant/thermophysicalProperties")
        assert re.search(r"^dpdt            no;$", text, re.M), text


def test_gravity_directions(tmp_path):
    assert "value           (0 0 -9.80665);" in _text(_write(tmp_path / "a"), "constant/g")
    assert "value           (0 0 0);" in _text(_write(tmp_path / "b", study={"gravity": "off"}), "constant/g")
    custom = _text(_write(tmp_path / "c", study={"gravity": "custom", "gravity_vector": [3, 4, 0], "gravity_magnitude": 10}), "constant/g")
    assert "value           (6 8 0);" in custom
    assert "value           (-9.81 0 0);" in _text(_write(tmp_path / "d", study={"gravity": "-x", "gravity_magnitude": 9.81}), "constant/g")


def test_every_boundary_kind_maps_to_its_entries(tmp_path):
    case = _write(tmp_path)
    t_field, p_rgh, p, alphat = (_text(case, f"0/{f}") for f in ("T", "p_rgh", "p", "alphat"))
    assert _entry(t_field, "inlet") == "type fixedValue; value uniform 293.15;"
    assert _entry(p_rgh, "inlet") == "type fixedFluxPressure; value uniform 0;"
    assert _entry(t_field, "outlet") == "type inletOutlet; inletValue uniform 295.15; value uniform 295.15;"
    assert _entry(p_rgh, "outlet") == "type prghPressure; p uniform 0; value uniform 0;"
    assert _entry(t_field, "heater") == (
        "type externalWallHeatFluxTemperature; mode flux; q uniform 2500; kappaMethod fluidThermo; value uniform 293.15;"
    )
    assert _entry(t_field, "cold_plate") == "type fixedValue; value uniform 283.15;"
    assert _entry(t_field, "lid") == (
        "type externalWallHeatFluxTemperature; mode coefficient; h uniform 12; Ta constant 288.15; "
        "kappaMethod fluidThermo; value uniform 293.15;"
    )
    assert _entry(t_field, "walls") == "type zeroGradient;"
    for f in (t_field, p_rgh, p, alphat):
        assert _entry(f, "side") == "type symmetry;"
    for wall in ("heater", "cold_plate", "lid", "walls"):
        assert _entry(p_rgh, wall) == "type fixedFluxPressure; value uniform 0;"
        assert _entry(alphat, wall) == "type compressible::alphatJayatillekeWallFunction; Prt 0.85; value uniform 0;"
    assert _entry(alphat, "inlet") == "type calculated; value uniform 0;"
    assert _entry(p, "inlet") == "type calculated; value uniform 0;"
    boundary = _text(case, "constant/polyMesh/boundary")
    for wall in ("heater", "cold_plate", "lid", "walls"):
        assert re.search(rf"{wall}\n\s*\{{\n\s*type\s+wall;", boundary), wall
    assert re.search(r"side\n\s*\{\n\s*type\s+symmetry;", boundary)
    assert re.search(r"inlet\n\s*\{\n\s*type\s+patch;", boundary)


def test_other_openings(tmp_path):
    bcs = [
        {"id": "a", "name": "inlet", "bc_type": "Velocity inlet", "velocity_type": "Flow rate", "flow_rate_type": "Mass",
         "value": 0.002, "unit": "kg/s", "faces": ["face 1@Body1"], "inlet_temperature": 310},
        {"id": "b", "name": "outlet", "bc_type": "Total pressure inlet", "value": 5, "unit": "Pa", "faces": ["face 2@Body1"],
         "inlet_temperature": 300},
        {"id": "c", "name": "heater", "bc_type": "Freestream", "value": 2, "unit": "m/s", "vector": [1, 0, 0],
         "freestream_pressure": 3, "faces": ["face 3@Body1"], "backflow_temperature": 290},
        {"id": "d", "name": "lid", "bc_type": "Velocity outlet", "value": 0.1, "unit": "m/s", "faces": ["face 5@Body1"]},
    ]
    case = _write(tmp_path, bcs=bcs, study={"turbulence_model": "laminar"})
    u_field, t_field, p_rgh = (_text(case, f"0/{f}") for f in ("U", "T", "p_rgh"))
    assert "type flowRateInletVelocity;" in _entry(u_field, "inlet") and "rho rho;" in _entry(u_field, "inlet")
    assert "rhoInlet 1.2" in _entry(u_field, "inlet")
    assert _entry(t_field, "inlet") == "type fixedValue; value uniform 310;"
    assert _entry(p_rgh, "outlet") == "type prghTotalPressure; p0 uniform 5; value uniform 5;"
    assert _entry(t_field, "outlet") == "type inletOutlet; inletValue uniform 300; value uniform 300;"
    assert _entry(p_rgh, "heater") == "type freestreamPressure; freestreamValue uniform 3; value uniform 3;"
    assert _entry(t_field, "heater") == "type inletOutlet; inletValue uniform 290; value uniform 290;"
    assert _entry(u_field, "heater").startswith("type freestreamVelocity;")
    assert _entry(p_rgh, "lid") == "type fixedFluxPressure; value uniform 0;"
    assert _entry(t_field, "lid") == "type inletOutlet; inletValue uniform 293.15; value uniform 293.15;"
    # Laminar: no turbulence fields and no alphat.
    for f in ("k", "omega", "nut", "alphat"):
        assert not (case / "0" / f).exists()


def test_turbulence_models_write_their_fields(tmp_path):
    ke = _write(tmp_path / "ke", study={"turbulence_model": "realizableKE"})
    assert (ke / "0" / "epsilon").is_file() and not (ke / "0" / "omega").is_file()
    assert "RASModel        realizableKE;" in _text(ke, "constant/turbulenceProperties")
    assert "div(phi,epsilon)" in _text(ke, "system/fvSchemes")
    lam = _write(tmp_path / "lam", study={"turbulence_model": "laminar"})
    assert _text(lam, "constant/turbulenceProperties").strip().endswith("simulationType  laminar;")
    assert not (lam / "constant" / "momentumTransport").exists()


def test_function_objects_and_sidecar(tmp_path):
    case = _write(tmp_path, run={"result_controls": MONITORS})
    cd = _text(case, "system/controlDict")
    assert "application     buoyantSimpleFoam;" in cd
    assert re.search(r"ht_wall_heat_flux\n\s*\{\n\s*type\s+wallHeatFlux;", cd)
    assert "patches         ( walls heater cold_plate lid );" in cd
    # h = q / (T_wall - T_ref): OpenFOAM's htcRaw (q / (T_ref - T_wall)) times -1, never written itself.
    assert "htcModel        fixedReferenceTemperature;" in cd and "result          htcRaw;" in cd
    assert "type            reference;" in cd and "scale           -1;" in cd and "result          htc;" in cd
    assert re.search(r"ht_htc_raw\n\s*\{[^}]*writeControl    none;", cd)
    assert "objects         ( rho );" in cd and "writeOption     anyWrite;" in cd
    for opening in ("inlet", "outlet"):
        assert f"ht_enthalpy_{opening}" in cd
    assert "ht_Tavg_cold_plate" in cd and "ht_Tmax_walls" in cd and "ht_Tavg_heater" in cd
    assert "probeLocations  ( (0.05 0.01 0.02) );" in cd
    meta = json.loads(_text(case, "w27-case.json"))
    assert meta["kinematic_fields"] == []
    assert meta["solver"] == "buoyantSimpleFoam"
    assert meta["density_model"] == "perfect_gas"
    assert meta["rho"] == pytest.approx(101325 * 28.97 / (8314.462618 * 293.15))
    assert meta["wall_patches"] == ["walls", "heater", "cold_plate", "lid"]
    assert meta["opening_patches"] == ["inlet", "outlet"]
    plans = {p["id"]: p for p in meta["ht_monitors"]}
    assert plans["mon-q"]["patches"] == ["heater"]
    assert plans["mon-t"]["patches"] == ["cold_plate", "walls"]
    assert plans["mon-tc"]["key"] == "ht_probe_thermocouple_1"
    assert meta["thermal"]["heater"] == {"kind": "wall", "wall": "no_slip", "mode": "heat_flux", "q": 2500.0}


def test_settle_stop_written_for_one_boundary(tmp_path):
    case = _write(tmp_path, run={"result_controls": MONITORS, "settle": {"id": "mon-q", "quantity": "Q", "tolerance": 0.01, "window": 50}})
    cd = _text(case, "system/controlDict")
    assert "functionObject  ht_wall_heat_flux;" in cd and "fields          ( int(heater) );" in cd
    meta = json.loads(_text(case, "w27-case.json"))
    assert meta["settle"]["text"] == "Heater flux · Heat flow stayed within 0.01 W of its average over 50 iterations"
    two = _write(tmp_path / "two", run={"result_controls": MONITORS, "settle": {"id": "mon-t", "quantity": "T_avg", "tolerance": 0.1, "window": 20}})
    assert "settleStop" not in _text(two, "system/controlDict")
    assert "the stop watches a monitor on one" in json.loads(_text(two, "w27-case.json"))["settle"]["error"]


def test_a_temperature_settle_stop_reads_in_the_projects_unit(tmp_path):
    """The stop's sentence the run keeps: a temperature difference in °C (metric) or °F (imperial),
    never K; the controlDict's tolerance stays in K."""
    tc = {"id": "mon-tc", "quantity": "T_pt", "tolerance": 0.05, "window": 20}
    metric = _write(tmp_path / "m", run={"result_controls": MONITORS, "settle": tc})
    assert json.loads(_text(metric, "w27-case.json"))["settle"]["text"] == (
        "Thermocouple 1 · Temperature (average of its points) stayed within 0.05 °C of its average over 20 iterations"
    )
    (tmp_path / "i").mkdir()
    (tmp_path / "i" / "project.json").write_text(json.dumps({"units": "Imperial"}), encoding="utf-8")
    imperial = _write(tmp_path / "i", run={"result_controls": MONITORS, "settle": tc})
    assert json.loads(_text(imperial, "w27-case.json"))["settle"]["text"] == (
        "Thermocouple 1 · Temperature (average of its points) stayed within 0.09 °F of its average over 20 iterations"
    )
    assert "0.05" in _text(imperial, "system/controlDict")


def test_transient_control(tmp_path):
    case = _write(tmp_path, transient={"end_time": 30, "write_count": 15, "max_co": 0.6, "delta_t": 0.002})
    cd = _text(case, "system/controlDict")
    assert "application     buoyantPimpleFoam;" in cd
    assert "endTime         30;" in cd and "writeInterval   2;" in cd and "deltaT          0.002;" in cd
    assert "adjustTimeStep  yes;" in cd and "maxCo           0.6;" in cd
    sol = _text(case, "system/fvSolution")
    assert "PIMPLE" in sol and "p_rghFinal" in sol and '"rho.*"' in sol
    assert "ddtSchemes { default Euler; }" in _text(case, "system/fvSchemes")


def test_a_prior_run_is_cleaned_and_a_continue_keeps_its_times(tmp_path):
    case = _write(tmp_path)
    (case / "100").mkdir()
    for f in ("T", "U"):
        (case / "100" / f).write_text("x", encoding="utf-8")
    (case / "postProcessing").mkdir()
    (case / "log.buoyantSimpleFoam").write_text("old", encoding="utf-8")
    spec = load_spec(make_inputs(tmp_path, restart={"end_time": 300}))
    report = write_case(spec, case)
    assert report["ok"] and report["restart"] == {"from_time": 100.0, "end_time": 300.0}
    assert (case / "100").is_dir() and (case / "postProcessing").is_dir()
    assert "startFrom       latestTime;" in _text(case, "system/controlDict")
    late = write_case(load_spec(make_inputs(tmp_path, restart={"end_time": 50})), case)
    assert not late["ok"] and "must be after the last saved time (100)" in late["error"]
    fresh = write_case(load_spec(make_inputs(tmp_path)), case)
    assert fresh["ok"] and not (case / "100").exists() and not (case / "postProcessing").exists()
    assert not (case / "log.buoyantSimpleFoam").exists()


def test_parallel_runs_get_a_decompose_dict(tmp_path):
    case = _write(tmp_path, n_procs=4)
    assert "numberOfSubdomains 4;" in _text(case, "system/decomposeParDict")


def test_steady_relaxation_is_the_studys(tmp_path):
    default = _text(_write(tmp_path / "a"), "system/fvSolution")
    assert "p_rgh           0.3;" in default and "U               0.7;" in default and "h               0.5;" in default
    assert '"(k|omega)" 0.7;' in default
    own = _text(_write(tmp_path / "b", study={"relax_u": 0.4, "relax_p": 0.6, "relax_h": 0.9}), "system/fvSolution")
    assert "p_rgh           0.6;" in own and "U               0.4;" in own and "h               0.9;" in own
    assert '"(k|omega)" 0.4;' in own


def test_untouched_thermal_fields_solve_at_what_the_editor_shows(tmp_path):
    """A BC the user never opened holds no thermal fields: the editor shows each field's
    default (20 °C, 1000 W/m², 10 W/(m²·K)) and the case solves exactly those, whatever the
    study's reference temperature."""
    from heat_transfer.bcs import AMBIENT_T, BACKFLOW_T, INLET_T, WALL_H, WALL_Q, WALL_T

    bare = [
        {"id": "bc-in", "name": "inlet", "bc_type": "Velocity inlet", "value": 0.5, "unit": "m/s", "faces": ["face 1@Body1"]},
        {"id": "bc-out", "name": "outlet", "bc_type": "Pressure", "value": 0, "unit": "Pa", "faces": ["face 2@Body1"]},
        {"id": "bc-heat", "name": "heater", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["face 3@Body1"],
         "thermal_condition": "heat_flux"},
        {"id": "bc-cold", "name": "cold_plate", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["face 4@Body1"],
         "thermal_condition": "temperature"},
        {"id": "bc-lid", "name": "lid", "bc_type": "Wall", "wall_type": "No-slip", "faces": ["face 5@Body1"],
         "thermal_condition": "heat_transfer_coefficient"},
    ]
    shown = {f.key: f.default for f in (INLET_T, BACKFLOW_T, WALL_T, WALL_Q, WALL_H, AMBIENT_T)}
    assert shown == {"inlet_temperature": 293.15, "backflow_temperature": 293.15, "wall_temperature": 293.15,
                     "wall_heat_flux": 1000.0, "wall_htc": 10.0, "ambient_temperature": 293.15}
    case = _write(tmp_path, bcs=bare, study={"reference_temperature": 350.0, "gravity": "off"})
    t_field = _text(case, "0/T")
    assert _entry(t_field, "inlet") == "type fixedValue; value uniform 293.15;"
    assert _entry(t_field, "outlet") == "type inletOutlet; inletValue uniform 293.15; value uniform 293.15;"
    assert _entry(t_field, "cold_plate") == "type fixedValue; value uniform 293.15;"
    assert "q uniform 1000;" in _entry(t_field, "heater")
    assert "h uniform 10; Ta constant 293.15;" in _entry(t_field, "lid")
    # The study's reference temperature is still where the fluid starts and what htc is against.
    assert "internalField   uniform 350;" in t_field
    assert "TRef            350;" in _text(case, "system/controlDict")


def test_health_hints_of_a_natural_convection_cavity(tmp_path):
    """RH1: a buoyant cavity's health hints: PISO at its Max Courant, p_rgh's 200-iteration cap,
    no velocity limit, and no fixed inflow (natural convection)."""
    case = _write(
        tmp_path,
        materials=[WATER],
        bcs=CAVITY_BCS,
        study={"gravity": "-y", "turbulence_model": "laminar", "reference_temperature": 298.15},
        transient={"end_time": 20, "write_count": 10, "max_co": 0.5},
    )
    h = json.loads(_text(case, "w27-case.json"))["health_hints"]
    assert h["app"] == "buoyantPimpleFoam" and h["mode"] == "PISO" and h["n_outer"] == 1
    assert h["max_co"] == 0.5 and h["limiter"] is None and h["fixed_inflow"] is False
    assert h["linsolve"]["p_rgh"]["max_iter"] == 200 and h["linsolve"]["h"]["max_iter"] == 1000
    steady = _write(tmp_path / "s", materials=[WATER], bcs=CAVITY_BCS, study={"gravity": "-y", "turbulence_model": "laminar"})
    hs = json.loads(_text(steady, "w27-case.json"))["health_hints"]
    assert hs["mode"] == "SIMPLE" and hs["max_co"] is None


def test_mesh_cell_size_leaves_out_a_hex_dominant_checkmesh(tmp_path: Path):
    """Hex-dominant meshes have a checkMesh report only since RH2 (their quality): it is not
    read, so the time step written for them stays what it was (spec RH2 4.1). Any other mesh's
    report is read as before (a total volume written without the sentence's full stop)."""
    from heat_transfer.runspec import _mesh_cell_size

    log = "    Min volume = 1e-09. Max volume = 1e-06.  Total volume = 0.001\n"
    hexd = tmp_path / "hexd"
    hexd.mkdir()
    (hexd / "w23-geometry-meta.json").write_text(json.dumps({"walls_level": 2}), encoding="utf-8")
    assert _mesh_cell_size(hexd, 1000) is None
    (hexd / "log.checkMesh").write_text(log, encoding="utf-8")
    assert _mesh_cell_size(hexd, 1000) is None
    # As the WSL script leaves the case (snappy_hexdominant.sh empties it; the counts and feature
    # marks are written after it), before generate_snappy.py writes the meta again.
    real = tmp_path / "hexd-as-left"
    real.mkdir()
    (real / "log.checkMesh").write_text(log, encoding="utf-8")
    (real / "w21-counts.json").write_text(json.dumps({"n_cells": 1000}), encoding="utf-8")
    (real / "w21-feature-marks.json").write_text(json.dumps({"marks": [12], "total": 12}), encoding="utf-8")
    assert _mesh_cell_size(real, 1000) is None
    cf = tmp_path / "cfmesh"
    cf.mkdir()
    (cf / "w28-cfmesh-meta.json").write_text("{}", encoding="utf-8")
    (cf / "log.checkMesh").write_text(log, encoding="utf-8")
    assert _mesh_cell_size(cf, 1000) == pytest.approx(0.01)


def test_a_2d_mesh_has_its_ends_empty_in_every_field(tmp_path):
    """One cell across (2D): the mesh facts' two ends on the Symmetry "side", holding nothing but
    end faces (one per cell each): every field and the boundary file make them empty, so the
    flow and the heat are solved in the section's plane only (as Incompressible Flow does)."""
    import json
    import shutil

    from ht_inputs import MESH
    from magnusim_sdk import courant_rates
    from magnusim_sdk.mesh_facts import FACTS_FILE, FACTS_VERSION

    mesh = tmp_path / "mesh"
    shutil.copytree(MESH, mesh)
    poly = mesh / "constant" / "polyMesh"
    ends = {"front": {"faces": ["Face 6@Body1"], "bc": "side", "patch": "side"}, "back": {"faces": ["Face 6@Body1"], "bc": "side", "patch": "side"}}
    # The fixture's side holds 4 faces: two ends of a 2-cell 2D mesh.
    facts = {"v": FACTS_VERSION, "n_cells": 2, "stamp": courant_rates.mesh_stamp(poly), "two_d": {"axis": "z", "cells_across": 1, **ends}}
    (mesh / FACTS_FILE).write_text(json.dumps(facts), encoding="utf-8")
    case = _write(tmp_path, mesh_dir=mesh)
    for f in ("U", "T", "p_rgh", "p", "alphat", "k", "omega", "nut"):
        assert _entry(_text(case, f"0/{f}"), "side") == "type empty;", f
    assert re.search(r"side\n\s*\{\n\s*type\s+empty;", _text(case, "constant/polyMesh/boundary"))
    # The walls are as on a 3D mesh.
    assert _entry(_text(case, "0/T"), "cold_plate") == "type fixedValue; value uniform 283.15;"
