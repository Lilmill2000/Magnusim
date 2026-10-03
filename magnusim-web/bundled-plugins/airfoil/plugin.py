"""Airfoil: 2D section polars from NeuralFoil, XFOIL and OpenFOAM 2D, in a workspace of its own.

register() runs in the core and only declares the jobs (the XFOIL polar, and the
OpenFOAM 2D case writer, whose case the workspace then queues with
ws.compute.submitOpenFOAM); everything else
is in the manifest (the study kind, the workspace, the start action and the
plugin's own environment) and in the service (airfoil_service.py), which runs
in that environment. Nothing here imports the plugin's own packages.
"""

from __future__ import annotations

from pathlib import Path

from cfddesk.registry.jobs import JobKind

# SPDX-License-Identifier: GPL-3.0-or-later

PLUGIN = "airfoil"


def register(hub):
    here = Path(__file__).resolve().parent
    hub.register_job(
        JobKind("xfoil_polar", "jobs/xfoil_polar.py", "project", ("study_id",), python="plugin"),
        plugin=PLUGIN,
        package_dir=here,
    )
    hub.register_job(
        JobKind("openfoam_2d", "jobs/openfoam_2d.py", "project", ("study_id", "alpha", "level"), python="plugin"),
        plugin=PLUGIN,
        package_dir=here,
    )
    return None
