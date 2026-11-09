import type { Context, Hono } from "hono";
import { err, ok } from "../../types/api.ts";
import { crossOriginRefusal } from "./cross-origin-guard.ts";
import { GUEST_KEY_HEADER, GUEST_WRITE_MAX_BYTES } from "../../shared/design-share-guest-types.ts";
import type { DesignCommentGuestView } from "../../shared/design-comment-thread-types.ts";
import type { ResolvedShareLink } from "../../services/design/share/design-share-resolve.ts";
import { guestLinkOpen, resolveGuestLink } from "../../services/design/share/design-share-guest-link.ts";
import {
  checkShareClientWrite, takeShareRead, takeShareWrite,
} from "../../services/design/share/design-share-rate-limit.ts";
import {
  addGuestComment, addGuestReply, deleteGuestComment, deleteGuestReply, guestCommentsEtag, guestKeyHash,
  listGuestThreads, updateGuestComment, updateGuestReply,
} from "../../services/design/share/design-share-comments.service.ts";
import { notifyGuestWrite } from "../../services/design/share/design-share-notifier.ts";
import { clientKeyOf, guestFail, invalidJson, readCappedText, tooManyRequests } from "./design-share-guest-shared.ts";

/**
 * `/s/<code>/comments…`: a reviewer's threads on the link, and their writes.
 *
 * A read needs no key (without one nothing is "mine"); `If-None-Match` is answered from the
 * ETag before the file is read. A write needs the reviewer's key and passes the cross-origin
 * header pair: there is no `cors()` in front of these routes, so a page on another origin
 * cannot get the browser to send either. The client's write budget is checked before the
 * code is looked up, and the write is counted against the client and the link before the
 * body is read, so a stream of refused writes still costs the sender.
 */

type Body = Record<string, unknown>;
type GuestWrite = (resolved: ResolvedShareLink, keyHash: string, body: Body) => Promise<Response>;

async function guestWrite(c: Context, run: GuestWrite): Promise<Response> {
  const refusal = crossOriginRefusal(c);
  if (refusal) return c.json(err(refusal), 403);
  const keyHash = guestKeyHash(c.req.header(GUEST_KEY_HEADER));
  if (!keyHash) return c.json(err("A reviewer key is needed"), 400);
  const clientKey = clientKeyOf(c);
  // Write spacing is per reviewer, not per address: behind the supervisor every LAN reviewer
  // shares one address, and a reply sent right after a colleague's comment is not a flood.
  // The per-link cap still bounds a sender that invents keys.
  const writerKey = `${clientKey}:${keyHash}`;
  const early = checkShareClientWrite(writerKey);
  if (early) return tooManyRequests(c, early);
  const resolved = await resolveGuestLink(c.req.param("code") ?? "");
  if (!resolved) {
    // A code that opens nothing still costs a read, so guessing has a price.
    takeShareRead("api", clientKey);
    return invalidJson(c);
  }
  const retry = takeShareWrite(writerKey, resolved.link.id);
  if (retry) return tooManyRequests(c, retry);
  let body: unknown;
  try {
    const text = await readCappedText(c.req.raw, GUEST_WRITE_MAX_BYTES);
    if (text === null) return c.json(err("Request too large"), 413);
    body = text.trim() ? JSON.parse(text) : {};
  } catch {
    return c.json(err("Expected a JSON object"), 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json(err("Expected a JSON object"), 400);
  try {
    return await run(resolved, keyHash, body as Body);
  } catch (e) {
    return guestFail(c, e, resolved.link.id);
  }
}

/**
 * Tell the owner, unless the link closed between the write and now: a revoked link's last
 * write is not news worth a notification, and a notification would carry its threads' text.
 */
function notifyIfOpen(r: ResolvedShareLink, thread: DesignCommentGuestView, kind: "comment" | "reply"): void {
  if (guestLinkOpen(r)) notifyGuestWrite(r, thread, kind);
}

export function registerGuestCommentRoutes(app: Hono): void {
  app.get("/:code/comments", async (c) => {
    const clientKey = clientKeyOf(c);
    const retry = takeShareRead("api", clientKey);
    if (retry) return tooManyRequests(c, retry);
    const resolved = await resolveGuestLink(c.req.param("code"));
    if (!resolved) return invalidJson(c);
    const keyHash = guestKeyHash(c.req.header(GUEST_KEY_HEADER));
    try {
      const etag = await guestCommentsEtag(resolved, keyHash);
      if (c.req.header("if-none-match") === etag) return new Response(null, { status: 304, headers: { ETag: etag } });
      const { threads, versionId, etag: current } = await listGuestThreads(resolved, keyHash);
      return c.json(ok({ threads, versionId }), 200, { ETag: current });
    } catch (e) {
      return guestFail(c, e, resolved.link.id);
    }
  });

  // New comments and replies tell the owner; edits and deletes do not.
  app.post("/:code/comments", (c) => guestWrite(c, async (r, key, body) => {
    const thread = await addGuestComment(r, key, body);
    notifyIfOpen(r, thread, "comment");
    return c.json(ok({ thread }), 201);
  }));

  app.post("/:code/comments/:id/replies", (c) => guestWrite(c, async (r, key, body) => {
    const thread = await addGuestReply(r, key, c.req.param("id"), body);
    notifyIfOpen(r, thread, "reply");
    return c.json(ok({ thread }), 201);
  }));

  app.patch("/:code/comments/:id", (c) => guestWrite(c, async (r, key, body) =>
    c.json(ok({ thread: await updateGuestComment(r, key, c.req.param("id"), body) }))));

  app.delete("/:code/comments/:id", (c) => guestWrite(c, async (r, key) => {
    await deleteGuestComment(r, key, c.req.param("id"));
    return c.json(ok({ deleted: c.req.param("id") }));
  }));

  app.patch("/:code/comments/:id/replies/:replyId", (c) => guestWrite(c, async (r, key, body) =>
    c.json(ok({ thread: await updateGuestReply(r, key, c.req.param("id"), c.req.param("replyId"), body) }))));

  app.delete("/:code/comments/:id/replies/:replyId", (c) => guestWrite(c, async (r, key) =>
    c.json(ok({ thread: await deleteGuestReply(r, key, c.req.param("id"), c.req.param("replyId")) }))));
}
