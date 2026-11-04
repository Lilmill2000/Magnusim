"""The report's figures, drawn with matplotlib (Agg) from ``result.json`` alone (the one source
of truth), as PNGs in the public page's ``img/`` folder.

One style everywhere: Magnusim's values a solid blue line, the reference a dark dashed line
or open markers, the probes (cell values) orange markers, recessive grid and axes, the
error in a text box. A case module says which figures it has (``FIGURES``) and draws each
(``draw``).
"""

from __future__ import annotations

from pathlib import Path
from types import ModuleType
from typing import Any

# The validated default categorical palette's first two slots (light surface), and ink.
SERIES = "#2a78d6"
SECOND = "#eb6834"
INK = "#0b0b0b"
INK_2 = "#52514e"
GRID = "#d9d8d4"
SURFACE = "#fcfcfb"
DPI = 150


def figure_file(result: dict[str, Any], kind: str) -> str:
    return f"{result['case']}-{result['variant']}-{kind}.png"


def figures_of(case: ModuleType, result: dict[str, Any]) -> list[dict[str, str]]:
    """The figures a result has (``file``, ``caption``), in the case's order."""
    out = []
    for kind, caption in case.FIGURES:
        if case.has_figure(kind, result):
            out.append({"kind": kind, "file": figure_file(result, kind), "caption": caption})
    return out


def style(ax: Any) -> None:
    ax.set_facecolor(SURFACE)
    ax.grid(True, color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(INK_2)
    ax.tick_params(colors=INK_2, labelsize=8)
    ax.xaxis.label.set_color(INK)
    ax.yaxis.label.set_color(INK)
    ax.xaxis.label.set_fontsize(9)
    ax.yaxis.label.set_fontsize(9)


def note(ax: Any, text: str) -> None:
    """A text box with the comparison, in the axes' lower right."""
    ax.text(0.98, 0.04, text, transform=ax.transAxes, ha="right", va="bottom", fontsize=8, color=INK,
            bbox={"boxstyle": "round,pad=0.35", "facecolor": "white", "edgecolor": GRID})


def render(case: ModuleType, result: dict[str, Any], out_dir: Path) -> list[Path]:
    """Draw every figure of ``result`` into ``out_dir``; return the files."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    out_dir.mkdir(parents=True, exist_ok=True)
    files = []
    for fig_doc in figures_of(case, result):
        fig, ax = plt.subplots(figsize=(6.4, 3.6), dpi=DPI)
        fig.patch.set_facecolor(SURFACE)
        style(ax)
        case.draw(fig_doc["kind"], result, ax)
        title = f"{result['title']}: {fig_doc['caption']}"
        ax.set_title(title, fontsize=9, color=INK, loc="left")
        leg = ax.get_legend()
        if leg is not None:
            leg.get_frame().set_edgecolor(GRID)
            for t in leg.get_texts():
                t.set_color(INK)
                t.set_fontsize(8)
        fig.tight_layout()
        path = out_dir / fig_doc["file"]
        # No time stamp in the PNG's metadata: the same result draws the same file.
        fig.savefig(path, dpi=DPI, facecolor=SURFACE, metadata={"Software": None})
        plt.close(fig)
        files.append(path)
    return files
