"""``VALIDATION.md`` and the public page (``<repo>/docs/validation/``: ``index.html``, ``img/``
and ``results.json``) from the committed results (``results/<case>/<variant>/result.json``),
with Heat Transfer's own validation set beside them (``heat_transfer.py``: its committed
``bundled-plugins/heat_transfer/validation/results.json``, no new runs).

Both are generated: ``report --check`` exits 1 when either text differs from what the
results give, or a figure is missing (the PNGs themselves are not compared byte for byte:
fonts and the plotting library's version change their pixels, not their content). Nothing
here publishes the page: that is a push, which only the project's owner makes.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from . import cases, heat_transfer
from .paths import REPORT_MD, RESULTS, SITE, SITE_IMG
from .plots import figures_of, render
from .result import read_result
from .site import build_site

VERDICT_WORDS = {"report_only": "report-only", "pass": "pass", "fail": "FAIL", "missing": "no value"}


def load_results(root: Path = RESULTS) -> list[dict[str, Any]]:
    """Every committed result, in the cases' order and each case's variants in its own order
    (Hex-dominant first). A mesh-only run or one whose settings were changed by hand is a probe,
    never a result: it is left out even if it lands here."""
    out = []
    for cid, case in cases.CASES.items():
        case_dir = root / cid
        if not case_dir.is_dir():
            continue
        order = list(case.VARIANTS)
        for vdir in sorted(case_dir.iterdir(), key=lambda p: (order.index(p.name) if p.name in order else 99, p.name)):
            path = vdir / "result.json"
            if path.is_file():
                res = read_result(path)
                if res.get("status") == "mesh_only" or res.get("overrides"):
                    continue
                out.append(res)
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


def _wrap(text: str, width: int = 92) -> str:
    """``text`` broken into lines of at most ``width`` characters (as the rest of the head)."""
    import textwrap

    return "\n".join(textwrap.wrap(text, width=width, break_long_words=False, break_on_hyphens=False))


def cells_text(v: Any) -> str:
    return f"{int(v):,}".replace(",", " ") if isinstance(v, (int, float)) else "-"


def cell(text: Any) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def err_text(q: dict[str, Any]) -> str:
    """The error in its band's own unit: absolute (in the quantity's unit) beside an absolute band
    (the vortex centre's ±0.01 L) or with no relative error (a reference of zero), else in %."""
    err = q.get("error")
    if err is None:
        return "-"
    if err.get("rel_pct") is None or (q.get("tolerance") or {}).get("abs_tol") is not None:
        x = float(err["abs"])
        return f"{'-' if x < 0 else '+'}{num(abs(x), 3)}{(' ' + q['unit']) if q.get('unit') else ''}"
    return f"{err['rel_pct']:+.2f} %"


def band_text(q: dict[str, Any]) -> str:
    tol = q["tolerance"]
    inside = q.get("within")
    mark = "" if inside is None else (" (inside)" if inside else " (outside)")
    if tol.get("abs_tol") is not None:
        return f"±{num(tol['abs_tol'], 3)}{(' ' + q['unit']) if q.get('unit') else ''}{mark}"
    return f"±{num(tol['rel_pct'], 3)} %{mark}"


STATUS_WORDS = {"ok": "ok", "not_settled": "NOT SETTLED", "layers_not_applied": "LAYERS NOT APPLIED"}


def status_text(res: dict[str, Any]) -> str:
    """A run's status for the tables: ``ok``, or what kept it from its numbers."""
    s = str(res.get("status"))
    return STATUS_WORDS.get(s, s.replace("_", " ").upper())


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


def iterations_text(r: dict[str, Any]) -> str:
    """How far a run went: a steady run's iterations; a transient run's time reached (s) and,
    when its status gives them, its time steps."""
    if r.get("transient"):
        t = r.get("sim_time")
        if t is None:
            return "-"
        steps = r.get("time_steps")
        return f"t = {num(t, 4)} s" + (f" ({cells_text(steps)} steps)" if steps else "")
    return str(r.get("iterations")) if r.get("iterations") is not None else "-"


def variant_label(case: Any, res: dict[str, Any]) -> str:
    return str(case.VARIANT_LABELS.get(res["variant"], res["variant"]))


def mesher_label(res: dict[str, Any]) -> str:
    """The run's mesher, as the Mesh panel names it."""
    m = (res.get("mesh") or {}).get("mesher")
    return {"snappy_hexdominant": "Hex-dominant", "standard": "Standard", "cfmesh": "cfMesh"}.get(str(m), str(m or "-"))


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
The tolerances are locked once Daniel has reviewed a full run of the whole set, and from then
on a locked quantity outside its tolerance fails the run and blocks a release. The bands
shown are the proposed ones (from the reference data). A run fails already when it cannot produce its numbers: a
setup the app refuses, a mesh or solve that fails, wall layers asked and not applied.

{so_far}

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


# The cases the design plans after the ones built so far (none: all six are built).
PLANNED = ""


def so_far_text(results: list[dict[str, Any]]) -> str:
    """Which cases and runs the report holds, and which are still to come (from the results
    themselves, so it never names a case without its numbers)."""
    have: dict[str, list[str]] = {}
    for res in results:
        have.setdefault(res["case"], []).append(variant_label(cases.get(res["case"]), res))
    done = [f"{cases.get(cid).TITLE} ({', '.join(labels)})" for cid, labels in have.items()]
    waiting = [cases.get(cid).TITLE for cid in cases.CASES if cid not in have]
    text = "The set so far: " + ("; ".join(done) if done else "no results yet") + "."
    if waiting:
        text += f" Built, its results to come: {'; '.join(waiting)}."
    if PLANNED:
        text += f" Then {PLANNED}; see `validation/README.md`."
    return text + " Heat Transfer's own validation set is reported after them."


def build_markdown(results: list[dict[str, Any]]) -> str:
    out = [HEAD.replace("{so_far}", _wrap(so_far_text(results)))]
    out.append("## Results\n")
    if not results:
        out.append("No results yet.\n")
        return "\n".join(out).rstrip() + "\n"
    out.append("Environment: " + "; ".join(env_lines(results)) + ".\n")
    out.append("| Case | Run | Status | Quantity | Reference | Magnusim | Error | Band (report-only) | Cells | Wall layers | Iterations / time | Solve time | Run health |")
    out.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for res in results:
        case = cases.get(res["case"])
        m = res.get("mesh") or {}
        r = res.get("run") or {}
        for q in res["quantities"]:
            out.append(
                f"| {cell(case.TITLE)} | {cell(variant_label(case, res))} | {status_text(res)} | {cell(q['label'])} | "
                f"{num(q['reference']['value'])} | {num(q['value'], 5)} | {err_text(q)} | {band_text(q)} | "
                f"{cells_text(m.get('n_cells'))} | {cell(layers_text(m))} | {iterations_text(r)} | "
                f"{run_time_text(res)} | {health_text(r)} |"
            )
    out.append("")
    for cid in dict.fromkeys(res["case"] for res in results):
        case = cases.get(cid)
        mine = [res for res in results if res["case"] == cid]
        out.append(f"## {case.TITLE}\n")
        out.append(mine[0]["setup"]["words"] + "\n")
        for res in mine:
            out.extend(_variant_section(case, res, mine[0]))
        out.append("### References\n")
        for spec in case.QUANTITIES.values():
            ref = spec.reference
            out.append(f"- **{spec.label}**: {num(ref.value)} ({ref.kind}, {ref.confidence}). {ref.citation}; "
                       f"{ref.where}. Conditions: {ref.conditions}.{(' ' + ref.note) if ref.note else ''}")
        out.append("")
        notes = case_notes(case, mine)
        if notes:
            out.append("### Notes\n")
            out.extend(f"- {n}" for n in notes)
            out.append("")
    out.extend(heat_transfer.markdown(heat_transfer.load()))
    return "\n".join(out).rstrip() + "\n"


def case_notes(case: Any, results: list[dict[str, Any]]) -> list[str]:
    """A case's notes (the report and the page). A note that quotes its reported runs (their
    cells, values, iterations, times, what the pre-run check said) is a function of those runs
    (``{variant: result}``) and returns None without them: it says what the results here give,
    never figures typed when an earlier run was made. Probe and coarse runs are not results, so
    their figures stay typed, dated."""
    by = {str(r.get("variant")): r for r in results}
    out = []
    for note in getattr(case, "NOTES", ()) or ():
        text = note(by) if callable(note) else note
        if text:
            out.append(str(text))
    return out


def pct_text(x: float) -> str:
    """A per cent difference as the notes give it: one significant digit under 1 %, else two."""
    return num(x, 1 if abs(x) < 1 else 2)


def rel_pct(a: float, b: float) -> float:
    """|a - b| as a per cent of |b|."""
    return 100.0 * abs(float(a) - float(b)) / abs(float(b))


def quantity(res: dict[str, Any] | None, key: str) -> dict[str, Any]:
    """A result's compared quantity ``key`` ({} without it)."""
    return next((q for q in (res or {}).get("quantities") or [] if q.get("key") == key), {})


def variant_facts(case: Any, res: dict[str, Any]) -> list[str]:
    """One run's facts in plain words, one per line (the report and the page): its status, mesh,
    run, pre-run check, what is shown beside the compared values, and its warnings."""
    m = res.get("mesh") or {}
    r = res.get("run") or {}
    q_ = m.get("quality") or {}
    out = []
    status = res["status"] + (f": {res['status_detail']}" if res.get("status_detail") else "")
    out.append(f"Status: {status}")
    if res["setup"].get("mesh_words"):
        out.append(f"Mesh settings: {res['setup']['mesh_words']}")
    if m.get("shared_from"):
        src = case.VARIANT_LABELS.get(m["shared_from"], m["shared_from"])
        out.append(f"Mesh: the same mesh as the {src} run's (the same geometry, fluid, BCs and mesh settings; "
                   "only the study's settings and the run differ)")
    bg = (m.get("background") or {}).get("block")
    first = (m.get("layers") or {}).get("first_m")
    est = ((res.get("setup") or {}).get("mesh") or {}).get("estimate") or {}
    two_d = m.get("two_d") or {}
    out.append(
        f"Mesh: {cells_text(m.get('n_cells'))} cells"
        + (f", one cell across (2D) along {two_d.get('axis')}" if two_d.get("cells_across") == 1 else "")
        + (f" (the plan's estimate about {cells_text(est['n_cells'])})" if est.get("n_cells") else "")
        + (f", background block {bg[0]} × {bg[1]} × {bg[2]}" if bg else "")
        + (f", wall cells {' × '.join(num(v, 3) for v in est['wall_cell_mm'])} mm (x × y × z)" if est.get("wall_cell_mm") else "")
        # A custom size's cells (finer or coarser than the walls' level), so the wall cells are not
        # read as the mesh's size where a custom size sets it.
        + "".join(f", {c.get('name')}'s custom size cells {' × '.join(num(v, 3) for v in c['cell_mm'])} mm (level "
                  f"{c.get('level')})" for c in est.get("custom_sizes") or [] if c.get("cell_mm"))
        + (f", generated in {num(m.get('generate_s'), 3)} s" if m.get("generate_s") is not None else "")
        + f"; checkMesh {'OK' if q_.get('ok') else 'not OK' if q_.get('known') else 'unknown'}"
        + (f" (max non-orthogonality {num(q_.get('max_non_orthogonality'), 3)}°, max skewness {num(q_.get('max_skewness'), 3)}, "
           f"max aspect ratio {num(q_.get('max_aspect_ratio'), 3)})" if q_.get("known") else "")
        + f"; wall layers {layers_text(m)}"
        + (f", first layer {num(float(first) * 1000, 3)} mm" if first else "")
    )
    conv = (f"converged at iteration {r['converged_at']}" if r.get("converged")
            else f"did not reach its residual targets within {r.get('end_time_set')} iterations")
    settle = r.get("settle") or {}
    drifts = [h for h in settle.get("histories") or [] if h.get("drift") is not None]
    if r.get("transient"):
        # A transient run goes for its end time: how far it got in time, and in how many steps.
        steps = r.get("time_steps")
        head = (f"Run: {num(r.get('sim_time'), 4)} s of flow of the {num(r.get('end_time_set'), 4)} s set"
                + (f", {cells_text(steps)} time steps" if steps else ""))
    else:
        head = (f"Run: {r.get('iterations') if r.get('iterations') is not None else '-'} iterations, {conv}"
                + (" (over its last 10 % of iterations: " + ", ".join(
                    str(h["label"]) + " moved " + num(100 * h["drift"], 2) + " %" for h in drifts) + ")"
                   if drifts and not settle.get("converged") else ""))
    out.append(
        head
        + f"; solve {run_time_text(res)} on {r.get('n_procs') or r.get('cores_set') or '-'} ranks (Cores {r.get('cores_set')}); "
        f"run health {health_text(r)}"
        + ("" if not (r.get("health") or {}).get("findings") else ": " + "; ".join(
            str(f.get("title") or f.get("text") or f.get("message") or f.get("code")).strip().rstrip(".")
            for f in r["health"]["findings"]))
    )
    lr = r.get("log_residuals") or {}
    if lr:
        out.append("The solver's last initial residuals: " + ", ".join(f"{k} {num(v, 2)}" for k, v in lr.items()))
    pre = res.get("precheck") or {}
    rows = pre.get("rows") or []
    if rows:
        out.append("Pre-run check: " + "; ".join(
            f"{x.get('level', '')} {x.get('code', '')}: {x.get('text') or x.get('title') or ''}".strip().rstrip(".") for x in rows))
    else:
        out.append("Pre-run check: nothing found" if pre.get("http_status") == 200 else "Pre-run check: not recorded")
    line = (pre.get("estimate") or {}).get("line") if isinstance(pre.get("estimate"), dict) else None
    if line:
        out.append(f"Its estimate before Start: {line}")
    shown = case.shown_words(res) if hasattr(case, "shown_words") else []
    if shown:
        out.append("Shown, not compared: " + "; ".join(shown))
    out.extend(f"Warning: {w}" for w in res.get("warnings") or [])
    return out


def quantity_value_text(q: dict[str, Any]) -> str:
    """A compared quantity's value against its reference, error, band, verdict and uncertainty."""
    if q["value"] is None:
        return "no value"
    val = (f"{num(q['value'], 5)} against {num(q['reference']['value'])} ({err_text(q)}, band {band_text(q)}, "
           f"{VERDICT_WORDS[q['verdict']]})")
    unc = q.get("uncertainty") or {}
    if unc.get("value") is not None:
        val += f"; ± {num(unc['value'], 2)} % ({unc.get('what') or unc.get('kind')})"
    return val


def _variant_section(case: Any, res: dict[str, Any], first: dict[str, Any]) -> list[str]:
    label = variant_label(case, res)
    facts = variant_facts(case, res)
    # The quantities go after the run's facts and before what is shown beside them.
    split = next((i for i, f in enumerate(facts) if f.startswith(("Shown, not compared", "Warning"))), len(facts))
    lines = [f"### {label}\n"]
    if res["setup"]["words"] != first["setup"]["words"]:
        lines.append(f"- Setup: {cell(res['setup']['words'])}")
    lines.extend(f"- {cell(f)}." for f in facts[:split])
    for q in res["quantities"]:
        lines.append(f"- **{cell(q['label'])}**: {quantity_value_text(q)}. How: {cell(q['how'])}. Source: `{q['source']}`."
                     + (f" {cell(q['detail'])}." if q.get("detail") else ""))
    lines.extend(f"- {cell(f)}." for f in facts[split:])
    lines.append("")
    for fig in figures_of(case, res):
        lines.append(f"![{res['title']}: {fig['caption']}](../../docs/validation/img/{fig['file']})")
    lines.append("")
    return lines


def build_all(*, check: bool = False, root: Path = RESULTS, md_path: Path = REPORT_MD, site_dir: Path = SITE) -> int:
    """Write (or with ``check`` compare) VALIDATION.md, the page, its results.json and figures."""
    results = load_results(root)
    texts: dict[Path, str] = {md_path: build_markdown(results)}
    texts.update({site_dir / name: text for name, text in build_site(results, heat_transfer.load()).items()})
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

