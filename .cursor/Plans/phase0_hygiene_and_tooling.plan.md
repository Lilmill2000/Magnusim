---
name: "Phase 0: Hygiene and Tooling"
overview: "Put the repo under version control, remove the duplicate CFD-Desk tree, add Python and JS test/lint tooling, lock dependencies, add golden-file tests around the two case writers and project migrations, and add a Playwright smoke test. Zero behavior change; every later phase depends on the safety net built here."
todos:
  - id: p0-git-init
    content: "Init git at repo root, commit baseline, verify .gitignore excludes node_modules/.venv/projects/.cache"
    status: pending
  - id: p0-remove-cfd-desk
    content: "Delete CFD-Desk/ and rewrite pack-portable.ps1 to build a zip from git archive"
    status: pending
  - id: p0-python-tooling
    content: "Add pytest/ruff/mypy config to python/pyproject.toml; create python/tests/; move the two existing unittest files"
    status: pending
  - id: p0-golden-writer-tests
    content: "Golden-file tests for cfddesk/case/writer.py (steady, AmgX, transient placeholder) and ras.py fields"
    status: pending
  - id: p0-migration-tests
    content: "Fixture-based tests for Project.from_dict migrations v5..v13 and fingerprint stability"
    status: pending
  - id: p0-js-tooling
    content: "ESLint flat config + tsconfig.json (checkJs) on scripts/ and src/; npm scripts lint/typecheck"
    status: pending
  - id: p0-playwright
    content: "playwright.config.js + one smoke spec (home -> open sample -> mesh form -> Generate at fineness 1 -> n_cells > 0)"
    status: pending
  - id: p0-lockfiles
    content: "requirements.lock via pip-compile; record OpenFOAM/cfMesh versions in .cfddesk-local.json; verify on start"
    status: pending
  - id: p0-jsonl-logging
    content: "scripts/log.js JSONL logger keyed by job id; wire into w21 and w27 spawn handlers"
    status: pending
  - id: p0-ci
    content: "GitHub Actions workflow: ruff + mypy + pytest (unit subset) + eslint + tsc on push"
    status: pending
isProject: false
---

# Phase 0: Hygiene and Tooling

## Goal

Make the codebase safe to refactor. Nothing in this phase changes runtime behavior. When it is done: the tree is in git, there is one copy of every file, `pytest` and `npm run lint` pass, golden files pin the exact OpenFOAM dictionaries the app writes today, and a Playwright smoke test proves Generate still produces a mesh.

## Findings this phase is built on

- **No `.git` directory exists** at `c:\Users\drmil\Desktop\Code\CFD`. The root README says "clone the GitHub repo" but the working tree is not a repo. `.gitignore` exists and already excludes `CFD-Desk/`, `cfd-web/node_modules/`, `cfd-web/python/.venv/`, `cfd-web/.cache/`, `cfd-web/projects/`, `cfd-web/.cfddesk-local.json`, `cfd-web/.cfddesk-ready`, `cfd-web/dist/`.
- **`CFD-Desk/`** is a source-only copy (~140 files) produced by `pack-portable.ps1` via two robocopy passes. It duplicates `cfd-web/scripts`, `src`, `python`, `setup`. Any fix must be made twice or re-packed.
- **Tests:** only `cfd-web/python/cfddesk/cad/test_compound.py` and `cfd-web/python/cfddesk/mesh/test_web_refinements.py` (both `unittest`), plus one frozen test in the HEXCORE backup. No pytest config, no JS tests, no `playwright.config.*` (Playwright is only a devDependency), no ESLint, no tsconfig, no CI.
- **Two case writers exist:** `cfd-web/python/cfddesk/case/writer.py` (`write_simplefoam_case`, L1050; AmgX/CPU, project-driven) and inline JS in `cfd-web/scripts/w27-solve.js` (`writeSolveCase` L1156-1618, `foamHeader` L667, `writeVolField` L683) plus `cfd-web/scripts/w30-transient.js` (`transientControlDict` L246, `transientFvSchemes` L274, `transientFvSolution` L300). The UI uses the JS one. Golden files must be captured for **both** so Phase 1 can prove equivalence.
- `python/pyproject.toml` has only `[build-system]`, `[project]` (deps: cadquery-ocp, pyvista, psutil, gmsh), `[tool.setuptools.packages.find]`.
- `.cfddesk-local.json` on this machine has only wizard keys (`hardware`, `units`, `length_unit`, `port`, `wizard_completed`); Setup intends to also write `wsl_distro`, `wsl_case_root`, `wsl_user`, `cartesianMesh`, `setup_completed`.
- AmgX is code-only (`writer.py` `write_run_amgx_sh`, expects `$HOME/cfd/builds/amgx-install`); Setup never installs it. Live UI solves use CPU GAMG via `openfoam2606`.

## Step 1: Version control

1. `git init` at `c:\Users\drmil\Desktop\Code\CFD`. Confirm `.gitignore` covers the paths above; add `cfd-web/python/**/__pycache__/`, `cfd-web/python/cfddesk.egg-info/`, `cfd-web/.cache/`, `*.pyc`, `test-results/`, `playwright-report/`.
2. Verify with `git status --short | wc -l` that no `.venv`, `node_modules`, project data, or `.cache` files are staged.
3. First commit: "Baseline before refactor". Tag `v0-baseline`.
4. Optional: create remote (the user has a GitHub MCP available; only if asked).

## Step 2: Remove `CFD-Desk/` and rewrite `pack-portable.ps1`

1. Delete `c:\Users\drmil\Desktop\Code\CFD\CFD-Desk\` entirely (it is regenerable and is already in `.gitignore`).
2. Rewrite `pack-portable.ps1`:
   - `git archive --format=zip -o dist/CFD-Desk-<shortsha>.zip HEAD` from repo root.
   - Post-process: the archive already excludes ignored paths. Add `START-HERE.txt` by keeping it in-tree at `cfd-web/START-HERE.txt` (move the text that `pack-portable.ps1` currently writes inline into a real file).
   - Print the zip path and size.
3. Update root `README.md` "Sharing / GitHub" section to say: run `pack-portable.ps1`, share the zip in `dist/`.
4. Search for any code path referencing `CFD-Desk` (README, START-HERE) and update.

## Step 3: Python tooling

Edit `cfd-web/python/pyproject.toml`:

```toml
[project.optional-dependencies]
dev = ["pytest>=8", "pytest-cov", "ruff>=0.5", "mypy>=1.10", "pip-tools", "hypothesis"]

[tool.pytest.ini_options]
testpaths = ["tests"]
markers = [
  "wsl: needs WSL + OpenFOAM (deselect with -m 'not wsl')",
  "occt: needs cadquery-ocp and a STEP fixture",
  "slow: > 10 s",
]
addopts = "-m 'not wsl'"

[tool.ruff]
line-length = 100
target-version = "py310"
[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP", "N", "W"]
ignore = ["E501"]

[tool.mypy]
python_version = "3.10"
ignore_missing_imports = true   # OCP, gmsh, pyvista have no stubs
check_untyped_defs = true
warn_unused_ignores = true
```

Layout to create:

```
cfd-web/python/tests/
  conftest.py              # fixtures: tmp_case_dir, sample_project_dict(version), elbow_step_path
  fixtures/
    projects/v5.json v6.json v7.json ... v13.json   # captured real project.json snapshots
    golden/
      steady_cpu/{controlDict,fvSchemes,fvSolution,transportProperties,turbulenceProperties,U,p,k,omega,nut}
      steady_amgx/...
      js_steady/...        # captured from current w27-solve.js writeSolveCase output
      js_transient/...     # captured from w30-transient.js
  unit/
    test_compound.py                 # moved from cfddesk/cad/
    test_web_refinements.py          # moved from cfddesk/mesh/
    test_case_writer_golden.py
    test_ras_fields.py
    test_project_migrations.py
    test_fingerprints.py
    test_mesh_sizing.py
    test_bc_registry.py
    test_units.py
  wsl/
    test_smoke_simplefoam.py         # @pytest.mark.wsl
```

Move the two existing unittest files (keep `unittest` style or convert; pytest runs both). Fix their imports (they currently import via package path so `pip install -e .` keeps them working).

Run `ruff check cfddesk tools tests --fix` once; commit formatting separately from logic. Run `mypy cfddesk` and add `# type: ignore[...]` only where OCP/gmsh types are opaque; do not loosen config to make it pass.

## Step 4: Golden-file tests for the case writers

### 4a. Python writer (`cfddesk/case/writer.py`)

`tests/unit/test_case_writer_golden.py`:

- Build a `Project` from `fixtures/projects/v13.json` (sample steady project) with `Project.from_dict`.
- Call `write_simplefoam_case(tmp_case, amgx_json=fixture, default_backend="cpu", project=project, solid=None)`; note `solid=None` requires inlet normals fall back; if that is a hard requirement, load `fixtures/elbow.step` via `load_step` and mark `@pytest.mark.occt`.
- Compare every produced file against `fixtures/golden/steady_cpu/*` after normalizing: strip the `// * * *` banner lines and any timestamp/absolute-path lines. Provide `--update-golden` via an env var `CFDDESK_UPDATE_GOLDEN=1` in `conftest.py`.
- Repeat with `default_backend="amgx"` -> `steady_amgx/`.
- Test `assert_guardrails(tmp_case)` returns a `GuardrailReport` with `amgx_on_p` matching backend.

### 4b. JS writer (`scripts/w27-solve.js`, `w30-transient.js`) captured as golden

Phase 1 will delete this writer; these goldens are the contract it must match.

- Add `cfd-web/scripts/__tests__/capture-js-case.mjs` (node script, dev-only) that imports `writeSolveCase` from `w27-solve.js` with a stubbed project directory (copy `projects/sample-project-steady-state-*` minus mesh/runs into `tests/fixtures/js-project/`), calls it with a fixed `runId`, `nProcs=1`, steady `endTime=200 writeInterval=50`, and copies the produced `system/`, `constant/`, `0/` into `python/tests/fixtures/golden/js_steady/`.
- Same with a transient control (`w30-transient.js` `TRANSIENT_DEFAULTS`) -> `js_transient/`.
- Commit these goldens. Phase 1 test: Python transient writer output == `js_transient/` (normalized).

Important caveat: `writeSolveCase` needs `boundary_conditions.json`, `materials.json`, `mesh.json`, `runs/catalog.json`, `geometry/cad_preview.json`, and `projects/active.json`. The capture script must set `process.env` or write a temp `projects/` root; `w27-solve.js` computes `PROJECTS_ROOT` from `__dirname`, so the capture script should copy the fixture into a temp dir and temporarily point the module at it (add an optional `CFDDESK_PROJECTS_ROOT` env override in `w27-solve.js` L~30 and every other `PROJECTS_ROOT` definition: `w16`, `w17`, `w18`, `w19`, `w20`, `w21`, `w22`, `w26`, `w28`, `vite-plugin-case-fields.js`). This env override is also required by Phase 3 and the Playwright test, so add it now.

### 4c. RAS fields

`test_ras_fields.py`: `write_ras_fields(tmp, "kOmegaSST", U_ref=10, intensity_pct=5)` writes `k`, `omega`, `nut` and no `epsilon`; `"kEpsilon"` writes `epsilon` not `omega`; `"laminar"` removes all. Check per-semantic patch blocks for inlet/outlet/wall/symmetry using `_ras_boundary_blocks`.

## Step 5: Migration and fingerprint tests

- Capture one real `project.json` at each schema version. The sample projects on disk are v13; produce older ones by hand-editing minimal documents per the migration docstring in `model.py` L1-25 (v7 pressure Pa, v8 nested BC, v9 quantized location, v10 block_aabb, v11 name_is_custom, v12 numerics seed, v13 fineness/mesh ids).
- `test_project_migrations.py`: for each fixture `Project.from_dict(doc)`; assert `version == 13`; assert invariants listed in the docstring (e.g. v7: pressures in Pa; v10: stored mesh fingerprint is **not** re-stamped; v12: `numerics` seeded).
- `test_fingerprints.py`: `mesh_input_fingerprint(project)` is stable across `to_dict -> from_dict`; changes when `hex_element_core` flips; does not change when `location_in_mesh` moves by < 1 nm (`LOCATION_FINGERPRINT_QUANTUM_M`).
- `test_mesh_sizing.py`: `standard_surface_size_m(0.032, 5) == pytest.approx(0.240e-3)` and the F-scaling `h(F) = h5 * 2**((5-F)/3)`; `clamp_fineness`.
- `test_bc_registry.py`: every key in `BC_TYPES` has `patch_type_for`, `default_settings` round-trips through its `settings_schema`; `bc_menu.legacy_from_nested(nested_from_legacy(k)) == k` for every supported key.
- `test_units.py`: `to_si/from_si` round trip for every `(quantity, unit)` in `UNITS`; `pa_to_kinematic(kinematic_to_pa(x, rho), rho) == x`.

## Step 6: JS tooling

Files to add in `cfd-web/`:

- `eslint.config.js` (flat config): `@eslint/js` recommended, `globals.browser` for `src/**`, `globals.node` for `scripts/**`, rules: `no-unused-vars: warn`, `no-undef: error`, `eqeqeq: warn`. Expect hundreds of warnings in `main.js`; set `--max-warnings` high initially and ratchet down per phase.
- `tsconfig.json`: `"allowJs": true, "checkJs": true, "noEmit": true, "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "strict": false, "include": ["scripts/**/*.js"]`. Only `scripts/` first; `src/main.js` will produce too many errors until Phase 4 splits it. Add `// @ts-check` to each `scripts/*.js` as it passes.
- `package.json` scripts: `"lint": "eslint scripts src"`, `"typecheck": "tsc -p tsconfig.json"`, `"test:e2e": "playwright test"`, `"test": "npm run lint && npm run typecheck && npm run test:e2e"`.
- devDependencies: `eslint`, `@eslint/js`, `globals`, `typescript`, `@types/node`.

## Step 7: Playwright smoke

- `cfd-web/playwright.config.js`: `webServer: { command: "npm run dev", url: "http://127.0.0.1:8082", reuseExistingServer: true, timeout: 120_000 }`, `use: { baseURL, headless: true }`, `timeout: 900_000` for the mesh test.
- `cfd-web/e2e/smoke.spec.js`:
  1. `GET /api/projects` returns JSON with the sample project id (find by title prefix `sample-project-steady-state`).
  2. Navigate to `/#/project/<id>` (route format from `dashboard.js` `parseHomeRoute`); assert `#app.workbench` visible and `#left-tree` contains a Mesh item.
  3. Open mesh form via `openTreeDetail` equivalent (click the tree item whose text matches `Mesh 1`); set fineness `#mesh-fineness` (confirm id from `index.html` L520-622) to 1; click Generate.
  4. Poll `GET /api/case` until `status` in `done|failed`; assert `done` and `n_cells > 0`. Mark this test `@wsl` via `test.describe.configure` + `process.env.CFDDESK_E2E_WSL === "1"` skip guard so CI without WSL runs only steps 1-3.
- Use the `CFDDESK_PROJECTS_ROOT` override (Step 4b) so the test runs against a copied fixture project, not the user's live projects.

## Step 8: Lockfiles and version pinning

- `pip-compile pyproject.toml --extra dev -o requirements.lock` in `cfd-web/python/`. `setup/Setup.ps1` step 5 changes from `pip install -e .` to `pip install -r requirements.lock && pip install -e . --no-deps`.
- `npm ci` in Setup instead of `npm install` (lockfile already exists).
- Record tool versions: extend `setup/wsl-bootstrap.sh` JSON output with `openfoam_version` (parse `openfoam2606 bash -c 'foamVersion'` or the apt package version) and `cfmesh_version`. `Setup.ps1` `Write-LocalConfig` persists them. `scripts/wsl-env.js` gains `verifyWslToolchain()` that runs once at Vite startup (called from `vite.config.js`) and logs a warning if `.cfddesk-local.json` lacks them or `wsl -d <distro> -- openfoam2606 bash -c 'foamVersion'` disagrees.

## Step 9: Structured logging

- `cfd-web/scripts/log.js`: `createJobLogger(kind, jobId)` -> appends `{ts, kind, job_id, level, msg, ...fields}` to `.cache/logs/<kind>/<jobId>.jsonl`; `log.info/warn/error`. Also mirrors to console at `warn+`.
- Wire into `w21-mesh-generate.js` (spawn stdout/stderr handlers around L763 and the snappy path L1103) and `w27-solve.js` (`startSolve` L2258, `applyProgressLine` L87). Keep the existing `log_excerpt` fields; add `log_jsonl_path` to the run/mesh record.
- `.cache/logs/` is inside `.cache/` so already ignored and "safe to delete".

## Step 10: CI

`.github/workflows/ci.yml`:

- Job `python`: ubuntu, setup-python 3.12, `pip install -r cfd-web/python/requirements.lock -e cfd-web/python`, `ruff check`, `mypy cfddesk`, `pytest -m "not wsl and not occt"`. OCCT wheels are large; run `occt` marker in a separate optional job with caching.
- Job `node`: `npm ci`, `npm run lint`, `npm run typecheck`, `npx playwright install --with-deps chromium`, `npx playwright test --grep-invert @wsl`.

## Acceptance criteria

- `git log` shows baseline tag; `git status` clean after `npm run dev` start/stop (caches ignored).
- `CFD-Desk/` gone; `pack-portable.ps1` produces `dist/CFD-Desk-<sha>.zip` that unzips to a tree with `Setup.bat`, `start.bat`, `cfd-web/`.
- `pytest` (default marker filter) passes; golden files exist for `steady_cpu`, `steady_amgx`, `js_steady`, `js_transient`.
- `npm run lint` and `npm run typecheck` exit 0 (warnings allowed, errors not).
- Playwright steps 1-3 pass everywhere; step 4 passes locally with WSL.
- Generate Mesh from the UI on the sample project still produces the same cell count as before Phase 0 (record it: sample steady project, F=5, expected from `mesh.json` `live_mesh_result.n_cells`).

## Out of scope

No refactor of `main.js`, no changes to the OpenFOAM dictionaries, no new dependencies in production code.
