"""The Airfoil plugin's own code: section geometry, study settings and the engines.

Standard library only, except :mod:`airfoil.neural` (NeuralFoil, imported when a
polar is asked for). Everything here runs in the plugin's own environment (its
service and its jobs); ``plugin.py`` runs in the core and imports none of it.
"""

from __future__ import annotations

# SPDX-License-Identifier: GPL-3.0-or-later
