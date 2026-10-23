/**
 * Sending from the dock (phase 4 spec 3.1, 3.3, 3.5): a request's start and its Stop.
 *
 * startDockTurn always carries this tab's live relay link (D3): the turn's questions show in
 * this tab and it is started_by 'window' (an agent's start proves the window with it too).
 * Bound to the workspace open here when its tools reached the server (`tab: 'link'`), else the
 * project's context (or none from Home). A link the server no longer takes (409 no_channel, or
 * 403 launch_proof for an agent) is replaced once by a fresh one. The 202's answer key is kept
 * only in this tab's sessionStorage, to show the turn's questions here again after a reload; it
 * never answers one.
 */
import { AssistantApiError, assistantPost } from '../api';
import { withAssistantLink } from '../relay';
import type { TurnStarted, TurnSummary } from '../wire';
import type { DockPlace } from './context';
import type { PreparedPicture } from './pictures';
import { addLocalTurn, clearStopSent, dropAnswerKey, keepAnswerKey, keepTurn, markStopSent, refreshConversations, setLocalPictures, showConversation, watchTurn } from './store';

export const TURNS_PATH = '/api/assistant/turns';

/** Turns this page started (since it loaded): their questions show here already. */
const started = new Set<string>();

export function startedHere(turn: string): boolean {
  return started.has(turn);
}

export interface DockSend {
  text: string;
  /** The conversation shown (null: a new one, which takes `provider`). */
  conversation: string | null;
  provider: string | null;
  place: DockPlace;
  pictures: readonly PreparedPicture[];
  /** The files attached and uploaded (their attachment ids; core host tools spec 13.1). */
  attachments?: readonly string[];
}

/** What POST /api/assistant/turns gets from the dock (`link` added per attempt). */
export function turnBody(s: DockSend): Record<string, unknown> {
  const ws = s.place.workspace;
  const bound = !!ws && ws.state === 'tools';
  return {
    text: s.text,
    ...(s.conversation ? { conversation: s.conversation } : s.provider ? { provider: s.provider } : {}),
    ...(bound
      ? { tab: 'link' }
      : s.place.projectId
        ? { context: { project_id: s.place.projectId, ...(s.place.simulationId ? { simulation_id: s.place.simulationId } : {}) } }
        : {}),
    ...(s.pictures.length ? { images: s.pictures.map((p) => ({ media_type: p.media_type, data: p.data })) } : {}),
    ...(s.attachments?.length ? { attachments: [...s.attachments] } : {}),
  };
}

const staleLink = (err: unknown): boolean =>
  err instanceof AssistantApiError && ((err.status === 409 && err.code === 'no_channel') || (err.status === 403 && err.code === 'launch_proof'));

/** POSTs the turn with this tab's link; once more with a fresh link when that one went stale. */
export async function postTurn(body: Record<string, unknown>): Promise<TurnStarted> {
  let refused: string | null = null;
  for (let attempt = 0; ; attempt += 1) {
    let used: string | null = null;
    try {
      return await withAssistantLink(async (link) => {
        used = link;
        return assistantPost<TurnStarted>(TURNS_PATH, link ? { ...body, link } : body);
      }, refused);
    } catch (err) {
      if (attempt > 0 || !staleLink(err) || !used) throw err;
      refused = used;
    }
  }
}

/**
 * Starts the request and shows it: the conversation (a new one is named by the 202), the turn
 * followed and announced, its pictures as this tab's own copies, the list read again.
 */
export async function startDockTurn(s: DockSend): Promise<TurnStarted> {
  const got = await postTurn(turnBody(s));
  started.add(got.turn);
  keepAnswerKey(got.turn, got.answer_key);
  if (s.pictures.length) setLocalPictures(got.turn, s.pictures.map((p) => URL.createObjectURL(p.blob)));
  addLocalTurn(got.conversation, got.turn);
  if (!s.conversation) showConversation(got.conversation);
  watchTurn(got.turn, { announce: true });
  void refreshConversations();
  return got;
}

/**
 * After a reload: a running request this tab started (its answer key kept) shows its open
 * questions in this tab again, on its live link (POST /turns/:id/show). The key only proves who
 * started it; the questions are answered through the relay as always. A key the server refuses,
 * or a request that ended, is forgotten; one shown in another window stays there.
 */
export async function showHere(turn: string, answerKey: string): Promise<void> {
  try {
    await withAssistantLink(async (link) => {
      if (!link) return null;
      return assistantPost(`${TURNS_PATH}/${encodeURIComponent(turn)}/show`, { link, answer_key: answerKey });
    });
  } catch (err) {
    if (err instanceof AssistantApiError && (err.code === 'answer_key' || err.code === 'ended' || err.status === 404)) dropAnswerKey(turn);
  }
}

/**
 * Stops a running request (the composer's Stop, the pill's, "Stop that request"): the footer
 * reads "Stopping…" until its end. Its channel stays pinned while the answer is on its way. A
 * Stop that didn't reach the server answers null and the footer goes back to what the request
 * does (never "Stopping…" for a request that isn't).
 */
export async function stopDockTurn(turn: string): Promise<{ stopping: boolean; turn?: TurnSummary } | null> {
  markStopSent(turn);
  const release = keepTurn(turn);
  try {
    return await assistantPost<{ stopping: boolean; turn?: TurnSummary }>(`${TURNS_PATH}/${encodeURIComponent(turn)}/stop`, {});
  } catch (err) {
    console.warn('[CFD] assistant stop', err);
    clearStopSent(turn);
    return null;
  } finally {
    release();
  }
}
