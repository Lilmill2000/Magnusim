"""RH3 (run health, spec 5.1-5.8): magnusim_sdk.numerics_settings and the core's part.

- the stored values: kept as saved when the solver can use them (even out of range), blank
  otherwise; an edited run key is held to its bounds, a stored one never;
- the strings: each choice's fixed OpenFOAM string, a preset's choices, the bounded prefix;
- setting_out_of_range: which values, the row's words ("Saved p tolerance 1e-2 is outside
  1e-12 to 1e-3."), one row, never blocking;
- the core: SchemaField.caution as x-cfddesk.caution; run_normalize passes the edited keys to a
  run model that takes them; RunModel.check's "numerics" passed on cleaned; a started run's
  numerics_used read in place of the study's; a Continue's restart numerics put over the study
  record (5.3).
"""

from __future__ import annotations

from types import SimpleNamespace

from magnusim_sdk import numerics_settings as ns
from magnusim_sdk.numerics_advice import ADVICE, RULE_MAX, description
from magnusim_sdk.runcheck import check


def test_stored_values_are_kept_as_saved_or_blank():
    got = ns.numerics_from_record(
        {
            "grad_limiter": "light",
            "momentum_convection": "nonsense",
            "p_tolerance": 0.01,
            "p_rel_tol": 0,
            "p_max_iter": 5000,
            "eq_tolerance": -1,
            "relax_turbulence": 1.5,
            "velocity_limit": "custom",
            "velocity_limit_max": "",
        }
    )
    assert got.grad_limiter == "light" and got.momentum_convection is None
    assert (got.p_tolerance, got.p_rel_tol, got.p_max_iter) == (0.01, 0.0, 5000)
    assert got.eq_tolerance is None and got.relax_turbulence == 1.5
    assert (got.velocity_limit, got.velocity_limit_max) == ("custom", None)
    assert ns.numerics_from_record(None) == ns.BLANK


def test_an_edit_is_held_to_its_bounds_a_stored_value_never():
    assert ns.clamp_edit("outer_relax_p", 1.5) == 1.0
    assert ns.clamp_edit("outer_tolerance", 1e-9) == 1e-6
    assert ns.clamp_edit("outer_tolerance", 0.5) == 0.1
    assert ns.run_value("outer_relax_p", 1.5) == 1.5
    assert ns.run_value("outer_relax_p", 0) is None and ns.run_value("outer_relax_p", "") is None


def test_the_choices_and_their_strings():
    choices = ns.scheme_choices(ns.BLANK, preset="robust")
    assert {k: v[0] for k, v in choices.items()} == ns.PRESET_CHOICES["robust"]
    assert all(v[1] == "preset" for v in choices.values())
    own = ns.scheme_choices(ns.NumericsSettings(grad_limiter="none"), preset="accurate")
    assert own["grad_limiter"] == ("none", "study") and own["non_orth_correction"] == ("full", "preset")
    assert ns.scheme_choices(ns.BLANK, preset=None)["turbulence_convection"] == ("second_order", "default")
    assert ns.bounded(ns.MOMENTUM["second_order"], True) == "bounded Gauss linearUpwind grad(U)"
    assert ns.foam_number(1e-7) == "1e-7" and ns.foam_number(0.01) == "0.01" and ns.foam_number(200) == "200"
    assert ns.changed_from_preset({"grad_limiter": "light", "turbulence_convection": "first_order", "non_orth_correction": "none"}, "robust") == [
        "grad_limiter",
        "non_orth_correction",
    ]


def test_the_velocity_limit():
    auto = ns.velocity_cap(ns.BLANK, 22.6, default="auto", factor=10, floor=50)
    assert auto["mode"] == "auto" and auto["cap"] == 226.0
    assert ns.limit_value(auto, speed=22.6, factor=10, floor=50, inlet="velocity_inlet_1_1") == "226 m/s = 10 × 22.6 m/s (inlet velocity_inlet_1_1)"
    slow = ns.velocity_cap(ns.BLANK, 1.2, default="auto", factor=10, floor=50)
    assert ns.limit_value(slow, speed=1.2, factor=10, floor=50) == "50 m/s (at least 50 m/s; 10 × 1.2 m/s is less)"
    off = ns.velocity_cap(ns.BLANK, 22.6, default="off", factor=10, floor=50)
    assert off["cap"] is None and ns.limit_value(off, speed=22.6, factor=10, floor=50) == "Off: nothing caps the velocity"
    blank = ns.velocity_cap(ns.NumericsSettings(velocity_limit="custom"), 22.6, default="auto", factor=10, floor=50)
    assert blank["cap"] == 226.0 and ns.limit_value(blank, speed=22.6, factor=10, floor=50).startswith("Custom with no maximum set, so automatic: 226 m/s")
    custom = ns.velocity_cap(ns.NumericsSettings(velocity_limit="custom", velocity_limit_max=300), 22.6, default="auto", factor=10, floor=50)
    assert custom["cap"] == 300 and ns.limit_value(custom, speed=22.6, factor=10, floor=50) == "300 m/s (custom)"


def test_stored_values_out_of_range_and_their_words():
    fields = [
        {"key": "p_tolerance", "label": "p tolerance", "min": 1e-12, "max": 1e-3},
        {"key": "relax_turbulence", "label": "Relaxation turbulence", "min": 0.0, "max": 1.0},
        {"key": "p_max_iter", "label": "p max iterations", "min": 10, "max": 2000},
        {"key": "velocity_limit_max", "label": "Velocity limit maximum", "min": 0.0, "max": None},
    ]
    got = ns.out_of_range(fields, {"p_tolerance": 0.01, "relax_turbulence": 1.5, "p_max_iter": 200, "velocity_limit_max": 300})
    assert [o["text"] for o in got] == [
        "Saved p tolerance 1e-2 is outside 1e-12 to 1e-3.",
        "Saved relaxation turbulence 1.5 is outside 0 to 1.",
    ]
    assert got[0]["short"] == "p tolerance 1e-2"


def test_setting_out_of_range_is_one_warn_row_that_blocks_nothing():
    rows = ns.out_of_range([{"key": "p_tolerance", "label": "p tolerance", "min": 1e-12, "max": 1e-3}], {"p_tolerance": 0.01})
    out = check({"time_dependency": "steady", "settings": {"end_time": 200}, "out_of_range": rows})
    row = {r["code"]: r for r in out["checks"]}["setting_out_of_range"]
    assert row["level"] == "warn" and row["fix"] is None
    assert row["text"] == "Saved p tolerance 1e-2 is outside 1e-12 to 1e-3."
    assert row["short"] == "p tolerance 1e-2"
    assert "setting_out_of_range" not in {r["code"] for r in check({"time_dependency": "steady", "settings": {}})["checks"]}


def test_every_rh3_key_has_its_advice_and_each_description_starts_with_its_rule():
    for key in (*ns.STUDY_KEYS, *ns.RUN_KEYS):
        assert key in ADVICE, key
        assert len(ADVICE[key]["rule"]) <= RULE_MAX, key
        assert description(key, "Own words.").startswith(ADVICE[key]["rule"] + " ")
        assert description(key, "Own words.").endswith(" Own words.")
    assert description("max_co") == ADVICE["max_co"]["rule"] + " " + ADVICE["max_co"]["more"]


def test_the_field_specs_carry_the_cautions():
    specs = {s["key"]: s for s in ns.study_field_specs(transient=False, energy=True, simplec=True, p_name="p", eq_max_iter_default=50, velocity_limit_default="auto")}
    assert specs["momentum_convection"]["caution"] == {"first_order": ns.CAUTION_FIRST_ORDER}
    assert specs["energy_convection"]["caution"] == {"first_order": ns.CAUTION_FIRST_ORDER}
    assert specs["velocity_limit"]["caution"] == {"off": ns.CAUTION_LIMIT_OFF}
    assert specs["relax_turbulence"]["depends_on"] == {"simplec": False}
    assert all(s["advanced"] for s in specs.values())


# ---------------------------------------------------------------------------
# The core
# ---------------------------------------------------------------------------


def test_schema_field_caution_is_x_cfddesk_caution():
    from cfddesk.registry.schema import SchemaField, to_json_schema

    schema = to_json_schema((SchemaField("s", "Scheme", "choice", choices=("a", "b"), caution={"b": "Careful."}), SchemaField("n", "N", "int")))
    assert schema["properties"]["s"]["x-cfddesk"]["caution"] == {"b": "Careful."}
    assert "x-cfddesk" not in schema["properties"]["n"]


def test_run_normalize_passes_the_edited_keys_to_a_model_that_takes_them():
    from cfddesk.registry import contract

    seen: dict = {}

    def takes(raw, edited=None):
        seen["edited"] = edited
        return dict(raw)

    model = contract.RunModel(defaults=dict, normalize=takes)
    spec = SimpleNamespace(key="x", run_model=model)
    contract.run_normalize(spec, {"a": 1, "b": 2, "c": 3}, {"a": 1, "b": 5})
    assert seen["edited"] == ["b", "c"]
    # A model without it (API before 1.9) gets the merged settings only.
    old = contract.RunModel(defaults=dict, normalize=lambda raw: {**raw, "old": True})
    assert contract.run_normalize(SimpleNamespace(key="y", run_model=old), {"a": 1}, {})["old"] is True


def test_run_check_passes_on_numerics_as_written_cleaned():
    from cfddesk.registry import contract

    rows = [{"group": "Schemes", "label": "Gradient limiter", "value": "cellLimited Gauss linear 1", "source": "preset", "extra": 1}, {"label": ""}, "x"]
    model = contract.RunModel(defaults=dict, normalize=dict, check=lambda **_k: {"checks": [], "estimate": None, "numerics": rows})
    out = contract.run_check(SimpleNamespace(key="x", run_model=model))
    assert out["numerics"] == [{"group": "Schemes", "label": "Gradient limiter", "value": "cellLimited Gauss linear 1", "source": "preset"}]
    plain = contract.RunModel(defaults=dict, normalize=dict, check=lambda **_k: {"checks": [], "estimate": None})
    assert "numerics" not in contract.run_check(SimpleNamespace(key="y", run_model=plain))


def test_a_started_run_reads_the_numerics_it_started_with():
    from cfddesk.project.run_check import with_numerics_used
    from cfddesk.project.run_inputs import RunInputs

    base = RunInputs(
        project_dir=".",  # type: ignore[arg-type]
        run_id="r",
        simulation_id="s",
        mesh_id=None,
        n_procs=1,
        require_mesh=False,
        time_dependency="steady",
        analysis_key="incompressible_steady",
        solver_key="simpleFoam",
        study={"relax_p": 0.2, "grad_limiter": "light", "turbulence_model": "kOmegaSST"},
    )
    # A draft (or a run started before RH3): the study's.
    assert with_numerics_used(base) is base
    used = {"analysis": "incompressible_steady", "mode": "steady", "at": "2026-11-04T00:00:00Z", "values": {"relax_p": 0.3, "grad_limiter": None}}
    got = with_numerics_used(RunInputs(**{**base.__dict__, "run": {"numerics_used": used}}))
    assert got.study == {"relax_p": 0.3, "turbulence_model": "kOmegaSST"}


def test_a_continue_goes_on_with_the_numerics_its_restart_names(tmp_path):
    """RH3 (spec 5.3): a Continue's restart may carry the numerics it goes on with (what the run
    started with, or the study's new values); the core puts them over the study record, a null
    taking the key out (blank: the preset's), and the analysis never sees them in its restart."""
    import json
    import shutil
    from pathlib import Path

    from cfddesk.project.run_inputs import gather_run_inputs, with_numerics
    from cfddesk.registry import run_case

    assert with_numerics({"relax_p": 0.2, "grad_limiter": "light", "name": "S"}, {"relax_p": 0.3, "grad_limiter": None, "p_tolerance": 1e-8}) == {
        "relax_p": 0.3,
        "name": "S",
        "p_tolerance": 1e-8,
    }
    root = tmp_path / "project"
    shutil.copytree(Path(__file__).resolve().parents[1] / "fixtures" / "js-project", root)
    rec = {"id": "sim_1", "name": "S", "time_dependency": "Steady-state", "relax_p": 0.2, "grad_limiter": "light"}
    (root / "simulation.json").write_text(json.dumps(rec), encoding="utf-8")
    (root / "simulations.json").write_text(json.dumps({"active_id": "sim_1", "simulations": [rec]}), encoding="utf-8")
    plain = gather_run_inputs(root, run_id="r", require_mesh=False)
    assert (plain.study["relax_p"], plain.study["grad_limiter"], plain.restart) == (0.2, "light", None)
    restart = run_case.restart_arg(json.dumps({"end_time": 200, "numerics": {"relax_p": 0.3, "grad_limiter": None}}))
    got = gather_run_inputs(root, run_id="r", require_mesh=False, restart=restart)
    assert got.study["relax_p"] == 0.3 and "grad_limiter" not in got.study
    assert got.restart == {"end_time": 200.0, "write_interval": None}
