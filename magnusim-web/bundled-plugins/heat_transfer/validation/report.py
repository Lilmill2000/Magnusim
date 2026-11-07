"""Write VALIDATION.md from the validation set's results (validation/results.json).

    python bundled-plugins/heat_transfer/validation/report.py          # write it
    python bundled-plugins/heat_transfer/validation/report.py --check  # exit 1 when it is out of date

The results come from ``pytest -m validation`` (tests/test_ht6_validation_wsl.py), each
row one quantity of one case on one mesher. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN = HERE.parent
RESULTS = HERE / "results.json"
REPORT = PLUGIN / "VALIDATION.md"

REQUIRED = ("case", "group", "quantity", "reference", "value", "error_pct", "mesher", "iterations", "source", "setup")
GROUPS = ("Natural convection", "Forced convection", "Conduction (CHT)")

HEAD = """# Heat Transfer: validation

Textbook heat transfer cases against published values. Each case is set up as a study,
meshed by the app's mesher and solved the way Start runs it (the runner's relay: this
plugin's prepare job, then `solve.sh` in WSL with OpenFOAM v2606), then measured from its
monitors and its saved fields. Hex-dominant meshes every case; the pipes are meshed with
Standard as well.

**Report-only.** These numbers are what this version computes; no case fails on them yet.
The tolerances are locked once Daniel has reviewed a full run of the whole set; from then on a
case outside its tolerance blocks a release. The proofs in `tests/test_ht_wsl_proofs.py` and `tests/test_ht5_cht_wsl.py` keep
their own tolerances.

Run the set (WSL with OpenFOAM v2606: about 35 minutes one case after another, each on 8
cores, on 2026-11-07; groups of cases can run side by side with `-k`), then this report:

```bash
cd python
pytest -m validation ../bundled-plugins/heat_transfer/tests -s
python ../bundled-plugins/heat_transfer/validation/report.py
```

The rows are in `validation/results.json` (`HT_VALIDATION_OUT` writes them elsewhere).

## How each number is measured

- **Cavity.** Nu = q L / (k ΔT). The headline is de Vahl Davis's Nu-bar, the cavity's
  mean Nusselt number: the mean of the hot and the cold wall's heat flow monitors (their
  mean flux) at the last iteration, with half of the gap between the two walls as its
  ±. His hot-wall values Nu_0 (1.117, 2.238, 4.509, 8.817) are noted beside it. Nu_max is
  the largest face value of the last saved wall heat flux on the hot wall, on the faces
  of the slab's middle half (the faces along the edges where the wall meets the symmetry
  planes are left out) between y/L 0.01 and 0.99 (the corner faces at the floor and the
  roof are left out too), with its height y/L; a peak more than 0.03 L from the
  reference's height is flagged in the table. The 2D cavity is a
  slab 40 mm deep (0.4 L) with symmetry on both faces, so the solution is the 2D one.
  It is that deep because Hex-dominant's background cells are cubes only when the part
  is about as deep as it is wide; on a 3 mm slab the cells came out ten times flatter
  than wide, the wall layers were not added (0.02 of 4) and, at Ra = 1e5 after 6000
  iterations, Nu_avg read +6.5 % and was still moving, where the 40 mm slab settled
  within about 1000 iterations.
- **Pipes.** Nu = q D / (k (T_wall − T_bulk)) in slices along the developed part of the
  pipe: T_wall and q are the area-weighted means of the wall faces in the slice, T_bulk
  the mixing-cup temperature of its cells (the sum of u T V over the sum of u V). The
  value is the slices' mean, its ± the standard error of that mean: on Hex-dominant
  meshes the slices scatter by several per cent around it with the castellated cells'
  pattern along the pipe. The air has constant properties (constant density, gravity
  off), as the correlations assume. The turbulent pipe's slices are 17.5 to 22.5 D after
  a uniform inlet, where the flow is still developing (its Nu is above the developed
  one), and its wall's y+ (OpenFOAM's yPlus on the solved case) is recorded with it. With
  k-omega SST's walls before 2026-11-06 (nutkWallFunction) it read 10 to 20 % under
  Gnielinski's correlation, more than the correlation's own scatter; with Spalding's law and
  stepwise omega since, within 2 % (the full run of 2026-11-07).
- **Conduction.** The heat through each face from the wall heat flux monitors, and the
  highest temperature from the solid's own monitor row.

Mesh checks of the turbulent pipe (2026-10-15, with the walls before 2026-11-06, before the
y+ was recorded, not in the table): Hex-dominant at fineness 7 (293 760 cells) read 98.52,
−7.88 % (fineness 6: −9.64 %); Standard at fineness 8 (141 197 cells) read 82.16, −23.17 %
(fineness 6: −20.55 %). With those walls Standard's tetrahedra read low whatever the cell
count; the checks were not run again with the new walls.
"""


def _num(value: float) -> str:
    a = abs(value)
    if a >= 100:
        return f"{value:.1f}"
    if a >= 10:
        return f"{value:.2f}"
    return f"{value:.3f}" if a >= 1 else f"{value:.4f}"


def _cell(text: object) -> str:
    """Text for a table cell ('|' would end the cell)."""
    return str(text).replace("|", "\\|")


def _cells(value: object) -> str:
    return f"{int(value):,}".replace(",", " ") if isinstance(value, (int, float)) else ""


def _rows(doc: dict) -> list[dict]:
    rows = list(doc.get("rows") or [])
    for r in rows:
        missing = [k for k in REQUIRED if k not in r]
        if missing:
            raise ValueError(f"row {r.get('case')!r} / {r.get('quantity')!r} has no {', '.join(missing)}")
    order = {g: i for i, g in enumerate(GROUPS)}
    return sorted(rows, key=lambda r: (order.get(r["group"], 99), r["case"], r["quantity"], r["mesher"] != "Hex-dominant"))


def _value(r: dict) -> str:
    """The value, with its uncertainty when the row has one ("4.365 ± 1.40 %")."""
    text = _num(float(r["value"]))
    if r.get("uncertainty_pct") is not None:
        text += f" ± {float(r['uncertainty_pct']):.2f} %"
    return text


def _flags(r: dict) -> str:
    """What the error column adds: a peak found away from the reference's height."""
    if r.get("peak_y_flag"):
        return f" (peak at y/L {float(r['peak_y']):.3f}, the reference's at {float(r['peak_y_ref']):.3f})"
    return ""


def build(doc: dict) -> str:
    rows = _rows(doc)
    out = [HEAD]
    stamps = sorted({(r.get("date", ""), r.get("plugin_version", ""), r.get("openfoam", "")) for r in rows})
    if stamps:
        runs = "; ".join(f"{d} (Heat Transfer {v}, OpenFOAM {o})" for d, v, o in stamps)
        out.append(f"Results of {runs}. The commit that holds them is in the repository's history.\n")
    out.append("## Results\n")
    out.append("| Case | Quantity | Reference | Magnusim | Error | Mesher | Cells | Iterations |")
    out.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in rows:
        out.append(
            f"| {_cell(r['case'])} | {_cell(r['quantity'])} | {_num(float(r['reference']))} | {_value(r)} | "
            f"{float(r['error_pct']):+.2f} %{_cell(_flags(r))} | {r['mesher']} | {_cells(r.get('cells'))} | {int(r['iterations'])} |"
        )
    out.append("")
    out.append("## The cases\n")
    for group in [g for g in GROUPS if any(r["group"] == g for r in rows)] + sorted(
        {r["group"] for r in rows} - set(GROUPS)
    ):
        out.append(f"### {group}\n")
        cases: dict[str, list[dict]] = {}
        for r in rows:
            if r["group"] == group:
                cases.setdefault(r["case"], []).append(r)
        for case, items in cases.items():
            out.append(f"**{case}.**")
            for s in dict.fromkeys(r["setup"] for r in items):
                out.append(f"{s}.")
            sources = list(dict.fromkeys(r["source"] for r in items))
            if len(sources) == 1:
                out.append(f"Reference: {sources[0]}.")
            out.append("")
            for r in items:
                bits = [f"{r['quantity']} on {r['mesher']}: {_value(r)} against {_num(float(r['reference']))} "
                        f"({float(r['error_pct']):+.2f} %){_flags(r)}"]
                if len(sources) > 1:
                    bits.append(f"reference: {r['source']}")
                if r.get("mesh"):
                    bits.append(f"mesh: {r['mesh']}")
                if r.get("detail"):
                    bits.append(str(r["detail"]))
                if r.get("layers_applied") is not None:
                    bits.append(f"layers applied: {'yes' if r['layers_applied'] else 'no'}")
                if r.get("layers"):
                    bits.append("layers: " + "; ".join(f"{k} {v}" for k, v in sorted(r["layers"].items())))
                out.append("- " + "; ".join(bits) + ".")
            out.append("")
    return "\n".join(out).rstrip() + "\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--check", action="store_true", help="exit 1 when VALIDATION.md is not what the results give")
    p.add_argument("--results", default=str(RESULTS))
    p.add_argument("--out", default=str(REPORT))
    args = p.parse_args(argv)
    text = build(json.loads(Path(args.results).read_text(encoding="utf-8")))
    out = Path(args.out)
    if args.check:
        have = out.read_text(encoding="utf-8").replace("\r\n", "\n") if out.is_file() else ""
        if have != text:
            print(f"{out.name} is out of date: run python {Path(__file__).as_posix()}", file=sys.stderr)
            return 1
        return 0
    out.write_bytes(text.encode("utf-8"))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
