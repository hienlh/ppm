import { DESIGN_GEN_RE } from "./design-types";

/**
 * Pinned element comments: what is stored in `designs/<slug>/.design/comments.json` and
 * what travels between the canvas, the server and the prompt builder.
 *
 * An anchor names an element two ways. `ppmId` (its start-tag offset) is exact, but only
 * for the `gen` it was read under: after the AI edits text above the element every later
 * offset moves, and an old id can name a *different* element. The text quote (the
 * element's own text plus a little of what precedes and follows it) survives that, and
 * `cssPath` breaks ties. See `bridge-anchor-resolve.ts`.
 *
 * Everything in an anchor may have come from the page, whose own scripts can say anything,
 * so {@link parseCommentAnchor} caps and shape-checks every field wherever one enters.
 */

export interface CommentQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface CommentAnchor {
  /** The HTML file, relative to the design folder. */
  file: string;
  ppmId: number | null;
  gen: string | null;
  tag: string;
  cssPath: string;
  quote: CommentQuote;
}

/**
 * Who wrote a comment or a reply, as any view may show it. The owner is the person running
 * PPM; a guest is a reviewer who opened a share link and typed a name.
 */
export type CommentAuthor = { kind: "owner" } | { kind: "guest"; name: string };

/**
 * Where a guest pinned their comment, in the snapshot their link showed. Written once when
 * the comment is made and never changed: the owner's canvas keeps re-anchoring `anchor`
 * against the live file, which says nothing about where the element is in the snapshot.
 * `ppmId`/`gen` are null when the server could not confirm them against the snapshot.
 */
export interface PinnedAnchor {
  snapshotId: string;
  ppmId: number | null;
  gen: string | null;
}

/** A reply in a thread. Replies have no anchor and no pin of their own. */
export interface DesignCommentReply<A extends CommentAuthor = CommentAuthor> {
  id: string;
  body: string;
  author: A;
  createdAt: string;
  updatedAt: string;
}

/**
 * A thread's root comment. The type parameter is the author shape: stored (with the key
 * hash), the owner's view, or the plain one the canvas and prompt builder rely on (see
 * `design-comment-thread-types.ts`).
 */
export interface DesignComment<A extends CommentAuthor = CommentAuthor> {
  id: string;
  file: string;
  anchor: CommentAnchor;
  body: string;
  /**
   * The element's markup, sliced by the server out of the source file when the comment was
   * made (or last re-anchored). Null when the page's `gen` no longer matched the file, or
   * the element was created by a script. Never the markup the page reported.
   */
  snippet: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  sentAt?: string;
  /** Absent means the owner, which is every comment written before reviewers existed. */
  author?: A;
  /** Oldest first; absent when there are none. */
  replies?: DesignCommentReply<A>[];
  /** Guest roots only. */
  pinnedAnchor?: PinnedAnchor;
}

export const COMMENT_LIMITS = {
  /** Roots the owner wrote. Guest entries are counted apart, so reviewers cannot use these up. */
  maxComments: 500,
  /** Replies in one thread, whoever wrote them. */
  maxReplies: 100,
  /** Guest roots and replies through one share link. */
  maxGuestEntriesPerLink: 150,
  /** Guest roots and replies across every link of a design. */
  maxGuestEntries: 1500,
  /** Characters (code points) in a guest's name. */
  guestName: 40,
  body: 4000,
  snippet: 2000,
  exact: 160,
  prefix: 32,
  suffix: 32,
  cssPath: 512,
  file: 1024,
} as const;

/** Lowest resolver score that still counts as the same element (see resolveAnchor). */
export const REANCHOR_MIN_SCORE = 0.55;

export const COMMENT_ID_RE = /^[0-9a-f]{12}$/;
export const ELEMENT_TAG_RE = /^[a-z][a-z0-9-]{0,31}$/;
/**
 * Exactly what the bridge's `cssPathOf` builds: a head of `#id` (a plain id), `body` or a
 * step, then up to five `tag:nth-of-type(n)` steps joined by ` > `; or nothing. Anything
 * else is not a path the canvas made, and it is printed in prompts, so it is dropped.
 */
const CSS_STEP = String.raw`[a-z][a-z0-9-]{0,31}:nth-of-type\([1-9][0-9]{0,5}\)`;
export const CSS_PATH_RE = new RegExp(String.raw`^(?:(?:#[A-Za-z][\w-]{0,63}|body|${CSS_STEP})(?: > ${CSS_STEP}){0,5})?$`);

type Raw = Record<string, unknown>;

const isRaw = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const capped = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

/** A page-supplied quote, capped; HTML comments are removed because they read as instructions. */
export function parseCommentQuote(v: unknown): CommentQuote {
  const q = isRaw(v) ? v : {};
  return {
    exact: stripHtmlComments(capped(q.exact, COMMENT_LIMITS.exact * 2)).slice(0, COMMENT_LIMITS.exact),
    prefix: stripHtmlComments(capped(q.prefix, COMMENT_LIMITS.prefix * 2)).slice(-COMMENT_LIMITS.prefix),
    suffix: stripHtmlComments(capped(q.suffix, COMMENT_LIMITS.suffix * 2)).slice(0, COMMENT_LIMITS.suffix),
  };
}

export function parsePpmId(v: unknown): number | null | undefined {
  if (v === null) return null;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0x7fffffff ? v : undefined;
}

/** A validated anchor, or null. `file` must be a non-empty string; the server checks the path. */
export function parseCommentAnchor(v: unknown): CommentAnchor | null {
  if (!isRaw(v)) return null;
  const ppmId = parsePpmId(v.ppmId);
  const gen = v.gen === null ? null : typeof v.gen === "string" && DESIGN_GEN_RE.test(v.gen) ? v.gen : undefined;
  const file = typeof v.file === "string" ? v.file : "";
  const tag = typeof v.tag === "string" ? v.tag.toLowerCase() : "";
  if (ppmId === undefined || gen === undefined || !file || file.length > COMMENT_LIMITS.file || !ELEMENT_TAG_RE.test(tag)) return null;
  const rawPath = capped(v.cssPath, COMMENT_LIMITS.cssPath);
  return { file, ppmId, gen, tag, cssPath: CSS_PATH_RE.test(rawPath) ? rawPath : "", quote: parseCommentQuote(v.quote) };
}

/** Removes `<!-- … -->`, including an unterminated one running to the end. */
export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}

export function isOpenComment(c: Pick<DesignComment, "resolvedAt">): boolean {
  return !c.resolvedAt;
}
