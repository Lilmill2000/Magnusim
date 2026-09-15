import json
from pathlib import Path
from cfddesk.project.model import Project

fixes = {
  "velocity_inlet": "velocity_inlet_fixed",
  "pressure_outlet": "pressure_outlet_gauge",
  "wall": "wall_noslip",
  "walls": "wall_noslip",
}

def fix_list(bcs, changed):
    for bc in bcs or []:
        t = bc.get("type")
        if t in fixes:
            bc["type"] = fixes[t]
            changed[0] = True
    return changed

for ver in range(5, 14):
    p = Path(f"tests/fixtures/projects/v{ver}.json")
    doc = json.loads(p.read_text(encoding="utf-8"))
    changed = [False]
    fix_list(doc.get("boundary_conditions"), changed)
    for sim in doc.get("simulations") or []:
        fix_list(sim.get("boundary_conditions"), changed)
    if changed[0]:
        p.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
        print("fixed", p.name)
    try:
        proj = Project.from_dict(json.loads(p.read_text(encoding="utf-8")))
        print("ok", ver, "->", proj.version)
    except Exception as e:
        print("FAIL", ver, type(e).__name__, e)

# How does fingerprint see hex_element_core?
doc = json.loads(Path("tests/fixtures/projects/v13.json").read_text(encoding="utf-8"))
proj = Project.from_dict(doc)
print("hex", proj.mesh.hex_element_core)
print("fp", proj.mesh_input_fingerprint())
# inspect payload path via meshes on sim
sim = proj.primary_simulation()
print("sim meshes", len(sim.meshes) if sim else None)
if sim and sim.meshes:
    m0 = sim.meshes[0]
    print("mesh0 type", type(m0), getattr(m0, "settings", None) or m0)
