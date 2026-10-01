"""An optional bundled plugin that ships off (gate:g11-*): nothing here runs until
someone turns it on in Settings > Plugins."""

from __future__ import annotations

import cfddesk.registry.discovery as _discovery

# Tests read this to tell whether the plugin was ever imported.
_discovery.__dict__.setdefault("_g11_imports", []).append("opt-demo")


def register(hub):
    return None
