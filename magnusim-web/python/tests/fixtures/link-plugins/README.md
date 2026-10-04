# Link fixture plugins (host API 1.5)

Plugins that link a project geometry, for the link tests. None of them is a real
design tool: the host's link must work for any plugin.

- `link-demo/`: kind **Demo** links a geometry (`links_geometry = true`), kind
  **Sketch** does not. When its study's record has `leave_hook` set (the exit-sync
  tests set it, host 1.6), its page registers an exit hook (`ws.nav.onLeave`): the page
  edits a design ("Change to v2"), saves it, and the hook saves unsaved work and links
  the saved design on every way out; `#hook-mode` makes it throw, stall, link without
  saving, call `nav.back()`, reload, or do nothing, and each run logs its reason in
  `studies/<id>/hook-log.json`. `workspace/exports/` holds the files its tests link (and
  its page links through the bridge; `v4` is v1 10 mm taller, its tops and boss kept by
  name but moved far): deterministic
  BREPs (binary and text) and face-name sidecars, built by

      cd python
      .venv/Scripts/python.exe tools/gen_link_demo_fixtures.py

  Rebuild them only on purpose; the outputs are committed.
- `bc-demo/`: no workspace; it registers a boundary-condition family, **Demo porous**
  (resolved to the BC type `demo_porous`), whose field `extra_faces` holds faces
  (widget `faces`). Its records are made as the BC panel makes them (`POST /api/bcs`
  with `bc_type: "Demo porous"` and the field at the top level, no `registry_key`). Such
  a record blocks a linked geometry's update (`plugin_needed`) while `bc-demo` is off or
  not installed, and its field is rewritten like any face list while it is on.
  `registry-rows.json` holds its rows of the generated registry, for a test that ships
  it as a bundled plugin (`MAGNUSIM_BUNDLED_DIR`, `link-bundled.test.js`).
- `link-demo-2/`: kind **Demo** too (the same title as link-demo's, so study and
  geometry names must be unique across plugins). Its backend (`plugin.py`, method
  `export`) writes a design as a **text** BREP and its sidecar through
  `magnusim_sdk.data` and `magnusim_sdk.link.write_face_names`; its page links them by
  **etag** (`ws.files.stat`) from its own "Send to simulation" button, with no exit
  hook. `designs/` holds link-demo's v1 and v2 as text BREPs with their faces, built by
  the same `tools/gen_link_demo_fixtures.py` (a plugin may import only `magnusim_sdk`,
  `cfddesk.registry` and the standard library, so the backend never converts a shape).
