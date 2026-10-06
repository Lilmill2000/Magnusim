"""Incompressible Flow: the Steady-State and Transient simulation types.

A required bundled plugin: the app cannot create or run simulations without
it. Everything lives in the ``incompressible_flow`` package next to this file;
it imports only ``magnusim_sdk`` and ``cfddesk.registry``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from cfddesk.registry.jobs import JobKind

from incompressible_flow.analyses import build_incompressible_steady, build_incompressible_transient
from incompressible_flow.bcs import register_bcs
from incompressible_flow.materials import build_newtonian_incompressible
from incompressible_flow.monitors import (
    build_area_average,
    build_flow_rate,
    build_forces,
    build_probe,
)
from incompressible_flow.solvers import build_pimple_foam, build_simple_foam

KEY = "incompressible_flow"


def register(hub: Any) -> None:
    # The prepare step of this plugin's runs (LaunchSpec.prepare_job, API 1.5): it
    # writes a run's case into the run's own case folder, on the core's Python.
    # Its `restart` param continues a run from its latest saved time.
    hub.register_job(
        JobKind(
            "incompressible_flow.write_run_case",
            "incompressible_flow/jobs/write_run_case.py",
            "study",
            ("run_id", "mesh_id", "time_dependency", "n_procs", "transient", "restart"),
            python="core",
        ),
        plugin=KEY,
        package_dir=Path(__file__).resolve().parent,
    )
    register_bcs(hub, KEY)
    hub.registry("material").register(build_newtonian_incompressible(), plugin=KEY)
    monitors = hub.registry("monitor")
    monitors.register(build_area_average(), plugin=KEY)
    monitors.register(build_flow_rate(), plugin=KEY)
    monitors.register(build_forces(), plugin=KEY)
    monitors.register(build_probe(), plugin=KEY)
    solvers = hub.registry("solver")
    for app in (build_simple_foam(), build_pimple_foam()):
        solvers.register(app, plugin=KEY)
    analyses = hub.registry("analysis")
    analyses.register(build_incompressible_steady(), plugin=KEY)
    analyses.register(build_incompressible_transient(), plugin=KEY)
