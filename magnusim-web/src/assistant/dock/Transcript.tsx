/**
 * The shown conversation's transcript (phase 4 spec 2.4-2.10, 4.7, 5.4, 10.4): its requests,
 * oldest first (the newest 10, "Show earlier requests" for 10 more), the intro while it has
 * none, the requests of other origins bound to this tab under "Elsewhere", and the picture
 * viewer. It follows the newest row while the person is within 48 px of the bottom; otherwise
 * a "New messages ↓" button appears.
 */
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentContext, AssistantStatus, ConversationRoom, ConversationTurn } from '../wire';
import { ELSEWHERE, NEW_MESSAGES, pictureAlt, SHOW_EARLIER, yourPictureAlt } from './copy';
import { TurnBlock } from './TurnBlock';
import type { TurnView } from './turnView';
import { Viewer, type ViewerPicture } from './Viewer';

/** Within this many px of the bottom, the transcript follows new rows. */
export const FOLLOW_SLACK_PX = 48;

export interface TranscriptTurn {
  id: string;
  row: ConversationTurn | null;
  view: TurnView;
}

export interface TranscriptProps {
  turns: readonly TranscriptTurn[];
  /** Requests of other origins bound to this tab (read-only; spec 4.7). */
  elsewhere?: readonly TranscriptTurn[];
  hasEarlier: boolean;
  onEarlier: () => void;
  intro: string | null;
  status: AssistantStatus | null;
  workspace: string;
  stops?: Readonly<Record<string, number>>;
  localPictures?: (turn: string) => readonly string[] | undefined;
  cardsFor?: (turn: string) => ReactNode;
  endExtraFor?: (turn: string) => ReactNode;
  noteFor?: (turn: string) => string | null;
  /** The conversation's nearest limit while no request of it runs (the meter's room readout). */
  room?: ConversationRoom | null;
  /** A coding agent's conversation: the context its agent uses, of its size, while no request of it runs. */
  agentContext?: AgentContext | null;
}

function picturesOf(t: TurnView): ViewerPicture[] {
  const out: ViewerPicture[] = [];
  t.promptImages.forEach((im, i) => out.push({ turn: t.id, image: im, alt: yourPictureAlt(i + 1, t.promptImages.length) }));
  for (const it of t.items) {
    if (it.kind !== 'tool' || !it.result) continue;
    const imgs = it.result.images;
    imgs.forEach((im, i) => out.push({ turn: t.id, image: im, alt: pictureAlt(i + 1, imgs.length, it.title || it.tool) }));
  }
  return out;
}

export function Transcript(p: TranscriptProps) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useRef(true);
  const lastHeight = useRef(0);
  const [behind, setBehind] = useState(false);
  const [viewer, setViewer] = useState<{ pictures: ViewerPicture[]; index: number } | null>(null);

  const scroller = () => ref.current?.closest<HTMLElement>('.assistant-dock-log') ?? null;
  const toBottom = useCallback(() => {
    const el = ref.current?.closest<HTMLElement>('.assistant-dock-log');
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    near.current = true;
    setBehind(false);
  }, []);

  useLayoutEffect(() => {
    const el = scroller();
    if (!el) return;
    const onScroll = () => {
      near.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
      if (near.current) setBehind(false);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // After each render: follow the newest row, or say new rows came below.
  useLayoutEffect(() => {
    const el = scroller();
    if (!el) return;
    const grew = el.scrollHeight > lastHeight.current;
    lastHeight.current = el.scrollHeight;
    if (!grew) return;
    if (near.current) el.scrollTop = el.scrollHeight;
    else setBehind(true);
  });

  const openPicture = (views: readonly TranscriptTurn[]) => (turn: string, n: string) => {
    const t = views.find((x) => x.id === turn);
    if (!t) return;
    const pictures = picturesOf(t.view);
    const index = pictures.findIndex((x) => x.image.n === n);
    if (index >= 0) setViewer({ pictures, index });
  };

  const block = (list: readonly TranscriptTurn[], t: TranscriptTurn, newest: boolean) => (
    <TurnBlock
      key={t.id}
      view={t.view}
      row={t.row}
      newest={newest}
      status={p.status}
      workspace={p.workspace}
      stopSentAt={p.stops?.[t.id] ?? null}
      localPictures={p.localPictures?.(t.id)}
      onOpenPicture={openPicture(list)}
      note={p.noteFor?.(t.id) ?? null}
      cards={p.cardsFor?.(t.id)}
      endExtra={p.endExtraFor?.(t.id)}
      room={newest ? (p.room ?? null) : null}
      agentContext={newest ? (p.agentContext ?? null) : null}
    />
  );

  return (
    <div className="dock-transcript" ref={ref}>
      {p.hasEarlier ? (
        <button type="button" className="dock-link-button dock-earlier" data-dock-earlier="1" onClick={p.onEarlier}>
          {SHOW_EARLIER}
        </button>
      ) : null}
      {!p.turns.length && p.intro ? (
        <p className="dock-intro" data-dock-intro="1">
          {p.intro}
        </p>
      ) : null}
      {p.turns.map((t, i) => block(p.turns, t, i === p.turns.length - 1))}
      {p.elsewhere && p.elsewhere.length ? (
        <section className="dock-elsewhere" data-dock-elsewhere="1">
          <h3 className="dock-subhead">{ELSEWHERE}</h3>
          {p.elsewhere.map((t) => block(p.elsewhere ?? [], t, false))}
        </section>
      ) : null}
      {behind ? (
        <button type="button" className="dock-new-messages" data-dock-new-messages="1" onClick={toBottom}>
          {NEW_MESSAGES}
        </button>
      ) : null}
      {viewer ? <Viewer pictures={viewer.pictures} index={viewer.index} onIndex={(index) => setViewer({ ...viewer, index })} onClose={() => setViewer(null)} /> : null}
    </div>
  );
}
