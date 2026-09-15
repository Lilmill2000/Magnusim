---
name: "Phase 3: Node Shim and Python Worker"
overview: "Reduce the Node layer to routing, static serving, and process supervision. Replace the if-chain router in vite-plugin-case-fields.js with a route table, add a long-lived Python JSON-RPC worker for reads/mutations/CAD, expose GET /api/registry/*, make result-filter and mesh/solve endpoints generic over the Phase 2 registries, and serve plugin UI bundles."
todos:
  - id: p3-route-table
    content: "scripts/api/router.js route table + scripts/api/routes/*.js; migrate all routes; delete the if-chain"
    status: pending
  - id: p3-worker
    content: "cfddesk/worker/: JSON-RPC over stdio server with method registry; scripts/py-worker.js client with restart + timeout"
    status: pending
  - id: p3-project-rpc
    content: "Project read/mutate RPC methods replacing project_cli.py subprocess calls; w16..w22,w26 handlers call worker"
    status: pending
  - id: p3-registry-api
    content: "GET /api/registry, /api/registry/:kind, /api/registry/:kind/:key -> worker registry.describe"
    status: pending
  - id: p3-generic-filter
    content: "GET /api/filter/:key (+/meta) generic over ResultFilterSpec with unified cache; legacy paths become aliases"
    status: pending
  - id: p3-generic-jobs
    content: "POST /api/jobs {kind, params}; GET /api/jobs/:id; SSE /api/jobs/:id/events; mesh + solve use it"
    status: pending
  - id: p3-cad-in-worker
    content: "CAD preview, STL, thumbnails via worker holding OCCT shapes in memory (LRU by project)"
    status: pending
  - id: p3-plugin-static
    content: "Serve /plugins/:key/ui/* from plugin ui/ directories; /api/plugins lists manifests + missing requirements"
    status: pending
  - id: p3-typescript-scripts
    content: "Convert scripts/ to TypeScript (tsx runtime or vite-node); strict on new files"
    status: pending
  - id: p3-tests
    content: "Route table unit tests (supertest-like via node:http), worker RPC tests, e2e unchanged"
    status: pending
isProject: false
---

# Phase 3: Node Shim and Python Worker

## Goal

Node knows nothing about CFD. It maps HTTP to worker RPC calls or job spawns, streams events, serves files. Adding a plugin adds routes automatically because routes are derived from registries.

## Findings this phase is built on

### Router today

`cfd-web/scripts/vite-plugin-case-fields.js` (2250 lines) middleware L1583-2247 is an ordered `if (parts[0]==='api' && parts[1]===...)` chain: case attach/status/detach (L1599-1660), mesh-surface (L1666), mesh-section (L1702), mesh generate (L1742), then delegates `handlePrefsApi`, `handleW28Api`, `handleW27Api`, `handleW22Api`, `handleW26Api`, `handleW20Api`, `handleW19Api`, `handleW18Api`, `handleW17Api`, `handleW16Api`, then GET-only exporters: times (L1900), inspect (L1924), iso-volume (L1970), cut-plane (L2011), iso-surface (L2044), plot-over-path (L2086), particle-trace faces/trace (L2116-2166), fields (L2169-2233). Each delegate returns `false` when unmatched. Aliases with underscores (`simulation_control`, `result_controls`, `area_average`, `mesh_refinements`) are matched inline. Per-handler response headers `X-CFD-Increment`, `X-CFD-Path-Kind`, `X-CFD-Case-Dir`, `X-CFD-Job-Pid`, `X-CFD-Source`.

Shared helpers: `sendJson` L388, `readJsonBody` L181, `resolveCaseDir` L116 (query `case=` or `activeCaseState.case_dir`, project isolation gate via `project-isolation.js`), `caseSnapshot` L198, `applyKickUpdate` L250, module state `activeCaseState` L76.

Cache scheme: `.cache/<kind>/<key>` with `.stamp` = `foamStamp` (field file mtime/size + `polyMesh/points` + `.cfddesk-prepared.vtu` + `exporterStamp()` = sha1 of `python/tools/*.py` names+mtime+size). `mesh-section`/`mesh-surface` are existence-only.

### Python spawn points (all `spawn`/`spawnSync` per request)

Exporters L455, 813, 901, 997, 1075, 1205, 1285, 1506, 1533; `w16` CAD tools L552-1221 (`convert_step_to_stl.py`, `export_step_cad_preview.py`, `render_geometry_thumb.py`, `normalize_cad_import.py`, `compound_step_parts.py`); `w21` L400, 763; `w27` L405. After Phase 1/2 also `prepare_run.py`, `run_solve.py`, `generate_snappy.py`, `project_cli.py`, `registry_dump.py`. Venv startup + OCP import per call is 1-3 s; CAD preview reloads the STEP each time.

### Env

`python-env.js`: `CFDDESK_PYTHON` -> `python/.venv/Scripts/python.exe` -> `python`. `wsl-env.js`: distro/case root from env -> `.cfddesk-local.json` -> probe. `prefs.js` `listenPort()` default 8082; `w32-prefs.js` handles `/api/prefs`. `hardware-profile.js` writes `hardware{n_procs,...}`.

`vite.config.js`: single plugin, `strictPort`, watch ignores `python/`, `projects/`, `.cache/`.

## Target layout

```
cfd-web/scripts/
  server/
    index.ts              # createApiPlugin(): Vite plugin; builds Router, Worker, JobManager
    router.ts             # Route {method, pattern, handler}; match(); param parsing; aliases
    http.ts               # sendJson, sendFile(range), readJsonBody, errors -> {error, detail, status}
    worker.ts             # PyWorker: spawn python -m cfddesk.worker; JSON-RPC; queue; restart; timeout
    jobs.ts               # JobManager: spawn tools via job-runner; event bus; SSE fanout; persistence of job records
    cache.ts              # stamp-based cache from vite-plugin (foamStamp, exporterStamp) generalized by ResultFilterSpec.cache_scope
    routes/
      projects.ts geometry.ts simulation.ts materials.ts bcs.ts mesh.ts refinements.ts
      result_controls.ts runs.ts media.ts prefs.ts registry.ts filters.ts jobs.ts plugins.ts case.ts
    legacy-aliases.ts     # maps old paths (/api/fields/:f, /api/cut-plane, /api/mesh/generate, /api/run/start ...) to new handlers
  python-env.ts wsl-env.ts prefs.ts hardware-profile.ts log.ts
cfd-web/python/cfddesk/worker/
  __init__.py  server.py (loop, dispatch, errors)  methods/ (project.py registry.py cad.py results.py jobs.py)
  protocol.py  # Request{id, method, params} Response{id, result|error{code,message,data}}; Notification for progress
```

## Step 1: Route table

`router.ts`:

```ts
type Handler = (ctx: Ctx) => Promise<void>;
interface Route { method: "GET"|"POST"|"DELETE"|"HEAD"; pattern: string; handler: Handler; legacy?: boolean }
interface Ctx { req; res; url: URL; params: Record<string,string>; query: URLSearchParams; body(): Promise<any>; json(status, obj); file(path, opts); worker: PyWorker; jobs: JobManager }
```

- Pattern syntax `/api/projects/:id`, trailing `*` for static.
- Underscore aliases handled once: normalize `_` to `-` in path segments before matching.
- Every current route is re-registered under a `routes/*.ts` module with identical request/response shape. Order-sensitivity disappears; conflicts fail fast at startup (duplicate `method+pattern` throws).
- Response headers `X-CFD-*` preserved by a small `legacyHeaders(ctx, snapshot)` helper used only by legacy aliases.
- `vite-plugin-case-fields.js` shrinks to `export default createApiPlugin` re-export, then is deleted once `vite.config.js` imports `scripts/server/index.ts`.

Unit test: `scripts/server/__tests__/router.test.ts` with `node:test` — matches, params, aliases, 405 vs 404.

## Step 2: Python worker

`cfddesk/worker/server.py`:

- Reads newline-delimited JSON-RPC 2.0 from stdin, writes responses to stdout; logs to stderr. Single-threaded event loop with a small thread pool for CAD ops (OCCT is not thread-safe per shape; keep one shape per project, serialize per-project).
- Method registry decorator `@rpc("project.get")`. Methods are pure functions over `cfddesk` (`Project.load`, `web_adapter`, `registry.describe`, `cad.step.load_step`, `results.loader`).
- `load_all()` (registries + plugins) on startup; `registry.reload` method for dev.
- Health: `worker.ping` -> `{pid, uptime, plugins, python}`.
- Long ops (mesh, solve, exports) are **not** in the worker; they remain separate processes via `JobManager` so a crash cannot take down the worker, and so they can be killed.

`worker.ts`:

- Spawn `PYTHON -m cfddesk.worker` at plugin start; `call(method, params, {timeoutMs=30000})` returns a promise; ids monotonic; pending map; on `exit` reject all pending and respawn with backoff (max 3 in 60 s, then 503 on `/api/*`).
- Notifications (`method: "progress"` without id) go to `JobManager` event bus (used by CAD import progress).

## Step 3: Project RPC methods (replace `project_cli.py`)

Methods: `project.list`, `project.get {id}`, `project.create`, `project.update`, `project.delete`, `project.move`, `folders.list/create`, `project.open` (active.json), `sim.list/create/update/activate/delete/copy`, `materials.get/set`, `bcs.get/set`, `mesh.get/set/delete`, `refinements.get/set`, `result_controls.get/set`, `sim_control.get/set`, `runs.list/create/update/delete/rename/activate`, `mesh.result.persist`. Each wraps Phase 1/2 `web_adapter` + `Project.save` and returns the same response document the JS handler returned (compat documented per method in a table in `routes/*.ts` header comments).

`tools/project_cli.py` becomes a thin CLI over the same functions (kept for scripting/tests).

Node handlers in `routes/*.ts` become 3-10 lines each: parse, `await ctx.worker.call(...)`, `ctx.json(200, result)`. `w16..w22, w26, w27` files are deleted after their routes move. Media (`w28`) stays in Node (binary upload/range) but writes only under `media/`.

## Step 4: Registry API

- `GET /api/registry` -> `registry.describe_all()` (Phase 2 `registry_dump` content, cached in worker; includes `plugins` and `missing` requirements).
- `GET /api/registry/:kind` and `/api/registry/:kind/:key` -> spec description with JSON Schema.
- `scripts/generated/registry.json` (Phase 2 stopgap) is deleted; `w17/w20/w21` logic already moved to worker.
- ETag from a hash of the description so the frontend can cache.

## Step 5: Generic result filter endpoint

- `GET /api/filter/:key?case=&time=&<params>` and `/api/filter/:key/meta`. `key` looked up in `registry.filter`; params validated against `params_schema` (worker `filter.validate`), tool spawned via `JobManager.runSync(tool, args)` (short-lived, still a subprocess because pyvista exports are heavy), cache dir `.cache/filter/<key>/<hash>` with stamp per `cache_scope`.
- `legacy-aliases.ts` maps `/api/fields/:field`, `/api/cut-plane`, `/api/iso-surface`, `/api/iso-volume`, `/api/plot-over-path`, `/api/particle-trace(/faces)`, `/api/inspect`, `/api/mesh-surface`, `/api/mesh-section` onto `/api/filter/<key>` with param renames, so `main.js` URL builders (L~86-656 `apiFieldUrl`, `apiCutPlaneUrl`, ...) need no change until Phase 4.
- Cache invalidation: keep `exporterStamp()` but compute over `tools/` **and** each plugin's `tools/` dir.

## Step 6: Generic jobs

- `POST /api/jobs {kind: "mesh"|"solve"|"cad_import"|<plugin kind>, params}` -> `JobManager.start(kind, params)` looks up `registry.jobs` (new small registry in Phase 2's spirit: `JobKind(key, tool, args_from_params, concurrency: 1)`) -> spawns via `job-runner` -> returns `{job_id}`.
- `GET /api/jobs/:id` -> record (`status, stage, progress, started_at, ..., result`); `GET /api/jobs?kind=&project=`.
- `GET /api/jobs/:id/events` -> Server-Sent Events of JSONL events (replaces 750 ms `/api/case` and 1500 ms `/api/run/status` polling; legacy polling endpoints remain as aliases built from the same record).
- `POST /api/jobs/:id/stop {force}`.
- Job records persisted to `.cache/jobs/<kind>/<id>.json`; mesh and run records in the project continue to be updated by the worker (`mesh.result.persist`, `runs.update`) on `result` events.
- `activeCaseState` (vite-plugin L76) is retired; "active case" = active project's active mesh/run resolved by the worker (`case.resolve {project_id, run_id|mesh_id}`), which is what `resolveCaseDir` was approximating. `/api/case*` remain as aliases.

## Step 7: CAD in the worker

- `cad.load {project_id, geometry_id}` keeps `LoadedSolid` in an LRU (size 4) keyed by `(step_path, mtime)`.
- `cad.preview`, `cad.faces`, `cad.stl`, `cad.thumb` reuse the code from `tools/export_step_cad_preview.py`, `convert_step_to_stl.py`, `render_geometry_thumb.py` (refactor those tools to call functions in `cfddesk/cad/preview.py` / `cad/export.py`; tools stay as CLIs).
- `cad.import` (STEP normalize/compound) runs as a **job** because it can take seconds and emits progress.
- Result: geometry panel loads without spawning Python; `w16-project-geometry.js` (2000+ lines) is deleted.

## Step 8: Plugin static + manifest API

- `GET /api/plugins` -> manifests + `missing` requirements + `enabled` flags; `POST /api/plugins/:key/enable|disable` writes `.cfddesk-local.json` and calls `registry.reload`.
- `GET /plugins/:key/ui/*` serves files from the plugin's declared `ui.dir` (from `PluginManifest.ui`), `Content-Type` by extension, `Cache-Control: no-store` in dev. Vite `server.fs.allow` gains plugin dirs.
- Path traversal guard: resolve and ensure inside `ui.dir`.

## Step 9: TypeScript for `scripts/`

- Add `typescript`, run Vite config via `vite.config.ts`; server code imported by Vite is transpiled by Vite's own esbuild (no separate build step). `tsconfig.server.json` `strict: true` for `scripts/server/**`; legacy `.js` files allowed until deleted.
- `npm run typecheck` covers both configs.

## Step 10: Tests

- Router unit tests (Step 1).
- Worker tests in Python: `tests/unit/test_worker_protocol.py` spins `cfddesk.worker.server` in-process with fake stdin/stdout; `project.get` on fixture; unknown method -> error code -32601; exception -> -32000 with traceback in `data` only when `CFDDESK_DEBUG=1`.
- Node worker client test: spawn real worker, `worker.ping`, kill it, verify respawn.
- Playwright e2e from Phase 0/1 unchanged and green (aliases prove compatibility).
- Load check: 200 sequential `GET /api/project` under 2 s total (was one Python spawn each in the `project_cli` interim).

## Acceptance criteria

- `vite-plugin-case-fields.js`, `w16..w22`, `w26`, `w27`, `w30`, `w32` deleted; `scripts/server/` is the API.
- No per-request Python spawn for reads; `ps` during idle UI shows one `cfddesk.worker` process.
- `GET /api/registry` returns all Phase 2 built-ins with JSON Schemas.
- `GET /api/filter/cut_plane?...` and legacy `/api/cut-plane?...` return identical bytes.
- Mesh and solve run via `/api/jobs`; SSE stream delivers stage/progress/residual events; legacy polling endpoints still work.
- Demo plugin's `ui/index.js` is fetchable at `/plugins/example/ui/index.js`.
