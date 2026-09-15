#!/usr/bin/env python3
"""Dump the full cfddesk plugin registry as JSON (Phase 2 land9 / p2-registry-cli).

CLI: tools/registry_dump.py [--check-requirements] [--out PATH] [--web-root PATH]

Prints (or writes) JSON:
  {analysis, solver, mesher, bc, material, monitor, filter, plugins, missing}

Uses existing load_all / Registry.describe / check_requirements.
Does not rewrite W17 / MESH_ENGINES consumers; dual-defaults stay carry.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

CFDDESK_ROOT = Path(__file__).resolve().parents[1]
if str(CFDDESK_ROOT) not in sys.path:
    sys.path.insert(0, str(CFDDESK_ROOT))

from cfddesk.registry import check_requirements, load_all
from cfddesk.registry.discovery import RegistryHub

# Soft-pass dump shape (Step 9). Always emit these keys even when empty.
DUMP_KINDS: tuple[str, ...] = (
    "analysis",
    "solver",
    "mesher",
    "bc",
    "material",
    "monitor",
    "filter",
)


def _jsonable(value: Any) -> Any:
    if is_dataclass(value) and not isinstance(value, type):
        return {k: _jsonable(v) for k, v in asdict(value).items()}
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _manifest_row(manifest: Any) -> dict[str, Any]:
    return {
        "key": getattr(manifest, "key", ""),
        "name": getattr(manifest, "name", ""),
        "version": getattr(manifest, "version", "0.0.0"),
        "requires": _jsonable(getattr(manifest, "requires", None) or []),
        "provides": _jsonable(getattr(manifest, "provides", None) or {}),
    }


def _missing_rows(hub: RegistryHub, env: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Collect Missing from plugin manifests and any registered spec with requires."""
    missing: list[Any] = []
    for manifest in hub.manifests.values():
        missing.extend(check_requirements(manifest, env))
    for kind in hub.kinds():
        for spec in hub.registry(kind).items():
            if getattr(spec, "requires", None):
                missing.extend(check_requirements(spec, env))
    # De-dupe by (kind, name, reason) while preserving order
    seen: set[tuple[str, str, str]] = set()
    out: list[dict[str, Any]] = []
    for m in missing:
        req = getattr(m, "requirement", None)
        kind = str(getattr(req, "kind", "") if req is not None else "")
        name = str(getattr(req, "name", "") if req is not None else "")
        reason = str(getattr(m, "reason", ""))
        key = (kind, name, reason)
        if key in seen:
            continue
        seen.add(key)
        out.append(_jsonable(m))
    return out


def dump_registry(
    *,
    web_root: Path | str | None = None,
    check_reqs: bool = False,
    env: dict[str, Any] | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """Build the registry dump dict (testable without CLI I/O)."""
    hub = load_all(web_root=web_root, force=force)
    payload: dict[str, Any] = {}
    for kind in DUMP_KINDS:
        payload[kind] = hub.registry(kind).describe()
    payload["plugins"] = [_manifest_row(m) for m in hub.manifests.values()]
    if check_reqs:
        payload["missing"] = _missing_rows(hub, env if env is not None else {})
    else:
        payload["missing"] = []
    return payload


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=(
            "Emit full cfddesk registry JSON "
            "(analysis/solver/mesher/bc/material/monitor/filter/plugins)."
        )
    )
    p.add_argument(
        "--check-requirements",
        action="store_true",
        help=(
            "Fill missing[] via check_requirements on manifests and specs "
            "(env empty unless --env-json)."
        ),
    )
    p.add_argument(
        "--env-json",
        type=Path,
        default=None,
        help=(
            "Optional JSON object passed as env to check_requirements "
            "(wsl_tools/python_packages/gpu)."
        ),
    )
    p.add_argument(
        "--web-root",
        type=Path,
        default=None,
        help="Web root for plugins/ discovery (default: CFDDESK_WEB_ROOT / wsl.config).",
    )
    p.add_argument(
        "--out",
        "-o",
        type=Path,
        default=None,
        help="Write JSON to this path instead of stdout.",
    )
    p.add_argument(
        "--force",
        action="store_true",
        help="Force load_all(force=True) re-discovery.",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    env: dict[str, Any] | None = None
    if args.env_json is not None:
        raw = json.loads(Path(args.env_json).read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            print(
                json.dumps({"ok": False, "error": "env-json must be an object"}),
                flush=True,
            )
            return 2
        env = raw

    try:
        payload = dump_registry(
            web_root=args.web_root,
            check_reqs=args.check_requirements,
            env=env,
            force=args.force,
        )
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}), flush=True)
        return 1

    text = json.dumps(payload, indent=2, sort_keys=False) + "\n"
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
