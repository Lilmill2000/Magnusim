"""A plugin with its own environment, service and job (gate:h12-*).

register() runs in the core and only declares things; the backend is the
service module (env_demo_service), run in the plugin's own environment.
"""

from __future__ import annotations

from pathlib import Path

from cfddesk.registry.jobs import JobKind

PLUGIN = "env-demo"


def register(hub):
    hub.register_job(
        JobKind("env_demo_sleep", "tools/sleep_tree.py", "project", ("seconds",), python="plugin"),
        plugin=PLUGIN,
        package_dir=Path(__file__).resolve().parent,
    )
    return None
