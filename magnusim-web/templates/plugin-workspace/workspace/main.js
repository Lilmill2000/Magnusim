// The workspace page (docs/plugins/authoring.md, "Workspaces (1.1)").
import { connect } from '@magnusim/workspace';

const ws = await connect();
const title = document.getElementById('title');
title.textContent = ws.context.study.title;
// A rename in the app's header arrives here.
ws.on('study', (study) => {
  title.textContent = study.title;
});

document.getElementById('save').addEventListener('click', async () => {
  const study = await ws.study.get();
  await ws.data.write(`studies/${study.id}/design.json`, { savedAt: new Date().toISOString() });
  await ws.study.update({ saved: true }, study.rev);
  ws.nav.setDirty(false);

  // Host 1.5 and later, with links_geometry = true on the kind: hand the saved
  // design to the simulation as a project geometry (the call and its how-to
  // come with host 1.5). Check ws.context.hostVersion first; an older host
  // refuses it.
  // await ws.project.linkGeometry({
  //   shape: { rel: `studies/${study.id}/design.brep`, format: 'brep', sha256 },
  //   sourceVersion,
  // });
});
