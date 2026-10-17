"""A plugin whose workspace offers tools to the app's assistant (bridge 1.9, unreleased).

It registers nothing in Python: its page (workspace/) keeps a counter and offers the
assistant tools to read and change it (e2e/assistant-workspace-tools.spec.js).
"""

from __future__ import annotations


def register(hub):
    del hub
    return None
