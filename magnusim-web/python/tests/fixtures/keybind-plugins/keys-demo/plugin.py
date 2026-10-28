"""A plugin with workspace commands (gate:keybinds-*): it registers nothing in Python.

Its Board workspace lists its commands and their default keys (workspace/commands.json); the
page shows each command's keys now (the defaults with the person's keybinds pref) and which
command a key press ran, so the e2e sees a change made in Settings take effect at once.
"""

from __future__ import annotations


def register(hub):
    return None
