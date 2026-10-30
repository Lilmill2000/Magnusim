// The dock's composer (phase 4 spec 3): sending, the body per context, the limits, every line
// that holds Send back, Stop, and the context chip. What it offers to attach is checked with
// drawings offered and not (drawings.ts), whatever ships.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantStatus, ConversationRow } from '../wire';
import { Composer, contextChip, placeholderOf } from './Composer';
import { CARRY_LINE, CONTINUE_IN_NEW_CHAT } from './copy';
import type { DockPlace } from './context';
import { setDrawingsOfferedForTests } from './drawings';
import type { PictureDeps } from './pictures';
import { turnBody } from './send';
import { dockStoreSnapshot, resetDockStoreForTests } from './store';

const wizard = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../wizard/controller', () => ({ openSetupWizard: wizard.open }));
const relay = vi.hoisted(() => ({ links: [] as Array<string | null>, core: new Set<string>() }));
vi.mock('../relay', () => ({
  // This tab's link: L1, then L2 once L1 was refused.
  withAssistantLink: async (use: (link: string | null) => Promise<unknown>, avoid: string | null = null) => {
    const link = avoid ? 'L2' : 'L1';
    relay.links.push(avoid);
    return use(link);
  },
  // The links the server holds this tab's core registration on (core host tools spec C7).
  coreRegisteredOn: (link: string | null) => !!link && relay.core.has(link),
}));
vi.mock('../../api/eventHub', () => ({
  openChannel: () => ({ CONNECTING: 0, OPEN: 1, CLOSED: 2, readyState: 0, addEventListener() {}, removeEventListener() {}, close() {}, pin() {} }),
}));

const HOME: DockPlace = { projectId: null, projectTitle: null, simulationId: null, workspace: null };
const PROJECT: DockPlace = { projectId: 'p1', projectTitle: 'Wing', simulationId: 's1', workspace: null };
const WS = (state: 'tools' | 'connecting' | 'late' | 'none'): DockPlace => ({ ...PROJECT, workspace: { plugin: 'ai-demo', key: 'counter', name: 'Counter', state } });

const ready = (label: string, kind = 'key', ok = true, billing = 'usd', detail = '') => ({ label, kind, ready: ok, reason: ok ? null : 'no_key', billing, detail });
const status = (def: string, rows: Record<string, unknown>): AssistantStatus => ({ provider: def, default_provider: def, providers_ready: rows, caps: { turn_usd: 8, day_usd: 15 } }) as unknown as AssistantStatus;
/** The coding agent's row: whether it takes pictures as its status says (left out: a server that doesn't say, not known). */
const helperRow = (images?: boolean | null) => ({ ...ready('Helper', 'agent', true, 'agent_account'), ...(images === undefined ? {} : { images }) });
const withHelper = (images?: boolean | null) => status('openai_compatible', { openai_compatible: ready('Local server', 'server', true, 'free', 'qwen'), 'agent:helper': helperRow(images) });
const LOCAL = withHelper();
/** Its last start said it takes no pictures. */
const HELPER_NO_PICTURES = withHelper(false);

/** What the composer names as attachable, with drawings offered (drawings.ts) and without. */
const GEOMETRY_ACCEPT = '.step,.stp,.iges,.igs,.brep,.brp,.stl,.obj,.ply';
const OFFERS = {
  on: {
    acceptAll: `image/png,image/jpeg,image/webp,${GEOMETRY_ACCEPT},.svg,.dxf`,
    acceptFiles: `${GEOMETRY_ACCEPT},.svg,.dxf`,
    attachFiles: "Attach geometry files or drawings (Helper doesn't take pictures)",
    dropAll: 'Drop pictures, geometry files or drawings to attach',
    dropFiles: 'Drop geometry files or drawings to attach',
    onlyFiles: 'Only pictures, geometry files (STEP, IGES, BREP, STL, OBJ, PLY) and drawings (SVG, DXF) can be attached.',
  },
  off: {
    acceptAll: `image/png,image/jpeg,image/webp,${GEOMETRY_ACCEPT}`,
    acceptFiles: GEOMETRY_ACCEPT,
    attachFiles: "Attach geometry files (Helper doesn't take pictures)",
    dropAll: 'Drop pictures or geometry files to attach',
    dropFiles: 'Drop geometry files to attach',
    onlyFiles: 'Only pictures and geometry files (STEP, IGES, BREP, STL, OBJ, PLY) can be attached.',
  },
} as const;
const SETTINGS = ['on', 'off'] as const;
/** Drawings offered or not for this test, and the words the composer says then. */
const offer = (s: (typeof SETTINGS)[number]) => {
  setDrawingsOfferedForTests(s === 'on');
  return OFFERS[s];
};

let posts: Array<{ url: string; body: Record<string, unknown> }> = [];
let answers: Array<[number, Record<string, unknown>]> = [];

beforeEach(() => {
  resetDockStoreForTests();
  sessionStorage.clear();
  posts = [];
  answers = [];
  relay.links = [];
  relay.core = new Set();
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
  setDrawingsOfferedForTests(null);
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

  it('a window whose core registration the server holds on the link binds the turn to it, from Home and the workbench (core host tools spec 11.3)', async () => {
    // The server holds it on L2 only: the first link's attempt goes unbound, the fresh one bound.
    relay.core = new Set(['L2']);
    answers = [[409, { ok: false, code: 'no_channel', error: 'This window lost its connection to Magnusim. Try again.' }]];
    mount({ place: PROJECT });
    fireEvent.change(area(), { target: { value: 'Open it' } });
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[0].body).toEqual({ text: 'Open it', provider: 'openai_compatible', context: { project_id: 'p1', simulation_id: 's1' }, link: 'L1' });
    expect(posts[1].body).toEqual({ text: 'Open it', provider: 'openai_compatible', tab: 'link', link: 'L2' });
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
    // The window's core registration on the link (C7): bound from Home and the workbench too.
    for (const place of [HOME, PROJECT, WS('connecting')]) expect(turnBody({ ...send, place }, true)).toEqual({ text: 'x', provider: 'p', tab: 'link' });
    // A conversation keeps its provider: only its id goes; one that continues another, that one's.
    expect(turnBody({ ...send, conversation: 'c9', place: HOME })).toEqual({ text: 'x', conversation: 'c9' });
    expect(turnBody({ ...send, carryFrom: 'c8', place: HOME })).toEqual({ text: 'x', carry_from: 'c8' });
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
    // The server's words name the limit with its numbers.
    const said = 'This conversation is full: it holds 100 pictures, and Magnusim keeps at most 100 in one conversation. Start a new one.';
    const named = mount({ conversation: { ...conv, full: 'images', full_text: said } as unknown as ConversationRow, conversationId: 'c1', onNew });
    expect(line()).toBe(said);
    expect((document.querySelector('[data-dock-send]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('[data-dock-continue]')?.textContent).toBe(CONTINUE_IN_NEW_CHAT);
    named.unmount();
    const { unmount } = mount({ conversation: conv, conversationId: 'c1', onNew });
    expect(line(), 'an older server names no limit').toBe('This conversation is full. Start a new one.');
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
    expect(document.querySelector('[data-dock-continue]'), 'an ended one has nothing to carry').toBeNull();
  });

  it('Continue in a new chat: the text typed moves into a new conversation, which says what goes with it, keeps the provider and sends carry_from; a send refused full offers it too', async () => {
    const said = 'This conversation is full: it has 300 messages, and one conversation holds at most 300. Start a new one.';
    const conv = { id: 'c1', provider: 'openai_compatible', label: 'Local server', project_id: 'p1', full: null } as unknown as ConversationRow;
    answers = [[409, { ok: false, code: 'conversation_full', error: said }]];
    const view = mount({ place: PROJECT, conversation: conv, conversationId: 'c1' });
    fireEvent.change(area(), { target: { value: 'Now the hands.' } });
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await waitFor(() => expect(line()).toBe(said));
    expect(document.querySelector('[data-dock-carry]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: CONTINUE_IN_NEW_CHAT }));
    const snap = dockStoreSnapshot();
    expect([snap.shown, snap.carry]).toEqual([null, { from: 'c1', provider: 'openai_compatible', label: 'Local server' }]);
    expect([sessionStorage.getItem('mg.assistant.dock.draft.c1'), sessionStorage.getItem('mg.assistant.dock.draft.new')]).toEqual([null, 'Now the hands.']);
    // The dock shows the new conversation (ConversationView passes the store's carry).
    view.rerender(<Composer place={PROJECT} status={LOCAL} conversation={null} conversationId={null} running={null} onNew={() => undefined} carry={snap.carry} />);
    expect(area().value).toBe('Now the hands.');
    expect(document.querySelector('[data-dock-carry]')?.textContent).toBe(CARRY_LINE);
    expect(document.querySelector('[data-dock-provider-locked]')?.textContent).toBe('Provider: Local server');
    expect([line(), sendButton().disabled]).toEqual([null, false]);
    answers = [[202, { ok: true, conversation: 'c2', turn: 't2', answer_key: 'k2' }]];
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1].body).toEqual({ text: 'Now the hands.', carry_from: 'c1', context: { project_id: 'p1', simulation_id: 's1' }, link: 'L1' });
    expect(dockStoreSnapshot()).toMatchObject({ shown: 'c2', carry: null });
  });

  for (const s of SETTINGS) {
    it(`a coding agent whose status says it takes no pictures: Attach says so and takes geometry files (and drawings while offered) only; a pasted picture is refused (drawings ${s})`, async () => {
      const w = offer(s);
      sessionStorage.setItem('mg.assistant.dock.provider', JSON.stringify({ home: 'agent:helper' }));
      mount({ status: HELPER_NO_PICTURES });
      const attach = document.querySelector('[data-dock-attach]') as HTMLButtonElement;
      expect(attach.disabled).toBe(false);
      expect(attach.title).toBe(w.attachFiles);
      expect(attach.getAttribute('aria-label')).toBe(w.attachFiles);
      expect((document.querySelector('[data-dock-file]') as HTMLInputElement).accept).toBe(w.acceptFiles);
      const f = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'a.png', { type: 'image/png' });
      fireEvent.paste(area(), { clipboardData: { files: [f], items: [] } });
      expect(document.querySelector('[data-dock-picture-error]')?.textContent).toBe("Helper doesn't take pictures. Send the message without them.");
    });

    it(`a coding agent that takes no pictures: a picture dropped on the dock says it takes none (never left for the browser to open); the overlay names what it takes (drawings ${s})`, async () => {
      const w = offer(s);
      sessionStorage.setItem('mg.assistant.dock.provider', JSON.stringify({ home: 'agent:helper' }));
      render(
        <aside id="assistant-dock">
          <Composer place={HOME} status={HELPER_NO_PICTURES} conversation={null} conversationId={null} running={null} onNew={() => undefined} />
        </aside>,
      );
      const panel = document.getElementById('assistant-dock') as HTMLElement;
      const f = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'a.png', { type: 'image/png' });
      const dt = { types: ['Files'], files: [f], items: [] };
      expect(fireEvent.dragEnter(panel, { dataTransfer: dt })).toBe(false);
      expect(document.querySelector('[data-dock-drop]')?.textContent).toBe(w.dropFiles);
      expect(fireEvent.drop(panel, { dataTransfer: dt })).toBe(false);
      await waitFor(() => expect(document.querySelector('[data-dock-picture-error]')?.textContent).toBe("Helper doesn't take pictures. Send the message without them."));
      expect(document.querySelector('[data-dock-picture-chip]')).toBeNull();
    });
  }

  for (const [how, images] of [
    ['takes them', true],
    ['not known yet', null],
    ["a server that doesn't say", undefined],
  ] as const) {
    it(`a coding agent whose status says it ${how === 'takes them' ? 'takes pictures' : `may (${how})`}: Attach, paste and drop take pictures as for any provider; the line names the agent; Send goes with them`, async () => {
      // Drawings on: the words with drawings (the cases above check both).
      const w = offer('on');
      sessionStorage.setItem('mg.assistant.dock.provider', JSON.stringify({ home: 'agent:helper' }));
      const deps: PictureDeps = { size: async () => ({ width: 10, height: 10, draw: async () => new Blob() }) };
      vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
      render(
        <aside id="assistant-dock">
          <Composer place={HOME} status={withHelper(images)} conversation={null} conversationId={null} running={null} onNew={() => undefined} pictureDeps={deps} />
        </aside>,
      );
      const attach = document.querySelector('[data-dock-attach]') as HTMLButtonElement;
      expect(attach.title).toBe('Attach pictures or files');
      expect(attach.getAttribute('aria-label')).toBe('Attach pictures or files');
      expect((document.querySelector('[data-dock-file]') as HTMLInputElement).accept).toBe(w.acceptAll);
      const png = (name: string) => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], name, { type: 'image/png' });
      await act(async () => {
        fireEvent.change(document.querySelector('[data-dock-file]') as HTMLInputElement, { target: { files: [png('picked.png')] } });
      });
      await act(async () => {
        fireEvent.paste(area(), { clipboardData: { files: [png('pasted.png')], items: [] } });
      });
      const panel = document.getElementById('assistant-dock') as HTMLElement;
      const dt = { types: ['Files'], files: [png('dropped.png')], items: [] };
      fireEvent.dragEnter(panel, { dataTransfer: dt });
      expect(document.querySelector('[data-dock-drop]')?.textContent).toBe(w.dropAll);
      await act(async () => {
        fireEvent.drop(panel, { dataTransfer: dt });
      });
      await waitFor(() => expect(Array.from(document.querySelectorAll('[data-dock-picture-chip]')).map((c) => c.getAttribute('data-dock-picture-chip'))).toEqual(['picked.png', 'pasted.png', 'dropped.png']));
      expect(document.querySelector('[data-dock-picture-error]')).toBeNull();
      expect(document.querySelector('[data-dock-pictures-note]')?.textContent).toBe('Pictures go to Helper with your message, and on to its own service.');
      fireEvent.change(area(), { target: { value: 'Like this' } });
      expect(line()).toBeNull();
      expect(sendButton().disabled).toBe(false);
      await act(async () => {
        fireEvent.click(sendButton());
      });
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0].body.provider).toBe('agent:helper');
      expect((posts[0].body.images as unknown[]).length).toBe(3);
    });
  }

  it("pictures attached, then the agent's status says it takes none (its start said so): Send is held with the line that says why; the server's refusal of them shows as any refusal", async () => {
    const w = offer('on');
    sessionStorage.setItem('mg.assistant.dock.provider', JSON.stringify({ home: 'agent:helper' }));
    const deps: PictureDeps = { size: async () => ({ width: 10, height: 10, draw: async () => new Blob() }) };
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
    const { rerender } = mount({ status: withHelper(null), pictureDeps: deps });
    const f = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'a.png', { type: 'image/png' });
    await act(async () => {
      fireEvent.paste(area(), { clipboardData: { files: [f], items: [] } });
    });
    await waitFor(() => expect(document.querySelector('[data-dock-picture-chip]')).not.toBeNull());
    fireEvent.change(area(), { target: { value: 'Like this' } });
    rerender(<Composer place={HOME} status={HELPER_NO_PICTURES} conversation={null} conversationId={null} running={null} onNew={() => undefined} pictureDeps={deps} />);
    expect(line()).toBe("Helper doesn't take pictures. Send the message without them.");
    expect(sendButton().disabled).toBe(true);
    expect((document.querySelector('[data-dock-attach]') as HTMLButtonElement).title).toBe(w.attachFiles);
    // Removed: Send goes.
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    expect(sendButton().disabled).toBe(false);
  });

  it("a coding agent's request that ends: the status is read again (what its start said of pictures shows for the next message)", async () => {
    const conv = { id: 'c1', provider: 'agent:helper', label: 'Helper', full: null } as unknown as ConversationRow;
    const { rerender } = mount({ conversation: conv, conversationId: 'c1', running: 't7' });
    const statusReads = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/api/assistant/status')).length;
    expect(statusReads()).toBe(0);
    rerender(<Composer place={HOME} status={LOCAL} conversation={conv} conversationId="c1" running={null} onNew={() => undefined} />);
    await waitFor(() => expect(statusReads()).toBe(1));
    // Not an agent's: nothing read.
    const other = { id: 'c2', provider: 'openai_compatible', label: 'Local server', full: null } as unknown as ConversationRow;
    rerender(<Composer place={HOME} status={LOCAL} conversation={other} conversationId="c2" running="t8" onNew={() => undefined} />);
    rerender(<Composer place={HOME} status={LOCAL} conversation={other} conversationId="c2" running={null} onNew={() => undefined} />);
    await act(async () => undefined);
    expect(statusReads()).toBe(1);
  });

  for (const s of SETTINGS) {
    it(`Attach stays on while a request runs (the next message can take pictures, as a paste or drop can); its accept list names what is offered (drawings ${s})`, () => {
      const w = offer(s);
      mount({ conversation: { id: 'c1', provider: 'openai_compatible', label: 'Local server', full: null } as unknown as ConversationRow, conversationId: 'c1', running: 't7' });
      const attach = document.querySelector('[data-dock-attach]') as HTMLButtonElement;
      expect(attach.disabled).toBe(false);
      expect(attach.title).toBe('Attach pictures or files');
      expect(attach.getAttribute('aria-label')).toBe('Attach pictures or files');
      expect((document.querySelector('[data-dock-file]') as HTMLInputElement).accept).toBe(w.acceptAll);
    });
  }

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

describe('files (core host tools spec 13.1)', () => {
  /** A scripted upload: each call held until the test answers it, its progress reported on demand. */
  function uploads() {
    const calls: Array<{ file: File; link: string | null; progress: (f: number) => void; signal: AbortSignal; answer: (status: number, body: Record<string, unknown>) => void }> = [];
    const send = (file: File, link: string | null, progress: (f: number) => void, signal: AbortSignal) =>
      new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => calls.push({ file, link, progress, signal, answer: (status, body) => resolve({ status, body }) }));
    return { calls, send };
  }
  const geometry = (name: string, size = 10) => new File([new Uint8Array(size)], name);
  const pick = async (files: File[]) => {
    await act(async () => {
      fireEvent.change(document.querySelector('[data-dock-file]') as HTMLInputElement, { target: { files } });
    });
  };
  const chips = () => Array.from(document.querySelectorAll('[data-dock-file-chip]'));

  it('a STEP file: its chip with name and size, a progress bar while it uploads, Send held until it is up; the request names it; the line under the chips', async () => {
    const up = uploads();
    mount({ uploadSend: up.send });
    fireEvent.change(area(), { target: { value: 'Import it' } });
    await pick([geometry('bracket.step', Math.round(4.2 * 1024 * 1024))]);
    expect(chips().map((c) => c.querySelector('.dock-chip-text > span')?.textContent)).toEqual(['bracket.step · 4.2 MB']);
    expect(chips()[0].getAttribute('data-dock-file-state')).toBe('uploading');
    expect(screen.getByText('Files stay on this PC. The Assistant gets their names and can import them into the project open here. A workspace tool may read one, and what it reports goes to the provider.')).toBeTruthy();
    expect(line()).toBe('Waiting for bracket.step to finish uploading…');
    expect(sendButton().disabled).toBe(true);
    await waitFor(() => expect(up.calls).toHaveLength(1));
    expect(up.calls[0].link).toBe('L1');
    act(() => up.calls[0].progress(0.5));
    const bar = screen.getByRole('progressbar', { name: 'Uploading bracket.step' });
    expect(bar.getAttribute('aria-valuenow')).toBe('50');
    await act(async () => up.calls[0].answer(200, { ok: true, attachment_id: 'att-0123456789abcdef', name: 'bracket.step', bytes: 4404019, kind: 'geometry', format: 'step' }));
    await waitFor(() => expect(chips()[0].getAttribute('data-dock-file-state')).toBe('ready'));
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(sendButton().disabled).toBe(false);
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toEqual({ text: 'Import it', provider: 'openai_compatible', link: 'L1', attachments: ['att-0123456789abcdef'] });
    await waitFor(() => expect(chips()).toHaveLength(0));
  });

  for (const s of SETTINGS) {
    it(`another type refused plainly, before anything is sent, in the words of what is offered (drawings ${s})`, async () => {
      const w = offer(s);
      const up = uploads();
      mount({ uploadSend: up.send });
      await pick([geometry('notes.txt'), geometry('plugin.zip')]);
      expect(Array.from(document.querySelectorAll('[data-dock-file-error]')).map((e) => e.textContent)).toEqual([w.onlyFiles]);
      expect(chips()).toHaveLength(0);
      expect(up.calls).toHaveLength(0);
    });
  }

  it('refused plainly: over 500 MB, a fifth file; what the server refuses; a stale link tried once more', async () => {
    const up = uploads();
    mount({ uploadSend: up.send });
    const big = geometry('huge.stl');
    Object.defineProperty(big, 'size', { value: 600 * 1024 * 1024 });
    await pick([big]);
    expect(Array.from(document.querySelectorAll('[data-dock-file-error]')).map((e) => e.textContent)).toEqual(['huge.stl is larger than 500 MB. Import it with + Add geometry.']);
    expect(up.calls).toHaveLength(0);
    await pick(['a.step', 'b.igs', 'c.brep', 'd.obj', 'e.ply'].map((n) => geometry(n)));
    expect(chips()).toHaveLength(4);
    expect(document.querySelector('[data-dock-file-error]')?.textContent).toBe('At most 4 files per message.');
    await waitFor(() => expect(up.calls).toHaveLength(4));
    // The server's words: the chip goes and the line stays.
    await act(async () => up.calls[0].answer(400, { ok: false, code: 'bad_type', error: "a.step doesn't look like a STEP file." }));
    await waitFor(() => expect(chips()).toHaveLength(3));
    expect(Array.from(document.querySelectorAll('[data-dock-file-error]')).map((e) => e.textContent)).toContain("a.step doesn't look like a STEP file.");
    // A link the server no longer takes: once more with a fresh one.
    await act(async () => up.calls[1].answer(409, { ok: false, code: 'no_channel', error: 'This window lost its connection to Magnusim. Try again.' }));
    await waitFor(() => expect(up.calls).toHaveLength(5));
    expect(up.calls[4].link).toBe('L2');
    await act(async () => up.calls[4].answer(200, { ok: true, attachment_id: 'att-00000000000000b2', name: 'b.igs', bytes: 10 }));
    await waitFor(() => expect(document.querySelector('[data-dock-file-chip="b.igs"]')?.getAttribute('data-dock-file-state')).toBe('ready'));
    // No answer at all.
    await act(async () => up.calls[2].answer(0, {}));
    await waitFor(() => expect(Array.from(document.querySelectorAll('[data-dock-file-error]')).map((e) => e.textContent)).toContain("c.brep didn't reach Magnusim's server. Attach it again."));
    // × while it uploads: the upload stops.
    fireEvent.click(screen.getByRole('button', { name: 'Remove d.obj' }));
    expect(up.calls[3].signal.aborted).toBe(true);
    expect(chips().map((c) => c.getAttribute('data-dock-file-chip'))).toEqual(['b.igs']);
  });

  for (const s of SETTINGS) {
    it(`paste and drop take files as Attach does; pictures and files in one drop go each their way; the overlay names what is offered (drawings ${s})`, async () => {
      const w = offer(s);
      const up = uploads();
      const deps: PictureDeps = { size: async () => ({ width: 10, height: 10, draw: async () => new Blob() }) };
      vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
      render(
        <aside id="assistant-dock">
          <Composer place={HOME} status={LOCAL} conversation={null} conversationId={null} running={null} onNew={() => undefined} uploadSend={up.send} pictureDeps={deps} />
        </aside>,
      );
      fireEvent.paste(area(), { clipboardData: { files: [geometry('pasted.stl')], items: [] } });
      await waitFor(() => expect(chips()).toHaveLength(1));
      const panel = document.getElementById('assistant-dock') as HTMLElement;
      const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'a.png', { type: 'image/png' });
      const dt = { types: ['Files'], files: [geometry('dropped.step'), png], items: [] };
      fireEvent.dragEnter(panel, { dataTransfer: dt });
      expect(document.querySelector('[data-dock-drop]')?.textContent).toBe(w.dropAll);
      await act(async () => {
        fireEvent.drop(panel, { dataTransfer: dt });
      });
      await waitFor(() => expect(chips().map((c) => c.getAttribute('data-dock-file-chip'))).toEqual(['pasted.stl', 'dropped.step']));
      await waitFor(() => expect(document.querySelector('[data-dock-picture-chip]')?.getAttribute('data-dock-picture-chip')).toBe('a.png'));
      expect(document.querySelector('[data-dock-file-error]')).toBeNull();
    });
  }

  it('a coding agent takes the files (no pictures): the upload and the request as for any provider', async () => {
    sessionStorage.setItem('mg.assistant.dock.provider', JSON.stringify({ home: 'agent:helper' }));
    const up = uploads();
    mount({ uploadSend: up.send });
    await pick([geometry('part.ply')]);
    await waitFor(() => expect(up.calls).toHaveLength(1));
    await act(async () => up.calls[0].answer(200, { ok: true, attachment_id: 'att-00000000000000c3', name: 'part.ply', bytes: 10 }));
    fireEvent.change(area(), { target: { value: 'Import it' } });
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body.attachments).toEqual(['att-00000000000000c3']);
    expect(posts[0].body.provider).toBe('agent:helper');
  });

  it('drawings offered: a .dxf picked and an SVG dropped (image/svg+xml) upload as files with their chips, never as pictures and never as markup in the page; their note; the request names them; over 20 MB refused before anything is sent', async () => {
    const w = offer('on');
    const up = uploads();
    const deps: PictureDeps = { size: async () => ({ width: 10, height: 10, draw: async () => new Blob() }) };
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
    render(
      <aside id="assistant-dock">
        <Composer place={HOME} status={LOCAL} conversation={null} conversationId={null} running={null} onNew={() => undefined} uploadSend={up.send} pictureDeps={deps} />
      </aside>,
    );
    const markup = '<svg xmlns="http://www.w3.org/2000/svg"><text>DRAWING-MARKUP</text><script>window.__ran = 1</script></svg>';
    const dxf = '  0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n';
    await pick([new File([dxf], 'flange.dxf')]);
    const panel = document.getElementById('assistant-dock') as HTMLElement;
    const dt = { types: ['Files'], files: [new File([markup], 'plate.svg', { type: 'image/svg+xml' })], items: [] };
    fireEvent.dragEnter(panel, { dataTransfer: dt });
    expect(document.querySelector('[data-dock-drop]')?.textContent).toBe(w.dropAll);
    await act(async () => {
      fireEvent.drop(panel, { dataTransfer: dt });
    });
    await waitFor(() => expect(up.calls.map((c) => c.file.name)).toEqual(['flange.dxf', 'plate.svg']));
    expect(chips().map((c) => [c.getAttribute('data-dock-file-chip'), c.getAttribute('data-dock-file-kind'), c.querySelector('.dock-chip-text > span')?.textContent])).toEqual([
      ['flange.dxf', 'drawing', `flange.dxf · ${dxf.length} bytes`],
      ['plate.svg', 'drawing', `plate.svg · ${markup.length} bytes`],
    ]);
    expect(document.querySelector('[data-dock-picture-chip]')).toBeNull();
    expect(document.querySelector('[data-dock-picture-error]')).toBeNull();
    expect(panel.querySelector('svg, img')).toBeNull();
    expect(document.body.innerHTML).not.toContain('DRAWING-MARKUP');
    expect(document.querySelector('[data-dock-files-note]')?.textContent).toBe(
      'Files stay on this PC. The Assistant gets their names. It can import geometry files into the project open here, and drawings in a workspace that imports them. A workspace tool may read one, and what it reports goes to the provider.',
    );
    await act(async () => up.calls[0].answer(200, { ok: true, attachment_id: 'att-00000000000000d1', name: 'flange.dxf', bytes: dxf.length, kind: 'drawing', format: 'dxf' }));
    await act(async () => up.calls[1].answer(200, { ok: true, attachment_id: 'att-00000000000000d2', name: 'plate.svg', bytes: markup.length, kind: 'drawing', format: 'svg' }));
    fireEvent.change(area(), { target: { value: 'Use these outlines' } });
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    // Too large: its own words, and nothing uploaded.
    const big = new File(['<svg/>'], 'poster.svg', { type: 'image/svg+xml' });
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    await pick([big]);
    expect(Array.from(document.querySelectorAll('[data-dock-file-error]')).map((e) => e.textContent)).toEqual(['poster.svg is larger than 20 MB, the limit for a drawing.']);
    expect(up.calls).toHaveLength(2);
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body.attachments).toEqual(['att-00000000000000d1', 'att-00000000000000d2']);
    expect(posts[0].body.images).toBeUndefined();
  });

  it('drawings offered: a coding agent that takes no pictures takes a drawing as a file: a pasted SVG uploads, no picture refusal', async () => {
    offer('on');
    sessionStorage.setItem('mg.assistant.dock.provider', JSON.stringify({ home: 'agent:helper' }));
    const up = uploads();
    mount({ status: HELPER_NO_PICTURES, uploadSend: up.send });
    await act(async () => {
      fireEvent.paste(area(), { clipboardData: { files: [new File(['<svg/>'], 'sketch.svg', { type: 'image/svg+xml' })], items: [] } });
    });
    await waitFor(() => expect(up.calls.map((c) => c.file.name)).toEqual(['sketch.svg']));
    expect(chips().map((c) => c.getAttribute('data-dock-file-kind'))).toEqual(['drawing']);
    expect(document.querySelector('[data-dock-picture-error]')).toBeNull();
  });

  it('drawings not offered: an .svg and a .dxf picked, an SVG dropped (image/svg+xml) and one pasted with no name are refused before any upload in the words that name pictures and geometry files only; no chip, no picture, nothing of the markup; geometry and a picture beside them go their way', async () => {
    const w = offer('off');
    const up = uploads();
    const deps: PictureDeps = { size: async () => ({ width: 10, height: 10, draw: async () => new Blob() }) };
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
    render(
      <aside id="assistant-dock">
        <Composer place={HOME} status={LOCAL} conversation={null} conversationId={null} running={null} onNew={() => undefined} uploadSend={up.send} pictureDeps={deps} />
      </aside>,
    );
    const markup = '<svg xmlns="http://www.w3.org/2000/svg"><text>DRAWING-MARKUP</text><script>window.__ran = 1</script></svg>';
    const dxf = '  0\nSECTION\n  2\nENTITIES\n  0\nENDSEC\n  0\nEOF\n';
    const fileErrors = () => Array.from(document.querySelectorAll('[data-dock-file-error]')).map((e) => e.textContent);
    // Picked by their extensions (no type, as a file picker may give them).
    await pick([new File([markup], 'plate.svg'), new File([dxf], 'flange.dxf')]);
    expect(fileErrors()).toEqual([w.onlyFiles]);
    // Dropped as image/svg+xml: never taken for a picture.
    const panel = document.getElementById('assistant-dock') as HTMLElement;
    await act(async () => {
      fireEvent.drop(panel, { dataTransfer: { types: ['Files'], files: [new File([markup], 'outline.svg', { type: 'image/svg+xml' })], items: [] } });
    });
    expect(fileErrors()).toEqual([w.onlyFiles]);
    // Pasted with no name, by its type only.
    await act(async () => {
      fireEvent.paste(area(), { clipboardData: { files: [new File([markup], '', { type: 'image/svg+xml' })], items: [] } });
    });
    expect(fileErrors()).toEqual([w.onlyFiles]);
    expect(up.calls).toHaveLength(0);
    expect(chips()).toHaveLength(0);
    expect(document.querySelector('[data-dock-picture-chip]')).toBeNull();
    expect(document.querySelector('[data-dock-picture-error]')).toBeNull();
    expect(document.body.innerHTML).not.toContain('DRAWING-MARKUP');
    // Beside geometry and a picture: those go their way, the drawing is refused.
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'a.png', { type: 'image/png' });
    await pick([geometry('bracket.step'), new File([markup], 'plate.svg', { type: 'image/svg+xml' }), png]);
    await waitFor(() => expect(up.calls.map((c) => c.file.name)).toEqual(['bracket.step']));
    expect(chips().map((c) => [c.getAttribute('data-dock-file-chip'), c.getAttribute('data-dock-file-kind')])).toEqual([['bracket.step', 'geometry']]);
    await waitFor(() => expect(document.querySelector('[data-dock-picture-chip]')?.getAttribute('data-dock-picture-chip')).toBe('a.png'));
    expect(fileErrors()).toEqual([w.onlyFiles]);
    expect(document.querySelector('[data-dock-files-note]')?.textContent).toBe(
      'Files stay on this PC. The Assistant gets their names and can import them into the project open here. A workspace tool may read one, and what it reports goes to the provider.',
    );
  });

  it('drawings not offered: a coding agent that takes no pictures refuses a pasted SVG as any other file (not as a picture), before any upload', async () => {
    const w = offer('off');
    sessionStorage.setItem('mg.assistant.dock.provider', JSON.stringify({ home: 'agent:helper' }));
    const up = uploads();
    mount({ status: HELPER_NO_PICTURES, uploadSend: up.send });
    await act(async () => {
      fireEvent.paste(area(), { clipboardData: { files: [new File(['<svg/>'], 'sketch.svg', { type: 'image/svg+xml' })], items: [] } });
    });
    expect(Array.from(document.querySelectorAll('[data-dock-file-error]')).map((e) => e.textContent)).toEqual([w.onlyFiles]);
    expect(document.querySelector('[data-dock-picture-error]')).toBeNull();
    expect(up.calls).toHaveLength(0);
    expect(chips()).toHaveLength(0);
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
