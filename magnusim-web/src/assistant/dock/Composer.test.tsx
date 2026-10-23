// The dock's composer (phase 4 spec 3): sending, the body per context, the limits, every line
// that holds Send back, Stop, and the context chip.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantStatus, ConversationRow } from '../wire';
import { Composer, contextChip, placeholderOf } from './Composer';
import type { DockPlace } from './context';
import type { PictureDeps } from './pictures';
import { turnBody } from './send';
import { dockStoreSnapshot, resetDockStoreForTests } from './store';

const wizard = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../wizard/controller', () => ({ openSetupWizard: wizard.open }));
const relay = vi.hoisted(() => ({ links: [] as Array<string | null> }));
vi.mock('../relay', () => ({
  // This tab's link: L1, then L2 once L1 was refused.
  withAssistantLink: async (use: (link: string | null) => Promise<unknown>, avoid: string | null = null) => {
    const link = avoid ? 'L2' : 'L1';
    relay.links.push(avoid);
    return use(link);
  },
}));
vi.mock('../../api/eventHub', () => ({
  openChannel: () => ({ CONNECTING: 0, OPEN: 1, CLOSED: 2, readyState: 0, addEventListener() {}, removeEventListener() {}, close() {}, pin() {} }),
}));

const HOME: DockPlace = { projectId: null, projectTitle: null, simulationId: null, workspace: null };
const PROJECT: DockPlace = { projectId: 'p1', projectTitle: 'Wing', simulationId: 's1', workspace: null };
const WS = (state: 'tools' | 'connecting' | 'late' | 'none'): DockPlace => ({ ...PROJECT, workspace: { plugin: 'ai-demo', key: 'counter', name: 'Counter', state } });

const ready = (label: string, kind = 'key', ok = true, billing = 'usd', detail = '') => ({ label, kind, ready: ok, reason: ok ? null : 'no_key', billing, detail });
const status = (def: string, rows: Record<string, unknown>): AssistantStatus => ({ provider: def, default_provider: def, providers_ready: rows, caps: { turn_usd: 8, day_usd: 15 } }) as unknown as AssistantStatus;
const LOCAL = status('openai_compatible', { openai_compatible: ready('Local server', 'server', true, 'free', 'qwen'), 'agent:helper': ready('Helper', 'agent', true, 'agent_account') });

let posts: Array<{ url: string; body: Record<string, unknown> }> = [];
let answers: Array<[number, Record<string, unknown>]> = [];

beforeEach(() => {
  resetDockStoreForTests();
  sessionStorage.clear();
  posts = [];
  answers = [];
  relay.links = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        const [st, body] = answers.shift() ?? [202, { ok: true, conversation: 'c1', turn: 't1', answer_key: 'k1' }];
        return new Response(JSON.stringify(body), { status: st });
      }
      return new Response(JSON.stringify({ ok: true, conversations: [] }), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetDockStoreForTests();
});

const mount = (o: Partial<Parameters<typeof Composer>[0]> = {}) =>
  render(<Composer place={HOME} status={LOCAL} conversation={null} conversationId={null} running={null} onNew={() => undefined} {...o} />);
const area = () => screen.getByRole('textbox', { name: 'Message to the Assistant' }) as HTMLTextAreaElement;
const sendButton = () => document.querySelector('[data-dock-send]') as HTMLButtonElement;
const line = () => document.querySelector('[data-dock-blocked]')?.textContent ?? null;

describe('typing and sending', () => {
  it('Enter sends; Shift+Enter is a newline; Enter while composing never sends', async () => {
    mount();
    expect(area().placeholder).toBe('Ask the Assistant…');
    expect(screen.getByText('Enter sends · Shift+Enter for a new line')).toBeTruthy();
    fireEvent.change(area(), { target: { value: 'Two\nlines' } });
    expect(fireEvent.keyDown(area(), { key: 'Enter', shiftKey: true })).toBe(true);
    fireEvent.keyDown(area(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(area(), { key: 'Enter', keyCode: 229 });
    expect(posts).toEqual([]);
    await act(async () => {
      fireEvent.keyDown(area(), { key: 'Enter' });
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/assistant/turns', body: { text: 'Two\nlines', provider: 'openai_compatible', link: 'L1' } });
    await waitFor(() => expect(area().value).toBe(''));
    expect(sessionStorage.getItem('mg.assistant.dock.keys')).toBe('{"t1":"k1"}');
  });

  it('counts from 18,000 characters; past 20,000 Send is disabled', () => {
    mount();
    fireEvent.change(area(), { target: { value: 'x'.repeat(17_999) } });
    expect(document.querySelector('[data-dock-count]')).toBeNull();
    fireEvent.change(area(), { target: { value: 'x'.repeat(18_000) } });
    expect(document.querySelector('[data-dock-count]')?.textContent).toBe('18,000 of 20,000 characters');
    expect(sendButton().disabled).toBe(false);
    fireEvent.change(area(), { target: { value: 'x'.repeat(20_001) } });
    expect(sendButton().disabled).toBe(true);
  });

  it("a refusal shows the server's words; the draft stays; a stale link goes once more with a fresh one", async () => {
    answers = [
      [409, { ok: false, code: 'no_channel', error: 'This window lost its connection to Magnusim. Try again.' }],
      [400, { ok: false, code: 'cap_day', error: "Today's $15.00 limit is reached; it resets at midnight." }],
    ];
    mount();
    fireEvent.change(area(), { target: { value: 'Hello' } });
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("Today's $15.00 limit is reached; it resets at midnight."));
    expect(posts.map((p) => p.body.link)).toEqual(['L1', 'L2']);
    expect(relay.links).toEqual([null, 'L1']);
    expect(area().value).toBe('Hello');
    expect(sessionStorage.getItem('mg.assistant.dock.draft.new')).toBe('Hello');
  });
});

describe('the body per context', () => {
  const send = { text: 'x', conversation: null, provider: 'p', pictures: [] };
  it('tab:link only with the workspace whose tools the server took; else the project; from Home neither', () => {
    expect(turnBody({ ...send, place: WS('tools') })).toEqual({ text: 'x', provider: 'p', tab: 'link' });
    for (const s of ['connecting', 'late', 'none'] as const) expect(turnBody({ ...send, place: WS(s) })).toEqual({ text: 'x', provider: 'p', context: { project_id: 'p1', simulation_id: 's1' } });
    expect(turnBody({ ...send, place: PROJECT })).toEqual({ text: 'x', provider: 'p', context: { project_id: 'p1', simulation_id: 's1' } });
    expect(turnBody({ ...send, place: HOME })).toEqual({ text: 'x', provider: 'p' });
    // A conversation keeps its provider: only its id goes.
    expect(turnBody({ ...send, conversation: 'c9', place: HOME })).toEqual({ text: 'x', conversation: 'c9' });
    const pic = { media_type: 'image/png' as const, data: 'AAAA', width: 1, height: 1, name: 'a.png', shrunk: false, blob: new Blob() };
    expect(turnBody({ ...send, place: HOME, pictures: [pic] }).images).toEqual([{ media_type: 'image/png', data: 'AAAA' }]);
  });

  it('the context chip and the placeholder', () => {
    expect([HOME, PROJECT, WS('tools'), WS('connecting'), WS('late'), WS('none')].map((p) => contextChip(p, 'Wing'))).toEqual([
      'Home · no project',
      'Project: Wing',
      'Counter in Wing',
      'Counter · connecting…',
      'Counter offers no tools now · the Assistant can read the project only',
      'Counter offers no tools · Project: Wing',
    ]);
    expect([HOME, PROJECT, WS('tools'), WS('none')].map(placeholderOf)).toEqual(['Ask the Assistant…', 'Ask about this project…', 'Tell the Assistant what to do in Counter…', 'Ask about this project…']);
  });
});

describe('what holds Send back', () => {
  it('the Assistant off and nothing picked: the line and Open Settings', () => {
    mount({ status: status('off', { first: ready('Cloud A', 'key', false, 'usd', 'No key') }) });
    expect(line()).toBe('The Assistant is off. Choose a provider in Settings → Assistant.');
    fireEvent.click(document.querySelector('[data-dock-open-settings]') as HTMLElement);
    expect(wizard.open).toHaveBeenCalledWith({ required: false, step: 'assistant' });
    fireEvent.change(area(), { target: { value: 'Hi' } });
    expect(sendButton().disabled).toBe(true);
  });

  it('the provider not ready', () => {
    mount({ status: status('first', { first: ready('Cloud A', 'key', false, 'usd', 'No key') }) });
    expect(line()).toBe('Cloud A: No key. Settings → Assistant can fix it.');
  });

  it('a workspace still offering its tools', () => {
    mount({ place: WS('connecting') });
    expect(line()).toBe('Waiting for Counter to offer its tools…');
  });

  it('a full conversation, and one that ended: New conversation', async () => {
    const onNew = vi.fn();
    const conv = { id: 'c1', provider: 'openai_compatible', label: 'Local server', full: 'messages' } as unknown as ConversationRow;
    const { unmount } = mount({ conversation: conv, conversationId: 'c1', onNew });
    expect(line()).toBe('This conversation is full. Start a new one.');
    fireEvent.click(document.querySelector('[data-dock-new-line]') as HTMLElement);
    expect(onNew).toHaveBeenCalledTimes(1);
    unmount();
    answers = [[404, { ok: false, code: 'unknown_conversation', error: 'That conversation has ended (2 hours idle, or forgotten). Start a new one.' }]];
    mount({ conversation: { ...conv, full: null }, conversationId: 'c1' });
    fireEvent.change(area(), { target: { value: 'Hi' } });
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await waitFor(() => expect(line()).toBe('That conversation has ended (2 hours idle, or forgotten). Start a new one.'));
    expect(posts[0].body).toEqual({ text: 'Hi', conversation: 'c1', link: 'L1' });
    expect(document.querySelector('[data-dock-provider-locked]')?.textContent).toBe('Provider: Local server');
  });

  it("a coding agent takes no pictures: Attach is off and says why; a paste says so too", async () => {
    sessionStorage.setItem('mg.assistant.dock.provider', JSON.stringify({ home: 'agent:helper' }));
    mount();
    const attach = document.querySelector('[data-dock-attach]') as HTMLButtonElement;
    expect(attach.disabled).toBe(true);
    expect(attach.title).toBe("Helper doesn't take pictures. Send the message without them.");
    const f = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'a.png', { type: 'image/png' });
    fireEvent.paste(area(), { clipboardData: { files: [f], items: [] } });
    expect(document.querySelector('[data-dock-picture-error]')?.textContent).toBe("Helper doesn't take pictures. Send the message without them.");
  });

  it('pictures: chips with their size, shrunk, removed; the line under them', async () => {
    const deps: PictureDeps = { size: async () => ({ width: 2600, height: 1300, draw: async () => new Blob([new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80])]) }) };
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
    mount({ pictureDeps: deps });
    const input = document.querySelector('[data-dock-file]') as HTMLInputElement;
    const f = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'wide.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [f] } });
    });
    await waitFor(() => expect(document.querySelector('[data-dock-picture-chip]')?.textContent).toContain('wide.png · 2000 × 1000'));
    expect(screen.getByText('Shrunk to 2000 × 1000 px to fit')).toBeTruthy();
    expect(screen.getByText('Pictures go to the provider with your message.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove wide.png' }));
    expect(document.querySelector('[data-dock-picture-chip]')).toBeNull();
  });
});

describe('Stop', () => {
  it('replaces Send while its request runs; it stops that request', async () => {
    answers = [[200, { ok: true, stopping: true }]];
    mount({ conversation: { id: 'c1', provider: 'openai_compatible', label: 'Local server', full: null } as unknown as ConversationRow, conversationId: 'c1', running: 't7' });
    expect(sendButton()).toBeNull();
    expect(screen.getByText('The Assistant is working on your last message.')).toBeTruthy();
    const stop = document.querySelector('[data-dock-stop]') as HTMLButtonElement;
    expect(stop.textContent).toBe('Stop');
    await act(async () => {
      fireEvent.click(stop);
    });
    await waitFor(() => expect(posts.map((p) => p.url)).toEqual(['/api/assistant/turns/t7/stop']));
  });

  it("a Stop that doesn't reach the server says so, and the request isn't shown as stopping", async () => {
    answers = [[500, { ok: false, error: 'boom' }]];
    mount({ conversation: { id: 'c1', provider: 'openai_compatible', label: 'Local server', full: null } as unknown as ConversationRow, conversationId: 'c1', running: 't7' });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-dock-stop]') as HTMLButtonElement);
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("The Stop didn't reach Magnusim's server, so the request goes on. Try Stop again."));
    expect(dockStoreSnapshot().stops.t7).toBeUndefined();
  });
});
