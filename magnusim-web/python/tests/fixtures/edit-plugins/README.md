# Edit fixture plugins (host API 1.7)

A plugin that edits a project geometry, for the geometry action tests only (the link tests
load `../link-plugins/`, which does not include it).

- `edit-demo/` (host 1.7): kind **Edit demo** links geometry and has a geometry action, **Edit in
  Demo** (`[[geometry_actions]]`), offered on a STEP, IGES or BREP import in the tree, the
  viewport and the Geometry panel. Its page shows `ws.context.geometry` and `launch`, reads
  the geometry (`geometrySource`, `geometryFaces`) and sends "Edit v2": `fixtures/box-pulled.bbrep`
  (the 20 mm cube `fixtures/box.step` with its top pulled up 10 mm) with its face names and
  the original's (`box.original_names.json`, as `originalNames`), so the host keeps the
  geometry and carries its boundary conditions by name. `box.bad_names.json` does not
  describe the original; `box.stl` is a mesh import no action may edit. Built by

      cd python
      .venv/Scripts/python.exe tools/gen_edit_demo_fixtures.py

  `e2e/geometry-actions.spec.js` and `scripts/server/__tests__/link-adopt.test.js` drive it.
