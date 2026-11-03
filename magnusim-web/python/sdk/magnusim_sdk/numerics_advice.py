"""The one source of the numerics advice texts (run health, RH1).

``ADVICE[key] = {"rule": ..., "more": ...}``: ``rule`` (at most 160 characters) is
the sentence every place repeats: the setting's description starts with it (the
Assistant's field list cuts descriptions at 160 characters, so the rule survives
the cut), the Run panel's tooltip shows that description, the Health block's
"Likely cause" finding ends with it, and the Assistant's CFD guide quotes it
(``scripts/generated/numerics-advice.json``, written by ``npm run gen:registry``).
``more`` follows the rule in the description.

Max Courant has no cap (Daniel, A1): a high value is warned about, never refused.
No text here says or implies that a higher Max Courant is faster on its own.

Standard library only; plugins import it (``description("max_co")``).
"""

from __future__ import annotations

from typing import TypedDict


class Advice(TypedDict):
    rule: str
    more: str


# The largest Courant number the advice allows with 1 outer corrector (PISO) and with
# 2-3 outer correctors (PIMPLE).
CO_PISO = 1
CO_PIMPLE = 5
# The velocity limit Incompressible Flow writes: LIMIT_FACTOR x the reference speed,
# at least LIMIT_FLOOR m/s.
LIMIT_FACTOR = 10
LIMIT_FLOOR = 50

ADVICE: dict[str, Advice] = {
    "max_co": {
        "rule": (
            "Max Courant is not a speed setting on its own. With 1 outer corrector (PISO) "
            "keep it at or below 1; 2-3 outer correctors allow up to about 5."
        ),
        "more": (
            "Largest cell Courant number the adjustable time step allows. Above 1 the steps "
            "are larger only if each has 2-3 outer correctors, and each step then costs about "
            "that many times more; without them the run becomes unstable."
        ),
    },
    "n_outer_correctors": {
        "rule": (
            "PIMPLE outer loops per time step. 1 = PISO: keep Max Courant at or below 1. 2-3 "
            "allow up to about 5, and each step then costs about that many times more."
        ),
        "more": "More than 1 pays off only with Max Courant above 1.",
    },
}

RULE_MAX = 160


def rule(key: str) -> str:
    """The advice's first sentence(s) for ``key``."""
    return ADVICE[key]["rule"]


def description(key: str) -> str:
    """A setting's schema description: its rule, then the rest."""
    a = ADVICE[key]
    return a["rule"] + " " + a["more"]


def as_json() -> dict[str, dict[str, str]]:
    """The table as plain JSON (scripts/generated/numerics-advice.json)."""
    return {k: {"rule": v["rule"], "more": v["more"]} for k, v in ADVICE.items()}
