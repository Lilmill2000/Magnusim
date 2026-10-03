"""A plugin whose study kind links a project geometry (gate:l2-*): it registers nothing in Python.

Its page (workspace/) writes BREP exports and links them; the tests also link its
files through the host's link route directly.
"""

from __future__ import annotations


def register(hub):
    return None
