import type { DesignCommentGuestView, GuestCommentReplyView } from "../../shared/design-comment-thread-types";
import type { DesignComment } from "../../shared/design-comment-types";
import type { PinStatus } from "../components/design/comments/use-comment-pins";

/**
 * Pure decisions about a link's threads: their order and numbers, what this reviewer may do
 * with each entry, and folding a write's answer into the list held on screen.
 */

export type GuestThread = DesignCommentGuestView;
export type GuestReply = GuestCommentReplyView;

const byCreation = (a: GuestThread, b: GuestThread): number =>
  a.createdAt === b.createdAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.createdAt < b.createdAt ? -1 : 1;

/** Open threads oldest first (the order pins are numbered in); resolved ones most recent first. */
export function groupThreads(threads: readonly GuestThread[]): { open: GuestThread[]; resolved: GuestThread[] } {
  const open = threads.filter((t) => !t.resolvedAt).sort(byCreation);
  const resolved = threads.filter((t) => t.resolvedAt).sort((a, b) => (a.resolvedAt! < b.resolvedAt! ? 1 : a.resolvedAt! > b.resolvedAt! ? -1 : 0));
  return { open, resolved };
}

/** Pin numbers: 1… over the open threads in creation order. Resolved threads have none. */
export function pinNumbers(open: readonly GuestThread[]): Map<string, number> {
  return new Map(open.map((t, i) => [t.id, i + 1]));
}

export type RootDelete = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether the reviewer may delete their own thread: only while nobody has replied, because
 * the replies would go with it. Null for someone else's thread (no button at all). Editing
 * stays allowed either way.
 */
export function rootDelete(thread: GuestThread): RootDelete | null {
  if (!thread.mine) return null;
  if (thread.replies.length === 0) return { allowed: true };
  const others = thread.replies.some((r) => !r.mine);
  return { allowed: false, reason: `${others ? "Others replied" : "It has replies"}, so you can edit it but not delete it.` };
}

export const canEditEntry = (entry: { mine: boolean }): boolean => entry.mine;
export const canDeleteReply = (reply: GuestReply): boolean => reply.mine;

/** What a byline shows. The owner is a badge, never a name, so no reviewer can look like them. */
export function bylineOf(author: GuestThread["author"]): { owner: true } | { owner: false; name: string } {
  return author.kind === "owner" ? { owner: true } : { owner: false, name: author.name };
}

/** The list with `thread` put in place of its old copy, or added when it is new. */
export function upsertThread(list: readonly GuestThread[], thread: GuestThread): GuestThread[] {
  const at = list.findIndex((t) => t.id === thread.id);
  if (at < 0) return [...list, thread];
  const next = list.slice();
  next[at] = thread;
  return next;
}

export function removeThread(list: readonly GuestThread[], id: string): GuestThread[] {
  return list.filter((t) => t.id !== id);
}

/**
 * The shape the canvas pin hook takes. A reviewer's view carries no snippet; the hook never
 * reads one, it only sends each thread's anchor to the frame.
 */
export function asPinComments(open: readonly GuestThread[]): DesignComment[] {
  return open.map((t) => ({
    id: t.id, file: t.file, anchor: t.anchor, body: t.body, snippet: null,
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  }));
}

/**
 * The note beside a thread: where its pin stands, in the words the owner's canvas uses.
 * Null while the frame has not answered yet for an open thread with no number.
 */
export function pinStatusText(status: PinStatus, number: number | null, resolved: boolean): string | null {
  if (resolved) return "Resolved";
  if (status === "detached") return "Detached";
  if (status === "elsewhere") return "On another page";
  return number === null ? null : `Pin ${number}`;
}
