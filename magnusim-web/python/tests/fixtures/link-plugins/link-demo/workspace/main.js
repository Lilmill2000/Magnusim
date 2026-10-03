// The Demo workspace (a test fixture, host API 1.5): it shows its study and links one of
// three designs from its own buttons, as a design tool would after a save. Each button
// fetches a committed export (./exports/v1..v3, tools/gen_link_demo_fixtures.py), writes
// it into the study's folder with ws.files.write, saves the study's source_version and
// calls ws.project.linkGeometry. The page shows the result and the geometry events it hears.
import { connect } from '@magnusim/workspace';

const ws = await connect();
window.__ws = ws;
const $ = (id) => document.getElementById(id);
$('link-title').textContent = ws.context.study.title;
ws.on('study', (study) => {
  $('link-title').textContent = study.title;
});

const events = [];
ws.on('geometry', (g) => {
  events.push(g);
  $('link-events').textContent = events.map((e) => `rev ${e.rev}`).join(', ');
});

async function put(name, rel) {
  const r = await fetch(`./exports/${name}`);
  if (!r.ok) throw new Error(`no fixture ${name}`);
  return ws.files.write(rel, await r.arrayBuffer());
}

/** Link one design version: its files, a newer source_version, then the link. */
async function linkVersion(version, names = `${version}.face_names.json`) {
  const sid = ws.context.study.id;
  $('link-status').textContent = `Linking ${version}…`;
  try {
    const shape = await put(`${version}.bbrep`, `studies/${sid}/exports/shape.bbrep`);
    const sidecar = names ? await put(names, `studies/${sid}/exports/face_names.json`) : null;
    const linked = await ws.project.linkedGeometry();
    const study = await ws.study.get();
    const sourceVersion = Math.max(Number(study.source_version) || 0, linked ? linked.sourceVersion : 0) + 1;
    await ws.study.update({ source_version: sourceVersion }, study.rev);
    const result = await ws.project.linkGeometry({
      shape: { rel: shape.rel, format: 'brep', sha256: shape.sha256 },
      ...(sidecar ? { faceNames: { rel: sidecar.rel, sha256: sidecar.sha256 } } : {}),
      sourceVersion,
      basedOnRev: linked ? linked.rev : null,
      onProgress: (p) => {
        $('link-stage').textContent = p.stage;
      },
    });
    $('link-status').textContent = `${result.change} rev ${result.rev}`;
    $('link-result').textContent = JSON.stringify({ change: result.change, rev: result.rev, lost: result.lost.length, returned: result.returned.length });
    return result;
  } catch (e) {
    $('link-status').textContent = `Refused: ${e.code || ''} ${e.message}`;
    throw e;
  }
}
window.linkVersion = linkVersion;

for (const v of ['v1', 'v2', 'v3']) {
  $(`link-${v}`).addEventListener('click', () => void linkVersion(v).catch(() => undefined));
}
