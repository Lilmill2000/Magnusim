"""Results package."""

from cfddesk.results.color_scale import ColorScale
from cfddesk.results.loader import ResultMesh, load_case_results, load_foam_case, load_vtu
from cfddesk.results.session import ResultsSession

__all__ = [
    "ColorScale",
    "ResultMesh",
    "ResultsSession",
    "load_case_results",
    "load_foam_case",
    "load_vtu",
]
