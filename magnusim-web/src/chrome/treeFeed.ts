import { apiGet } from '../api/client';
import type { ProjectTreeDoc } from './treeModel';

/**
 * Reads of GET /api/project/tree, one request per project at a time.
 *
 * Each read is a project.tree call on the one serial Python worker. A geometry or study
 * switch fires cfd:tree-sync 6-8 times at once, and a request for each used to queue ahead
 * of the switch's own hydrate. Now a read goes out at once when none is out (so it still
 * answers before a hydrate sent after it); asked for while one is out, it marks the tree
 * dirty, and when that answer lands exactly one more request goes out for all of them.
 */

/** One answer. `seq` numbers the requests as sent; a project's answers land in that order. */
export interface TreeAnswer {
  seq: number;
  doc: ProjectTreeDoc | null;
  error?: unknown;
}

type Reader = (answer: TreeAnswer) => void;

interface Feed {
  /** A request is out. */
  busy: boolean;
  /** Asked for while a request was out: read once more when it lands. */
  dirty: boolean;
  /** Each reader, with the first request it hears: one sent after it started listening. */
  readers: Map<Reader, number>;
  /** The request that is out (its seq), while busy. */
  current: number;
}

const feeds = new Map<string, Feed>();
let sent = 0;
let listening = false;

function feedFor(projectId: string): Feed {
  let feed = feeds.get(projectId);
  if (!feed) {
    feed = { busy: false, dirty: false, readers: new Map(), current: 0 };
    feeds.set(projectId, feed);
  }
  return feed;
}

function forget(projectId: string, feed: Feed): void {
  if (feed.busy || feed.readers.size) return;
  if (feeds.get(projectId) === feed) feeds.delete(projectId);
}

function send(projectId: string, feed: Feed): void {
  feed.busy = true;
  feed.dirty = false;
  const seq = ++sent;
  feed.current = seq;
  const land = (answer: TreeAnswer) => {
    try {
      for (const [reader, first] of [...feed.readers]) {
        if (seq >= first && feed.readers.has(reader)) reader(answer);
      }
    } finally {
      feed.busy = false;
      if (feed.dirty) send(projectId, feed);
      else forget(projectId, feed);
    }
  };
  apiGet<ProjectTreeDoc>('/api/project/tree', { project_id: projectId }).then(
    (doc) => land({ seq, doc }),
    (error: unknown) => land({ seq, doc: null, error }),
  );
}

/** Read the project's tree: now, or once more after the request that is out. */
export function readProjectTree(projectId: string): void {
  const feed = feedFor(projectId);
  if (feed.busy) feed.dirty = true;
  else send(projectId, feed);
}

// One cfd:tree-sync listener for all readers: a sync reads each watched project once,
// however many readers it has (the tree and the header menus hear the same syncs).
function onSync(): void {
  for (const [projectId, feed] of feeds) {
    if (feed.readers.size) readProjectTree(projectId);
  }
}

/**
 * Hear the answers to the project's tree reads sent from now on; every cfd:tree-sync
 * reads it again. Returns the stop.
 */
export function onProjectTree(projectId: string, reader: Reader): () => void {
  if (!listening && typeof window !== 'undefined') {
    window.addEventListener('cfd:tree-sync', onSync);
    listening = true;
  }
  const feed = feedFor(projectId);
  feed.readers.set(reader, sent + 1);
  return () => {
    feed.readers.delete(reader);
    forget(projectId, feed);
  };
}

/**
 * Like onProjectTree, for a reader that only needs the project's current tree (the
 * header's Workspaces menu): it also hears the request that is out, and reads only
 * when none is, so starting it never costs a follow-up read of the tree.
 */
export function followProjectTree(projectId: string, reader: Reader): () => void {
  const stop = onProjectTree(projectId, reader);
  const feed = feedFor(projectId);
  if (feed.busy) feed.readers.set(reader, feed.current);
  else send(projectId, feed);
  return stop;
}
