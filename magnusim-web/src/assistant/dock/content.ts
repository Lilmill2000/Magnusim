/**
 * What the shown conversation puts in the dock: DockShell's `content` (its conversation menu,
 * question cards, transcript and composer; chat dock spec 2-4, 8.3). ConversationView builds
 * it from the conversation store (store.ts, useDockStore); while the status isn't read (or the
 * Assistant is off or remote) there is none and the shell shows its own states.
 */
export { useDockContent } from './ConversationView';
