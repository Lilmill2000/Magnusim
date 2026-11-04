"""The public page of the validation set: ``index.html`` (one static, self-contained page: no
scripts, no external fonts or styles; light and dark by the reader's setting) and
``results.json`` (every result as committed), built into ``<repo>/docs/validation/`` beside
the figures in ``img/``. GitHub Pages serves ``docs/`` once it is turned on for the
repository; nothing here turns it on or pushes.
"""

from __future__ import annotations

import html
import json
from typing import Any

from . import cases
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
    from .report import band_text, err_text

    inside = q.get("within")
    cls = "" if inside is None else (" in" if inside else " out")
    case = cases.get(res["case"])
    return (
        f"<tr><td>{esc(case.TITLE)}</td><td>{esc(case.VARIANT_LABELS.get(res['variant'], res['variant']))}</td>"
        f"<td>{esc(q['label'])}</td><td class=num>{esc(_num(q['reference']['value']))}</td>"
        f"<td class=num>{esc(_num(q['value'], 5))}</td><td class=\"num{cls}\">{esc(err_text(q))}</td>"
        f"<td class=\"num{cls}\">{esc(band_text(q))}</td></tr>"
    )


def build_index(results: list[dict[str, Any]]) -> str:
    from .report import env_lines, layers_text, run_time_text

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
        '<p><span class="badge">Report-only</span> No case fails on these numbers yet. After the first full run the '
        "tolerances are locked; from then on a value outside its tolerance blocks a release. The bands shown are the "
        "proposed ones.</p>",
    ]
    if results:
        out.append('<p class="env">' + "<br>".join(esc(x) for x in env_lines(results)) + "</p>")
        out.append("<h2>Results</h2>")
        out.append('<div class="scroll"><table><thead><tr><th>Case</th><th>Mesher</th><th>Quantity</th>'
                   "<th>Reference</th><th>Magnusim</th><th>Error</th><th>Band</th></tr></thead><tbody>")
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
            m = res.get("mesh") or {}
            r = res.get("run") or {}
            qual = m.get("quality") or {}
            label = case.VARIANT_LABELS.get(res["variant"], res["variant"])
            out.append(f"<h3>{esc(label)}</h3><ul class=facts>")
            status = res["status"] + (f": {res['status_detail']}" if res.get("status_detail") else "")
            out.append(f"<li>Status: {esc(status)}</li>")
            if res["setup"].get("mesh_words"):
                out.append(f"<li>Mesh settings: {esc(res['setup']['mesh_words'])}</li>")
            out.append(
                f"<li>Mesh: {esc(_num(m.get('n_cells'), 7))} cells; checkMesh "
                f"{'OK' if qual.get('ok') else 'not OK' if qual.get('known') else 'unknown'}"
                + (f" (max non-orthogonality {esc(_num(qual.get('max_non_orthogonality'), 3))}°, max skewness "
                   f"{esc(_num(qual.get('max_skewness'), 3))})" if qual.get("known") else "")
                + f"; wall layers {esc(layers_text(m))}</li>"
            )
            conv = (f"converged at iteration {r['converged_at']}" if r.get("converged")
                    else f"stopped at its iteration limit ({r.get('end_time_set')})")
            out.append(f"<li>Run: {esc(r.get('iterations'))} iterations, {esc(conv)}; solve {esc(run_time_text(res))} "
                       f"on {esc(r.get('n_procs') or r.get('cores_set'))} ranks; run health "
                       f"{esc((r.get('health') or {}).get('verdict') or '-')}</li>")
            for q in res["quantities"]:
                out.append(f"<li><strong>{esc(q['label'])}</strong>: how: {esc(q['how'])}. Source: "
                           f"<code>{esc(q['source'])}</code>.{(' ' + esc(q['detail']) + '.') if q.get('detail') else ''}</li>")
            for w in res.get("warnings") or []:
                out.append(f"<li>Warning: {esc(w)}</li>")
            out.append("</ul>")
            figs = figures_of(case, res)
            if figs:
                out.append('<div class="figs">')
                for f in figs:
                    alt = f"{res['title']}: {f['caption']}"
                    out.append(f'<figure><img src="img/{esc(f["file"])}" alt="{esc(alt)}" loading="lazy">'
                               f"<figcaption>{esc(alt)}</figcaption></figure>")
                out.append("</div>")
        out.append("<h3>References</h3><ul class=refs>")
        for spec in case.QUANTITIES.values():
            ref = spec.reference
            out.append(f"<li><strong>{esc(spec.label)}</strong>: {esc(_num(ref.value))} ({esc(ref.kind)}, "
                       f"{esc(ref.confidence)}). {esc(ref.citation)}; {esc(ref.where)}. Conditions: "
                       f"{esc(ref.conditions)}.{(' ' + esc(ref.note)) if ref.note else ''}</li>")
        out.append("</ul>")
    out.extend([
        "<h2>How to reproduce</h2>",
        "<p>On Windows with Magnusim's Setup done (WSL with OpenFOAM v2606), from <code>magnusim-web</code>:</p>",
        "<pre>npm run test:validation\nnpm run validation:report</pre>",
        "<p>Each run's requests are in <code>validation/results/&lt;case&gt;/&lt;variant&gt;/plan.json</code> and its "
        "values, their sources, the mesh, the run and its health in <code>result.json</code> beside it; "
        '<a href="results.json">results.json</a> holds them all.</p>',
        "<footer>Generated from the committed results by <code>npm run validation:report</code>.</footer>",
        "</main></body></html>",
    ])
    return "\n".join(out) + "\n"


def build_site(results: list[dict[str, Any]]) -> dict[str, str]:
    """The page's text files by name (the figures are drawn by plots.render)."""
    return {
        "index.html": build_index(results),
        "results.json": json.dumps({"schema": "magnusim-validation-site/1", "results": results}, indent=1,
                                   ensure_ascii=False) + "\n",
    }
