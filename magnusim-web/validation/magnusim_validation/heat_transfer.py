"""Heat Transfer's own validation set, shown in the report and on the public page beside the
cases here (Daniel, 2026-11-05: both). Its rows are the ones it committed
(``bundled-plugins/heat_transfer/validation/results.json``, written by ``pytest -m validation``
there); nothing here runs them again. They are read and formatted with Heat Transfer's own
report code (``bundled-plugins/heat_transfer/validation/report.py``), so a number reads the
same in both reports.

Its runs go another way than this set's: each case is a study set up in Python and meshed
and solved by the plugin's prepare job and ``solve.sh`` in WSL (the relay Start uses), not
sent over the app's HTTP routes, so the two sets exercise different parts of the app. The
report and the page say so.
"""

from __future__ import annotations

import functools
import html
import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

from .paths import WEB

HT_VALIDATION = WEB / "bundled-plugins" / "heat_transfer" / "validation"
HT_RESULTS = HT_VALIDATION / "results.json"
HT_REPORT_MD = "bundled-plugins/heat_transfer/VALIDATION.md"

HOW = (
    "Heat Transfer's own validation set: natural convection in a square cavity (de Vahl Davis), forced convection "
    "in a pipe (laminar and turbulent) and conduction through solids, each against its published value. Its runs go "
    "another way than the cases above: each case is a study set up in Python, meshed by the app's mesher and solved "
    "by the plugin's prepare job and solve.sh in WSL (the relay Start uses), not sent over the app's HTTP routes, so "
    "the two sets exercise different parts of the app. Report-only, as above. Its rows are the ones it committed "
    "(bundled-plugins/heat_transfer/validation/results.json, from pytest -m validation there); this report reads "
    "them and runs nothing."
)


@functools.lru_cache(maxsize=1)
def _report_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("ht_validation_report", HT_VALIDATION / "report.py")
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {HT_VALIDATION / 'report.py'}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load(path: Path = HT_RESULTS) -> dict[str, Any] | None:
    """Heat Transfer's committed rows, in its report's order (None when it has none)."""
    if not path.is_file():
        return None
    rep = _report_module()
    rows = rep._rows(json.loads(path.read_text(encoding="utf-8")))
    if not rows:
        return None
    stamps = sorted({(r.get("date", ""), r.get("plugin_version", ""), r.get("openfoam", "")) for r in rows})
    groups = [g for g in rep.GROUPS if any(r["group"] == g for r in rows)]
    groups += sorted({r["group"] for r in rows} - set(groups))
    return {"source": "bundled-plugins/heat_transfer/validation/results.json", "rows": rows, "stamps": stamps,
            "groups": groups}


def stamp_text(doc: dict[str, Any]) -> str:
    return "; ".join(f"{d} (Heat Transfer {v}, OpenFOAM {o})" for d, v, o in doc["stamps"])


def table_rows(doc: dict[str, Any]) -> list[dict[str, str]]:
    """Each row's cells as Heat Transfer's report writes them."""
    rep = _report_module()
    out = []
    for r in doc["rows"]:
        cells = r.get("cells")
        out.append({
            "case": str(r["case"]),
            "quantity": str(r["quantity"]),
            "reference": rep._num(float(r["reference"])),
            "value": rep._value(r),
            "error": f"{float(r['error_pct']):+.2f} %{rep._flags(r)}",
            "mesher": str(r["mesher"]),
            "cells": f"{int(cells):,}".replace(",", " ") if isinstance(cells, (int, float)) else "-",
            "iterations": str(int(r["iterations"])),
        })
    return out


def cases_of(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """Per group, per case: its setups, its references (one, or one per row) and each row's line."""
    rep = _report_module()
    out = []
    for group in doc["groups"]:
        by_case: dict[str, list[dict[str, Any]]] = {}
        for r in doc["rows"]:
            if r["group"] == group:
                by_case.setdefault(r["case"], []).append(r)
        items = []
        for case, rows in by_case.items():
            sources = list(dict.fromkeys(r["source"] for r in rows))
            lines = []
            for r in rows:
                bits = [f"{r['quantity']} on {r['mesher']}: {rep._value(r)} against {rep._num(float(r['reference']))} "
                        f"({float(r['error_pct']):+.2f} %){rep._flags(r)}"]
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
                lines.append("; ".join(bits))
            items.append({"case": case, "setups": list(dict.fromkeys(r["setup"] for r in rows)),
                          "reference": sources[0] if len(sources) == 1 else None, "lines": lines})
        out.append({"group": group, "cases": items})
    return out


def markdown(doc: dict[str, Any] | None) -> list[str]:
    """The Heat Transfer section of VALIDATION.md."""
    if not doc:
        return []
    from .report import cell

    out = ["## Heat Transfer\n", HOW + f" Its own report: `{HT_REPORT_MD}`.\n", f"Results of {stamp_text(doc)}.\n"]
    out.append("| Case | Quantity | Reference | Magnusim | Error | Mesher | Cells | Iterations |")
    out.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in table_rows(doc):
        out.append(f"| {cell(r['case'])} | {cell(r['quantity'])} | {r['reference']} | {r['value']} | {cell(r['error'])} | "
                   f"{r['mesher']} | {r['cells']} | {r['iterations']} |")
    out.append("")
    for g in cases_of(doc):
        out.append(f"### {g['group']}\n")
        for c in g["cases"]:
            out.append(f"**{cell(c['case'])}.**")
            out.extend(f"{cell(s)}." for s in c["setups"])
            if c["reference"]:
                out.append(f"Reference: {cell(c['reference'])}.")
            out.append("")
            out.extend(f"- {cell(line)}." for line in c["lines"])
            out.append("")
    return out


def html_section(doc: dict[str, Any] | None) -> list[str]:
    """The Heat Transfer section of the public page."""
    if not doc:
        return []

    def esc(v: Any) -> str:
        return html.escape(str(v), quote=True)

    out = ["<h2>Heat Transfer</h2>", f"<p>{esc(HOW)} Its own report: <code>{esc(HT_REPORT_MD)}</code>.</p>",
           f'<p class="env">Results of {esc(stamp_text(doc))}.</p>',
           '<div class="scroll"><table><thead><tr><th>Case</th><th>Quantity</th><th>Reference</th><th>Magnusim</th>'
           "<th>Error</th><th>Mesher</th><th>Cells</th><th>Iterations</th></tr></thead><tbody>"]
    for r in table_rows(doc):
        out.append(f"<tr><td>{esc(r['case'])}</td><td>{esc(r['quantity'])}</td><td class=num>{esc(r['reference'])}</td>"
                   f"<td class=num>{esc(r['value'])}</td><td class=num>{esc(r['error'])}</td><td>{esc(r['mesher'])}</td>"
                   f"<td class=num>{esc(r['cells'])}</td><td class=num>{esc(r['iterations'])}</td></tr>")
    out.append("</tbody></table></div>")
    for g in cases_of(doc):
        out.append(f"<h3>{esc(g['group'])}</h3>")
        for c in g["cases"]:
            head = " ".join(f"{esc(s)}." for s in c["setups"])
            ref = f" Reference: {esc(c['reference'])}." if c["reference"] else ""
            out.append(f"<p><strong>{esc(c['case'])}.</strong> {head}{ref}</p><ul class=facts>")
            out.extend(f"<li>{esc(line)}.</li>" for line in c["lines"])
            out.append("</ul>")
    return out
