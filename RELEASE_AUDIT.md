# Magnusim release audit — 17 September 2026

This records the local code changes and verification performed before the first
public release. Changes are in the working tree; this audit did not publish,
push, or commit the project. Pre-existing migration work was preserved.

## Bugs and release problems addressed

- Project hydration no longer deletes records as a side effect of reading them.
  Study ownership, stale folder paths, legacy adoption, and run selection now
  respect the geometry/study directory layout.
- Creating a new run persists its selection. Completing a run writes back to
  its owning study. A stop request from another project cannot stop that run.
- Result attachment now includes the study ID required by the server. Waiting
  for a browser paint cannot indefinitely block background-tab result loading.
- Transient solves preserve intermediate frames when copying from WSL; parallel
  transient reconstruction includes all saved times. Copy/reconstruction errors
  are no longer silently reported as successful result transfer.
- Native solved fields take precedence over a mesh-only prepared VTU snapshot.
  The volume cache version changed so old cached volumes cannot mask that fix.
- The React tree again exposes graphs, screenshots, and recordings. The tree
  distinguishes No-slip from Slip, and boundary-condition picker labels refresh
  from saved settings. Legacy boundary-condition type names are normalized.
- UTF-8 worker I/O fixes a reproducible Windows encoding crash. Missing Python
  executables and worker startup failures reject requests instead of hanging.
- Terminal event streams close and detach listeners; client event history and
  solver log tails are bounded.
- Request size limits, JSON validation, same-origin checks, canonical project
  containment, and plugin/media file containment were added or tightened.
  Traversal through a directory link is covered by a regression test.
- Unicode media filenames and HTTP byte ranges work; malformed project IDs
  cannot silently target the currently active project.
- Production preview now installs the API middleware. Setup scripts use the
  correct Node/Python requirements, WSL variable expansion, and OpenFOAM probe.
  Python wheels include the WSL templates.
- Known npm dependency findings and vulnerable Python packaging tools were
  updated. Setup/build requirements retain the patched packaging minimums.
- Portable packaging refuses a dirty working tree instead of silently exporting
  an old HEAD. Generated build artifacts, test projects, credentials, and local
  evidence are excluded from normal source staging.

## Removed interface placeholders

Static structural analysis, the unfinished Water preset, and virtual
thermocouple controls were removed. Their restoration criteria are recorded in
[ROADMAP.md](ROADMAP.md). Unreachable old geometry-role and boundary-condition
modals were removed; the functioning boundary-condition picker remains.

## Verification

- 249 Python tests passed (one WSL-marked test deselected); Ruff passed and mypy
  reported no issues in 111 source files.
- Node API, traversal, media, worker-failure, project isolation, and run-selection
  regression tests: 24 passed; TypeScript checks for all three configurations.
- 13 React/store unit tests, generated registry consistency, and three OpenFOAM
  case-writer golden comparisons.
- Production Vite build and ordinary local Playwright smoke tests.
- Real WSL/OpenFOAM workflow: 24,390-cell mesh, simpleFoam steady solve,
  pimpleFoam transient solve, residuals, intermediate saved fields, and opening
  results in the browser. The transient assertion requires two output frames.
- Browser result workflow: nonempty streamlines from native solved velocity,
  screenshot saved and reopened with nonzero image
  dimensions, graph CSV and PNG downloads, and a recording saved to its gallery.
- Manual local UI: setup wizard, folders/projects, geometry import, study
  creation, Air assignment, boundary-condition creation, reload persistence,
  viewport fit, cutting-plane creation/orientation, comparison and synchronized
  filters, and animation play/pause.
- npm audit and pip-audit against the installed Python environment reported no
  known vulnerabilities after remediation. pip check passed. A wheel was built
  and its solver templates inspected.

Automated tests are in the repository. Disposable local evidence is under
`magnusim-web/.cache/` and Playwright's ignored output directories. The isolated UI
project is under `magnusim-web/.cache/audit-projects/`; normal user projects were not
used as destructive test fixtures.

## Publication boundaries and remaining checks

- The source license is Apache-2.0. Gmsh/OpenFOAM and other dependencies retain
  their licenses. **A bundle containing those dependencies is a separate
  distribution decision**, described in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
  Relicensing a single mesher adapter does not settle combined-work obligations.
- High-confidence credential-pattern scans found no hits in scanned working
  text files or Git-history blobs. This does not certify binary files or
  unknown secret formats. Old history still contains personal filesystem paths
  and the deployment hostname; removing files from today's tree does not erase
  those historical versions. No history rewrite was performed.
- The API has no built-in authentication and controls local files/processes.
  Keep the default loopback binding, or use an authenticated trusted proxy as
  documented in [SECURITY.md](SECURITY.md). Public deployment authentication and
  the remote GitHub repository were not verified from this environment.
- Fresh-machine Windows setup and hosted Linux CI still need to run after the
  release changes are committed. Local tests used the installed Windows/WSL
  toolchain. The real solve checks used serial execution, not an exhaustive
  parallel/multi-machine matrix.
- ESLint has no errors but retains 2,746 legacy warnings; Vite reports a
  large runtime chunk. Those are maintenance/performance debt, not hidden by
  disabling the audited runtime from linting.
- This is regression and workflow verification, not a claim that every possible
  geometry, mesher, browser, button-state combination, or numerical method has
  been validated. Engineering accuracy needs benchmark cases and convergence
  studies beyond these successful smoke solves.

The frozen hexcore reference directory was left untouched.
