// The Counter workspace (a test fixture): a counter the app's assistant reads and changes
// through tools this page offers (ws.assistant, bridge 1.9, unreleased: the host still says
// 1.8, so the page checks that ws.assistant exists). The counter lives in the page only:
// it starts at 0 on every load.
//
// Tools: get_count (read), add {by} (edit; its result's summary names what it did, for the
// turn's log), slow_add {by, steps?} (edit: progress every 200 ms, then adds after `steps`
// ticks, or, with no steps, once the test calls window.__release(); Stop, a closed page or a
// lost link aborts it and #aborted reads "aborted"), reset (destructive), mystery (a risk the
// host does not know, so it counts as destructive), snap (read: a 64x64 PNG of the counter),
// read_study (read, a 1 s stall window: it waits on the app's answer to ws.study.get(), which
// keeps it alive however long that takes) and fail_hint (read: it always fails, with a hint
// that says how to fix it and a detail the model can act on). A registration the app could
// not take yet (not_connected) is made again when the page is shown.
//
// What the e2e reads: #counter, #slow, #aborted, #ai-available ("yes" or "no") with
// #ai-reason, #calls (the tools run, in order), and window.__aiCalls; window.__register()
// registers again.
import { connect } from '@magnusim/workspace';

const $ = (id) => document.getElementById(id);
let count = 0;
const show = () => {
  $('counter').textContent = String(count);
};
show();
window.__aiCalls = [];

const ws = await connect();
window.__ws = ws;
$('title').textContent = ws.context.study.title;

const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const BY = { type: 'integer', minimum: -100, maximum: 100, description: 'How much to add.' };

const TOOLS = [
  { name: 'get_count', title: 'Read the counter', description: 'Read the counter.', inputSchema: obj({}), risk: 'read' },
  { name: 'add', title: 'Add to the counter', description: 'Add a whole number to the counter.', inputSchema: obj({ by: BY }), risk: 'edit' },
  {
    name: 'slow_add',
    title: 'Add slowly',
    description: 'Add a whole number to the counter slowly, one step every 200 ms (steps, else until the workspace says it is done).',
    inputSchema: obj({ by: BY, steps: { type: 'integer', minimum: 1, maximum: 50, description: 'How many steps.' } }, ['by']),
    risk: 'edit',
    timeoutS: 30,
  },
  { name: 'reset', title: 'Reset the counter', description: 'Set the counter to 0.', inputSchema: obj({}), risk: 'destructive' },
  {
    name: 'mystery',
    title: 'Do the mystery thing',
    description: 'Does something.',
    inputSchema: obj({ note: { type: 'string', maxLength: 64, title: 'Note', description: 'A note.' } }, []),
    // Not a risk the host knows: it counts as destructive.
    risk: 'surprising',
  },
  { name: 'snap', title: 'Picture the counter', description: 'A 64x64 picture of the counter.', inputSchema: obj({}), risk: 'read' },
  {
    name: 'read_study',
    title: "Read the study's title",
    description: "Read the study's title from the app.",
    inputSchema: obj({}),
    risk: 'read',
    // Its own window is short: only its call to the app in flight keeps it alive.
    timeoutS: 1,
  },
  {
    name: 'fail_hint',
    title: 'Try a big step',
    description: 'Tries to add 10 to the counter; it always fails, and says how to add instead.',
    inputSchema: obj({}),
    risk: 'read',
  },
];

/** What fail_hint throws: its message, how to fix it, and plain JSON the model can act on. */
const FAIL_HINT = {
  code: 'invalid_input',
  message: 'step_too_big: the counter takes at most 3 at a time.',
  hint: 'Call add with by set to 1, 2 or 3.',
  detail: { reason: 'step_too_big', field: 'by', allowed: [1, 2, 3] },
};

const GUIDE = 'The counter starts at 0 each time the workspace opens. Read it with get_count; add or slow_add change it; reset sets it to 0.';

/** The running slow_add's way to finish now (window.__release), or null. */
let finishSlow = null;
window.__release = () => {
  if (!finishSlow) return false;
  finishSlow();
  return true;
};

function slowAdd(call) {
  const by = Number(call.input.by);
  const steps = call.input.steps === undefined || call.input.steps === null ? 0 : Number(call.input.steps);
  $('slow').textContent = 'running';
  $('aborted').textContent = '';
  return new Promise((resolve, reject) => {
    let step = 0;
    let timer = null;
    const end = () => {
      clearInterval(timer);
      finishSlow = null;
      call.signal.removeEventListener('abort', onAbort);
    };
    const finish = () => {
      end();
      count += by;
      show();
      $('slow').textContent = 'done';
      resolve({ text: `Added ${by}: the counter is ${count}.`, data: { count } });
    };
    const onAbort = () => {
      end();
      $('slow').textContent = 'stopped';
      $('aborted').textContent = 'aborted';
      reject(Object.assign(new Error('Stopped before it added anything.'), { code: 'failed' }));
    };
    const tick = () => {
      step += 1;
      call.progress(steps ? Math.min(1, step / steps) : null, `Adding ${by}: step ${step}`);
      if (steps && step >= steps) finish();
    };
    finishSlow = finish;
    call.signal.addEventListener('abort', onAbort, { once: true });
    timer = setInterval(tick, 200);
    tick();
  });
}

/** A 64x64 PNG of the counter. */
async function snap() {
  const canvas = new OffscreenCanvas(64, 64);
  const g = canvas.getContext('2d');
  g.fillStyle = 'white';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = 'black';
  g.font = '28px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(count), 32, 32);
  return canvas.convertToBlob({ type: 'image/png' });
}

async function handle(call) {
  window.__aiCalls.push({ tool: call.tool, input: call.input, turn: call.turn });
  $('calls').textContent = window.__aiCalls.map((c) => c.tool).join(' ');
  switch (call.tool) {
    case 'get_count':
      return { text: `The counter is ${count}.`, data: { count } };
    case 'add':
      count += Number(call.input.by);
      show();
      return { text: `The counter is ${count}.`, data: { count }, summary: `Added ${Number(call.input.by)}: the counter is ${count}` };
    case 'slow_add':
      return slowAdd(call);
    case 'reset':
      count = 0;
      show();
      return { text: 'The counter is 0.', data: { count } };
    case 'mystery':
      return 'Nothing happened.';
    case 'snap':
      return { text: `A picture of the counter (${count}).`, images: [{ mediaType: 'image/png', data: await snap() }] };
    case 'read_study': {
      const study = await ws.study.get();
      return { text: `The study is ${study.title}.`, data: { title: study.title } };
    }
    case 'fail_hint':
      throw Object.assign(new Error(FAIL_HINT.message), { code: FAIL_HINT.code, hint: FAIL_HINT.hint, detail: FAIL_HINT.detail });
    default:
      throw Object.assign(new Error(`No tool named ${call.tool}.`), { code: 'invalid_input' });
  }
}

let lastReason = '';
async function register() {
  if (!ws.assistant) {
    $('ai-available').textContent = 'no';
    $('ai-reason').textContent = 'this app offers no assistant';
    return;
  }
  let reg;
  try {
    reg = await ws.assistant.register(TOOLS, handle, { guide: GUIDE });
  } catch (e) {
    reg = { available: false, accepted: [], refused: [], reason: (e && e.code) || 'failed' };
  }
  lastReason = reg.available ? '' : reg.reason || '';
  $('ai-available').textContent = reg.available ? 'yes' : 'no';
  $('ai-reason').textContent = reg.available ? reg.accepted.join(' ') : lastReason;
  window.__aiRegistration = reg;
  return reg;
}
// The e2e registers again through this, as the page would on its own.
window.__register = register;

// The app could not reach its assistant from this tab yet (it opened in the background): again once shown.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && lastReason === 'not_connected') void register();
});
await register();
