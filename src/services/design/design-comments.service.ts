import { randomBytes } from "node:crypto";
import {
  COMMENT_ID_RE, COMMENT_LIMITS, parseCommentAnchor, parsePpmId, type CommentAnchor, type DesignComment,
} from "../../shared/design-comment-types.ts";
import { DESIGN_GEN_RE } from "../../shared/design-types.ts";
import { resolveDesignDir } from "./design-paths.ts";
import { withRecoveredDesign } from "./design-restore-journal.ts";
import { emitDesignEvent } from "./design-events.ts";
import { DesignError } from "./design-error.ts";
import { readComments, writeComments } from "./comments/design-comments-store.ts";
import { elementContext, validateReanchor, type ElementContext } from "./comments/design-comment-element-context.ts";

/**
 * Pinned element comments of one design.
 *
 * Every change runs under the design's lock (so two devices commenting at once cannot lose
 * each other's write), writes `comments.json` atomically, and announces itself as
 * `comments_changed`: `.design/` is not watched, so that event is the only way another
 * device's list learns of it.
 *
 * Input arrives from the browser, and anchors originate in the page, so everything is
 * validated and capped here. The element snippet is never taken from the request; it is
 * built from the source file (see `design-comment-element-context.ts`).
 */

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const badRequest = (message: string): DesignError => new DesignError(400, "EBADCOMMENT", message);
const notFound = (): DesignError => new DesignError(404, "ENOENT", "Comment not found");

function parseBody(v: unknown, required: boolean): string | undefined {
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || !v.trim()) throw badRequest("A comment needs some text");
  if (v.length > COMMENT_LIMITS.body) throw badRequest(`A comment is at most ${COMMENT_LIMITS.body} characters`);
  return v.trim();
}

function parseAnchorInput(input: Raw): CommentAnchor {
  const anchor = parseCommentAnchor(input.anchor);
  if (!anchor) throw badRequest("Invalid element anchor");
  if (input.file !== undefined && input.file !== anchor.file) throw badRequest("file does not match the anchor");
  return anchor;
}

function changed(projectPath: string, slug: string): void {
  emitDesignEvent("comments_changed", { projectPath, slug });
}

export async function listComments(projectPath: string, slug: string): Promise<DesignComment[]> {
  return readComments(await resolveDesignDir(projectPath, slug));
}

/** The server-built context for an element, without saving anything ("Send to AI" on one element). */
export async function previewElementContext(projectPath: string, slug: string, input: unknown): Promise<ElementContext> {
  if (!isRaw(input)) throw badRequest("Expected a JSON object");
  const anchor = parseAnchorInput(input);
  await resolveDesignDir(projectPath, slug);
  return elementContext(projectPath, slug, anchor);
}

export async function addComment(projectPath: string, slug: string, input: unknown): Promise<DesignComment> {
  if (!isRaw(input)) throw badRequest("Expected a JSON object");
  const anchor = parseAnchorInput(input);
  const body = parseBody(input.body, true)!;
  const comment = await withRecoveredDesign(projectPath, slug, async (designDir) => {
    const comments = await readComments(designDir);
    if (comments.length >= COMMENT_LIMITS.maxComments) {
      throw new DesignError(409, "ETOOMANY", `A design holds at most ${COMMENT_LIMITS.maxComments} comments; delete resolved ones first`);
    }
    const context = await elementContext(projectPath, slug, anchor);
    const now = new Date().toISOString();
    const created: DesignComment = {
      id: randomBytes(6).toString("hex"),
      file: anchor.file,
      anchor: { ...anchor, quote: context.quote },
      body,
      snippet: context.snippet,
      createdAt: now,
      updatedAt: now,
    };
    await writeComments(designDir, [...comments, created]);
    return created;
  });
  changed(projectPath, slug);
  return comment;
}

/**
 * `body`, `resolved` (true/false), `sent` (true: stamp `sentAt`) and `anchor` (`{ppmId,
 * gen}` the canvas found the element under, re-validated against the source; 409 if it
 * does not hold up). At least one must be given.
 */
export async function updateComment(projectPath: string, slug: string, id: string, patch: unknown): Promise<DesignComment> {
  if (!COMMENT_ID_RE.test(id)) throw notFound();
  if (!isRaw(patch)) throw badRequest("Expected a JSON object");
  const body = parseBody(patch.body, false);
  const resolved = patch.resolved === undefined ? undefined : patch.resolved === true ? true : patch.resolved === false ? false : null;
  if (resolved === null) throw badRequest("resolved must be true or false");
  if (patch.sent !== undefined && patch.sent !== true) throw badRequest("sent can only be true");
  let move: { ppmId: number; gen: string } | undefined;
  if (patch.anchor !== undefined) {
    const a = isRaw(patch.anchor) ? patch.anchor : {};
    const ppmId = parsePpmId(a.ppmId);
    if (typeof ppmId !== "number" || typeof a.gen !== "string" || !DESIGN_GEN_RE.test(a.gen)) throw badRequest("Invalid anchor update");
    move = { ppmId, gen: a.gen };
  }
  if (body === undefined && resolved === undefined && patch.sent === undefined && !move) throw badRequest("Nothing to update");

  const updated = await withRecoveredDesign(projectPath, slug, async (designDir) => {
    const comments = await readComments(designDir);
    const index = comments.findIndex((c) => c.id === id);
    if (index < 0) throw notFound();
    const now = new Date().toISOString();
    const next: DesignComment = { ...comments[index]!, updatedAt: now };
    if (body !== undefined) next.body = body;
    if (resolved === true && !next.resolvedAt) next.resolvedAt = now;
    if (resolved === false) delete next.resolvedAt;
    if (patch.sent === true) next.sentAt = now;
    if (move) {
      next.snippet = await validateReanchor(projectPath, slug, next.anchor, move);
      next.anchor = { ...next.anchor, ppmId: move.ppmId, gen: move.gen };
    }
    comments[index] = next;
    await writeComments(designDir, comments);
    return next;
  });
  changed(projectPath, slug);
  return updated;
}

export async function deleteComment(projectPath: string, slug: string, id: string): Promise<void> {
  if (!COMMENT_ID_RE.test(id)) throw notFound();
  await withRecoveredDesign(projectPath, slug, async (designDir) => {
    const comments = await readComments(designDir);
    const rest = comments.filter((c) => c.id !== id);
    if (rest.length === comments.length) throw notFound();
    await writeComments(designDir, rest);
  });
  changed(projectPath, slug);
}
