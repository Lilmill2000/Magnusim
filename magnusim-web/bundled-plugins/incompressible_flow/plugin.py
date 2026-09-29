"""Incompressible Flow: the Steady-State and Transient simulation types.

A required bundled plugin: the app cannot create or run simulations without
it. Everything lives in the ``incompressible_flow`` package next to this file;
it imports only ``magnusim_sdk`` and ``cfddesk.registry``.
"""

from __future__ import annotations

from typing import Any

from incompressible_flow.analyses import build_incompressible_steady, build_incompressible_transient
from incompressible_flow.materials import build_newtonian_incompressible
from incompressible_flow.monitors import build_area_average, build_flow_rate
from incompressible_flow.solvers import build_pimple_foam, build_simple_foam

KEY = "incompressible_flow"


def register(hub: Any) -> None:
    hub.registry("material").register(build_newtonian_incompressible(), plugin=KEY)
    monitors = hub.registry("monitor")
    monitors.register(build_area_average(), plugin=KEY)
    monitors.register(build_flow_rate(), plugin=KEY)
    solvers = hub.registry("solver")
    for app in (build_simple_foam(), build_pimple_foam()):
        solvers.register(app, plugin=KEY)
    analyses = hub.registry("analysis")
    analyses.register(build_incompressible_steady(), plugin=KEY)
    analyses.register(build_incompressible_transient(), plugin=KEY)
