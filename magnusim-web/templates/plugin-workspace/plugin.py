"""Copy-paste workspace plugin: a study kind that opens in your own page.

Register backend methods here for the page's ``ws.service(...)`` calls
(``hub.register_method(PLUGIN, "name", fn)``); this one has none.
"""

from __future__ import annotations

PLUGIN = "my-workspace"


def register(hub):
    return None
