"""A plugin that edits a project geometry (host API 1.7): it registers nothing in Python.

Its page (workspace/) reads the geometry its study edits, and sends an edit back.
"""

from __future__ import annotations


def register(hub):
    return None
