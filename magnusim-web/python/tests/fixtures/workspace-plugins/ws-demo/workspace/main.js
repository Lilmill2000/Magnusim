// The Bench workspace: what a plugin page can do from its sandboxed frame.
import { connect } from '@magnusim/workspace';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

const ws = await connect();
// The e2e drives the bridge through this handle.
window.__ws = ws;
document.getElementById('bench-title').textContent = ws.context.study.title;
// A rename in the app's header (or a save) arrives here.
ws.on('study', (study) => {
  document.getElementById('bench-title').textContent = study.title;
});
document.getElementById('bench-status').textContent = `Connected to ${ws.context.project.title}`;
createRoot(document.getElementById('react-root')).render(
  createElement('p', { 'data-react': '1' }, `React in the frame: ${ws.context.plugin} / ${ws.context.workspace}`),
);

const checks = {};
try {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(new URL('./add.wasm', import.meta.url)));
  checks.wasm = instance.exports.add(20, 22);
} catch (e) {
  checks.wasm = 'failed: ' + e.message;
}
try {
  const worker = ws.spawnWorker(new URL('./worker.js', import.meta.url));
  // Posted before the module has loaded: the SDK holds them for it.
  worker.postMessage('first');
  worker.postMessage('second');
  const got = await new Promise((resolve) => {
    const out = { answer: null, echoes: [] };
    worker.onmessage = (e) => {
      if ('answer' in e.data) out.answer = e.data.answer;
      else out.echoes.push(e.data.echo);
      if (out.answer !== null && out.echoes.length === 2) resolve(out);
    };
    worker.onerror = () => resolve({ answer: 'failed', echoes: [] });
    setTimeout(() => resolve(out), 5000);
  });
  checks.worker = got.answer;
  checks.early = got.echoes;
} catch (e) {
  checks.worker = 'failed: ' + e.message;
}
checks.units = ws.context.units;
document.getElementById('bench-checks').textContent = JSON.stringify(checks);
window.__benchChecks = checks;
