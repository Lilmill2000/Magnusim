/**
 * The dock's composer (phase 4 spec 3): where the person types to the Assistant.
 *
 * - Where the request goes (the context chip, `data-dock-context`), who answers it (the provider
 *   picker, editable only before a conversation's first message), the text (1 to 8 rows; Enter
 *   sends, Shift+Enter makes a newline, never while composing), the person's pictures (Attach,
 *   paste, or a drop onto the dock; at most 4, shrunk to fit) and geometry files and drawings
 *   beside them (core host tools spec 13.1: the same three ways in, at most 4 of 500 MB each, a
 *   drawing 20 MB, each uploaded at once with its progress and named in the request by its
 *   attachment id; a drawing shows as a file chip, its markup never put in the page). Drawings
 *   only while the dock offers them (drawings.ts); until then one is refused as any other file.
 * - Send is disabled, with the line that says why in place of the hint, while the Assistant is
 *   off, the provider isn't ready, the workspace is still offering its tools, a coding agent that
 *   takes no pictures is picked with pictures attached, a file is still uploading, the
 *   conversation ended or is full, or the text is empty or past 20,000 characters. While its
 *   request runs, Send is Stop. A coding agent takes files, and pictures unless its status row
 *   says it takes none (`images: false`, what its last start said); not known yet, it takes them,
 *   and the server ends the request bad_images before anything is sent if its start says no.
 * - A refusal shows the server's words above the composer; the draft and pictures stay. The
 *   draft is kept per conversation (store.ts). A full conversation's line is the server's: which
 *   limit it reached, with its numbers (the row's full_text), with New conversation and Continue
 *   in a new chat (store.ts continueInNewChat: the draft moves into the new one's box). A new
 *   conversation that continues an earlier one says what goes with its first message, keeps the
 *   earlier one's provider (the picker locked to it) and sends carry_from instead of a provider.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { openSetupWizard } from '../../wizard/controller';
import { AssistantApiError } from '../api';
import { isAgentProvider, providerReady, refreshStatus } from '../status';
import type { AssistantStatus, ConversationRow } from '../wire';
import {
  ATTACH,
  attachFilesOnly,
  ATTACH_LABEL,
  charCount,
  COMPOSER_HINT,
  CONTEXT_HOME,
  contextConnecting,
  contextLate,
  contextNoTools,
  contextProject,
  contextWorkspace,
  CARRY_LINE,
  CONTINUE_IN_NEW_CHAT,
  CONVERSATION_FULL,
  DRAWINGS_STAY,
  dropFiles,
  dropPictures,
  fileChip,
  FILES_STAY,
  MESSAGE_LABEL,
  NEW_CONVERSATION,
  noPictures,
  OPEN_SETTINGS,
  PICTURES_GO,
  picturesGoToAgent,
  pictureChip,
  PLACEHOLDER_HOME,
  PLACEHOLDER_PROJECT,
  placeholderWorkspace,
  providerNotReady,
  onlyFiles,
  removePicture,
  SEND,
  shrunkTo,
  STATE_OFF,
  STOP,
  STOP_FAILED,
  STOP_LABEL,
  uploadingLabel,
  waitingForTools,
  waitingForUpload,
  WORKING_ON_IT,
} from './copy';
import { acceptAll, acceptFiles, checkFiles, kindOf, uploadFile, type AttachedFile, type UploadSend } from './attachments';
import type { DockPlace } from './context';
import { drawingsOffered } from './drawings';
import { addPictures, dragHasFiles, picturesFrom, type PictureDeps, type PreparedPicture } from './pictures';
import { defaultProvider, ProviderPicker, providerOptions } from './ProviderPicker';
import { startDockTurn, stopDockTurn } from './send';
import { continueInNewChat, draftOf, pickedProvider, setDraft, setPickedProvider, type DockCarry } from './store';

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

/** A line shown in place of the hint, with Send disabled, and what it offers (`carry`: Continue in a new chat too). */
export interface Blocked {
  line: string;
  action?: 'settings' | 'new';
  carry?: boolean;
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
  /** The earlier conversation the new one shown continues (Continue in a new chat; store.ts). */
  carry?: DockCarry | null;
  /** Extra reason Send can't go (tab_busy: another request works in this workspace). */
  busy?: (Blocked & { onStop?: () => void; stopLabel?: string }) | null;
  /** Tests: the browser calls pictures need. */
  pictureDeps?: PictureDeps;
  /** Tests: the upload's browser call (XMLHttpRequest otherwise). */
  uploadSend?: UploadSend;
}

/** The context key the provider pick is kept under. */
const contextKey = (place: DockPlace) => place.projectId ?? 'home';

export function Composer({ place, status, conversation, conversationId, running, onNew, carry = null, busy = null, pictureDeps, uploadSend }: ComposerProps) {
  const draftKey = conversationId;
  // Only a new conversation continues one.
  const carrying = conversationId ? null : carry;
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
  // The files: kept in a ref too, so two quick adds count each other against the limit.
  const [files, setFilesState] = useState<AttachedFile[]>([]);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const filesRef = useRef<AttachedFile[]>([]);
  const uploads = useRef(new Map<string, AbortController>());
  const fileSerial = useRef(0);
  const putFiles = useCallback((next: AttachedFile[]) => {
    filesRef.current = next;
    setFilesState(next);
  }, []);
  const patchFile = useCallback((key: string, patch: Partial<AttachedFile>) => putFiles(filesRef.current.map((f) => (f.key === key ? { ...f, ...patch } : f))), [putFiles]);
  const removeFile = useCallback(
    (key: string) => {
      uploads.current.get(key)?.abort();
      uploads.current.delete(key);
      putFiles(filesRef.current.filter((f) => f.key !== key));
    },
    [putFiles],
  );
  // Leaving the composer stops its uploads (the server sweeps what it kept).
  useEffect(() => {
    const live = uploads.current;
    return () => {
      for (const ac of live.values()) ac.abort();
      live.clear();
    };
  }, []);

  // Another conversation (or one that continues another): its draft; a refusal of the one before is not this one's.
  const carryKey = carrying?.from ?? null;
  useEffect(() => {
    setText(draftOf(draftKey));
    setError(null);
  }, [draftKey, carryKey]);
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
  const choice = conversation ? conversation.provider : carrying ? carrying.provider : pickable(picked) ? picked : def;
  const ready = choice ? providerReady(status, choice) : null;
  // A conversation keeps its provider once it has a message (before the list names it too); one
  // that continues another, that one's.
  const locked = conversationId ? (conversation?.label ?? ready?.label ?? '') : carrying ? carrying.label || ready?.label || '' : null;
  const agent = !!choice && (isAgentProvider(choice) || ready?.kind === 'agent');
  const agentName = ready?.label ?? conversation?.label ?? '';
  // A coding agent whose last start said it takes no pictures (not known yet: it may take them).
  const noAgentPictures = agent && ready?.images === false;

  // A coding agent's request ended: the status is read again, so what its start said of pictures
  // shows here for the next message (after a bad_images end too).
  const ranOnAgent = useRef(false);
  useEffect(() => {
    if (running) ranOnAgent.current = agent;
    else if (ranOnAgent.current) {
      ranOnAgent.current = false;
      void refreshStatus();
    }
  }, [running, agent]);

  /** One geometry file or drawing: its chip at once, uploading; its attachment id once the server kept it. */
  const startUpload = useCallback(
    (file: File) => {
      fileSerial.current += 1;
      const key = `f${fileSerial.current}`;
      const ac = new AbortController();
      uploads.current.set(key, ac);
      const kind = kindOf(file) === 'drawing' ? 'drawing' : 'geometry';
      putFiles([...filesRef.current, { key, name: file.name, bytes: file.size, kind, state: 'uploading', progress: 0, id: null }]);
      uploadFile(file, (progress) => patchFile(key, { progress }), ac.signal, uploadSend)
        .then((r) => patchFile(key, { state: 'ready', progress: 1, id: r.id, name: r.name, bytes: r.bytes }))
        .catch((err: unknown) => {
          if (ac.signal.aborted) return;
          putFiles(filesRef.current.filter((f) => f.key !== key));
          const text = err instanceof Error ? err.message : String(err);
          setFileErrors((e) => (e.includes(text) ? e : [...e, text]));
        })
        .finally(() => uploads.current.delete(key));
    },
    [patchFile, putFiles, uploadSend],
  );

  // Pictures go to pictures.ts (unless a coding agent that takes none is picked); geometry files
  // and drawings (while the dock offers them) upload; anything else is refused.
  const add = useCallback(
    async (all: File[]) => {
      if (!all.length) return;
      const pics = all.filter((f) => kindOf(f) === 'picture');
      const toUpload = all.filter((f) => kindOf(f) === 'geometry' || kindOf(f) === 'drawing');
      const fileLines: string[] = all.some((f) => kindOf(f) === 'other') ? [onlyFiles(drawingsOffered())] : [];
      if (toUpload.length) {
        const checked = checkFiles(filesRef.current.length, toUpload);
        fileLines.push(...checked.errors);
        checked.accepted.forEach(startUpload);
      }
      setFileErrors(fileLines);
      if (!pics.length) {
        setPictureErrors([]);
        return;
      }
      if (noAgentPictures) {
        setPictureErrors([noPictures(agentName)]);
        return;
      }
      const out = await addPictures(picturesRef.current, pics, pictureDeps);
      setPictures(out.pictures);
      setPictureErrors(out.errors);
    },
    [noAgentPictures, agentName, pictureDeps, startUpload],
  );

  // A drop anywhere on the dock attaches; the overlay says so while files are dragged over it. A
  // coding agent that takes no pictures takes files only: a picture's drop says so (DockShell
  // keeps any file drop from leaving the app).
  useEffect(() => {
    const panel = document.getElementById('assistant-dock');
    if (!panel) return;
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
  }, [add]);

  const projectTitle = place.projectTitle ?? conversation?.project_title ?? place.projectId ?? '';
  const ws = place.workspace;
  // The Attach label, its accept list and the drop overlay name drawings only while offered.
  const drawings = drawingsOffered();

  // Why Send can't go now (the first that holds), shown in place of the hint.
  let blocked: (Blocked & { onStop?: () => void; stopLabel?: string }) | null = null;
  if (error && (error.code === 'unknown_conversation' || error.code === 'conversation_full')) blocked = { line: error.text, action: 'new', carry: error.code === 'conversation_full' && !!conversationId };
  else if (conversation?.full) blocked = { line: conversation.full_text || CONVERSATION_FULL, action: 'new', carry: !isAgentProvider(conversation.provider) };
  else if (!running && !choice) blocked = { line: STATE_OFF, action: 'settings' };
  else if (!running && ready && !ready.ready) blocked = { line: providerNotReady(ready.label, ready.detail || ready.reason || ''), action: 'settings' };
  else if (!running && busy) blocked = busy;
  else if (!running && ws && ws.state === 'connecting') blocked = { line: waitingForTools(ws.name) };
  else if (!running && noAgentPictures && pictures.length) blocked = { line: noPictures(agentName) };
  else if (!running && files.some((f) => f.state === 'uploading')) blocked = { line: waitingForUpload(files.find((f) => f.state === 'uploading')?.name ?? '') };

  const tooLong = text.length > TEXT_MAX;
  const canSend = !running && !blocked && !sending && !!text.trim() && !tooLong;

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      const attachments = files.filter((f) => f.state === 'ready' && f.id).map((f) => f.id as string);
      await startDockTurn({ text, conversation: conversationId, provider: conversationId || carrying ? null : choice, carryFrom: carrying?.from ?? null, place, pictures, attachments });
      setText('');
      setDraft(draftKey, '');
      setPictures([]);
      setPictureErrors([]);
      putFiles([]);
      setFileErrors([]);
    } catch (err) {
      const code = err instanceof AssistantApiError ? err.code : 'network';
      setError({ text: err instanceof Error ? err.message : String(err), code });
    } finally {
      setSending(false);
    }
  };

  // Continue in a new chat: the box's text goes with it (store.ts moves the draft).
  const onContinue = () => {
    if (!conversationId) return;
    setDraft(conversationId, text);
    continueInNewChat({ from: conversationId, provider: conversation?.provider ?? choice ?? '', label: conversation?.label ?? ready?.label ?? '' });
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    // Composing (an input method), never sent.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void send();
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = picturesFrom(e.clipboardData);
    if (!pasted.length) return;
    e.preventDefault();
    void add(pasted);
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
      {carrying ? (
        <p className="dock-muted" data-dock-carry={carrying.from}>
          {CARRY_LINE}
        </p>
      ) : null}
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
          <p className="dock-muted dock-chips-note" data-dock-pictures-note="1">
            {agent ? picturesGoToAgent(agentName) : PICTURES_GO}
          </p>
        </>
      ) : null}
      {pictureErrors.map((line) => (
        <p key={line} className="dock-alert" role="alert" data-dock-picture-error="1">
          {line}
        </p>
      ))}
      {files.length ? (
        <>
          <ul className="dock-chips" data-dock-files="1">
            {files.map((f) => (
              <FileChip key={f.key} file={f} onRemove={() => removeFile(f.key)} />
            ))}
          </ul>
          <p className="dock-muted dock-chips-note" data-dock-files-note="1">
            {files.some((f) => f.kind === 'drawing') ? DRAWINGS_STAY : FILES_STAY}
          </p>
        </>
      ) : null}
      {fileErrors.map((line) => (
        <p key={line} className="dock-alert" role="alert" data-dock-file-error="1">
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
          aria-label={noAgentPictures ? attachFilesOnly(agentName, drawings) : ATTACH_LABEL}
          title={noAgentPictures ? attachFilesOnly(agentName, drawings) : ATTACH_LABEL}
          data-dock-attach="1"
          onClick={() => file.current?.click()}
        >
          {ATTACH}
        </button>
        <input
          ref={file}
          type="file"
          accept={noAgentPictures ? acceptFiles() : acceptAll()}
          multiple
          hidden
          data-dock-file="1"
          onChange={(e) => {
            const picked = Array.from(e.target.files || []);
            e.target.value = '';
            void add(picked);
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
              {blocked.carry ? (
                <button type="button" className="dock-link-button" data-dock-continue="1" onClick={onContinue}>
                  {CONTINUE_IN_NEW_CHAT}
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
          {noAgentPictures ? dropFiles(drawings) : dropPictures(drawings)}
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

/** A file's chip (a drawing's too, with no preview): its type, "<name> · 4.2 MB", the upload's progress while it goes, and ×. */
function FileChip({ file, onRemove }: { file: AttachedFile; onRemove: () => void }) {
  const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(file.name)?.[1] ?? '').toUpperCase();
  const pct = Math.round(file.progress * 100);
  return (
    <li className="dock-chip dock-file-chip" data-dock-file-chip={file.name} data-dock-file-kind={file.kind} data-dock-file-state={file.state}>
      <span className="dock-chip-img dock-file-type" aria-hidden="true">
        {ext}
      </span>
      <span className="dock-chip-text">
        <span>{fileChip(file.name, file.bytes)}</span>
        {file.state === 'uploading' ? (
          <span className="dock-progress-bar" role="progressbar" aria-label={uploadingLabel(file.name)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ width: `${pct}%` }} />
          </span>
        ) : null}
      </span>
      <button type="button" className="assistant-dock-icon" aria-label={removePicture(file.name)} onClick={onRemove}>
        ×
      </button>
    </li>
  );
}
