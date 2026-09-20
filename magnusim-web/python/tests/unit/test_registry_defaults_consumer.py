"""Phase 2 land13: dual-defaults consumer keys match committed registry.json."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from cfddesk.registry.analysis import DEFAULT_STEADY_KEY

WEB_ROOT = Path(__file__).resolve().parents[3]
COMMITTED_REGISTRY = WEB_ROOT / "scripts" / "generated" / "registry.json"
REGISTRY_DEFAULTS_JS = WEB_ROOT / "scripts" / "registry-defaults.js"
PROVE_JS = WEB_ROOT / "scripts" / "__tests__" / "prove-registry-defaults.mjs"
TOOLS = WEB_ROOT / "python" / "tools"

EXPECTED_MESHER_KEYS = {"standard", "cfmesh", "snappy_hexdominant"}
EXPECTED_MESH_ENGINES = {"standard", "cfmesh"}


def test_committed_registry_has_analysis_and_mesher_keys():
    assert COMMITTED_REGISTRY.is_file()
    doc = json.loads(COMMITTED_REGISTRY.read_text(encoding="utf-8"))
    a_keys = {row["key"] for row in doc["analysis"]}
    m_keys = {row["key"] for row in doc["mesher"]}
    assert DEFAULT_STEADY_KEY in a_keys
    assert a_keys >= {DEFAULT_STEADY_KEY, "incompressible_transient"}
    assert m_keys == EXPECTED_MESHER_KEYS
    # Product mesh engines must be dump keys (no parallel invent).
    assert EXPECTED_MESH_ENGINES <= m_keys


def test_registry_defaults_module_exists():
    assert REGISTRY_DEFAULTS_JS.is_file()
    text = REGISTRY_DEFAULTS_JS.read_text(encoding="utf-8")
    assert "loadCommittedRegistry" in text
    assert "buildW17DefaultsFromRegistry" in text
    assert "MESH_ENGINES" in text
    assert "registry.json" in text


def test_w17_w20_import_registry_defaults():
    w17 = (WEB_ROOT / "scripts" / "w17-simulation.js").read_text(encoding="utf-8")
    w20 = (WEB_ROOT / "scripts" / "w20-mesh.js").read_text(encoding="utf-8")
    w21 = (WEB_ROOT / "scripts" / "w21-mesh-generate.js").read_text(encoding="utf-8")
    assert "registry-defaults.js" in w17
    assert "buildW17DefaultsFromRegistry" in w17
    assert "acceptsW17Analysis" in w17
    assert "registry-defaults.js" in w20
    assert "MESH_ENGINES" in w20
    assert "registry-defaults.js" in w21
    assert "resolveMeshBackend" in w21
    assert "mesherKeys" in w21
    assert "stamp_project" in w20
    # No parallel hard-coded MESH_ENGINES set left in w20.
    assert "new Set(['standard', 'cfmesh'])" not in w20
    assert 'new Set(["standard", "cfmesh"])' not in w20


def test_node_prove_registry_defaults_smoke():
    if shutil.which("node") is None:
        pytest.skip("node is not on PATH")
    assert PROVE_JS.is_file()
    proc = subprocess.run(
        ["node", str(PROVE_JS)],
        cwd=str(WEB_ROOT),
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr or proc.stdout
    data = json.loads(proc.stdout)
    assert data.get("ok") is True
    assert data.get("analysis_type") == DEFAULT_STEADY_KEY
    assert set(data.get("MESH_ENGINES") or []) == EXPECTED_MESH_ENGINES
    assert DEFAULT_STEADY_KEY in set(data.get("analysis_keys") or [])
    assert EXPECTED_MESHER_KEYS <= set(data.get("mesher_keys") or [])


def test_registry_dump_check_still_green():
    script = TOOLS / "registry_dump.py"
    proc = subprocess.run(
        [sys.executable, str(script), "--check", "--committed", str(COMMITTED_REGISTRY)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr or proc.stdout
    payload = json.loads(proc.stdout)
    assert payload.get("ok") is True
