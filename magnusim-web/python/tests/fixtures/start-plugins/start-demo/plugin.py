"""A plugin with start actions (gate:l1-*): it registers nothing in Python.

Its manifest declares two study kinds with workspaces and one start action
(``[[start_actions]]``, API 1.4); the workspace page shows the study it opened.
"""

from __future__ import annotations


def register(hub):
    return None
