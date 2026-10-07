#!/usr/bin/env python3
"""Plugin package: ``npm run plugin:pack -- <plugin key or folder> [--out <folder>] [--no-tests]``.

Checks the plugin (plugin:check), then zips it as ``<out>/<key>-v<version>.zip``
with one top folder named after its key, and writes ``<zip>.sha256`` next to it.
Settings > Plugins > "Install plugin from zip..." installs the zip on any PC;
a zip of a bundled plugin with a higher version is an update of it.

What goes in: the files git tracks in the plugin folder (so build output and
local files stay out), or every file when the folder is not in a git checkout;
never tests/, e2e/, node_modules/, caches or bytecode
(cfddesk.registry.plugin_package.PACK_SKIP_DIRS). A plugin key is looked for in
bundled-plugins/ and then in plugins/. Exit 1: the check failed or the zip
could not be made; 2: no such plugin.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
for _p in (_ROOT, _ROOT / "sdk", Path(__file__).resolve().parent):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from cfddesk.registry.plugin_package import PackageError, pack_plugin  # noqa: E402

WEB_ROOT = _ROOT.parent


def _find(arg: str, base: Path) -> Path | None:
    """A plugin folder from a path (relative to ``base``) or a key."""
    path = Path(arg)
    if not path.is_absolute():
        path = base / path
    if (path / "manifest.toml").is_file():
        return path.resolve()
    for root in (WEB_ROOT / "bundled-plugins", WEB_ROOT / "plugins"):
        if (root / arg / "manifest.toml").is_file():
            return (root / arg).resolve()
    return None


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("plugin", help="a plugin key (bundled-plugins/<key> or plugins/<key>) or a plugin folder")
    p.add_argument("--out", default="", help="where the zip goes (default: dist/ next to magnusim-web)")
    p.add_argument("--no-tests", action="store_true", help="check the plugin without running its own tests")
    p.add_argument("--json", action="store_true", help="print the result as JSON")
    p.add_argument("--base", default=os.environ.get("INIT_CWD") or os.getcwd(), help=argparse.SUPPRESS)
    args = p.parse_args(argv)
    base = Path(args.base)
    folder = _find(args.plugin, base)
    if folder is None:
        print(f"plugin:pack: no plugin {args.plugin!r} (a folder with manifest.toml, or a key in bundled-plugins/ or plugins/)", file=sys.stderr)
        return 2
    import plugin_check

    report = plugin_check._check_or_report_crash(folder, run_tests=not args.no_tests)
    if not args.json:
        # As plugin:check prints it: UTF-8 whatever the console's code page.
        sys.stdout.buffer.write((plugin_check.render(report) + "\n\n").encode("utf-8"))
        sys.stdout.buffer.flush()
    if not report.ok:
        print(f"plugin:pack: {folder.name} did not pass plugin:check ({report.errors} error(s)); nothing was packed", file=sys.stderr)
        return 1
    out = Path(args.out) if args.out else WEB_ROOT.parent / "dist"
    if not out.is_absolute():
        out = base / out
    out = out.resolve()
    try:
        result = pack_plugin(folder, out)
    except PackageError as exc:
        print(f"plugin:pack: {exc.message}", file=sys.stderr)
        return 1
    result["checked"] = "plugin:check passed" + (" (its own tests not run: --no-tests)" if args.no_tests else "")
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"{result['key']} {result['version']}: {result['zip']}")
        print(f"  {result['files']} files, {result['bytes'] / 1048576:.1f} MB ({result['unpacked_bytes'] / 1048576:.1f} MB unpacked), from {result['from']}")
        print(f"  sha256 {result['sha256']}")
        print(f"  {result['checked']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
