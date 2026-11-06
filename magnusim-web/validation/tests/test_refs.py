"""Reference tables (refs/*.csv): each carries its citation, where in the source, the conditions,
its kind and how sure it is, or it is refused; the cavity's tables hold what the reference
data say (Ghia et al.'s two tables with the one correction, the extrema and the vortex)."""

from __future__ import annotations

import pytest
from magnusim_validation.refs import REFS, parse, read

HEAD = """# citation: A. Author (1900), J. 1:1-2
# where: Table 1
# conditions: Re = 100
# kind: numerical
# confidence: SECONDARY
"""


def test_a_table_needs_its_citation_where_conditions_kind_and_confidence():
    t = parse(HEAD + "x,v\n0.5,1.25\n0.75,\n", "t.csv")
    assert t.columns == ("x", "v") and t.column("v") == [1.25, None]
    ref = t.reference(1.25, unit="U")
    assert ref.citation == "A. Author (1900), J. 1:1-2" and ref.where == "Table 1 (validation/refs/t.csv)"
    assert (ref.kind, ref.confidence, ref.conditions, ref.unit) == ("numerical", "SECONDARY", "Re = 100", "U")
    for key in ("citation", "where", "conditions", "kind", "confidence"):
        text = "\n".join(line for line in HEAD.splitlines() if not line.startswith(f"# {key}:")) + "\nx\n1\n"
        with pytest.raises(ValueError, match=key):
            parse(text, "t.csv")
    with pytest.raises(ValueError, match="kind"):
        parse(HEAD.replace("numerical", "guess") + "x\n1\n")
    with pytest.raises(ValueError, match="cells"):
        parse(HEAD + "x,v\n1\n")
    with pytest.raises(KeyError):
        t.column("y")


def test_every_committed_table_reads():
    names = sorted(p.name for p in REFS.glob("*.csv"))
    assert names == ["armaly_1983_fig14_x1.csv", "bfs_re800_scatter.csv", "botella_peyret_1998_extrema.csv",
                     "gartling_1990_re800.csv", "ghia_1982_table1_u.csv", "ghia_1982_table2_v.csv",
                     "marchi_2009_vortex.csv"]
    for name in names:
        assert read(name).rows


def test_the_cavity_tables_hold_the_reference_datas_values():
    u = read("ghia_1982_table1_u.csv")
    v = read("ghia_1982_table2_v.csv")
    assert len(u.rows) == len(v.rows) == 17
    assert u.row(y=0.1719)["u_re1000"] == -0.38289 and u.row(y=0.4531)["u_re100"] == -0.21090
    # The one value the two transcriptions disagree on, as Marchi et al. (2009) quote it.
    assert v.row(x=0.9063)["v_re1000"] == -0.51550
    assert "-0.51550" in v.meta["note"]
    b = read("botella_peyret_1998_extrema.csv")
    assert b.value(re=1000, quantity="v_min") == -0.5270771 and b.row(re=100, quantity="u_min")["at"] == 0.4581
    m = read("marchi_2009_vortex.csv")
    assert m.meta["confidence"] == "CONFIRMED"
    assert m.value(re=100, quantity="psi_min") == -0.1035212 and m.value(re=1000, quantity="vortex_y") == 0.56543
    with pytest.raises(KeyError):
        m.value(re=400, quantity="psi_min")


def test_the_step_tables_hold_the_reference_datas_values():
    a = read("armaly_1983_fig14_x1.csv")
    assert (a.meta["kind"], a.meta["confidence"]) == ("experimental", "CONFIRMED") and "Fig. 14" in a.meta["where"]
    assert len(a.rows) == 10 and a.row(re=100)["x1_over_s"] == 3.00 and a.row(re=804)["x1_over_s"] == 14.19
    g = read("gartling_1990_re800.csv")
    assert (g.meta["kind"], g.meta["confidence"]) == ("numerical", "SECONDARY") and "MFIX-Exa" in g.meta["checked"]
    assert g.row(quantity="lower_reattachment")["x_over_s"] == 12.20 and g.row(quantity="lower_reattachment")["x_over_h"] == 6.10
    assert g.row(quantity="upper_separation")["x_over_s"] == 9.70 and g.row(quantity="upper_reattachment")["x_over_s"] == 20.96
    # Each value in step heights is twice its value in channel heights (S = H/2).
    assert all(r["x_over_s"] == 2 * r["x_over_h"] for r in g.rows)
    s = read("bfs_re800_scatter.csv")
    assert len(s.rows) == 10 and s.meta["confidence"] == "SECONDARY"
    assert (min(s.column("xr_over_s")), max(s.column("xr_over_s"))) == (11.48, 12.20)
    assert s.row(source="Erturk (2008)")["xr_over_s"] == 11.834
