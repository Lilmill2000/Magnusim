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

Each restored control should have a persistence check and a successful
end-to-end simulation or result-generation test. Do not expose placeholder
buttons marked “coming soon.”
