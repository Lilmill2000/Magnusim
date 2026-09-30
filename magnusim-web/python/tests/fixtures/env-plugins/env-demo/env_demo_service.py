"""The env-demo service: runs in the plugin's own environment (magnusim_sdk.service)."""

from __future__ import annotations

import importlib.util
import os
import sys
import time

from magnusim_sdk.data import PluginData
from magnusim_sdk.service import method


@method("hello")
def hello(params, scope):
    return {
        "prefix": sys.prefix,
        "cfddesk_importable": importlib.util.find_spec("cfddesk") is not None,
        "pid": os.getpid(),
        "echo": params.get("echo"),
        "project_id": scope.get("project_id"),
    }


@method("slow", timeout_s=2)
def slow(params, scope):
    time.sleep(float(params.get("seconds") or 5))
    return {"slept": True}


@method("crash")
def crash(params, scope):
    print("about to exit", flush=True)
    os._exit(1)


@method("notes/write")
def notes_write(params, scope):
    data = PluginData(scope["project_dir"], scope["plugin"])
    data.write_json("notes/note.json", {"text": str(params.get("text") or "")})
    return {"ok": True}


@method("migrate_study")
def migrate_study(params, scope):
    study = dict(params["study"])
    study["title"] = str(study.get("title") or "") + " (upgraded)"
    study["units"] = "SI"
    return study
