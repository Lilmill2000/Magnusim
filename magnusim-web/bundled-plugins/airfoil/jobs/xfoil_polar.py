"""Job tool ``xfoil_polar``: the XFOIL polar of one Airfoil analysis study.

    python jobs/xfoil_polar.py --study-id <sid>

Runs on the plugin's own environment, in the plugin's folder; the host tells it
the project (MAGNUSIM_PROJECT_DIR) and the plugin (MAGNUSIM_PLUGIN_KEY). It
reads the study's saved settings, runs XFOIL in a temporary folder and saves
``studies/<sid>/results/xfoil.json``. Events (MAGNUSIM_EVENT lines):

- ``stage`` ``{stage, label}``: ``prepare``, ``xfoil``, ``save``;
- ``progress`` ``{alpha, done, total, fraction}``: one per α XFOIL finished;
- ``log`` ``{line}``: one per α that did not converge ("α = 12°: did not converge");
- ``result`` ``{engine, total, converged, not_converged}``, or ``error`` ``{message}`` (exit 1).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import sys
import tempfile
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

PLUGIN_DIR = Path(__file__).resolve().parents[1]
if str(PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_DIR))

from magnusim_sdk.data import PluginData, PluginDataError  # noqa: E402
from magnusim_sdk.events import emit  # noqa: E402

from airfoil import datfile, naca, settings, store, xfoil  # noqa: E402

# SPDX-License-Identifier: GPL-3.0-or-later

Emit = Callable[..., None]


def run_job(
    sid: str,
    data: PluginData,
    *,
    exe: Sequence[str] | None = None,
    timeout_s: float | None = None,
    emit_fn: Emit = emit,
) -> int:
    """Run and save the polar; 0 when it was saved, 1 (after an ``error`` event) when not."""
    try:
        emit_fn("stage", stage="prepare", label="Preparing the polar")
        sid = store.study_id(sid)
        study = data.study(sid)
        cfg = settings.from_study(study)
        name, x, y = store.section(data, sid, cfg["airfoil"])
        alphas = settings.alpha_list(cfg["conditions"])
        emit_fn("stage", stage="xfoil", label=f"Running XFOIL: {len(alphas)} angles")

        def progress(done: int, alpha: float, total: int) -> None:
            emit_fn("progress", alpha=alpha, done=done, total=total, fraction=round(done / total, 4))

        with tempfile.TemporaryDirectory(prefix="magnusim-xfoil-") as tmp:
            polar = xfoil.run(
                name, x, y, alphas, cfg["conditions"], Path(tmp), exe=exe, timeout_s=timeout_s, on_progress=progress
            )
        for line in xfoil.describe_not_converged(polar.not_converged):
            emit_fn("log", line=line)
        emit_fn("stage", stage="save", label="Saving the polar")
        doc: dict[str, Any] = {
            "engine": "xfoil",
            "airfoil": cfg["airfoil"],
            "name": name,
            "conditions": cfg["conditions"],
            "iterations": xfoil.ITERATIONS,
            "alphas": alphas,
            "rows": polar.rows,
            "not_converged": polar.not_converged,
            "cp": polar.cp,
            "seconds": polar.seconds,
            "computed_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        }
        store.write_result(data, sid, "xfoil", doc)
        emit_fn(
            "result",
            engine="xfoil",
            total=len(alphas),
            converged=len(polar.rows),
            not_converged=polar.not_converged,
        )
        return 0
    except (
        xfoil.XfoilError,
        settings.SettingsError,
        store.StoreError,
        naca.NacaError,
        datfile.DatError,
        PluginDataError,
    ) as exc:
        emit_fn("error", message=str(exc))
        return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="The XFOIL polar of one Airfoil analysis study")
    parser.add_argument("--study-id", required=True)
    args = parser.parse_args(argv)
    try:
        data = PluginData.from_env()
    except PluginDataError as exc:
        emit("error", message=str(exc))
        return 1
    return run_job(args.study_id, data)


if __name__ == "__main__":
    raise SystemExit(main())
