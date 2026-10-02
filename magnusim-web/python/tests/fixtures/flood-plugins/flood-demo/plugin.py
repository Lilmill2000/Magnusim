"""Flood demo (e2e/job-log-flood.spec.js): one JobKind that sends job events as fast
as a small OpenFOAM case's relay did, about ten a time step and thousands of
steps a second (H15 core bug 1: such a run kept the app server from answering).

- The JobKind ``flood_demo_events`` (core interpreter, standard library only):
  ``--steps N`` time steps at ``--rate R`` steps a second (0: as fast as it can).
"""

from __future__ import annotations

from pathlib import Path

from cfddesk.registry.jobs import JobKind

PLUGIN = "flood-demo"


def register(hub):
    hub.register_job(
        JobKind("flood_demo_events", "jobs/flood.py", "project", ("steps", "rate"), python="core"),
        plugin=PLUGIN,
        package_dir=Path(__file__).resolve().parent,
    )
    return None
