"""Heat Transfer: the Steady-State and Transient heat transfer simulation types
(buoyant flow of one fluid, and conjugate heat transfer with solid bodies).

A bundled plugin that ships on (it can be turned off in Settings > Plugins).
Everything lives in the ``heat_transfer`` package next to this file; it imports
only ``magnusim_sdk``, ``cfddesk.registry`` and Incompressible Flow's exported
flow boundary conditions (``incompressible_flow.flow_bcs``).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from cfddesk.registry.jobs import JobKind

from heat_transfer.analyses import build_heat_transfer_steady, build_heat_transfer_transient
from heat_transfer.bcs import SOLID_WALL_BC_FAMILY, SOLID_WALL_BC_TYPE
from heat_transfer.materials import build_thermo_fluid, build_thermo_solid
from heat_transfer.monitors import (
    build_surface_temperature,
    build_thermocouple,
    build_wall_heat_flux,
)
from heat_transfer.solvers import (
    build_buoyant_pimple_foam,
    build_buoyant_simple_foam,
    build_cht_multi_region_foam,
    build_cht_multi_region_simple_foam,
)

KEY = "heat_transfer"


def register(hub: Any) -> None:
    # The prepare step of this plugin's runs (LaunchSpec.prepare_job): it writes a
    # run's case into the run's own case folder, on the core's Python.
    hub.register_job(
        JobKind(
            "heat_transfer.write_run_case",
            "heat_transfer/jobs/write_run_case.py",
            "study",
            ("run_id", "mesh_id", "time_dependency", "n_procs", "transient", "restart"),
            python="core",
        ),
        plugin=KEY,
        package_dir=Path(__file__).resolve().parent,
    )
    materials = hub.registry("material")
    materials.register(build_thermo_fluid(), plugin=KEY)
    materials.register(build_thermo_solid(), plugin=KEY)
    # A solid body's outer faces (its own BC family; the type first, then the family).
    hub.registry("bc").register(SOLID_WALL_BC_TYPE, plugin=KEY)
    hub.registry("bc_family").register(SOLID_WALL_BC_FAMILY, plugin=KEY)
    monitors = hub.registry("monitor")
    monitors.register(build_wall_heat_flux(), plugin=KEY)
    monitors.register(build_surface_temperature(), plugin=KEY)
    monitors.register(build_thermocouple(), plugin=KEY)
    solvers = hub.registry("solver")
    solvers.register(build_buoyant_simple_foam(), plugin=KEY)
    solvers.register(build_buoyant_pimple_foam(), plugin=KEY)
    solvers.register(build_cht_multi_region_simple_foam(), plugin=KEY)
    solvers.register(build_cht_multi_region_foam(), plugin=KEY)
    analyses = hub.registry("analysis")
    analyses.register(build_heat_transfer_steady(), plugin=KEY)
    analyses.register(build_heat_transfer_transient(), plugin=KEY)
