// The Demo workspace (a test fixture, host API 1.5 and 1.6): it shows its study and links one
// of three designs from its own buttons, as a design tool would after a save. Each button
// fetches a committed export (./exports/v1..v3, tools/gen_link_demo_fixtures.py), writes
// it into the study's folder with ws.files.write, saves the study's source_version and
// calls ws.project.linkGeometry. The page shows the result and the geometry events it hears.
//
// Exit sync (1.6): a study whose record has `leave_hook` set (the tests set it) registers an
// exit hook. The page then edits a design ("Change to v2" marks it unsaved), saves it
// (writes the export and a newer source_version, no link) and the hook, on every way out
// the host owns, saves unsaved work first and links the saved design when it is newer than
// the one the geometry has. `#hook-mode` picks what the hook does (sync, throw, stall,
// nosave, back-inside, reload, noop); `#hook-delay` waits before the link and `#hook-after`
// after it (ms); `#hook-view`
// returns a camera, `#link-view` links with one; `#link-always` links even an unchanged
// design (the host answers `none`). Each run appends its reason to studies/<sid>/hook-log.json.
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

// ---- exit sync (host 1.6) --------------------------------------------------------------

const sid = ws.context.study.id;
const DESIGN_REL = `studies/${sid}/design.json`;
const LOG_REL = `studies/${sid}/hook-log.json`;
// The design on screen (edited, maybe not saved yet).
let design = null;
let dirty = false;

function showDesign() {
  $('design').textContent = design ? `${design.version}${design.names !== `${design.version}.face_names.json` ? ' (renamed)' : ''}${dirty ? ' (not saved)' : ''}` : 'none';
}

async function savedDesign() {
  return ws.data.read(DESIGN_REL);
}

/** Save the design on screen: its export, then a newer source_version; no link. */
async function saveDesign() {
  if (!design) return null;
  const shape = await put(`${design.version}.bbrep`, `studies/${sid}/design/shape.bbrep`);
  const sidecar = await put(design.names, `studies/${sid}/design/face_names.json`);
  const linked = await ws.project.linkedGeometry();
  const study = await ws.study.get();
  const sourceVersion = Math.max(Number(study.source_version) || 0, linked ? linked.sourceVersion : 0) + 1;
  await ws.study.update({ source_version: sourceVersion }, study.rev);
  const saved = { ...design, sourceVersion, shape: { rel: shape.rel, sha256: shape.sha256 }, faceNames: { rel: sidecar.rel, sha256: sidecar.sha256 } };
  await ws.data.write(DESIGN_REL, saved);
  dirty = false;
  await ws.nav.setDirty(false);
  showDesign();
  $('hook-status').textContent = `saved ${design.version} as ${sourceVersion}`;
  return saved;
}

function edit(version, names) {
  design = { version, names };
  dirty = true;
  void ws.nav.setDirty(true, `Design ${version} is not saved`);
  showDesign();
}

/** The camera the hook lands with: an orthographic view from +x, 100 mm high. */
const VIEW = { position: [400, 15, 15], target: [0, 15, 15], up: [0, 0, 1], projection: 'orthographic', height: 100 };
/** The camera the link call carries: a perspective view from -y, 30 degrees. */
const LINK_VIEW = { position: [15, -400, 15], target: [15, 0, 15], up: [0, 0, 1], projection: 'perspective', fovDeg: 30 };

/** Link the saved design when it is newer than the one the geometry has. */
async function linkSaved(withDirty) {
  const saved = await savedDesign();
  if (!saved) return null;
  const linked = await ws.project.linkedGeometry();
  // Nothing newer to link (unless `#link-always`: then the host answers `none`).
  if (!withDirty && !$('link-always').checked && linked && linked.sourceVersion >= saved.sourceVersion) return null;
  const view = $('link-view').checked ? LINK_VIEW : undefined;
  const result = await ws.project.linkGeometry({
    shape: { rel: saved.shape.rel, format: 'brep', sha256: saved.shape.sha256 },
    faceNames: saved.faceNames,
    sourceVersion: saved.sourceVersion,
    basedOnRev: linked ? linked.rev : null,
    ...(view ? { view } : {}),
    onProgress: (p) => {
      $('link-stage').textContent = p.stage;
    },
  });
  $('link-status').textContent = `${result.change} rev ${result.rev}${result.created ? ' created' : ''}`;
  return result;
}

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

async function logRun(reason, mode) {
  const log = (await ws.data.read(LOG_REL)) || [];
  log.push({ reason, mode, at: Date.now() });
  await ws.data.write(LOG_REL, log);
}

async function onLeave({ reason, signal, progress }) {
  const mode = $('hook-mode').value || 'sync';
  await logRun(reason, mode);
  $('hook-status').textContent = `leaving (${reason}, ${mode})`;
  if (mode === 'noop') return undefined;
  if (mode === 'throw') throw new Error('The export failed');
  if (mode === 'stall') {
    await sleep(10 * 60 * 1000, signal);
    return undefined;
  }
  if (mode === 'reload') {
    location.reload();
    await sleep(10 * 60 * 1000, signal);
    return undefined;
  }
  if (mode === 'back-inside') {
    const left = await ws.nav.back();
    $('hook-back').textContent = `nav.back: ${left}`;
    await logRun(`nav.back:${left}`, mode);
  }
  if (mode === 'nosave') {
    // Links while dirty: the host refuses it (unsaved); the hook goes on as if nothing happened.
    try {
      await linkSaved(true);
    } catch (e) {
      $('hook-status').textContent = `refused ${e.code}`;
    }
    return undefined;
  }
  progress(0.1, 'Saving the design');
  if (dirty) await saveDesign();
  const delay = Number($('hook-delay').value) || 0;
  if (delay) {
    progress(0.5, 'Exporting the design');
    await sleep(delay, signal);
  }
  try {
    await linkSaved(false);
  } catch (e) {
    // "Keep editing" (cancelled): stay as we are, with no error (authoring.md).
    if (e && e.code === 'cancelled') {
      $('hook-status').textContent = 'Kept editing';
      return undefined;
    }
    throw e;
  }
  const after = Number($('hook-after').value) || 0;
  if (after) await sleep(after, signal);
  return $('hook-view').checked ? { view: VIEW } : undefined;
}

const study = await ws.study.get();
if (study.leave_hook) {
  $('hook-mode').value = String(study.leave_hook) === 'true' ? 'sync' : String(study.leave_hook);
  await ws.nav.onLeave(onLeave);
  $('hook-on').textContent = 'on';
}
const loaded = await savedDesign();
if (loaded) design = { version: loaded.version, names: loaded.names };
showDesign();

for (const [id, version, names] of [
  ['edit-v1', 'v1', 'v1.face_names.json'],
  ['edit-v2', 'v2', 'v2.face_names.json'],
  ['edit-v3', 'v3', 'v3.face_names.json'],
  ['edit-v1-renamed', 'v1', 'v1-renamed.face_names.json'],
]) {
  $(id).addEventListener('click', () => edit(version, names));
}
$('save').addEventListener('click', () => void saveDesign().catch((e) => ($('hook-status').textContent = `save failed: ${e.message}`)));
// The page's own "Done": nav.back(), and the exit hook does the sync.
$('done').addEventListener('click', () => void ws.nav.back());
$('open3d').addEventListener('click', () => {
  void ws.results.openIn3D($('case').value).then(
    (r) => ($('hook-status').textContent = `openIn3D: ${r.opened}`),
    (e) => ($('hook-status').textContent = `openIn3D refused: ${e.code || ''} ${e.message}`),
  );
});
document.body.dataset.ready = '1';
