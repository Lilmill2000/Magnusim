/**
 * The dock's composer (phase 4 spec 3): where the person types to the Assistant.
 *
 * - Where the request goes (the context chip, `data-dock-context`), who answers it (the provider
 *   picker, editable only before a conversation's first message), the text (1 to 8 rows; Enter
 *   sends, Shift+Enter makes a newline, never while composing), and the person's pictures
 *   (Attach, paste, or a drop onto the dock; at most 4, shrunk to fit).
 * - Send is disabled, with the line that says why in place of the hint, while the Assistant is
 *   off, the provider isn't ready, the workspace is still offering its tools, a coding agent is
 *   picked with pictures attached, the conversation ended or is full, or the text is empty or
 *   past 20,000 characters. While its request runs, Send is Stop.
 * - A refusal shows the server's words above the composer; the draft and pictures stay. The
 *   draft is kept per conversation (store.ts).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { openSetupWizard } from '../../wizard/controller';
import { AssistantApiError } from '../api';
import { isAgentProvider, providerReady } from '../status';
import type { AssistantStatus, ConversationRow } from '../wire';
import {
  ATTACH,
  ATTACH_LABEL,
  charCount,
  COMPOSER_HINT,
  CONTEXT_HOME,
  contextConnecting,
  contextLate,
  contextNoTools,
  contextProject,
  contextWorkspace,
  CONVERSATION_FULL,
  DROP_PICTURES,
  MESSAGE_LABEL,
  NEW_CONVERSATION,
  noPictures,
  OPEN_SETTINGS,
  PICTURES_GO,
  pictureChip,
  PLACEHOLDER_HOME,
  PLACEHOLDER_PROJECT,
  placeholderWorkspace,
  providerNotReady,
  removePicture,
  SEND,
  shrunkTo,
  STATE_OFF,
  STOP,
  STOP_FAILED,
  STOP_LABEL,
  waitingForTools,
  WORKING_ON_IT,
} from './copy';
import type { DockPlace } from './context';
import { addPictures, dragHasFiles, picturesFrom, type PictureDeps, type PreparedPicture } from './pictures';
import { defaultProvider, ProviderPicker, providerOptions } from './ProviderPicker';
import { startDockTurn, stopDockTurn } from './send';
import { draftOf, pickedProvider, setDraft, setPickedProvider } from './store';

/** The server's limit on a request's text, and where the count starts to show. */
export const TEXT_MAX = 20_000;
export const COUNT_FROM = 18_000;
/** The textarea grows to this many rows. */
export const MAX_ROWS = 8;

const openSettings = () => openSetupWizard({ required: false, step: 'assistant' });

/** The context chip's words (spec 3.3). */
export function contextChip(place: DockPlace, projectTitle: string): string {
  const ws = place.workspace;
  if (!place.projectId) return CONTEXT_HOME;
  if (!ws) return contextProject(projectTitle);
  if (ws.state === 'tools') return contextWorkspace(ws.name, projectTitle);
  if (ws.state === 'connecting') return contextConnecting(ws.name);
  if (ws.state === 'late') return contextLate(ws.name);
  return contextNoTools(ws.name, projectTitle);
}

export function placeholderOf(place: DockPlace): string {
  const ws = place.workspace;
  if (ws && ws.state === 'tools') return placeholderWorkspace(ws.name);
  return place.projectId ? PLACEHOLDER_PROJECT : PLACEHOLDER_HOME;
}

/** A line shown in place of the hint, with Send disabled, and what it offers. */
export interface Blocked {
  line: string;
  action?: 'settings' | 'new';
}

export interface ComposerProps {
  place: DockPlace;
  status: AssistantStatus;
  /** The conversation shown (null: a new one). */
  conversation: ConversationRow | null;
  /** Its id even before the list names it (a conversation this tab just started). */
  conversationId: string | null;
  /** Its request running now, if any (Send is Stop). */
  running: string | null;
  onNew: () => void;
  /** Extra reason Send can't go (tab_busy: another request works in this workspace). */
  busy?: (Blocked & { onStop?: () => void; stopLabel?: string }) | null;
  /** Tests: the browser calls pictures need. */
  pictureDeps?: PictureDeps;
}

/** The context key the provider pick is kept under. */
const contextKey = (place: DockPlace) => place.projectId ?? 'home';

export function Composer({ place, status, conversation, conversationId, running, onNew, busy = null, pictureDeps }: ComposerProps) {
  const draftKey = conversationId;
  const [text, setText] = useState(() => draftOf(draftKey));
  const [pictures, setPictures] = useState<PreparedPicture[]>([]);
  const [pictureErrors, setPictureErrors] = useState<string[]>([]);
  const [error, setError] = useState<{ text: string; code: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [picked, setPicked] = useState<string | null>(() => pickedProvider(contextKey(place)));
  const area = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const picturesRef = useRef(pictures);
  picturesRef.current = pictures;

  // Another conversation: its draft; a refusal of the one before is not this one's.
  useEffect(() => {
    setText(draftOf(draftKey));
    setError(null);
  }, [draftKey]);
  // A Stop that didn't reach the server is about the request it was for.
  useEffect(() => setError((e) => (e && e.code === 'stop' ? null : e)), [running]);
  const ctxKey = contextKey(place);
  useEffect(() => setPicked(pickedProvider(ctxKey)), [ctxKey]);

  // 1 to 8 rows, growing with the text.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    // The CSS caps it at MAX_ROWS rows (then it scrolls).
    el.style.height = 'auto';
    const cs = getComputedStyle(el);
    const borders = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    el.style.height = `${el.scrollHeight + borders}px`;
  }, [text]);

  const options = providerOptions(status);
  const def = defaultProvider(status);
  const pickable = (id: string | null) => !!id && options.some((o) => o.id === id && o.ready);
  const choice = conversation ? conversation.provider : pickable(picked) ? picked : def;
  const ready = choice ? providerReady(status, choice) : null;
  // A conversation keeps its provider once it has a message (before the list names it too).
  const locked = conversationId ? (conversation?.label ?? ready?.label ?? '') : null;
  const agent = !!choice && (isAgentProvider(choice) || ready?.kind === 'agent');
  const agentName = ready?.label ?? conversation?.label ?? '';

  const add = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const out = await addPictures(picturesRef.current, files, pictureDeps);
      setPictures(out.pictures);
      setPictureErrors(out.errors);
    },
    [pictureDeps],
  );

  // A drop anywhere on the dock attaches; the overlay says so while files are dragged over it.
  useEffect(() => {
    const panel = document.getElementById('assistant-dock');
    if (!panel || agent) return;
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (dragHasFiles(e.dataTransfer)) e.preventDefault();
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      const files = picturesFrom(e.dataTransfer);
      depth = 0;
      setDragging(false);
      if (!files.length) return;
      e.preventDefault();
      void add(files);
    };
    panel.addEventListener('dragenter', enter);
    panel.addEventListener('dragover', over);
    panel.addEventListener('dragleave', leave);
    panel.addEventListener('drop', drop);
    return () => {
      panel.removeEventListener('dragenter', enter);
      panel.removeEventListener('dragover', over);
      panel.removeEventListener('dragleave', leave);
      panel.removeEventListener('drop', drop);
    };
  }, [add, agent]);

  const projectTitle = place.projectTitle ?? conversation?.project_title ?? place.projectId ?? '';
  const ws = place.workspace;

  // Why Send can't go now (the first that holds), shown in place of the hint.
  let blocked: (Blocked & { onStop?: () => void; stopLabel?: string }) | null = null;
  if (error && (error.code === 'unknown_conversation' || error.code === 'conversation_full')) blocked = { line: error.text, action: 'new' };
  else if (conversation?.full) blocked = { line: CONVERSATION_FULL, action: 'new' };
  else if (!running && !choice) blocked = { line: STATE_OFF, action: 'settings' };
  else if (!running && ready && !ready.ready) blocked = { line: providerNotReady(ready.label, ready.detail || ready.reason || ''), action: 'settings' };
  else if (!running && busy) blocked = busy;
  else if (!running && ws && ws.state === 'connecting') blocked = { line: waitingForTools(ws.name) };
  else if (!running && agent && pictures.length) blocked = { line: noPictures(agentName) };

  const tooLong = text.length > TEXT_MAX;
  const canSend = !running && !blocked && !sending && !!text.trim() && !tooLong;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      await startDockTurn({ text, conversation: conversationId, provider: conversationId ? null : choice, place, pictures });
      setText('');
      setDraft(draftKey, '');
      setPictures([]);
      setPictureErrors([]);
    } catch (err) {
      const code = err instanceof AssistantApiError ? err.code : 'network';
      setError({ text: err instanceof Error ? err.message : String(err), code });
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // Composing (an input method), never sent.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void send();
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = picturesFrom(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    if (agent) {
      setPictureErrors([noPictures(agentName)]);
      return;
    }
    void add(files);
  };

  return (
    <div className="dock-composer" data-dock-composer="1">
      <div className="dock-composer-top">
        <span className="dock-context" data-dock-context={ws ? ws.state : place.projectId ? 'project' : 'home'}>
          {contextChip(place, projectTitle)}
        </span>
        <ProviderPicker
          options={options}
          value={choice}
          locked={locked}
          onPick={(id) => {
            setPicked(id);
            setPickedProvider(contextKey(place), id);
          }}
        />
      </div>
      {error && error.code !== 'unknown_conversation' && error.code !== 'conversation_full' ? (
        <p className="dock-alert" role="alert" data-dock-refusal={error.code}>
          {error.text}
        </p>
      ) : null}
      {pictures.length ? (
        <>
          <ul className="dock-chips" data-dock-pictures="1">
            {pictures.map((p, i) => (
              <PictureChip key={`${p.name}-${i}`} picture={p} onRemove={() => setPictures(pictures.filter((x) => x !== p))} />
            ))}
          </ul>
          <p className="dock-muted dock-chips-note">{PICTURES_GO}</p>
        </>
      ) : null}
      {pictureErrors.map((line) => (
        <p key={line} className="dock-alert" role="alert" data-dock-picture-error="1">
          {line}
        </p>
      ))}
      <textarea
        ref={area}
        className="dock-textarea"
        aria-label={MESSAGE_LABEL}
        placeholder={placeholderOf(place)}
        rows={1}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDraft(draftKey, e.target.value);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <div className="dock-composer-row">
        <button
          type="button"
          className="dock-attach"
          aria-label={ATTACH_LABEL}
          title={agent ? noPictures(agentName) : ATTACH_LABEL}
          disabled={agent || !!running}
          data-dock-attach="1"
          onClick={() => file.current?.click()}
        >
          {ATTACH}
        </button>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          hidden
          data-dock-file="1"
          onChange={(e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = '';
            void add(files);
          }}
        />
        <div className="dock-composer-line" data-dock-line-state={blocked ? 'blocked' : running ? 'running' : 'hint'}>
          {running ? (
            <span className="dock-muted">{WORKING_ON_IT}</span>
          ) : blocked ? (
            <>
              <span className="dock-muted" data-dock-blocked="1">
                {blocked.line}
              </span>
              {blocked.action === 'settings' ? (
                <button type="button" className="dock-link-button" data-dock-open-settings="1" onClick={openSettings}>
                  {OPEN_SETTINGS}
                </button>
              ) : blocked.action === 'new' ? (
                <button type="button" className="dock-link-button" data-dock-new-line="1" onClick={onNew}>
                  {NEW_CONVERSATION}
                </button>
              ) : null}
              {blocked.onStop ? (
                <button type="button" className="dock-link-button" data-dock-stop-other="1" onClick={blocked.onStop}>
                  {blocked.stopLabel}
                </button>
              ) : null}
            </>
          ) : (
            <span className="dock-muted">{COMPOSER_HINT}</span>
          )}
          {text.length >= COUNT_FROM ? (
            <span className={`dock-muted dock-count${tooLong ? ' over' : ''}`} data-dock-count="1">
              {charCount(text.length)}
            </span>
          ) : null}
        </div>
        {running ? (
          <button type="button" className="dock-stop" data-dock-stop="1" aria-label={STOP_LABEL} onClick={() => void stopDockTurn(running).then((out) => setError(out === null ? { text: STOP_FAILED, code: 'stop' } : null))}>
            {STOP}
          </button>
        ) : (
          <button type="button" className="dock-send" data-dock-send="1" disabled={!canSend} onClick={() => void send()}>
            {SEND}
          </button>
        )}
      </div>
      {dragging ? (
        <div className="dock-drop" data-dock-drop="1" aria-hidden="true">
          {DROP_PICTURES}
        </div>
      ) : null}
    </div>
  );
}

function PictureChip({ picture, onRemove }: { picture: PreparedPicture; onRemove: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    try {
      u = URL.createObjectURL(picture.blob);
    } catch {
      u = null;
    }
    setUrl(u);
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [picture.blob]);
  return (
    <li className="dock-chip" data-dock-picture-chip={picture.name}>
      {url ? <img src={url} alt="" /> : <span className="dock-chip-img" />}
      <span className="dock-chip-text">
        <span>{pictureChip(picture.name, picture.width, picture.height)}</span>
        {picture.shrunk ? <span className="dock-muted">{shrunkTo(picture.width, picture.height)}</span> : null}
      </span>
      <button type="button" className="assistant-dock-icon" aria-label={removePicture(picture.name)} onClick={onRemove}>
        ×
      </button>
    </li>
  );
}
