// The Cavity workspace (Foam demo, H15): writes the lid-driven cavity into this
// study's folder and runs it through the host (ws.compute, host 1.3).
//
// Inputs: case folder (inside the study), end time, write interval, solver app,
// ranks, the WSL steps ("blockMesh, decomposePar, renumberMesh*, …"; * runs a
// step in parallel) and a broken blockMeshDict. Buttons: Write, Run, Stop, Open
// in 3D. Outputs: #status, #stage, #ahead, #error ("<code>: <message>"), #job
// and #events (one JSON event per line). The e2e reads window.__cavity too.
import { connect } from '@magnusim/workspace';

const root = document.getElementById('root');
root.innerHTML = `
  <main class="cavity">
    <h1 id="cavity-title">Cavity</h1>
    <p id="cavity-host">Connecting…</p>
    <div class="cavity-form">
      <label>Case folder <input id="case" value="cases/c1" autocomplete="off" /></label>
      <label>End time <input id="end-time" value="0.5" autocomplete="off" /></label>
      <label>Write interval <input id="write-interval" value="0.1" autocomplete="off" /></label>
      <label>Solver <input id="app" value="pimpleFoam" autocomplete="off" /></label>
      <label>Ranks <input id="n-procs" value="1" autocomplete="off" /></label>
      <label>WSL steps <input id="pre" value="blockMesh" autocomplete="off" /></label>
      <label class="cavity-check"><input id="broken" type="checkbox" /> Broken blockMeshDict</label>
    </div>
    <div class="cavity-actions">
      <button type="button" id="write">Write</button>
      <button type="button" id="run">Run</button>
      <button type="button" id="stop">Stop</button>
      <button type="button" id="open3d">Open in 3D</button>
    </div>
    <dl class="cavity-out">
      <dt>Status</dt><dd id="status"></dd>
      <dt>Stage</dt><dd id="stage"></dd>
      <dt>Ahead</dt><dd id="ahead"></dd>
      <dt>Case</dt><dd id="job"></dd>
      <dt>Error</dt><dd id="error"></dd>
    </dl>
    <pre id="events"></pre>
  </main>`;

const $ = (id) => document.getElementById(id);
const state = { job: null, events: [], written: null, lastSubmit: null, opened: null };
window.__cavity = state;

function show(id, value) {
  $(id).textContent = value == null ? '' : String(value);
}

function showError(err) {
  const code = err && err.code ? String(err.code) : 'failed';
  show('error', `${code}: ${err && err.message ? err.message : String(err)}`);
}

/** One event of the followed case: kept, listed, and reflected in the outputs. */
function onEvent(ev) {
  state.events.push(ev);
  $('events').textContent += `${JSON.stringify(ev)}\n`;
  if (ev.event === 'queued') {
    show('status', 'queued');
    show('ahead', ev.ahead);
  } else if (ev.event === 'start') {
    show('status', 'running');
    show('ahead', '');
  } else if (ev.event === 'stage') {
    show('stage', ev.stage);
  } else if (ev.event === 'end') {
    show('status', ev.status);
    show('stage', '');
    if (ev.error || ev.code) show('error', `${ev.code || ev.status}: ${ev.error || ''}`);
  } else if (ev.event === 'error') {
    showError(ev);
  }
}

let unfollow = () => undefined;
function follow(id) {
  if (state.job === id) return;
  unfollow();
  state.job = id;
  state.events = [];
  $('events').textContent = '';
  show('job', id);
  unfollow = ws.compute.events(id, onEvent);
}

const ws = await connect();
// The e2e drives the bridge through this handle too.
window.__ws = ws;
show('cavity-title', ws.context.study.title);
show('cavity-host', `Connected to ${ws.context.project.title} (host ${ws.context.hostVersion})`);
ws.on('study', (study) => show('cavity-title', study.title));

function pre() {
  return $('pre')
    .value.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.endsWith('*') ? { tool: s.slice(0, -1).trim(), parallel: true } : { tool: s }));
}

$('write').addEventListener('click', async () => {
  show('error', '');
  try {
    const r = await ws.service('write_cavity', {
      case: $('case').value.trim(),
      study_id: ws.context.study.id,
      end_time: Number($('end-time').value),
      write_interval: Number($('write-interval').value),
      write_format: 'binary',
      broken: $('broken').checked,
    });
    if (!r || r.ok === false) throw Object.assign(new Error((r && r.error) || 'The case was not written'), { code: 'write' });
    state.written = $('case').value.trim();
    show('status', 'written');
  } catch (err) {
    showError(err);
  }
});

$('run').addEventListener('click', async () => {
  show('error', '');
  const opts = {
    caseRel: $('case').value.trim(),
    app: $('app').value,
    nProcs: Number($('n-procs').value) || 1,
    pre: pre(),
    results: { rho: 1, kinematicFields: ['p'] },
  };
  state.lastSubmit = null;
  try {
    const r = await ws.compute.submitOpenFOAM(opts);
    state.lastSubmit = r;
    show('ahead', r.ahead);
    follow(r.id);
  } catch (err) {
    state.lastSubmit = { error: err.message, code: err.code };
    showError(err);
  }
});

$('stop').addEventListener('click', async () => {
  if (!state.job) return;
  try {
    const r = await ws.compute.stop(state.job);
    if (r.stopping) show('stage', 'stopping');
    else show('status', r.status);
  } catch (err) {
    showError(err);
  }
});

$('open3d').addEventListener('click', async () => {
  show('error', '');
  try {
    state.opened = await ws.results.openIn3D($('case').value.trim());
  } catch (err) {
    state.opened = { error: err.message, code: err.code };
    showError(err);
  }
});

// A reopened page finds its case: the newest queued or running one of this study.
try {
  const jobs = await ws.compute.list();
  const live = jobs.find((j) => j.status === 'running' || j.status === 'queued');
  if (live) {
    $('case').value = live.caseRel;
    show('status', live.status);
    show('stage', live.stage || '');
    follow(live.id);
  }
} catch (err) {
  showError(err);
}
document.body.dataset.ready = '1';
