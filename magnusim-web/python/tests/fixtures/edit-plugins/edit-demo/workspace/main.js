// The Demo editor (a test fixture, host API 1.7): the page a geometry action ("Edit in
// Demo") opens. It shows the geometry its study edits (ws.context.geometry) and what was
// right-clicked (ws.context.launch), reads the geometry's STEP file and face table, and
// sends an edit back: "Edit v2" writes the cube with its top pulled up 10 mm
// (./fixtures/box-pulled.bbrep, tools/gen_edit_demo_fixtures.py), its face names and the
// original's names (box.original_names.json), then links them with `originalNames`, so the
// host keeps the geometry and carries its boundary conditions to the new faces by name.
// window.editV2({ names: 'none' | 'bad' | 'rotated' | 'one_wrong' }) links without the
// original's names, with a file of another shape, with every row naming the next face, or
// with the top's row naming another face.
import { connect } from '@magnusim/workspace';

const ws = await connect();
window.__ws = ws;
const $ = (id) => document.getElementById(id);
$('title').textContent = ws.context.study.title;
$('ctx').textContent = JSON.stringify(ws.context.geometry ?? null);
$('launch').textContent = JSON.stringify(ws.context.launch ?? null);

const sid = ws.context.study.id;

async function put(name, rel) {
  const r = await fetch(`./fixtures/${name}`);
  if (!r.ok) throw new Error(`no fixture ${name}`);
  return ws.files.write(rel, await r.arrayBuffer());
}

async function readSource() {
  const src = await ws.project.geometrySource();
  const bytes = new Uint8Array(await src.file.arrayBuffer());
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  const out = { geometryId: src.geometryId, name: src.file.name, size: src.size, sha256: src.sha256, hashed: digest, adopted: src.adopted, format: src.format };
  $('src').textContent = JSON.stringify(out);
  return out;
}
window.readSource = readSource;

async function faces() {
  const t = await ws.project.geometryFaces();
  const out = {
    geometryId: t.geometryId,
    rev: t.rev,
    sourceSha256: t.sourceSha256,
    bodies: t.bodies.length,
    faces: t.faces.length,
    uses: t.faces.filter((f) => f.uses.length).map((f) => ({ index: f.index, label: f.label, normal: f.normal, uses: f.uses.map((u) => `${u.kind}:${u.item}`) })),
  };
  $('face-list').textContent = JSON.stringify(out);
  return out;
}
window.faces = faces;

async function editV2(opts = {}) {
  const names = opts.names || 'original';
  $('status').textContent = 'Linking v2…';
  try {
    const shape = await put('box-pulled.bbrep', `studies/${sid}/exports/shape.bbrep`);
    const sidecar = await put('box-pulled.face_names.json', `studies/${sid}/exports/face_names.json`);
    const file = { bad: 'box.bad_names.json', rotated: 'box.rotated_names.json', one_wrong: 'box.one_wrong_names.json' }[names] || 'box.original_names.json';
    const original = names === 'none' ? null : await put(file, `studies/${sid}/exports/original_names.json`);
    const linked = await ws.project.linkedGeometry();
    const study = await ws.study.get();
    const sourceVersion = Math.max(Number(study.source_version) || 0, linked ? linked.sourceVersion : 0) + 1;
    await ws.study.update({ source_version: sourceVersion }, study.rev);
    const result = await ws.project.linkGeometry({
      shape: { rel: shape.rel, format: 'brep', sha256: shape.sha256 },
      faceNames: { rel: sidecar.rel, sha256: sidecar.sha256 },
      ...(original ? { originalNames: { rel: original.rel, sha256: original.sha256 } } : {}),
      sourceVersion,
      basedOnRev: linked ? linked.rev : null,
    });
    const out = {
      geometryId: result.geometryId,
      change: result.change,
      rev: result.rev,
      fromRev: result.fromRev,
      created: result.created,
      lost: result.lost.length,
      byName: result.match.byName,
      adopted: result.adopted === true,
      unverified: result.unverified ?? null,
    };
    $('status').textContent = `${result.change} rev ${result.rev}`;
    $('result').textContent = JSON.stringify(out);
    return out;
  } catch (e) {
    $('status').textContent = `Refused: ${e.code || ''} ${e.message}`;
    throw e;
  }
}
window.editV2 = editV2;

$('read-source').addEventListener('click', () => void readSource().catch((e) => ($('src').textContent = `Refused: ${e.code || ''} ${e.message}`)));
$('faces').addEventListener('click', () => void faces().catch((e) => ($('face-list').textContent = `Refused: ${e.code || ''} ${e.message}`)));
$('edit-v2').addEventListener('click', () => void editV2().catch(() => undefined));
$('edit-v2-plain').addEventListener('click', () => void editV2({ names: 'none' }).catch(() => undefined));
$('done').addEventListener('click', () => void ws.nav.back());
