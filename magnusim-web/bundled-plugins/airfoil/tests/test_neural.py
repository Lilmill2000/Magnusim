"""How a study's conditions reach NeuralFoil, without NeuralFoil: stand-in
``aerosandbox`` / ``neuralfoil`` modules record what ``Airfoil.get_aero_from_neuralfoil``
is given, so a swapped or dropped argument fails here (the real polar tests run at
the defaults, where Mach 0, Ncrit 9 and free transition hide such a mistake)."""

from __future__ import annotations

import types

import pytest

import airfoil_service as svc
from airfoil import naca, neural, settings

np = pytest.importorskip("numpy")


class _Recorder:
    def __init__(self):
        self.airfoils: list[dict] = []
        self.calls: list[dict] = []

    def modules(self):
        rec = self

        class Airfoil:
            def __init__(self, name, coordinates):
                rec.airfoils.append({"name": name, "coordinates": np.asarray(coordinates)})

            def get_aero_from_neuralfoil(self, **kwargs):
                rec.calls.append(kwargs)
                a = np.asarray(kwargs["alpha"], dtype=float)
                # Every argument changes the numbers, so a dropped one would show too.
                cl = 0.1 * (a + 2.0) * (1.0 + kwargs["mach"])
                return {
                    "CL": cl,
                    "CD": 0.006 + 0.0001 * a * a + 0.0001 * kwargs["n_crit"],
                    "CM": np.full_like(a, -0.05),
                    "analysis_confidence": np.full_like(a, 0.9),
                    "Top_Xtr": np.full_like(a, kwargs["xtr_upper"]),
                    "Bot_Xtr": np.full_like(a, kwargs["xtr_lower"]),
                }

        asb = types.SimpleNamespace(Airfoil=Airfoil, __version__="stand-in")
        nf = types.SimpleNamespace(__version__="stand-in")
        return {"np": np, "asb": asb, "nf": nf}


@pytest.fixture
def recorder(monkeypatch):
    rec = _Recorder()
    monkeypatch.setattr(neural, "_modules", rec.modules())
    return rec


def test_every_condition_reaches_neuralfoil(recorder):
    sec = naca.generate("2412")
    conditions = settings.normalize_conditions(
        {"re": 2.5e5, "mach": 0.3, "ncrit": 5, "xtr_top": 0.1, "xtr_bottom": 0.4, "alpha_start": -2, "alpha_end": 4, "alpha_step": 2}
    )
    alphas = settings.alpha_list(conditions)
    rows = neural.evaluate(sec.name, sec.x, sec.y, alphas, conditions, "large")
    (call,) = recorder.calls
    assert call["Re"] == 2.5e5
    assert call["mach"] == 0.3
    assert call["n_crit"] == 5.0
    assert call["xtr_upper"] == 0.1
    assert call["xtr_lower"] == 0.4
    assert call["model_size"] == "large"
    assert list(call["alpha"]) == [-2.0, 0.0, 2.0, 4.0]
    (foil,) = recorder.airfoils
    assert foil["name"] == "NACA 2412"
    assert foil["coordinates"].shape == (len(sec.x), 2)
    assert foil["coordinates"][:, 0].tolist() == pytest.approx(sec.x)
    assert foil["coordinates"][:, 1].tolist() == pytest.approx(sec.y)
    # The rows carry what came back, upper and lower surface the right way round.
    assert [r["alpha"] for r in rows] == alphas
    assert rows[-1]["cl"] == pytest.approx(0.1 * 6.0 * 1.3)
    assert rows[0]["xtr_top"] == 0.1 and rows[0]["xtr_bottom"] == 0.4
    assert rows[0]["confidence"] == 0.9


def test_the_service_passes_the_conditions_and_the_default_model(project, recorder):
    _data, scope, sid = project
    conditions = {"re": 3e6, "mach": 0.5, "ncrit": 7, "xtr_top": 0.2, "xtr_bottom": 0.6, "alpha_start": 0, "alpha_end": 2, "alpha_step": 1}
    got = svc.neuralfoil_polar({"study_id": sid, "conditions": conditions}, scope)
    assert got["ok"] is True, got
    (call,) = recorder.calls
    assert (call["Re"], call["mach"], call["n_crit"], call["xtr_upper"], call["xtr_lower"]) == (3e6, 0.5, 7.0, 0.2, 0.6)
    # The model the plugin documents as its default (xlarge), and the saved result names it.
    assert call["model_size"] == "xlarge" == got["model_size"]
    got = svc.neuralfoil_polar({"study_id": sid, "conditions": conditions, "model_size": "small"}, scope)
    assert recorder.calls[-1]["model_size"] == "small" == got["model_size"]


def test_an_unknown_model_is_refused(recorder):
    sec = naca.generate("0012", 41)
    with pytest.raises(ValueError, match="Unknown NeuralFoil model"):
        neural.evaluate(sec.name, sec.x, sec.y, [0.0], settings.normalize_conditions({}), "huge")
    assert recorder.calls == []
