import { Hono, type Context } from "hono";
import { assistantNotes, type NoteResult } from "../../services/assistant-notes/assistant-notes.service.ts";
import { createLogger } from "../../services/logger.ts";
import { ok, err } from "../../types/api.ts";

/**
 * PPM Assistant's notebook for Settings (`/api/assistant/notes`), behind PPM's auth. Everything
 * written here is the user's: a line added or edited becomes theirs and verified. `PATCH` takes
 * either `{ text }` (an edit) or `{ verified: true }` ("Mark as verified", which clears the
 * unverified flag and changes nothing else). Every change is announced as
 * `assistant:notes_changed`.
 */
export const assistantNotesRoutes = new Hono();

const log = createLogger("assistant-notes");
const USER = { by: "user" } as const;

function noteId(raw: string): number | null {
  if (!/^[1-9]\d{0,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json() as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function respond(c: Context, result: NoteResult, action: string) {
  log.info(`notebook ${action}: ${result.ok ? `#${result.note.id}` : result.code} (site=${c.req.header("sec-fetch-site") ?? "none"})`);
  if (result.ok) return c.json(ok({ note: result.note }));
  return c.json(err(result.error), result.code === "not_found" ? 404 : 400);
}

assistantNotesRoutes.get("/notes", (c) => {
  try {
    return c.json(ok(assistantNotes.list()));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

assistantNotesRoutes.post("/notes", async (c) => {
  const body = await jsonBody(c);
  if (!body || typeof body.text !== "string") return c.json(err("Body must be { text }"), 400);
  try {
    return respond(c, assistantNotes.add(body.text, USER), "add");
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

assistantNotesRoutes.patch("/notes/:id", async (c) => {
  const id = noteId(c.req.param("id"));
  if (id === null) return c.json(err("No such note"), 404);
  const body = await jsonBody(c);
  const editing = typeof body?.text === "string";
  const verifying = body?.verified === true;
  if (!body || editing === verifying) return c.json(err("Body must be { text } or { verified: true }"), 400);
  try {
    return editing
      ? respond(c, assistantNotes.edit(id, body.text, USER), "edit")
      : respond(c, assistantNotes.markVerified(id), "verify");
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

assistantNotesRoutes.delete("/notes/:id", (c) => {
  const id = noteId(c.req.param("id"));
  if (id === null) return c.json(err("No such note"), 404);
  try {
    return respond(c, assistantNotes.remove(id, USER), "delete");
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});
