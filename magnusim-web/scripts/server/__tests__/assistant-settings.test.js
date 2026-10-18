// The Assistant's settings (Foundation spec 4.1): defaults and every bound, the base URL
// rules (a server outside this PC needs a confirmation), consent per project and
// destination, one atomic write queue, and nothing of it in the app's prefs.
import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = mkdtempSync(join(tmpdir(), 'magnusim-assistant-settings-'));
process.env.MAGNUSIM_PROJECTS_ROOT = join(ROOT, 'projects');
process.env.MAGNUSIM_LOCAL_JSON = join(ROOT, 'local.json');
process.env.MAGNUSIM_ASSISTANT_HOME = join(ROOT, 'home');
mkdirSync(process.env.MAGNUSIM_PROJECTS_ROOT, { recursive: true });

const S = await import('../assistant/settings.ts');
const { resetAssistantState } = await import('../assistant/state.ts');

const DATA = join(ROOT, 'home', 'assistant');
const FILE = join(DATA, 'settings.json');

after(() => {
  resetAssistantState();
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* the OS temp cleaner takes it */
  }
});

beforeEach(() => {
  resetAssistantState();
  rmSync(join(ROOT, 'home'), { recursive: true, force: true });
});

const onDisk = () => JSON.parse(readFileSync(FILE, 'utf8'));
const tempFiles = () => (existsSync(DATA) ? readdirSync(DATA).filter((n) => n.endsWith('.tmp')) : []);

describe('defaults and bounds', () => {
  it('starts Off with the documented defaults, and writes nothing to read them', async () => {
    const s = await S.loadSettings();
    assert.deepEqual(s, {
      version: 1,
      provider: 'off',
      models: { anthropic: 'claude-opus-5-5', openai: 'gpt-6.1-sol', openai_compatible: '' },
      base_url: 'http://127.0.0.1:1234/v1',
      base_url_confirmed_remote: null,
      effort: 'default',
      privacy: 'ask',
      caps: { turn_usd: 3, day_usd: 15, steps: 50, turn_minutes: 30, turn_tokens: 3_000_000 },
      consents: {},
      mcp: { clients: false, port: null, ask_in_client: false },
      agents: {},
      custom_agents: [],
      agent_caps: { changes: 24, calls: 400, turn_minutes: 60 },
    });
    assert.deepEqual(S.DEFAULT_SETTINGS, s);
    assert.equal(existsSync(join(ROOT, 'home')), false);
    // A copy: changing it changes nothing.
    s.caps.turn_usd = 99;
    assert.equal((await S.loadSettings()).caps.turn_usd, 3);
  });

  it('every limit has its range (ends included) and the day is at least the turn', () => {
    const d = S.defaultSettings();
    const ok = (caps) => S.validatePatch(d, { caps });
    const bad = (caps, field) => {
      const r = S.validatePatch(d, { caps });
      assert.equal(r.ok, false, JSON.stringify(caps));
      assert.equal(r.status, 400);
      assert.equal(r.field, field, JSON.stringify(caps));
      assert.equal(typeof r.error, 'string');
    };
    const ranges = {
      turn_usd: [0.05, 15, 0.04, 100.01],
      day_usd: [3, 1000, 0.09, 1000.5],
      steps: [1, 200, 0, 201],
      turn_minutes: [1, 240, 0, 241],
      turn_tokens: [10_000, 50_000_000, 9_999, 50_000_001],
    };
    for (const [key, [lo, hi, below, above]] of Object.entries(ranges)) {
      assert.equal(ok({ [key]: lo }).ok, true, `${key} ${lo}`);
      assert.equal(ok({ [key]: hi }).ok, true, `${key} ${hi}`);
      bad({ [key]: below }, `caps.${key}`);
      bad({ [key]: above }, `caps.${key}`);
      bad({ [key]: String(lo) }, `caps.${key}`);
      bad({ [key]: Number.NaN }, `caps.${key}`);
    }
    for (const key of ['steps', 'turn_minutes', 'turn_tokens']) bad({ [key]: 10_000.5 }, `caps.${key}`);
    assert.equal(ok({ turn_usd: 0.05, day_usd: 0.1 }).ok, true);
    bad({ turn_usd: 20, day_usd: 10 }, 'caps.day_usd');
    bad({ turn_usd: 16 }, 'caps.day_usd'); // over today's $15.00
    bad({ weekly_usd: 5 }, 'caps.weekly_usd');
    assert.equal(S.validatePatch(d, { caps: [] }).field, 'caps');
  });

  it('refuses unknown keys and values, with the field', () => {
    const d = S.defaultSettings();
    const field = (patch) => {
      const r = S.validatePatch(d, patch);
      assert.equal(r.ok, false, JSON.stringify(patch));
      assert.equal(r.status, 400);
      return r.field;
    };
    assert.equal(field({ provider: 'cloud' }), 'provider');
    assert.equal(field({ provider: 'anthropic', model: 'bad model' }), 'model');
    assert.equal(field({ provider: 'anthropic', model: 'x'.repeat(129) }), 'model');
    assert.equal(field({ model: 'claude-opus-5-5' }), 'model', 'no model while Off');
    assert.equal(field({ effort: 'max' }), 'effort');
    assert.equal(field({ privacy: 'sometimes' }), 'privacy');
    assert.equal(field({ forget_consents: 'yes' }), 'forget_consents');
    assert.equal(field({ confirm_remote: 1 }), 'confirm_remote');
    assert.equal(field({ api_key: 'sk-not-here' }), 'api_key');
    assert.equal(field({ models: [] }), 'models');
    assert.equal(field({ models: 'gpt-6-luna' }), 'models');
    assert.equal(field({ models: { cloud: 'x' } }), 'models.cloud');
    assert.equal(field({ models: { off: 'x' } }), 'models.off');
    assert.equal(field({ models: { anthropic: 'bad model' } }), 'models.anthropic');
    assert.equal(field({ models: { openai_compatible: '' } }), 'models.openai_compatible');
    assert.equal(S.validatePatch(d, null).ok, false);
    assert.equal(S.validatePatch(d, []).ok, false);
    // Names every object inherits are no limit or provider (parsed as a request body is, so __proto__ is an own key).
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      assert.equal(field(JSON.parse(`{"caps":{"${name}":5}}`)), `caps.${name}`, name);
      assert.equal(field(JSON.parse(`{"models":{"${name}":"x"}}`)), `models.${name}`, name);
      assert.equal(field(JSON.parse(`{"${name}":5}`)), name, name);
    }
  });

  it('a bare model id is the default provider’s (now or in the same change); refused while the default is Off', () => {
    const d = S.defaultSettings();
    const r = S.validatePatch(d, { provider: 'openai_compatible', model: 'qwen3:32b' });
    assert.equal(r.ok, true);
    assert.equal(r.settings.models.openai_compatible, 'qwen3:32b');
    assert.equal(r.settings.models.anthropic, 'claude-opus-5-5');
    const r2 = S.validatePatch(r.settings, { model: 'org/model-v1.5' });
    assert.equal(r2.settings.models.openai_compatible, 'org/model-v1.5');
    const off = S.validatePatch(d, { model: 'claude-sonnet-5-5' });
    assert.deepEqual([off.ok, off.status, off.field], [false, 400, 'model']);
  });

  it("each provider's card saves its own model (models), never into the default's, whatever the default (Off included)", () => {
    const d = { ...S.defaultSettings(), provider: 'anthropic' };
    const r = S.validatePatch(d, { models: { openai_compatible: 'x' } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.settings.models, { anthropic: 'claude-opus-5-5', openai: 'gpt-6.1-sol', openai_compatible: 'x' });
    assert.equal(r.settings.provider, 'anthropic', 'the default stays');
    const two = S.validatePatch(r.settings, { models: { openai: 'gpt-6-luna', anthropic: 'claude-sonnet-5-5' } });
    assert.deepEqual(two.settings.models, { anthropic: 'claude-sonnet-5-5', openai: 'gpt-6-luna', openai_compatible: 'x' });
    const off = S.validatePatch(S.defaultSettings(), { models: { anthropic: 'claude-sonnet-5-5' } });
    assert.equal(off.ok, true, 'with the default Off');
    assert.equal(off.settings.models.anthropic, 'claude-sonnet-5-5');
    // Changing the default changes no provider's model.
    const moved = S.validatePatch(two.settings, { provider: 'openai_compatible' });
    assert.deepEqual(moved.settings.models, two.settings.models);
  });
});

describe('the base URL', () => {
  const d = S.defaultSettings();
  const field = (base_url) => {
    const r = S.validatePatch(d, { base_url });
    assert.equal(r.ok, false, String(base_url));
    assert.equal(r.status, 400, String(base_url));
    assert.equal(r.field, 'base_url');
  };

  it('http or https only, no user info, query or fragment, at most 300 characters', () => {
    field('ftp://127.0.0.1/v1');
    field('file:///C:/x');
    field('http://user:pw@127.0.0.1:1234/v1');
    field('http://user@127.0.0.1:1234/v1');
    field('http://127.0.0.1:1234/v1?key=1');
    field('http://127.0.0.1:1234/v1#x');
    field('http://127.0.0.1:1234/v1?');
    field(`http://127.0.0.1:1234/${'a'.repeat(300)}`);
    field('not a url');
    field('');
    field(42);
  });

  it('a trailing slash goes; a server on this PC needs no confirmation', () => {
    for (const [url, saved] of [
      ['http://127.0.0.1:1234/v1/', 'http://127.0.0.1:1234/v1'],
      ['  http://localhost:11434/v1  ', 'http://localhost:11434/v1'],
      ['http://[::1]:8080/v1', 'http://[::1]:8080/v1'],
      ['https://127.5.6.7/v1', 'https://127.5.6.7/v1'],
    ]) {
      const r = S.validatePatch(d, { base_url: url });
      assert.equal(r.ok, true, url);
      assert.equal(r.settings.base_url, saved);
      assert.equal(r.settings.base_url_confirmed_remote, null);
      assert.equal(S.isLoopbackUrl(saved), true);
    }
  });

  it('a server outside this PC answers 409 needs_confirm until confirmed, then counts as confirmed', () => {
    const remote = 'http://192.168.1.20:1234/v1';
    const asked = S.validatePatch(d, { base_url: remote });
    assert.equal(asked.ok, false);
    assert.equal(asked.status, 409);
    assert.equal(asked.needs_confirm, 'base_url');
    assert.equal(S.validatePatch(d, { base_url: remote, confirm_remote: false }).status, 409);
    const yes = S.validatePatch(d, { base_url: remote, confirm_remote: true });
    assert.equal(yes.ok, true);
    assert.equal(yes.settings.base_url, remote);
    assert.equal(yes.settings.base_url_confirmed_remote, remote);
    // The same server again: already confirmed. Another one: asked again.
    assert.equal(S.validatePatch(yes.settings, { base_url: `${remote}/` }).ok, true);
    assert.equal(S.validatePatch(yes.settings, { base_url: 'https://llm.example.com/v1' }).status, 409);
    assert.equal(S.validatePatch(yes.settings, { base_url: 'http://localhost.example.com/v1' }).status, 409);
    // Back on this PC: the confirmation goes.
    const back = S.validatePatch(yes.settings, { base_url: 'http://127.0.0.1:1234/v1' });
    assert.equal(back.settings.base_url_confirmed_remote, null);
    assert.equal(S.isLoopbackUrl(remote), false);
  });

  it('a settings file naming an unconfirmed remote server falls back to this PC', async () => {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(FILE, JSON.stringify({ version: 1, provider: 'openai_compatible', base_url: 'http://10.0.0.5:1234/v1' }));
    const s = await S.loadSettings();
    assert.equal(s.provider, 'openai_compatible');
    assert.equal(s.base_url, 'http://127.0.0.1:1234/v1');
    const n = S.normalizeSettings({ base_url: 'http://10.0.0.5:1234/v1', base_url_confirmed_remote: 'http://10.0.0.5:1234/v1' });
    assert.equal(n.base_url, 'http://10.0.0.5:1234/v1');
  });

  it('an unreadable or odd file reads as the defaults, field by field', async () => {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(FILE, '{not json');
    assert.deepEqual(await S.loadSettings(), S.defaultSettings());
    const n = S.normalizeSettings({ provider: 'x', effort: 'high', caps: { steps: 500, turn_usd: 2 }, models: { openai: 'bad id' } });
    assert.equal(n.provider, 'off');
    assert.equal(n.effort, 'high');
    assert.equal(n.caps.steps, 50);
    assert.equal(n.caps.turn_usd, 2);
    assert.equal(n.models.openai, 'gpt-6.1-sol');
    assert.deepEqual(S.normalizeSettings({ caps: { turn_usd: 50, day_usd: 10 } }).caps, S.defaultSettings().caps);
  });
});

describe('other apps (MCP)', () => {
  it('a page may switch other apps on and off, and nothing else of it', () => {
    const d = S.defaultSettings();
    const on = S.validatePatch(d, { mcp: { clients: true } });
    assert.equal(on.ok, true);
    assert.deepEqual(on.settings.mcp, { clients: true, port: null, ask_in_client: false });
    assert.deepEqual(S.validatePatch(on.settings, { mcp: {} }).settings.mcp, on.settings.mcp, 'an empty change changes nothing');
    assert.equal(S.validatePatch(on.settings, { mcp: { clients: false } }).settings.mcp.clients, false);
    for (const [patch, field] of [
      [{ mcp: { clients: 'yes' } }, 'mcp.clients'],
      [{ mcp: { port: 4000 } }, 'mcp.port'],
      [{ mcp: { ask_in_client: true } }, 'mcp.ask_in_client'],
      [{ mcp: { clients: true, constructor: 1 } }, 'mcp.constructor'],
      [{ mcp: true }, 'mcp'],
      [{ mcp: [] }, 'mcp'],
    ]) {
      const r = S.validatePatch(d, patch);
      assert.equal(r.ok, false, JSON.stringify(patch));
      assert.equal(r.status, 400);
      assert.equal(r.field, field, JSON.stringify(patch));
    }
  });

  it('a file keeps the switch and a valid port; anything else reads as the default, ask_in_client always false', () => {
    assert.deepEqual(S.normalizeSettings({ mcp: { clients: true, port: 47123, ask_in_client: true } }).mcp, { clients: true, port: 47123, ask_in_client: false });
    for (const port of [0, 65_536, 1.5, '4000', -1, null]) {
      assert.equal(S.normalizeSettings({ mcp: { port } }).mcp.port, null, String(port));
    }
    assert.deepEqual(S.normalizeSettings({ mcp: 'on' }).mcp, S.defaultSettings().mcp);
    assert.deepEqual(S.normalizeSettings({ mcp: { clients: 1 } }).mcp.clients, false);
  });

  it('the switch is saved and read back', async () => {
    const r = await S.saveSettings({ mcp: { clients: true } });
    assert.equal(r.ok, true);
    assert.deepEqual(onDisk().mcp, { clients: true, port: null, ask_in_client: false });
    resetAssistantState();
    assert.equal((await S.loadSettings()).mcp.clients, true);
  });
});

describe('consent: per project and destination', () => {
  it('Send is remembered for that project and destination only; a changed created_at asks again', () => {
    let s = S.defaultSettings();
    assert.equal(S.hasConsent(s, 'p1', '2026-01-01T00:00:00Z', 'anthropic'), false);
    s = S.withConsent(s, 'p1', '2026-01-01T00:00:00Z', 'anthropic', new Date('2026-10-16T10:00:00Z'));
    assert.equal(S.hasConsent(s, 'p1', '2026-01-01T00:00:00Z', 'anthropic'), true);
    assert.equal(S.hasConsent(s, 'p1', '2026-01-01T00:00:00Z', 'openai'), false, 'another destination');
    assert.equal(S.hasConsent(s, 'p1', '2026-01-01T00:00:00Z', 'host:llm.example.com'), false);
    assert.equal(S.hasConsent(s, 'p2', '2026-01-01T00:00:00Z', 'anthropic'), false, 'another project');
    assert.equal(S.hasConsent(s, 'p1', '2026-05-05T00:00:00Z', 'anthropic'), false, 'a project made again under the same id');
    s = S.withConsent(s, 'p1', '2026-01-01T00:00:00Z', 'openai');
    assert.deepEqual(Object.keys(s.consents.p1.to).sort(), ['anthropic', 'openai']);
    assert.equal(s.consents.p1.to.anthropic, '2026-10-16T10:00:00.000Z');
    // A new created_at starts that project's answers afresh.
    s = S.withConsent(s, 'p1', '2026-05-05T00:00:00Z', 'openai');
    assert.deepEqual(s.consents.p1, { created_at: '2026-05-05T00:00:00Z', to: { openai: s.consents.p1.to.openai } });
    assert.equal(S.hasConsent(s, 'p1', '2026-01-01T00:00:00Z', 'anthropic'), false);
    assert.equal(S.consentCount(s), 1);
    // A project with no created_at is its own value.
    s = S.withConsent(s, 'p3', null, 'anthropic');
    assert.equal(S.hasConsent(s, 'p3', null, 'anthropic'), true);
    assert.equal(S.hasConsent(s, 'p3', '2026-01-01T00:00:00Z', 'anthropic'), false);
  });

  it('a project id or destination named like an inherited property is just a name', async () => {
    const odd = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];
    let s = S.defaultSettings();
    for (const pid of odd) {
      assert.equal(S.hasConsent(s, pid, null, 'anthropic'), false, pid);
      assert.equal(S.hasConsent(s, 'p1', null, pid), false, pid);
    }
    for (const pid of odd) s = S.withConsent(s, pid, 'c1', 'anthropic');
    s = S.withConsent(s, 'p1', null, '__proto__');
    assert.equal(Object.getPrototypeOf(s.consents), Object.prototype, 'the map keeps its prototype');
    assert.deepEqual(Object.keys(s.consents).sort(), [...odd, 'p1'].sort());
    assert.equal(S.consentCount(s), odd.length + 1);
    for (const pid of odd) {
      assert.equal(S.hasConsent(s, pid, 'c1', 'anthropic'), true, pid);
      assert.equal(S.hasConsent(s, pid, 'c1', 'openai'), false, pid);
    }
    assert.equal(S.hasConsent(s, 'p1', null, '__proto__'), true);
    assert.equal(S.hasConsent(s, 'p1', null, 'constructor'), false);
    // Written and read back from the file the same way.
    for (const pid of odd) await S.rememberConsent(pid, 'c1', 'anthropic');
    assert.deepEqual(Object.keys(onDisk().consents).sort(), [...odd].sort());
    resetAssistantState();
    const read = await S.loadSettings();
    assert.deepEqual(Object.keys(read.consents).sort(), [...odd].sort());
    for (const pid of odd) assert.equal(S.hasConsent(read, pid, 'c1', 'anthropic'), true, pid);
    assert.equal(S.consentCount(read), odd.length);
  });

  it('remembered on disk, and forgotten all at once', async () => {
    await S.rememberConsent('p1', 'c1', 'anthropic');
    await S.rememberConsent('p2', null, 'host:10.0.0.5');
    assert.equal(S.consentCount(onDisk()), 2);
    assert.equal(S.hasConsent(onDisk(), 'p2', null, 'host:10.0.0.5'), true);
    const r = await S.saveSettings({ forget_consents: true });
    assert.equal(r.ok, true);
    assert.deepEqual(onDisk().consents, {});
    assert.deepEqual((await S.loadSettings()).consents, {});
  });
});

describe('saving', () => {
  it('writes the whole object atomically (0600 on POSIX), and nothing on a refusal', async () => {
    const refused = await S.saveSettings({ caps: { steps: 0 } });
    assert.equal(refused.ok, false);
    assert.equal(existsSync(FILE), false, 'a refused change writes nothing');
    const r = await S.saveSettings({ provider: 'anthropic', effort: 'high' });
    assert.equal(r.ok, true);
    const doc = onDisk();
    assert.deepEqual(doc, r.settings);
    assert.deepEqual(Object.keys(doc).sort(), Object.keys(S.DEFAULT_SETTINGS).sort(), 'the whole object');
    assert.deepEqual(tempFiles(), []);
    if (process.platform !== 'win32') {
      assert.equal(statSync(FILE).mode & 0o777, 0o600);
      assert.equal(statSync(DATA).mode & 0o777, 0o700);
    }
    // A later process reads what was written.
    resetAssistantState();
    assert.equal((await S.loadSettings()).effort, 'high');
  });

  it('one queue: concurrent saves all land, in order, and memory equals the file', async () => {
    const patches = [
      { provider: 'openai' },
      { caps: { steps: 7 } },
      { caps: { turn_minutes: 9 } },
      { privacy: 'deny' },
      { model: 'gpt-6-luna' },
      { caps: { turn_tokens: 20_000 } },
      { effort: 'low' },
      { caps: { day_usd: 40 } },
      { caps: { turn_usd: 30 } },
      { effort: 'medium' },
    ];
    const results = await Promise.all(patches.map((p) => S.saveSettings(p)));
    assert.ok(results.every((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok)));
    const s = await S.loadSettings();
    assert.equal(s.provider, 'openai');
    assert.equal(s.models.openai, 'gpt-6-luna');
    assert.equal(s.privacy, 'deny');
    assert.equal(s.effort, 'medium');
    assert.deepEqual(s.caps, { turn_usd: 30, day_usd: 40, steps: 7, turn_minutes: 9, turn_tokens: 20_000 });
    assert.deepEqual(onDisk(), s);
    assert.deepEqual(tempFiles(), []);
  });
});

describe('none of it reaches the app prefs', () => {
  it('publicPrefs() and GET /api/prefs carry no Assistant setting, and the local settings file holds none', async () => {
    await S.saveSettings({ provider: 'anthropic', privacy: 'allow', caps: { turn_usd: 1 } });
    await S.rememberConsent('p1', 'c1', 'anthropic');
    const { publicPrefs } = await import('../../prefs.js');
    const { handlePrefsApi } = await import('../../w32-prefs.js');
    let body = null;
    await handlePrefsApi({ method: 'GET' }, {}, new URL('http://127.0.0.1/api/prefs'), ['api', 'prefs'], {
      sendJson: (_res, _status, b) => {
        body = b;
      },
      readJsonBody: async () => ({}),
    });
    const ASSISTANT_WORDS = /assistant|provider|privacy|consent|caps|turn_usd|day_usd|base_url|model|effort|secret|api_?key/i;
    for (const [name, doc] of [['publicPrefs', publicPrefs()], ['GET /api/prefs', body]]) {
      assert.ok(doc && doc.ok, name);
      for (const key of Object.keys(doc)) assert.doesNotMatch(key, ASSISTANT_WORDS, `${name}.${key}`);
      assert.doesNotMatch(JSON.stringify(doc), /anthropic|claude|gpt-6/i, name);
    }
    const local = process.env.MAGNUSIM_LOCAL_JSON;
    if (existsSync(local)) assert.doesNotMatch(readFileSync(local, 'utf8'), ASSISTANT_WORDS);
  });
});
