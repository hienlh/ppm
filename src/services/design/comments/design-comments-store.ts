import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import {
  COMMENT_ID_RE, COMMENT_LIMITS, parseCommentAnchor, parsePpmId, type PinnedAnchor,
} from "../../../shared/design-comment-types.ts";
import {
  GUEST_KEY_HASH_RE, parseGuestName, SHARE_LINK_ID_RE,
  type StoredCommentAuthor, type StoredCommentReply, type StoredDesignComment,
} from "../../../shared/design-comment-thread-types.ts";
import { DESIGN_GEN_RE, isSnapshotId } from "../../../shared/design-types.ts";
import { dotDesignDir, lstatOrNull } from "../design-paths.ts";
import { ensureDotDesign, writeFileAtomic } from "../design-fs.ts";
import { readDesignFileSafe } from "../design-safe-walk.ts";
import { DesignError } from "../design-error.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("design");

/**
 * `designs/<slug>/.design/comments.json`: `{ version: 1, comments: [...] }`.
 *
 * The file is PPM's own data, but it sits in a folder an agent can write to, so it is read
 * as untrusted: every entry is re-validated and capped, and a file that does not parse is
 * treated as empty — after a copy is kept as `comments.json.bak`, so a hand edit gone wrong
 * is recoverable rather than silently replaced by the next save.
 *
 * Fields added after the first version (`author`, `replies`, `pinnedAnchor`) are optional
 * and only written when present, so a file from before reviewers existed reads and writes
 * back with the same meaning. An entry naming an author this parser cannot accept is
 * dropped rather than read as the owner's.
 */

export const COMMENTS_FILE = "comments.json";
const MAX_FILE_BYTES = 16 * 1024 * 1024;
/** Roots a file may hold: the owner's cap plus the most guest roots there can be. */
const MAX_STORED_ROOTS = COMMENT_LIMITS.maxComments + COMMENT_LIMITS.maxGuestEntries;

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const isoOrUndefined = (v: unknown): string | undefined =>
  typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : undefined;
const parseText = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.slice(0, COMMENT_LIMITS.body) : null;

/** Undefined when absent (the owner), null when present but not an author. */
function parseAuthor(v: unknown): StoredCommentAuthor | undefined | null {
  if (v === undefined) return undefined;
  if (!isRaw(v)) return null;
  if (v.kind === "owner") return { kind: "owner" };
  if (v.kind !== "guest") return null;
  const name = parseGuestName(v.name);
  if (!name.ok || typeof v.linkId !== "string" || !SHARE_LINK_ID_RE.test(v.linkId)) return null;
  if (typeof v.keyHash !== "string" || !GUEST_KEY_HASH_RE.test(v.keyHash)) return null;
  return { kind: "guest", name: name.name, linkId: v.linkId, keyHash: v.keyHash };
}

function parsePinnedAnchor(v: unknown): PinnedAnchor | undefined {
  if (!isRaw(v) || !isSnapshotId(v.snapshotId)) return undefined;
  const ppmId = parsePpmId(v.ppmId);
  const gen = v.gen === null ? null : typeof v.gen === "string" && DESIGN_GEN_RE.test(v.gen) ? v.gen : undefined;
  if (ppmId === undefined || gen === undefined) return undefined;
  return { snapshotId: v.snapshotId, ppmId, gen };
}

function parseReply(v: unknown): StoredCommentReply | null {
  if (!isRaw(v) || typeof v.id !== "string" || !COMMENT_ID_RE.test(v.id)) return null;
  const body = parseText(v.body);
  const createdAt = isoOrUndefined(v.createdAt);
  // A reply is written with its author; one without is read as the owner's, like a root.
  const author = v.author === undefined ? { kind: "owner" as const } : parseAuthor(v.author);
  if (!body || !createdAt || !author) return null;
  return { id: v.id, body, author, createdAt, updatedAt: isoOrUndefined(v.updatedAt) ?? createdAt };
}

function parseReplies(v: unknown): StoredCommentReply[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set<string>();
  const out: StoredCommentReply[] = [];
  for (const raw of v) {
    if (out.length >= COMMENT_LIMITS.maxReplies) break;
    const reply = parseReply(raw);
    if (reply && !seen.has(reply.id)) {
      seen.add(reply.id);
      out.push(reply);
    }
  }
  return out.length ? out : undefined;
}

export function parseStoredComment(v: unknown): StoredDesignComment | null {
  if (!isRaw(v) || typeof v.id !== "string" || !COMMENT_ID_RE.test(v.id)) return null;
  const anchor = parseCommentAnchor(v.anchor);
  const createdAt = isoOrUndefined(v.createdAt);
  const author = parseAuthor(v.author);
  if (!anchor || !createdAt || author === null || typeof v.body !== "string" || !v.body.trim()) return null;
  const comment: StoredDesignComment = {
    id: v.id,
    file: anchor.file,
    anchor,
    body: v.body.slice(0, COMMENT_LIMITS.body),
    snippet: typeof v.snippet === "string" ? v.snippet.slice(0, COMMENT_LIMITS.snippet) : null,
    createdAt,
    updatedAt: isoOrUndefined(v.updatedAt) ?? createdAt,
  };
  const resolvedAt = isoOrUndefined(v.resolvedAt);
  const sentAt = isoOrUndefined(v.sentAt);
  if (resolvedAt) comment.resolvedAt = resolvedAt;
  if (sentAt) comment.sentAt = sentAt;
  if (author) comment.author = author;
  const replies = parseReplies(v.replies);
  if (replies) comment.replies = replies;
  const pinnedAnchor = parsePinnedAnchor(v.pinnedAnchor);
  if (pinnedAnchor) comment.pinnedAnchor = pinnedAnchor;
  return comment;
}

export async function readComments(designDir: string): Promise<StoredDesignComment[]> {
  const dir = dotDesignDir(designDir);
  const dirStat = await lstatOrNull(dir);
  if (!dirStat) return [];
  // Same rule as every write into `.design/`: a link there would move the read elsewhere.
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new DesignError(403, "EDESIGNPATH", ".design must be a real directory");
  const path = join(dir, COMMENTS_FILE);
  if (!(await lstatOrNull(path))) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readDesignFileSafe(path, MAX_FILE_BYTES)));
  } catch (e) {
    // A JSON error quotes the token it stopped at, which is the file's own text.
    log.warn(`${path} is unreadable (${(e as Error).message.replace(/(["']).*?\1/g, "$1…$1")}); keeping a .bak and starting empty`);
    await copyFile(path, `${path}.bak`).catch((err: Error) =>
      log.error(`could not back up ${path}: ${err.message}; the next comment saved replaces it, and its comments are lost`));
    return [];
  }
  const list = isRaw(parsed) && Array.isArray(parsed.comments) ? parsed.comments : [];
  const seen = new Set<string>();
  const out: StoredDesignComment[] = [];
  for (const raw of list.slice(0, MAX_STORED_ROOTS)) {
    const comment = parseStoredComment(raw);
    if (comment && !seen.has(comment.id)) {
      seen.add(comment.id);
      out.push(comment);
    }
  }
  return out;
}

/**
 * Refuses a write that would make the file larger than it may be read back: an oversized
 * file reads as unreadable, which would lose every comment in it.
 */
export async function writeComments(designDir: string, comments: readonly StoredDesignComment[]): Promise<void> {
  const text = `${JSON.stringify({ version: 1, comments }, null, 2)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    throw new DesignError(409, "ETOOMANY", "This design's comments are at their size limit; delete resolved threads first");
  }
  const dir = await ensureDotDesign(designDir);
  await writeFileAtomic(join(dir, COMMENTS_FILE), text);
}
