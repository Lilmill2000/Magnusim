"""``VALIDATION.md`` and the public page (``<repo>/docs/validation/``: ``index.html``, ``img/``
and ``results.json``) from the committed results (``results/<case>/<variant>/result.json``).

Both are generated: ``report --check`` exits 1 when either text differs from what the
results give, or a figure is missing (the PNGs themselves are not compared byte for byte:
fonts and the plotting library's version change their pixels, not their content). Nothing
here publishes the page: that is a push, which only the project's owner makes.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from . import cases
from .paths import REPORT_MD, RESULTS, SITE, SITE_IMG
from .plots import figures_of, render
from .result import read_result
from .site import build_site

VARIANT_ORDER = ("hexdominant", "standard")
VERDICT_WORDS = {"report_only": "report-only", "pass": "pass", "fail": "FAIL", "missing": "no value"}


def load_results(root: Path = RESULTS) -> list[dict[str, Any]]:
    """Every committed result, in the cases' order, Hex-dominant first."""
    out = []
    for cid in cases.CASES:
        case_dir = root / cid
        if not case_dir.is_dir():
            continue
        for vdir in sorted(case_dir.iterdir(), key=lambda p: (VARIANT_ORDER.index(p.name) if p.name in VARIANT_ORDER else 99, p.name)):
            path = vdir / "result.json"
            if path.is_file():
                out.append(read_result(path))
    return out


def num(v: Any, digits: int = 4) -> str:
    """A number to ``digits`` significant digits, without trailing noise."""
    if v is None:
        return "-"
    x = float(v)
    if x == 0:
        return "0"
    text = f"{x:.{digits}g}"
    if "e" in text:
        mant, exp = text.split("e")
        return f"{mant} × 10^{int(exp)}"
    return text


def cells_text(v: Any) -> str:
    return f"{int(v):,}".replace(",", " ") if isinstance(v, (int, float)) else "-"


def cell(text: Any) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def err_text(q: dict[str, Any]) -> str:
    return "-" if q.get("error") is None else f"{q['error']['rel_pct']:+.2f} %"


def band_text(q: dict[str, Any]) -> str:
    tol = q["tolerance"]
    inside = q.get("within")
    mark = "" if inside is None else (" (inside)" if inside else " (outside)")
    return f"±{num(tol['rel_pct'], 3)} %{mark}"


def layers_text(m: dict[str, Any]) -> str:
    lay = m.get("layers") or {}
    if not lay.get("asked"):
        return "none asked"
    walls = lay.get("walls") or []
    cover = "; ".join(f"{w.get('patch')} {num(w.get('layers'), 3)} of {num(w.get('layers_asked'), 3)}" for w in walls)
    return f"{'applied' if lay.get('applied') else 'NOT applied'}{f' ({cover})' if cover else ''}"


def health_text(r: dict[str, Any]) -> str:
    h = (r.get("health") or {})
    return str(h.get("verdict") or "-")


def run_time_text(res: dict[str, Any]) -> str:
    r = res.get("run") or {}
    t = r.get("wall_s")
    return "-" if t is None else f"{float(t):.0f} s"


def env_lines(results: list[dict[str, Any]]) -> list[str]:
    """One line per distinct environment the results ran in (commit, OpenFOAM, date, PC)."""
    seen: dict[tuple[Any, ...], list[str]] = {}
    for res in results:
        a = res.get("app") or {}
        pc = a.get("pc") or {}
        during = pc.get("wsl_during") or pc.get("wsl_before") or {}
        key = (a.get("commit"), a.get("dirty"), a.get("openfoam"), str((res.get("when") or {}).get("started") or "")[:10] or "undated",
               pc.get("cpus"), (res.get("run") or {}).get("cores_set"))
        load = during.get("load_1min")
        seen.setdefault(key, []).append(f"{res['case']}/{res['variant']}" + (f" (WSL load {load:g} while it solved)" if load is not None else ""))
    out = []
    for (commit, dirty, foam, day, cpus, cores), runs in seen.items():
        c = str(commit or "unknown")[:12] + (" with uncommitted changes" if dirty else "")
        out.append(f"{day}: commit {c}, OpenFOAM {foam or 'unknown'}, {cores} cores of a {cpus}-thread PC: "
                   + ", ".join(runs))
    return out


HEAD = """# Validation

Magnusim's validation set: textbook flows with published answers, set up and solved through
the app itself. Each case is a STEP file imported into a project, given its BCs and fluid,
meshed by the app's mesher and solved by Start, through the same routes the page and the
Assistant use; its numbers are then read from the run's own monitors and from Plot over
path, and compared with the reference values below, each with its citation. Nothing is
tuned per case and no number is typed in: a value here is what the app produced.

**Report-only.** These numbers are what this version computes; no case fails on them yet.
After the first full run the tolerances are locked, and from then on a locked quantity
outside its tolerance fails the run and blocks a release. The bands shown are the proposed
ones (from the reference data). A run fails already when it cannot produce its numbers: a
setup the app refuses, a mesh or solve that fails, wall layers asked and not applied.

The set so far: case 1 (laminar pipe, both meshers). Cases 2 to 6 (turbulent pipe,
lid-driven cavity, backward-facing step, cylinder, sphere) follow; see
`validation/README.md`.

## Running it

WSL with OpenFOAM v2606, as the app's Setup installs it. From `magnusim-web`:

```bash
npm run test:validation                                   # every case and variant (8 cores each), then this report
npm run test:validation -- --case c1 --variant standard --cores 4
npm run test:validation -- --coarse                       # quick coarse runs (results-coarse/, not reported)
npm run validation:report                                 # this file and the public page from the results
npm run validation:report -- --check                      # exit 1 when they are out of date
```

Each run writes `validation/results/<case>/<variant>/plan.json` (every request it sends)
and `result.json` (the values, their sources, the mesh, the run and its health). The
public page is built into `docs/validation/` at the repository's root; it is published
only when GitHub Pages is turned on for `docs/` and the branch is pushed.
"""


def build_markdown(results: list[dict[str, Any]]) -> str:
    out = [HEAD]
    out.append("## Results\n")
    if not results:
        out.append("No results yet.\n")
        return "\n".join(out).rstrip() + "\n"
    out.append("Environment: " + "; ".join(env_lines(results)) + ".\n")
    out.append("| Case | Mesher | Quantity | Reference | Magnusim | Error | Band (report-only) | Cells | Wall layers | Iterations | Solve time | Run health |")
    out.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for res in results:
        case = cases.get(res["case"])
        m = res.get("mesh") or {}
        r = res.get("run") or {}
        for q in res["quantities"]:
            out.append(
                f"| {cell(case.TITLE)} | {case.VARIANT_LABELS.get(res['variant'], res['variant'])} | {cell(q['label'])} | "
                f"{num(q['reference']['value'])} | {num(q['value'], 5)} | {err_text(q)} | {band_text(q)} | "
                f"{cells_text(m.get('n_cells'))} | {cell(layers_text(m))} | {r.get('iterations') if r.get('iterations') is not None else '-'} | "
                f"{run_time_text(res)} | {health_text(r)} |"
            )
    out.append("")
    for cid in dict.fromkeys(res["case"] for res in results):
        case = cases.get(cid)
        mine = [res for res in results if res["case"] == cid]
        out.append(f"## {case.TITLE}\n")
        out.append(mine[0]["setup"]["words"] + "\n")
        for res in mine:
            out.extend(_variant_section(case, res))
        out.append("### References\n")
        for spec in case.QUANTITIES.values():
            ref = spec.reference
            out.append(f"- **{spec.label}**: {num(ref.value)} ({ref.kind}, {ref.confidence}). {ref.citation}; "
                       f"{ref.where}. Conditions: {ref.conditions}.{(' ' + ref.note) if ref.note else ''}")
        out.append("")
        if getattr(case, "NOTES", ()):
            out.append("### Notes\n")
            out.extend(f"- {n}" for n in case.NOTES)
            out.append("")
    return "\n".join(out).rstrip() + "\n"


def _variant_section(case: Any, res: dict[str, Any]) -> list[str]:
    label = case.VARIANT_LABELS.get(res["variant"], res["variant"])
    m = res.get("mesh") or {}
    r = res.get("run") or {}
    q_ = m.get("quality") or {}
    lines = [f"### {label}\n"]
    status = res["status"] + (f": {res['status_detail']}" if res.get("status_detail") else "")
    lines.append(f"- Status: {cell(status)}.")
    if res["setup"].get("mesh_words"):
        lines.append(f"- Mesh settings: {cell(res['setup']['mesh_words'])}.")
    bg = (m.get("background") or {}).get("block")
    first = (m.get("layers") or {}).get("first_m")
    lines.append(
        f"- Mesh: {cells_text(m.get('n_cells'))} cells"
        + (f", background block {bg[0]} × {bg[1]} × {bg[2]}" if bg else "")
        + (f", generated in {num(m.get('generate_s'), 3)} s" if m.get("generate_s") is not None else "")
        + f"; checkMesh {'OK' if q_.get('ok') else 'not OK' if q_.get('known') else 'unknown'}"
        + (f" (max non-orthogonality {num(q_.get('max_non_orthogonality'), 3)}°, max skewness {num(q_.get('max_skewness'), 3)}, "
           f"max aspect ratio {num(q_.get('max_aspect_ratio'), 3)})" if q_.get("known") else "")
        + f"; wall layers {layers_text(m)}"
        + (f", first layer {num(float(first) * 1000, 3)} mm" if first else "")
        + "."
    )
    conv = (f"converged at iteration {r['converged_at']}" if r.get("converged")
            else f"did not reach its residual targets within {r.get('end_time_set')} iterations")
    lines.append(
        f"- Run: {r.get('iterations') if r.get('iterations') is not None else '-'} iterations, {conv}; "
        f"solve {run_time_text(res)} on {r.get('n_procs') or r.get('cores_set') or '-'} ranks (Cores {r.get('cores_set')}); "
        f"run health {health_text(r)}"
        + ("" if not (r.get("health") or {}).get("findings") else ": " + "; ".join(
            cell(f.get("title") or f.get("text") or f.get("message") or f.get("code")) for f in r["health"]["findings"]))
        + "."
    )
    pre = res.get("precheck") or {}
    rows = pre.get("rows") or []
    if rows:
        lines.append("- Pre-run check: " + "; ".join(cell(f"{x.get('level', '')} {x.get('code', '')}: {x.get('text') or x.get('title') or ''}".strip().rstrip(".")) for x in rows) + ".")
    else:
        lines.append("- Pre-run check: nothing found." if pre.get("http_status") == 200 else "- Pre-run check: not recorded.")
    est = (pre.get("estimate") or {}).get("line") if isinstance(pre.get("estimate"), dict) else None
    if est:
        lines.append(f"- Its estimate before Start: {cell(est)}.")
    for q in res["quantities"]:
        val = "no value" if q["value"] is None else f"{num(q['value'], 5)} against {num(q['reference']['value'])} ({err_text(q)}, band {band_text(q)}, {VERDICT_WORDS[q['verdict']]})"
        unc = q.get("uncertainty") or {}
        if q["value"] is not None and unc.get("value") is not None:
            val += f"; ± {num(unc['value'], 2)} % ({unc.get('what') or unc.get('kind')})"
        lines.append(f"- **{cell(q['label'])}**: {val}. How: {cell(q['how'])}. Source: `{q['source']}`."
                     + (f" {cell(q['detail'])}." if q.get("detail") else ""))
    shown = res.get("shown") or {}
    if shown:
        bits = []
        if shown.get("d_eff_mm") is not None:
            bits.append(f"the pipe's cross-section as meshed {num(shown['area_mm2'], 5)} mm² (inlet {num(shown['inlet_area_mm2'], 5)}, "
                        f"outlet {num(shown['outlet_area_mm2'], 5)}; {shown['area_vs_nominal_pct']:+.2f} % against pi D²/4), "
                        f"so D_eff {num(shown['d_eff_mm'], 5)} mm and U_b {num(shown['ub_m_s'], 5)} m/s")
        if shown.get("dpdx_Pa_m") is not None:
            bits.append(f"-dp/dx {num(shown['dpdx_Pa_m'], 5)} Pa/m ({shown['dpdx_vs_nominal_pct']:+.2f} % against 32 mu U / D² = {num(shown['dpdx_exact_nominal_Pa_m'], 4)} Pa/m with the nominal D)")
        if shown.get("inlet_p_Pa") is not None:
            bits.append(f"the inlet's area-averaged pressure {num(shown['inlet_p_Pa'], 4)} Pa (the outlet's 0 Pa)"
                        + (f", flow out against in {num(shown['imbalance_pct'], 2)} %" if shown.get("imbalance_pct") is not None else ""))
        if shown.get("f_darcy") is not None:
            bits.append(f"Darcy f {num(shown['f_darcy'], 4)} at Re_eff {num(shown['re_eff'], 5)}")
        if shown.get("probe_ucl_over_ub") is not None:
            bits.append(f"the centreline probes' mean U_x over x/D 10 to 13 {num(shown['probe_ucl_over_ub'], 5)} U_b (cell values)")
        if shown.get("profile_rms_over_ub") is not None:
            bits.append(f"the profile at x = 12 D within an RMS {num(shown['profile_rms_over_ub'], 3)} U_b of the parabola")
        if bits:
            lines.append("- Shown, not compared: " + "; ".join(bits) + ".")
    for w in res.get("warnings") or []:
        lines.append(f"- Warning: {cell(w)}.")
    lines.append("")
    for fig in figures_of(case, res):
        lines.append(f"![{res['title']}: {fig['caption']}](../../docs/validation/img/{fig['file']})")
    lines.append("")
    return lines


def build_all(*, check: bool = False, root: Path = RESULTS, md_path: Path = REPORT_MD, site_dir: Path = SITE) -> int:
    """Write (or with ``check`` compare) VALIDATION.md, the page, its results.json and figures."""
    results = load_results(root)
    texts: dict[Path, str] = {md_path: build_markdown(results)}
    texts.update({site_dir / name: text for name, text in build_site(results).items()})
    figs = [(cases.get(r["case"]), r, f) for r in results for f in figures_of(cases.get(r["case"]), r)]
    if check:
        stale = []
        for path, text in texts.items():
            have = path.read_text(encoding="utf-8").replace("\r\n", "\n") if path.is_file() else None
            if have != text:
                stale.append(str(path))
        stale += [str(site_dir / "img" / f["file"]) for _, _, f in figs if not (site_dir / "img" / f["file"]).is_file()]
        if stale:
            print("out of date (run npm run validation:report): " + ", ".join(stale), file=sys.stderr)
            return 1
        print(f"validation report up to date ({len(results)} results)")
        return 0
    for path, text in texts.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
    img = site_dir / "img" if site_dir != SITE else SITE_IMG
    for res in results:
        render(cases.get(res["case"]), res, img)
    nojekyll = site_dir.parent / ".nojekyll"
    if not nojekyll.exists():
        nojekyll.write_text("", encoding="utf-8")
    print(f"wrote {md_path} and {site_dir} ({len(results)} results)")
    return 0

