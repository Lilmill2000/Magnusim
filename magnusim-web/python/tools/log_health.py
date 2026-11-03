"""An ended run's health from its solver log (RH1 "Check its log", spec 3.9).

    python log_health.py --case <case dir> --app <solver> [--analysis <key> --plugin <key>]
                         [--latest-saved <t>] [--head-missing]

Reads the run's log parts in its case folder (``log.<app>.1``, ``.2``, … oldest first, then
``log.<app>``): the head of the oldest part and the tail of the newest (16 MB each) with the
middle left out, through the analysis's log parser hook ``health_advice`` when it has one,
and the health hints of its ``w27-case.json``. Prints one JSON line: ``{"ok": true, "health":
{...}}`` or ``{"ok": false, "error": "..."}``. Reads files only.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "sdk"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

APP_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")


def log_parts(case: Path, app: str) -> list[Path]:
    """The run's log parts, oldest first: log.<app>.1, .2, … then log.<app>."""
    parts = []
    numbered = sorted(
        (int(m.group(1)), p)
        for p in case.glob(f"log.{app}.*")
        if (m := re.fullmatch(rf"log\.{re.escape(app)}\.(\d+)", p.name))
    )
    parts += [p for _n, p in numbered]
    current = case / f"log.{app}"
    if current.is_file():
        parts.append(current)
    return parts


def advice_of(analysis: str | None, plugin: str | None):
    """The analysis's log parser hook ``health_advice``, or None (generic words)."""
    if not analysis or not plugin:
        return None
    try:
        from cfddesk.registry import load_all
        from cfddesk.registry.contract import load_log_parser
        from cfddesk.wsl.foam_relay import resolve_log_parser

        parser = load_log_parser(resolve_log_parser(load_all(), analysis, plugin=plugin))
        return getattr(parser, "health_advice", None)
    except Exception:
        return None


def main(argv: list[str] | None = None) -> int:
    from magnusim_sdk.health import check_log

    from cfddesk.wsl.foam_case import case_health_hints

    ap = argparse.ArgumentParser()
    ap.add_argument("--case", required=True)
    ap.add_argument("--app", required=True)
    ap.add_argument("--analysis", default="")
    ap.add_argument("--plugin", default="")
    ap.add_argument("--latest-saved", type=float, default=None)
    ap.add_argument("--head-missing", action="store_true")
    args = ap.parse_args(argv)
    case = Path(args.case)

    def say(doc: dict) -> int:
        print(json.dumps(doc, separators=(",", ":")), flush=True)
        return 0 if doc.get("ok") else 1

    if not APP_RE.match(args.app) or not case.is_dir():
        return say({"ok": False, "error": "This run's case folder or solver is not known."})
    parts = log_parts(case, args.app)
    if not parts:
        return say({"ok": False, "error": "Its solver log is gone, so its health cannot be checked."})
    # A part numbered after a gap (log.<app>.2 without .1) means the head is gone.
    names = [p.name for p in parts]
    head_missing = args.head_missing or (len(parts) > 1 and f"log.{args.app}.1" not in names)
    rec = check_log(
        [str(p) for p in parts],
        case_health_hints(case),
        head_missing=head_missing,
        latest_saved=args.latest_saved,
        advice=advice_of(args.analysis or None, args.plugin or None),
    )
    return say({"ok": True, "health": rec})


if __name__ == "__main__":
    raise SystemExit(main())
