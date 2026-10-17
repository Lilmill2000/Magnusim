// The Windows trampoline for a coding agent (phase 3 spec 4.11). Plain ESM, node: modules only.
//
//   node launch.mjs <agent argv...>      with an extra pipe as fd 3
//
// It starts nothing until Magnusim has put it in the agent's job object: it blocks on one line
// from fd 3, and on `go` spawns the agent (no shell, hidden window) with its own stdin, stdout
// and stderr, so the agent and every process the agent starts are born inside the job. It then
// passes the agent's exit code through. If fd 3 ends without `go` (Magnusim went away, or the
// job could not be made), it exits without starting anything.
import { spawn } from 'node:child_process';
import { Socket } from 'node:net';

const argv = process.argv.slice(2);
if (!argv.length) {
  process.stderr.write('launch.mjs: no agent command\n');
  process.exit(2);
}

let started = false;
const control = new Socket({ fd: 3, readable: true, writable: false });
let buf = '';
control.setEncoding('utf8');
control.on('data', (d) => {
  if (started) return;
  buf += d;
  const nl = buf.indexOf('\n');
  if (nl < 0) return;
  const line = buf.slice(0, nl).trim();
  if (line !== 'go') {
    process.stderr.write('launch.mjs: not started\n');
    process.exit(3);
  }
  started = true;
  control.destroy();
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', windowsHide: true, shell: false });
  } catch (err) {
    process.stderr.write(`launch.mjs: ${err?.code || err?.message || err}\n`);
    process.exit(127);
  }
  child.on('error', (err) => {
    process.stderr.write(`launch.mjs: ${err?.code || err?.message || err}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
});
const gone = () => {
  if (!started) process.exit(3);
};
control.on('end', gone);
control.on('close', gone);
control.on('error', gone);
