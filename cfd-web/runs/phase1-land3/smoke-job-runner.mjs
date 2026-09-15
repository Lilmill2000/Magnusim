import { parseJobLine } from '../../scripts/job-runner.js';
const a = parseJobLine('CFDDESK_EVENT {"event":"stage","stage":"solve"}');
const b = parseJobLine('{"event":"result","ok":true}');
const c = parseJobLine('Time = 1');
console.log(JSON.stringify({a,b,c}));
if (!a || a.event !== 'stage') process.exit(1);
if (!b || b.event !== 'result') process.exit(1);
if (c !== null) process.exit(1);
console.log('job-runner parse OK');
