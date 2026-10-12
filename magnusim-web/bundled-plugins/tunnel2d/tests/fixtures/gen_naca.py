"""Writes naca.json: the Airfoil plugin's NACA sections (airfoil/naca.py), which the
tunnel's TypeScript port (src/geometry/naca.ts) must reproduce. Run from magnusim-web:
python/.venv/Scripts/python bundled-plugins/tunnel2d/tests/fixtures/gen_naca.py"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# SPDX-License-Identifier: GPL-3.0-or-later

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "airfoil"))

from airfoil import naca  # noqa: E402

CASES = [("0012", 81, False), ("2412", 81, False), ("4415", 40, True), ("23012", 81, False), ("23112", 60, False), ("44012", 121, True), ("6409", 20, False)]
ERRORS = ["", "12", "2012", "0212", "123456", "03012", "26012", "21112", "23200", "abcd"]

out = {"sections": [], "errors": []}
for code, n, closed in CASES:
    s = naca.generate(code, n, closed)
    out["sections"].append({"code": code, "points": n, "closed": closed, "x": s.x, "y": s.y, "name": s.name})
for text in ERRORS:
    try:
        naca.parse_code(text)
        out["errors"].append({"text": text, "error": None})
    except naca.NacaError as err:
        out["errors"].append({"text": text, "error": str(err)})
(HERE / "naca.json").write_text(json.dumps(out), encoding="utf-8")
print(f"wrote {len(out['sections'])} sections, {len(out['errors'])} error cases")
