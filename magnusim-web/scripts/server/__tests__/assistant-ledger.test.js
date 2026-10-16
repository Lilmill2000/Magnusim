// The Assistant's day ledger (Foundation spec 6.6): reserve then settle, the day from an
// injected clock, reservations a crashed run left open counted as spent, 31 days kept,
// the day's cap never passed by two reservations at once, and one write queue that loses
// nothing on disk.
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-ledger-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');

const { SpendLedger, spendLedger, todayKey } = await import('../assistant/ledger.ts');
const { resetAssistantState } = await import('../assistant/state.ts');

after(() => {
  resetAssistantState();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* the OS temp cleaner takes it */
  }
});

let n = 0;
let dir = '';
beforeEach(() => {
  n += 1;
  dir = join(ROOT, `case-${n}`);
  mkdirSync(dir, { recursive: true });
});

/** A clock the test moves: local noon of the given date. */
function clockAt(y, m, d) {
  const box = { now: new Date(y, m - 1, d, 12, 0, 0) };
  return { box, clock: () => box.now };
}
const fileOf = () => join(dir, 'spend.json');
const onDisk = () => JSON.parse(readFileSync(fileOf(), 'utf8'));
const tempFiles = () => readdirSync(dir).filter((x) => x.endsWith('.tmp'));
const close = (a, b) => Math.abs(a - b) < 1e-9;

describe('reserve and settle', () => {
  it('a reservation counts until settled, then the real cost counts', async () => {
    const { clock } = clockAt(2026, 10, 16);
    const l = new SpendLedger({ file: fileOf(), clock });
    const r = await l.reserve(0.31);
    assert.match(r.id, /^r-[0-9a-f]{12}$/);
    assert.equal(r.day, '2026-10-16');
    assert.equal(l.reservedToday(), 0.31);
    assert.equal(l.spentToday(), 0);
    assert.deepEqual(Object.keys(onDisk().open), [r.id], 'on disk before the request is sent');
    await l.settle(r, 0.12);
    assert.equal(l.reservedToday(), 0);
    assert.equal(l.spentToday(), 0.12);
    assert.deepEqual(onDisk(), { version: 1, days: { '2026-10-16': { usd: 0.12, requests: 1 } }, open: {} });
    await l.settle(r, 5); // twice: nothing
    assert.equal(l.spentToday(), 0.12);
    assert.deepEqual(tempFiles(), []);
  });

  it('the day is the local date of the injected clock, and rolls over at midnight', async () => {
    const { box, clock } = clockAt(2026, 10, 16);
    assert.equal(todayKey(clock), '2026-10-16');
    // Local, not UTC: just after midnight and just before it are the same local day.
    assert.equal(todayKey(() => new Date(2026, 0, 2, 0, 0, 1)), '2026-01-02');
    assert.equal(todayKey(() => new Date(2026, 0, 2, 23, 59, 59)), '2026-01-02');
    const l = new SpendLedger({ file: fileOf(), clock });
    await l.settle(await l.reserve(1), 1);
    const late = await l.reserve(0.5);
    box.now = new Date(2026, 9, 17, 0, 0, 5);
    assert.equal(l.spentToday(), 0, 'a new day');
    assert.equal(l.reservedToday(), 0, "yesterday's reservation is yesterday's");
    await l.settle(late, 0.4);
    assert.deepEqual(onDisk().days, { '2026-10-16': { usd: 1.4, requests: 2 } });
    assert.equal(l.spentToday(), 0);
  });

  it('keeps 31 days', async () => {
    const { box, clock } = clockAt(2026, 8, 1);
    const l = new SpendLedger({ file: fileOf(), clock });
    for (let d = 0; d < 40; d += 1) {
      box.now = new Date(2026, 7, 1 + d, 12);
      await l.settle(await l.reserve(0.01), 0.01);
    }
    const days = Object.keys(onDisk().days).sort();
    assert.equal(days.length, 32, 'today and the 31 days before it');
    assert.equal(days.at(-1), '2026-09-09');
    assert.equal(days[0], '2026-08-09');
  });
});

describe('crash recovery', () => {
  it('reservations an earlier run left open count as spent, and are written so', async () => {
    writeFileSync(
      fileOf(),
      JSON.stringify({
        version: 1,
        days: { '2026-10-16': { usd: 0.5, requests: 3 }, bad: { usd: 1 } },
        open: {
          'r-aaaaaaaaaaaa': { usd: 0.25, day: '2026-10-16', at: '2026-10-16T10:00:00Z' },
          'r-bbbbbbbbbbbb': { usd: 1, day: '2026-10-15', at: '2026-10-15T23:59:00Z' },
          'r-cccccccccccc': { usd: 2, day: 'yesterday' },
        },
      }),
    );
    const { clock } = clockAt(2026, 10, 16);
    const l = new SpendLedger({ file: fileOf(), clock });
    await l.load();
    assert.equal(l.spentToday(), 0.75);
    assert.equal(l.reservedToday(), 0);
    assert.deepEqual(onDisk(), {
      version: 1,
      days: { '2026-10-15': { usd: 1, requests: 1 }, '2026-10-16': { usd: 0.75, requests: 4 } },
      open: {},
    });
  });

  it('an unreadable file starts from zero', async () => {
    writeFileSync(fileOf(), '{"version":1,');
    const l = new SpendLedger({ file: fileOf(), clock: clockAt(2026, 10, 16).clock });
    assert.equal(await l.reserve(0.1, { dayCapUsd: 1 }).then((r) => r.usd), 0.1);
  });
});

describe('the day cap under concurrency', () => {
  it('two reservations against a cap with room for one: exactly one passes', async () => {
    const l = new SpendLedger({ file: fileOf(), clock: clockAt(2026, 10, 16).clock });
    await l.settle(await l.reserve(14), 14);
    const both = await Promise.all([l.reserve(0.6, { dayCapUsd: 15 }), l.reserve(0.6, { dayCapUsd: 15 })]);
    assert.equal(both.filter(Boolean).length, 1, JSON.stringify(both));
    assert.equal(l.reservedToday(), 0.6);
    // The room left fits exactly.
    assert.ok(await l.reserve(0.4, { dayCapUsd: 15 }));
    assert.equal(await l.reserve(0.000001, { dayCapUsd: 15 }), null);
  });

  it('20 concurrent reserve/settle calls, then a reload from disk: the same totals, no open entry lost, no temp file', async () => {
    const { clock } = clockAt(2026, 10, 16);
    const l = new SpendLedger({ file: fileOf(), clock });
    const settled = [];
    const ops = [];
    for (let i = 0; i < 20; i += 1) {
      ops.push(
        l.reserve(0.1 + i / 100).then(async (r) => {
          if (i % 3 === 0) return r; // left open, as a request still running
          await l.settle(r, 0.05 + i / 1000);
          settled.push(r.id);
          return r;
        }),
      );
    }
    const reservations = await Promise.all(ops);
    const open = reservations.filter((r) => !settled.includes(r.id));
    assert.equal(open.length, 7);
    const memory = { spent: l.spentToday(), reserved: l.reservedToday() };
    const doc = onDisk();
    assert.deepEqual(Object.keys(doc.open).sort(), open.map((r) => r.id).sort(), 'every open reservation is on disk');
    assert.ok(close(doc.days['2026-10-16'].usd, memory.spent));
    assert.equal(doc.days['2026-10-16'].requests, 13);
    assert.deepEqual(tempFiles(), []);
    // Writes asked for while one waits ride on it (one queue).
    const w1 = l.flush();
    assert.equal(l.flush(), w1);
    await w1;
    // A later run reads it: the open ones count as spent, nothing lost.
    const again = new SpendLedger({ file: fileOf(), clock });
    await again.load();
    assert.ok(close(again.spentToday(), memory.spent + memory.reserved), `${again.spentToday()} vs ${memory.spent + memory.reserved}`);
    assert.equal(onDisk().days['2026-10-16'].requests, 20);
    assert.deepEqual(tempFiles(), []);
  });
});

describe("the server's ledger", () => {
  it('is spend.json in the Assistant data folder, one per server', async () => {
    const a = await spendLedger();
    const b = await spendLedger();
    assert.equal(a, b);
    assert.equal(a.file, join(ROOT, 'home', 'assistant', 'spend.json'));
    assert.equal(existsSync(a.file), false, 'nothing written until something is spent');
    await a.settle(await a.reserve(0.2), 0.2);
    assert.equal(JSON.parse(readFileSync(a.file, 'utf8')).days[todayKey()].usd, 0.2);
  });
});
