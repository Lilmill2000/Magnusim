/**
 * What the shown conversation puts in the dock: DockShell's `content` (its conversation menu,
 * question cards, transcript and composer; chat dock spec 2-4, 8.3). The conversation's parts
 * come with the next commits and read the conversation store (store.ts, useDockStore). Until
 * then there is none, and the shell shows its own states (loading, error, remote, off) or an
 * empty panel.
 */
import type { DockContent } from './DockShell';

export function useDockContent(): DockContent | null {
  return null;
}
