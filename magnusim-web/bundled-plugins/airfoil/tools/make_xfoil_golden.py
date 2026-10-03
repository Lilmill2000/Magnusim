"""Write the XFOIL golden from the shipped program (run again only when xfoil.exe or
the session the plugin sends changes, and commit the result).

    python tools/make_xfoil_golden.py

NACA 2412 from the plugin's generator (81 points per side, cosine spacing, open
trailing edge: 161 points), re-panelled by XFOIL's ``PANE`` on its defaults,
Re 1e6, Mach 0, Ncrit 9, free transition (xtr 1/1), 100 iterations, α −4…10° in
steps of 1°, swept 0 → 10 then INIT and −1 → −4. The file records all of that:
the exact session sent to XFOIL, the program's SHA-256, every row XFOIL
converged, and the angles it did not.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import sys
import tempfile
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_DIR))

from airfoil import naca, settings, xfoil  # noqa: E402

# SPDX-License-Identifier: GPL-3.0-or-later

OUT = PLUGIN_DIR / "tests" / "goldens" / "xfoil_naca2412_re1e6.json"

# What XFOIL 6.99 printed for PANE in the run that made the golden (its defaults;
# the session changes none of them).
PANELING = {
    "panel_nodes": 160,
    "bunching": 1.0,
    "te_le_density_ratio": 0.15,
    "refined_area_le_density_ratio": 0.2,
    "refined_area_xc_top": [1.0, 1.0],
    "refined_area_xc_bottom": [1.0, 1.0],
}


def golden_inputs() -> tuple[dict, dict]:
    airfoil = settings.normalize_airfoil({"source": "naca", "code": "2412"})
    conditions = settings.normalize_conditions(
        {"re": 1e6, "mach": 0.0, "ncrit": 9.0, "xtr_top": 1.0, "xtr_bottom": 1.0, "alpha_start": -4.0, "alpha_end": 10.0, "alpha_step": 1.0}
    )
    return airfoil, conditions


def main() -> int:
    reason = xfoil.unavailable_reason()
    if reason:
        print(reason, file=sys.stderr)
        return 1
    exe = xfoil.default_exe()
    airfoil, conditions = golden_inputs()
    sec = naca.generate(airfoil["code"], airfoil["points_per_side"], closed_te=airfoil["closed_te"])
    alphas = settings.alpha_list(conditions)
    order = xfoil.sweep_order(alphas)
    with tempfile.TemporaryDirectory() as tmp:
        got = xfoil.run(sec.name, sec.x, sec.y, alphas, conditions, Path(tmp))
    row4 = next((r for r in got.rows if r["alpha"] == 4.0), None)
    # A program that is badly off must not become the golden: thin-airfoil theory gives
    # about 0.67 for this section at 4° (zero lift at about -2.08°); XFOIL's viscous value
    # at Re 1e6 is a little higher, about 0.70-0.72 (the laminar bottom surface).
    if row4 is None or not 0.6 < row4["cl"] < 0.8 or not 0.004 < row4["cd"] < 0.012:
        print(f"refused: α = 4° gave {row4}; expected Cl 0.6-0.8 and Cd 0.004-0.012", file=sys.stderr)
        return 1
    doc = {
        "about": "XFOIL golden for the Airfoil plugin: tests/test_xfoil_golden.py compares the shipped xfoil.exe with it.",
        "xfoil": {
            "version": "6.99",
            "program": "xfoil/bin/xfoil.exe (MIT's Windows build from XFOIL6.99.zip)",
            "sha256": hashlib.sha256(exe.read_bytes()).hexdigest(),
        },
        "airfoil": airfoil,
        "section": {"name": sec.name, "points": len(sec.x), "spacing": "cosine", "trailing_edge": "open"},
        "conditions": conditions,
        "iterations": xfoil.ITERATIONS,
        "paneling": PANELING,
        "sweep_order": order,
        "session": xfoil.build_script(order, conditions).splitlines(),
        "rows": got.rows,
        "not_converged": got.not_converged,
        "made_on": _dt.date.today().isoformat(),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {OUT}: {len(got.rows)} rows, not converged {got.not_converged}, Cl(4°) = {row4['cl']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
