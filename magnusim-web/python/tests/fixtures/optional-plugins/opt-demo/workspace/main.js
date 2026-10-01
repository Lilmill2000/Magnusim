// The optional demo's workspace: it opens only once the plugin is turned on.
import { connect } from '@magnusim/workspace';

const ws = await connect();
document.getElementById('opt-status').textContent = `Optional demo connected: ${ws.context.study.title}`;
