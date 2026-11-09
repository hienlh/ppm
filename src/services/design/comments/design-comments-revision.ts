import { designLockKey } from "../design-lock.ts";

/**
 * A per-design counter, bumped every time a comment change is announced. It lets a poll be
 * answered "unchanged" from memory and one `stat`, without reading `comments.json`. It is
 * lost on restart, which is why a reader pairs it with a per-boot id and the file's own
 * mtime and size rather than trusting it alone.
 */

const revisions = new Map<string, number>();

export function bumpCommentsRevision(projectPath: string, slug: string): void {
  const key = designLockKey(projectPath, slug);
  revisions.set(key, (revisions.get(key) ?? 0) + 1);
}

export function commentsRevision(projectPath: string, slug: string): number {
  return revisions.get(designLockKey(projectPath, slug)) ?? 0;
}
