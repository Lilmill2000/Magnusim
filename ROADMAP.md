# Deferred features

These unfinished controls were removed from the release interface during the
September 2026 readiness audit. This list preserves the intended work.

- **Static structural simulation:** add the analysis definition, material model,
  boundary conditions, mesher/solver integration, and result controls before
  exposing it in the analysis picker.
- **Water preset:** verify the supported incompressible material workflow and
  its unit conversions, then restore the preset in material pickers.
- **Virtual thermocouple:** implement temperature-capable analysis and monitor
  output before restoring the point-data monitor option.
- **Energy (temperature) and passive species:** removed from the study panel in
  Phase 6 (2026-09-24) because no solve path ever read them. To restore: solve
  T and N species as transported scalars (OpenFOAM `scalarTransport` function
  objects work with simpleFoam/pimpleFoam), add inlet temperature/concentration
  and wall thermal type (fixed T, heat flux, adiabatic) to the BC editor, add
  thermal/species diffusivity (Pr, Sc), show T and species as result fields,
  and prove it with a WSL solve. Passive temperature ignores buoyancy; hot air
  rising needs the buoyant solver family, which is a separate, larger feature.

Each restored control should have a persistence check and a successful
end-to-end simulation or result-generation test. Do not expose placeholder
buttons marked “coming soon.”
