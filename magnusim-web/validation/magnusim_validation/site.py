"""The public page of the validation set: ``index.html`` (one static, self-contained page: no
scripts, no external fonts or styles; light and dark by the reader's setting) and
``results.json`` (every result as committed, each value's band and verdict as the locks judge it
now and the verdict its run gave in ``verdict_at_run``, and Heat Transfer's own rows), built into
``<repo>/docs/validation/`` beside the figures in ``img/``. GitHub Pages serves ``docs/`` once it is turned on for the
repository; nothing here turns it on or pushes.
"""

from __future__ import annotations

import html
import json
from typing import Any

from . import cases, heat_transfer
from .plots import figures_of

CSS = """
:root{color-scheme:light;--bg:#fcfcfb;--card:#ffffff;--text:#0b0b0b;--muted:#52514e;--line:#e3e2de;
--accent:#2a78d6;--in:#0b6b3a;--out:#a3341b;--chip:#f1f0ec}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#1a1a19;--card:#232322;--text:#f0efec;
--muted:#c3c2b7;--line:#3a3a37;--accent:#3987e5;--in:#5fcf8f;--out:#f08a6c;--chip:#2c2c2a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1080px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:28px;line-height:1.2;margin:8px 0 4px}
h2{font-size:21px;margin:40px 0 8px;padding-top:8px;border-top:1px solid var(--line)}
h3{font-size:17px;margin:28px 0 6px}
p,li{max-width:76ch}
.lede{color:var(--muted);margin:0 0 16px}
.badge{display:inline-block;background:var(--chip);border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:13px}
.env{color:var(--muted);font-size:13px}
.scroll{overflow-x:auto;margin:12px 0;border:1px solid var(--line);border-radius:8px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);white-space:nowrap}
tr:last-child td{border-bottom:none}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.in{color:var(--in)}.out{color:var(--out)}
.facts{margin:6px 0;padding-left:20px}
.facts li{margin:3px 0}
figure{margin:16px 0;background:#fcfcfb;border:1px solid var(--line);border-radius:8px;padding:8px}
figure img{display:block;width:100%;height:auto}
figcaption{color:#52514e;font-size:13px;padding:4px 4px 0}
.figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto}
.refs li{margin:6px 0}
a{color:var(--accent)}
footer{margin-top:48px;color:var(--muted);font-size:13px}
""".strip()


def esc(v: Any) -> str:
    return html.escape(str(v), quote=True)


def _num(v: Any, digits: int = 4) -> str:
    from .report import num

    return num(v, digits)


def _q_row(res: dict[str, Any], q: dict[str, Any]) -> str:
    from .report import band_text, err_text, status_text, variant_label, verdict_text

    inside = q.get("within")
    cls = "" if inside is None else (" in" if inside else " out")
    vcls = {"pass": " class=in", "fail": " class=out"}.get(str(q.get("verdict")), "")
    scls = "" if res.get("status") == "ok" else " class=out"
    case = cases.get(res["case"])
    return (
        f"<tr><td>{esc(case.TITLE)}</td><td>{esc(variant_label(case, res))}</td>"
        f"<td{scls}>{esc(status_text(res))}</td>"
        f"<td>{esc(q['label'])}</td><td class=num>{esc(_num(q['reference']['value']))}</td>"
        f"<td class=num>{esc(_num(q['value'], 5))}</td><td class=\"num{cls}\">{esc(err_text(q))}</td>"
        f"<td class=\"num{cls}\">{esc(band_text(q))}</td><td{vcls}>{esc(verdict_text(q))}</td></tr>"
    )


def build_index(results: list[dict[str, Any]], ht: dict[str, Any] | None = None) -> str:
    from .locks import LOCKED_ON
    from .report import (
        case_notes,
        env_lines,
        lock_html,
        quantity_value_text,
        variant_facts,
        variant_label,
    )

    out = [
        "<!doctype html>",
        '<html lang="en"><head><meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        "<title>Magnusim validation</title>",
        f"<style>{CSS}</style></head><body><main>",
        "<h1>Magnusim validation</h1>",
        '<p class="lede">Textbook flows with published answers, set up, meshed and solved through the app itself, '
        "and compared with their reference values. A value here is what the app produced: nothing is tuned per case "
        "and no number is typed in.</p>",
        f'<p><span class="badge">Locked {esc(LOCKED_ON)}</span> {lock_html(results)}</p>',
    ]
    if results:
        out.append('<p class="env">' + "<br>".join(esc(x) for x in env_lines(results)) + "</p>")
        out.append("<h2>Results</h2>")
        out.append('<div class="scroll"><table><thead><tr><th>Case</th><th>Run</th><th>Status</th><th>Quantity</th>'
                   "<th>Reference</th><th>Magnusim</th><th>Error</th><th>Band</th><th>Verdict</th></tr></thead><tbody>")
        for res in results:
            out.extend(_q_row(res, q) for q in res["quantities"])
        out.append("</tbody></table></div>")
    else:
        out.append("<p>No results yet.</p>")
    for cid in dict.fromkeys(r["case"] for r in results):
        case = cases.get(cid)
        mine = [r for r in results if r["case"] == cid]
        out.append(f"<h2>{esc(case.TITLE)}</h2>")
        out.append(f"<p>{esc(mine[0]['setup']['words'])}</p>")
        for res in mine:
            out.append(f"<h3>{esc(variant_label(case, res))}</h3><ul class=facts>")
            if res["setup"]["words"] != mine[0]["setup"]["words"]:
                out.append(f"<li>Setup: {esc(res['setup']['words'])}</li>")
            facts = variant_facts(case, res)
            split = next((i for i, f in enumerate(facts) if f.startswith(("Shown, not compared", "Warning"))), len(facts))
            out.extend(f"<li>{esc(f)}</li>" for f in facts[:split])
            for q in res["quantities"]:
                out.append(f"<li><strong>{esc(q['label'])}</strong>: {esc(quantity_value_text(q))}. How: {esc(q['how'])}. "
                           f"Source: <code>{esc(q['source'])}</code>.{(' ' + esc(q['detail']) + '.') if q.get('detail') else ''}</li>")
            out.extend(f"<li>{esc(f)}</li>" for f in facts[split:])
            out.append("</ul>")
            figs = figures_of(case, res)
            if figs:
                out.append('<div class="figs">')
                for f in figs:
                    alt = f"{res['title']}: {f['caption']}"
                    out.append(f'<figure><img src="img/{esc(f["file"])}" alt="{esc(alt)}" loading="lazy">'
                               f"<figcaption>{esc(alt)}</figcaption></figure>")
                out.append("</div>")
        notes = case_notes(case, mine)
        if notes:
            out.append("<h3>Notes</h3><ul class=refs>")
            out.extend(f"<li>{esc(n)}</li>" for n in notes)
            out.append("</ul>")
        out.append("<h3>References</h3><ul class=refs>")
        for spec in case.QUANTITIES.values():
            ref = spec.reference
            out.append(f"<li><strong>{esc(spec.label)}</strong>: {esc(_num(ref.value))} ({esc(ref.kind)}, "
                       f"{esc(ref.confidence)}). {esc(ref.citation)}; {esc(ref.where)}. Conditions: "
                       f"{esc(ref.conditions)}.{(' ' + esc(ref.note)) if ref.note else ''}</li>")
        out.append("</ul>")
    out.extend(heat_transfer.html_section(ht))
    out.extend([
        "<h2>How to reproduce</h2>",
        "<p>On Windows with Magnusim's Setup done (WSL with OpenFOAM v2606), from <code>magnusim-web</code>:</p>",
        "<pre>npm run test:validation\nnpm run validation:report</pre>",
        "<p>Heat Transfer's set, from <code>magnusim-web/python</code>:</p>",
        "<pre>pytest -m validation ../bundled-plugins/heat_transfer/tests -s\n"
        "python ../bundled-plugins/heat_transfer/validation/report.py</pre>",
        "<p>Each run's requests are in <code>validation/results/&lt;case&gt;/&lt;variant&gt;/plan.json</code> and its "
        "values, their sources, the mesh, the run and its health in <code>result.json</code> beside it; "
        '<a href="results.json">results.json</a> holds them all.</p>',
        "<footer>Generated from the committed results by <code>npm run validation:report</code>.</footer>",
        "</main></body></html>",
    ])
    return "\n".join(out) + "\n"


def build_site(results: list[dict[str, Any]], ht: dict[str, Any] | None = None) -> dict[str, str]:
    """The page's text files by name (the figures are drawn by plots.render), each value judged by
    the locks; ``ht``: Heat Transfer's rows (heat_transfer.load)."""
    from .locks import judge

    results = judge(results)[0]
    doc: dict[str, Any] = {"schema": "magnusim-validation-site/1", "results": results}
    if ht:
        doc["heat_transfer"] = {"source": ht["source"], "how": heat_transfer.HOW, "rows": ht["rows"]}
    return {
        "index.html": build_index(results, ht),
        "results.json": json.dumps(doc, indent=1, ensure_ascii=False) + "\n",
    }
