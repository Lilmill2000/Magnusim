import { parseJobLine } from '../../scripts/job-runner.js';

const cases = [
  ['MAGNUSIM_EVENT {"event":"stage","stage":"solve"}', 'stage', 'solve'],
  ['CFDDESK_EVENT {"event":"stage","stage":"decompose"}', 'stage', 'decompose'],
  ['{"event":"result","ok":true}', 'result', null],
  ['[0] MAGNUSIM_EVENT {"event":"time_saved","t":2}', 'time_saved', null],
  ['Time = 1', null, null],
];

let failed = 0;
for (const [line, expectEvent, expectStage] of cases) {
  const ev = parseJobLine(line);
  if (expectEvent == null) {
    if (ev !== null) { console.error('expected null for', line, 'got', ev); failed++; }
  } else if (!ev || ev.event !== expectEvent) {
    console.error('expected', expectEvent, 'for', line, 'got', ev); failed++;
  } else if (expectStage != null && ev.stage !== expectStage) {
    console.error('expected stage', expectStage, 'got', ev.stage); failed++;
  }
}
if (failed) process.exit(1);
console.log(JSON.stringify({ ok: true, cases: cases.length, note: 'MAGNUSIM_EVENT preferred; CFDDESK_EVENT alias OK' }));
