"""H3: a plugin analysis is in the registry while enabled, and gone when disabled."""

from __future__ import annotations

import json
from pathlib import Path

from cfddesk.registry.discovery import load_all, reset_for_tests


def _plugin(root: Path) -> None:
    folder = root / "plugins" / "h3probe"
    folder.mkdir(parents=True)
    (folder / "manifest.toml").write_text(
        'key = "h3probe"\nname = "H3 probe"\nversion = "0.0.1"\napi_version = "1.0"\n',
        encoding="utf-8",
    )
    (folder / "plugin.py").write_text(
        "\n".join(
            [
                "from dataclasses import replace",
                "from cfddesk.builtin.incompressible import build_incompressible_steady",
                "def register(hub):",
                "    spec = replace(build_incompressible_steady(), key='h3probe', label='H3 probe analysis')",
                "    hub.registry('analysis').register(spec, plugin='h3probe')",
            ]
        ),
        encoding="utf-8",
    )


def _keys() -> set[str]:
    from cfddesk.registry.discovery import get_registry

    return {row["key"] for row in get_registry("analysis").describe()}


def test_gate_h3_picker_open(tmp_path: Path) -> None:
    reset_for_tests()
    try:
        _plugin(tmp_path)
        load_all(web_root=tmp_path)
        assert "h3probe" in _keys()
        assert "incompressible_steady" in _keys()
        (tmp_path / ".cfddesk-local.json").write_text(
            json.dumps({"plugins": {"disabled": ["h3probe"]}}),
            encoding="utf-8",
        )
        reset_for_tests()
        load_all(web_root=tmp_path)
        assert "h3probe" not in _keys()
        assert "incompressible_steady" in _keys()
    finally:
        reset_for_tests()
