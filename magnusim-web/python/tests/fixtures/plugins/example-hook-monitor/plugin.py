"""case.written hook that appends one function object to controlDict."""

from __future__ import annotations

from pathlib import Path

from cfddesk.registry.hooks import get_hooks
from cfddesk.registry.manifest import PluginManifest

PLUGIN = "example-hook-monitor"
MONITOR = "exampleHookMonitor"

_BLOCK = """    exampleHookMonitor
    {
        type            surfaceFieldValue;
        libs            ("libfieldFunctionObjects.so");
        writeControl    timeStep;
        writeInterval   1;
        log             false;
        writeFields     false;
        regionType      patch;
        name            walls;
        operation       areaAverage;
        fields          ( p );
    }
"""


def _on_case_written(*, ctx=None, result=None, **_ignored):
    del result
    try:
        out = getattr(ctx, "out_dir", None)
        if out is None:
            return
        path = Path(out) / "system" / "controlDict"
        if not path.is_file():
            return
        text = path.read_text(encoding="utf-8")
        if MONITOR in text:
            return
        end = text.rfind("}")
        if end < 0:
            path.write_text(text + "\nfunctions\n{\n" + _BLOCK + "}\n", encoding="utf-8")
            return
        path.write_text(text[:end] + _BLOCK + text[end:], encoding="utf-8")
    except (OSError, TypeError, ValueError):
        return


def register(hub):
    del hub
    get_hooks().on("case.written", _on_case_written, plugin=PLUGIN)
    return PluginManifest(
        key=PLUGIN,
        name="Hook monitor",
        version="0.1.0",
        description="Appends one function object after a case is written",
        authors=["Magnusim"],
        api_version="1.0",
        ui="ui",
        ui_entry="index.js",
        source="local",
    )
