// The page a start action opens: it shows which study, of which kind, in which workspace.
import { connect } from '@magnusim/workspace';

const ws = await connect();
window.__ws = ws;
document.getElementById('start-title').textContent = ws.context.study.title;
document.getElementById('start-where').textContent = `${ws.context.plugin} / ${ws.context.workspace} / ${ws.context.study.kind}`;
ws.on('study', (study) => {
  document.getElementById('start-title').textContent = study.title;
});
