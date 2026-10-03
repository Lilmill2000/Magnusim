"""Job tool ``openfoam_2d``: the OpenFOAM 2D case of one angle of one Airfoil analysis study.

    python jobs/openfoam_2d.py --study-id <sid> --alpha <deg> [--level coarse|medium|fine]

Runs on the plugin's own environment (Gmsh), in the plugin's folder; the host
tells it the project (MAGNUSIM_PROJECT_DIR) and the plugin
(MAGNUSIM_PLUGIN_KEY). It reads the study's saved section and conditions,
meshes the section (a structured C-mesh, :mod:`airfoil.cmesh`) and writes the
case in ``studies/<sid>/openfoam/run-<n>-a<α>`` (:mod:`airfoil.openfoam`). It
runs nothing in WSL: the workspace queues the case it wrote with
``ws.compute.submitOpenFOAM`` and the options this job hands back. Events
(MAGNUSIM_EVENT lines):

- ``stage`` ``{stage, label}``: ``prepare``, ``mesh``, ``write``;
- ``result`` ``{case_rel, alpha, level, cells, submit}``, or ``error`` ``{message}`` (exit 1).
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

PLUGIN_DIR = Path(__file__).resolve().parents[1]
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))

from magnusim_sdk.data import PluginData, PluginDataError  # noqa: E402
from magnusim_sdk.events import emit  # noqa: E402
from magnusim_sdk.gmsh_helpers import initialize_gmsh  # noqa: E402

from airfoil import cmesh, datfile, foamcase, naca, openfoam, settings, store  # noqa: E402

# SPDX-License-Identifier: GPL-3.0-or-later

Emit = Callable[..., None]


def run_job(sid: str, alpha: float, level: str, data: PluginData, *, gmsh: Any = None, emit_fn: Emit = emit) -> int:
    """Write the case; 0 when it was written, 1 (after an ``error`` event) when not."""
    try:
        emit_fn("stage", stage="prepare", label="Reading the study")
        sid = store.study_id(sid)
        cfg = settings.from_study(data.study(sid))
        name, x, y = store.section(data, sid, cfg["airfoil"])
        if gmsh is None:
            # Gmsh is in the plugin's own environment (requirements.lock), which this job
            # runs on (python="plugin"), so the boundary check lets it import Gmsh.
            import gmsh as gmsh_api

            gmsh = gmsh_api
            initialize_gmsh(gmsh, readConfigFiles=False)
            gmsh.option.setNumber("General.Terminal", 0)
            owned = True
        else:
            owned = False
        try:
            meta = openfoam.write_case(
                data,
                sid,
                name=name,
                x=x,
                y=y,
                airfoil=cfg["airfoil"],
                conditions=cfg["conditions"],
                alpha=alpha,
                level=level,
                gmsh=gmsh,
                on_stage=lambda stage, label: emit_fn("stage", stage=stage, label=label),
            )
        finally:
            if owned:
                gmsh.finalize()
        emit_fn(
            "result",
            case_rel=meta["case_rel"],
            alpha=meta["alpha"],
            level=meta["level"],
            cells=meta["cells"],
            submit=meta["submit"],
        )
        return 0
    except (
        openfoam.RunError,
        foamcase.CaseError,
        cmesh.MeshError,
        settings.SettingsError,
        store.StoreError,
        naca.NacaError,
        datfile.DatError,
        PluginDataError,
    ) as exc:
        emit_fn("error", message=str(exc))
        return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="The OpenFOAM 2D case of one angle of one Airfoil analysis study")
    parser.add_argument("--study-id", required=True)
    parser.add_argument("--alpha", required=True, type=float)
    parser.add_argument("--level", default=cmesh.DEFAULT_LEVEL)
    args = parser.parse_args(argv)
    try:
        data = PluginData.from_env()
    except PluginDataError as exc:
        emit("error", message=str(exc))
        return 1
    return run_job(args.study_id, args.alpha, args.level, data)


if __name__ == "__main__":
    raise SystemExit(main())
