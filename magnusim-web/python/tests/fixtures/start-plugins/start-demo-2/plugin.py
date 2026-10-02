"""A plugin with start actions (gate:l1-*): it registers nothing in Python.

Its manifest declares three study kinds, each with a workspace and a header
start action (``[[start_actions]]``, API 1.4), one of them with a place this
host does not know; the workspace page shows the study it opened.
"""

from __future__ import annotations


def register(hub):
    return None
