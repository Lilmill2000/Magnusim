/**
 * A saved chat read in the dock (History, Daniel: "save 31 days"): what the history kept of each
 * request (scripts/server/assistant/history.ts), oldest first. The person's prompt (and how many
 * pictures went with it, and its files), each tool step's line (its title and its result's
 * summary, or how it failed), the model's words, and how the request ended, as a live request's
 * end block says it. Nothing in it runs or answers: it is read only. In the composer's place, a
 * line says so with Continue in a new chat (not for a coding agent's: it keeps its own history)
 * and New conversation.
 *
 * Every string here is server data shown as text.
 */
import type { HistoryRequest } from '../wire';
import {
  ATTACHED_FILES,
  CONTINUE_IN_NEW_CHAT,
  dayTime,
  endBody,
  endLabel,
  NEW_CONVERSATION,
  SAVED_CUT,
  SAVED_LOADING,
  savedLine,
  savedPictures,
  savedStep,
  SHOW_MORE,
  stepsLeftOut,
  usageLine,
} from './copy';
import { ModelText } from './ModelText';
import { continueInNewChat, moreSavedChat, showConversation, type DockSaved } from './store';

type EndState = 'done' | 'stopped' | 'failed' | 'capped';
type Billing = 'usd' | 'free' | 'agent_account';
const END_STATES: ReadonlySet<string> = new Set(['done', 'stopped', 'failed', 'capped']);
const BILLINGS: ReadonlySet<string> = new Set(['usd', 'free', 'agent_account']);

/** Whether a saved chat's provider is a coding agent's (nothing of it is carried). */
const isAgent = (provider: string) => provider.startsWith('agent:');

function SavedRequest({ r, label }: { r: HistoryRequest; label: string }) {
  const state: EndState = END_STATES.has(r.end.state) ? (r.end.state as EndState) : 'failed';
  const billing: Billing = BILLINGS.has(r.usage.billing) ? (r.usage.billing as Billing) : 'usd';
  const ended = endLabel(state);
  const body = state === 'done' ? usageLine(r.usage.steps, billing, r.usage.usd, billing === 'agent_account' ? label : null) : endBody(state, r.end.message, r.end.reason);
  return (
    <article className="dock-turn" data-dock-saved-turn={r.turn}>
      <div className="dock-you">
        <p className="dock-bubble" data-dock-prompt="1">
          {r.prompt}
        </p>
        {r.pictures ? <p className="dock-muted dock-from">{savedPictures(r.pictures)}</p> : null}
        {r.files.length ? (
          <ul className="dock-you-files" aria-label={ATTACHED_FILES}>
            {r.files.map((f, i) => (
              <li key={`${i}:${f}`}>{f}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {r.steps.map((s, i) => (
        <p key={`${i}:${s.tool}`} className="dock-muted dock-line" data-dock-saved-step={s.tool} data-dock-saved-ok={s.ok === null ? 'none' : s.ok ? '1' : '0'}>
          {savedStep(s.ok, s.title || s.tool, s.line, s.code)}
        </p>
      ))}
      {r.steps_left_out ? <p className="dock-muted dock-line">{stepsLeftOut(r.steps_left_out)}</p> : null}
      {r.answer ? <ModelText text={r.answer} /> : null}
      {r.cut?.length ? <p className="dock-muted dock-line">{SAVED_CUT}</p> : null}
      <div className={`dock-end${state === 'done' ? '' : ` ${state}`}`} data-turn-end={state}>
        {ended ? <strong className="dock-end-label">{ended}</strong> : null}
        {body ? <p className={state === 'done' ? 'dock-muted' : undefined}>{body}</p> : null}
      </div>
    </article>
  );
}

/** The saved chat's requests (the dock's log while it is shown). */
export function SavedChat({ saved }: { saved: DockSaved }) {
  const label = saved.chat?.label ?? '';
  return (
    <div className="dock-transcript" data-dock-saved={saved.id} data-dock-saved-state={saved.state}>
      {saved.requests.map((r, i) => (
        <SavedRequest key={`${i}:${r.turn}`} r={r} label={label} />
      ))}
      {saved.state === 'loading' ? <p className="dock-muted">{SAVED_LOADING}</p> : null}
      {saved.error ? (
        <p className="dock-alert" role="alert">
          {saved.error}
        </p>
      ) : null}
      {saved.next !== null && saved.state !== 'loading' ? (
        <button type="button" className="dock-link-button dock-earlier" data-dock-saved-more="1" onClick={() => void moreSavedChat()}>
          {SHOW_MORE}
        </button>
      ) : null}
    </div>
  );
}

/** In the composer's place under a saved chat: it is read only; Continue in a new chat, or New conversation. */
export function SavedBar({ saved }: { saved: DockSaved }) {
  const chat = saved.chat;
  const carry = !!chat && !isAgent(chat.provider);
  return (
    <div className="dock-readonly" data-dock-saved-bar="1">
      <p className="dock-muted">{savedLine(chat ? dayTime(chat.ended_at) : '', carry)}</p>
      <div className="dock-readonly-actions">
        {carry && chat ? (
          <button type="button" className="home-btn" data-dock-saved-continue="1" onClick={() => continueInNewChat({ from: chat.id, provider: chat.provider, label: chat.label })}>
            {CONTINUE_IN_NEW_CHAT}
          </button>
        ) : null}
        <button type="button" className="home-btn" data-dock-new-line="1" onClick={() => showConversation(null)}>
          {NEW_CONVERSATION}
        </button>
      </div>
    </div>
  );
}
