"""A plugin that owns project-level studies (gate:h11-*).

Its methods reach its own data folder in the open project through
scope["data"] (cfddesk.registry.plugin_data.PluginData), and nothing else.
"""

from __future__ import annotations

PLUGIN = "study-demo"


def _note_write(params, scope):
    data = scope["data"]
    data.write_json(str(params.get("rel") or "notes/note.json"), {"text": str(params.get("text") or "")})
    return {"ok": True, "studies": [s["id"] for s in data.studies()]}


def _note_read(params, scope):
    return {"ok": True, "doc": scope["data"].read_json(str(params.get("rel") or "notes/note.json"))}


def register(hub):
    hub.register_method(PLUGIN, "notes/write", _note_write)
    hub.register_method(PLUGIN, "notes/read", _note_read)
    return None
