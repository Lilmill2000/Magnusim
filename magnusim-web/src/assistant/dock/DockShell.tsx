/**
 * The dock's frame (chat dock spec 1.2-1.4, 2.1, 2.10): the panel at the bottom right with its
 * header, the pill, and the states the dock shows by itself before any conversation (the
 * status not read yet, the server not answering, remote access, the Assistant off). What a
 * conversation shows (its menu, questions, transcript and composer) comes in as `content`.
 *
 * - `#assistant-dock` is always in the page; `hidden` while the dock isn't open (the
 *   workspace overlay watches that attribute to give the frame its keyboard back, HOST_UI).
 * - Escape inside the panel closes it, unless something inside used the key first
 *   (`preventDefault`: a question card answers No, a menu or the picture viewer closes); an
 *   Escape that closed it goes no further (the workbench's own Escape keys, an armed pick).
 * - Opening ends the workspace frame's full screen, where the dock can't be seen.
 * - Opening gives the keyboard to the entry: a `[data-dock-autofocus]` element, else the
 *   composer's text field, else the first button of the body, else the panel.
 * - The status is read again each time the dock opens.
 */
import { useEffect, useLayoutEffect, useRef, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { openSetupWizard } from '../../wizard/controller';
import { exitFrameFullscreen } from '../../workspace/leaveGuard';
import { listAgentsOnce, refreshStatus, retryStatus, providerReady, useAssistantStatus, type StatusSnapshot } from '../status';
import { ASSISTANT_SETTINGS, CLOSE_DOCK, DOCK_TITLE, OPEN_SETTINGS, REMOTE_TEXT, STATE_ERROR, STATE_LOADING, STATE_OFF, STOP, STOP_LABEL, TRY_AGAIN } from './copy';
import { closeDock, openDock, takeReturnFocus, useDock } from './dockState';
import { dragHasFiles } from './pictures';

/** The states the dock shows by itself, from the status alone. */
export type DockShellState = 'loading' | 'error' | 'remote' | 'off';
/** The states a conversation gives the dock (2.10). */
export type DockConversationState = 'empty' | 'ready' | 'running' | 'question';
export type DockState = DockShellState | DockConversationState;

/** What a conversation puts in the dock (lane B: the menu, cards, transcript, composer). */
export interface DockContent {
  state: DockConversationState;
  /** After the title in the header: the conversation menu and New (2.1). */
  header?: ReactNode;
  /** Cards not tied to the shown conversation (4.1), above the transcript. */
  questions?: ReactNode;
  /** The transcript, or the intro of an empty conversation (7). */
  log?: ReactNode;
  /** The composer, or what stands in its place (2.2: another project's conversation). */
  composer?: ReactNode;
}

/**
 * The state the status alone decides, or null when a conversation decides it. Off: no
 * provider is ready and the default is Off (2.3, 2.10).
 */
export function dockShellState(s: StatusSnapshot): DockShellState | null {
  if (s.state !== 'ready') return s.state;
  const status = s.status;
  const def = status.default_provider ?? status.provider;
  if (def !== 'off') return null;
  const rows = status.providers_ready;
  const anyReady = !!rows && Object.keys(rows).some((id) => providerReady(status, id)?.ready === true);
  return anyReady ? null : 'off';
}

const openSettings = () => openSetupWizard({ required: false, step: 'assistant' });

/**
 * A file dragged onto the dock or its pill never leaves the app (the browser would open it in
 * place of Magnusim): the composer attaches pictures, or says why not; every other state, a
 * read-only conversation and the pill take the drop and do nothing.
 */
function keepFileDrop(e: ReactDragEvent<HTMLElement>): void {
  if (dragHasFiles(e.dataTransfer)) e.preventDefault();
}

/** The panel's entry for the keyboard. */
function entryOf(panel: HTMLElement): HTMLElement {
  return (
    panel.querySelector<HTMLElement>('[data-dock-autofocus]') ??
    panel.querySelector<HTMLElement>('.assistant-dock-composer textarea:not(:disabled)') ??
    panel.querySelector<HTMLElement>('.assistant-dock-body button:not(:disabled)') ??
    panel
  );
}

function ShellBody({ state }: { state: DockShellState }) {
  if (state === 'loading') return <p className="assistant-dock-note">{STATE_LOADING}</p>;
  if (state === 'remote') return <p className="assistant-dock-note" data-dock-remote="1">{REMOTE_TEXT}</p>;
  if (state === 'error') {
    return (
      <>
        <p className="assistant-dock-note">{STATE_ERROR}</p>
        <button type="button" className="home-btn" data-dock-retry="1" onClick={() => void retryStatus()}>
          {TRY_AGAIN}
        </button>
      </>
    );
  }
  return (
    <>
      <p className="assistant-dock-note">{STATE_OFF}</p>
      <button type="button" className="home-btn" data-dock-open-settings="1" onClick={openSettings}>
        {OPEN_SETTINGS}
      </button>
    </>
  );
}

export function DockShell({ content = null }: { content?: DockContent | null }) {
  const dock = useDock();
  const status = useAssistantStatus();
  const panelRef = useRef<HTMLElement>(null);
  const shell = dockShellState(status);
  const state: DockState = shell ?? (content ? content.state : 'empty');

  // A close with the keyboard in the dock gives it back now, as the corner button shows again.
  useLayoutEffect(() => {
    if (!dock.open) takeReturnFocus()?.();
  }, [dock.open]);

  // Each opening reads the status again (and the coding agents, once, if never looked for)
  // and ends the frame's full screen.
  useEffect(() => {
    if (!dock.open) return;
    void refreshStatus().then(listAgentsOnce);
    void exitFrameFullscreen();
  }, [dock.open]);

  // The keyboard goes to the entry when asked (opening, Ctrl+/ from elsewhere)...
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!dock.open || !panel || dock.focusSeq === 0) return;
    entryOf(panel).focus({ preventScroll: true });
  }, [dock.focusSeq, dock.open]);
  // ...and when it was on the panel itself and the state changed (the status came in).
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel && dock.open && document.activeElement === panel) entryOf(panel).focus({ preventScroll: true });
  }, [state, dock.open]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.nativeEvent.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    closeDock();
  };

  const pill = dock.pill;
  return (
    <>
      <aside
        id="assistant-dock"
        ref={panelRef}
        className="assistant-dock"
        aria-label={DOCK_TITLE}
        data-assistant-dock-state={state}
        data-dock-size={dock.size}
        hidden={!dock.open}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onDragOver={keepFileDrop}
        onDrop={keepFileDrop}
      >
        <header className="assistant-dock-head">
          <h2 className="assistant-dock-title">{DOCK_TITLE}</h2>
          {!shell && content ? content.header : null}
          <span className="assistant-dock-head-gap" />
          <button type="button" className="assistant-dock-icon" aria-label={ASSISTANT_SETTINGS} title={ASSISTANT_SETTINGS} data-dock-settings="1" onClick={openSettings}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
              <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" />
              </g>
            </svg>
          </button>
          <button type="button" className="assistant-dock-icon" aria-label={CLOSE_DOCK} title={CLOSE_DOCK} data-dock-close="1" onClick={() => closeDock()}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
              <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        {shell ? (
          <>
            {/* A question shows whatever the dock's state (another app's, with the Assistant off). */}
            {shell !== 'remote' && content && content.questions ? (
              <div className="assistant-dock-questions" data-dock-questions="1">
                {content.questions}
              </div>
            ) : null}
            <div className="assistant-dock-body assistant-dock-state">
              <ShellBody state={shell} />
            </div>
          </>
        ) : (
          <>
            {content && content.questions ? (
              <div className="assistant-dock-questions" data-dock-questions="1">
                {content.questions}
              </div>
            ) : null}
            <div className="assistant-dock-body assistant-dock-log" role="log" aria-live="off" aria-relevant="additions">
              {content ? content.log : null}
            </div>
            {content && content.composer ? <footer className="assistant-dock-composer">{content.composer}</footer> : null}
          </>
        )}
      </aside>
      {/* Outside the panel: announcements also reach the person while it is closed (live.ts). */}
      <div id="assistant-dock-live" className="assistant-dock-live" role="status" aria-live="polite" />
      {/* The corner button: always there while the dock is closed ("Assistant", or what is going on). */}
      <div
        className="assistant-dock-pill"
        data-assistant-pill="1"
        data-pill={pill ? pill.kind : undefined}
        hidden={dock.open}
        onDragOver={keepFileDrop}
        onDrop={keepFileDrop}
      >
        <button
          type="button"
          className="assistant-dock-pill-open"
          aria-label={pill ? pill.text : DOCK_TITLE}
          aria-controls="assistant-dock"
          aria-expanded="false"
          onClick={(e) => openDock({ from: e.currentTarget })}
        >
          <svg className="assistant-dock-pill-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
            <path
              d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V16.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinejoin="round"
            />
          </svg>
          <span className="assistant-dock-pill-dot" aria-hidden="true" />
          <span className="assistant-dock-pill-text">{pill ? pill.text : DOCK_TITLE}</span>
        </button>
        {pill && pill.onStop ? (
          <button type="button" className="assistant-dock-pill-stop" aria-label={STOP_LABEL} data-pill-stop="1" onClick={pill.onStop}>
            {STOP}
          </button>
        ) : null}
      </div>
    </>
  );
}
