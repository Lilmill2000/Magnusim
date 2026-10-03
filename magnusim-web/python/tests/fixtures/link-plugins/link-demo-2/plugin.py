"""A plugin whose backend makes the export it links (gate:l2-e2e, gate:l2-choice).

``export`` writes a design version as a **text** BREP and its face-name sidecar
(``magnusim_sdk.link.write_face_names``, with the text file's own hash) into the study's
folder through ``magnusim_sdk.data`` (the call's ``scope["data"]``). The page then reads
each file's etag with ``ws.files.stat`` and links them from its own "Send to simulation"
button. It registers no exit hook. The designs (``designs/``: link-demo's v1 and v2 as
text BREPs) are built by tools/gen_link_demo_fixtures.py.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path

PLUGIN = "link-demo-2"
DESIGNS = Path(__file__).resolve().parent / "designs"


def _export(params: dict, scope: dict) -> dict:
    from magnusim_sdk.link import write_face_names

    data = scope.get("data")
    if data is None:
        return {"ok": False, "error": "this call has no open project"}
    sid = str(params.get("study_id") or "").strip()
    version = str(params.get("version") or "v1")
    if not sid or version not in ("v1", "v2"):
        return {"ok": False, "error": "study_id and a version (v1 or v2) are required"}
    raw = (DESIGNS / f"{version}.brep").read_bytes()
    names = json.loads((DESIGNS / f"{version}.face_names.json").read_text(encoding="utf-8"))
    base = f"studies/{sid}/export"
    data.write_bytes(f"{base}/shape.brep", raw)
    with tempfile.TemporaryDirectory() as tmp:
        side = Path(tmp) / "face_names.json"
        write_face_names(side, names["bodies"], names["faces"], hashlib.sha256(raw).hexdigest())
        data.write_bytes(f"{base}/face_names.json", side.read_bytes())
    return {"ok": True, "shape": f"{base}/shape.brep", "faceNames": f"{base}/face_names.json"}


def register(hub):
    hub.register_method(PLUGIN, "export", _export)
    return None
