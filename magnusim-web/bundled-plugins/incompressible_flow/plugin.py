"""Incompressible Flow: the Steady-State and Transient simulation types.

A required bundled plugin: the app cannot create or run simulations without
it. It registers both analyses and their solver apps; the core reaches them
only through the analysis contract (cfddesk.registry.contract).

Until H9 the implementation still lives in the core packages imported below
(cfddesk.builtin.incompressible, solvers_openfoam, incompressible_contract);
H9 moves it into this folder and removes these imports (the plugin-boundary
check lists them as its only allowed exception).
"""

from __future__ import annotations

from typing import Any

from cfddesk.builtin.incompressible import (
    build_incompressible_steady,
    build_incompressible_transient,
)
from cfddesk.builtin.solvers_openfoam import (
    build_pimple_foam,
    build_simple_foam,
    build_simple_foam_amgx,
)

KEY = "incompressible_flow"


def register(hub: Any) -> None:
    solvers = hub.registry("solver")
    for app in (build_simple_foam(), build_pimple_foam(), build_simple_foam_amgx()):
        solvers.register(app, plugin=KEY)
    analyses = hub.registry("analysis")
    analyses.register(build_incompressible_steady(), plugin=KEY)
    analyses.register(build_incompressible_transient(), plugin=KEY)
