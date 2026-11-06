"""Magnusim's validation set: textbook flows set up, meshed and solved through the app's own
routes, and their numbers compared with published reference values.

``python -m magnusim_validation`` (from ``magnusim-web/validation``) plans a case, evaluates a
run the browser-test driver made, and builds the report; ``README.md`` says how the parts fit.
"""

from __future__ import annotations

SCHEMA_PLAN = "magnusim-validation-plan/1"
SCHEMA_RESULT = "magnusim-validation-result/1"
