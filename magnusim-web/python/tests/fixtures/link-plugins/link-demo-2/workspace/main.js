// The Demo 2 workspace (a test fixture, host API 1.5): a plugin with no exit hook that links
// from its own "Send to simulation" button. Its backend writes the export (a text BREP and
// its face names, plugin.py `export`); the page reads each file's etag with ws.files.stat
// and links them by etag, so it never reads the bytes itself.
import { connect } from '@magnusim/workspace';

const ws = await connect();
const $ = (id) => document.getElementById(id);
$('link2-title').textContent = ws.context.study.title;
ws.on('study', (study) => {
  $('link2-title').textContent = study.title;
});

async function send() {
  const sid = ws.context.study.id;
  const version = $('link2-version').value;
  $('link2-status').textContent = `Sending ${version}…`;
  try {
    const out = await ws.service('export', { study_id: sid, version });
    if (!out || !out.ok) throw new Error((out && out.error) || 'the export failed');
    const shape = await ws.files.stat(out.shape);
    const names = await ws.files.stat(out.faceNames);
    const linked = await ws.project.linkedGeometry();
    const study = await ws.study.get();
    const sourceVersion = Math.max(Number(study.source_version) || 0, linked ? linked.sourceVersion : 0) + 1;
    await ws.study.update({ source_version: sourceVersion }, study.rev);
    const result = await ws.project.linkGeometry({
      shape: { rel: out.shape, format: 'brep', etag: shape.etag },
      faceNames: { rel: out.faceNames, etag: names.etag },
      sourceVersion,
      basedOnRev: linked ? linked.rev : null,
    });
    $('link2-status').textContent = `${result.change} rev ${result.rev}${result.created ? ' created' : ''}`;
  } catch (e) {
    // "Keep editing" in the host's question: stay as we are, no error (authoring.md).
    $('link2-status').textContent = e && e.code === 'cancelled' ? 'Kept editing' : `Refused: ${(e && e.code) || ''} ${e && e.message}`;
  }
}

$('link2-send').addEventListener('click', () => void send());
