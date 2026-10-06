import { Hono, type Context } from "hono";
import { resolve } from "node:path";
import { ok, err } from "../../types/api.ts";
import { getSessionProjectPath, resolveMigratedSession } from "../../services/db.service.ts";
import { isValidBaselineSessionId, keepsSessionWrites } from "../../services/session-file-baselines/session-file-baselines.service.ts";
import {
  lineage,
  MAX_SESSION_CHANGE_PATHS,
  sessionFileChanges,
  sessionFileDiff,
  setSessionFilesReviewed,
} from "../../services/session-file-baselines/session-file-changes.service.ts";
import { answerSessionChanges, undoSessionAnswer } from "../../services/session-file-baselines/session-review-actions.ts";
import { MAX_TURN_CALLS, revertTurn } from "../../services/session-file-baselines/session-turn-revert.ts";
import type { SessionAnswer, SessionAnswerFile } from "../../shared/session-file-changes.ts";

type Env = { Variables: { projectPath: string; projectName: string } };

/**
 * A chat session's changes, for the changes bar above the composer and the Review tab.
 * Mounted under one project's `/chat`, and every route answers only for a session of that
 * project (`sessionOf`): another project's is a 404, as if it did not exist.
 */
export const chatFileChangesRoutes = new Hono<Env>();

/** Paths compared the way the file system does: case-blind on Windows. */
function samePath(a: string, b: string): boolean {
  const [x, y] = [resolve(a), resolve(b)];
  return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Whether the session is this project's. It matters because the routes write as well as read,
 * and a session's records can name files anywhere. The project PPM recorded for the session
 * decides: a provider records it when the session starts, and the Claude capture hooks when PPM
 * first keeps a write of a session started elsewhere. One with no record passes only while PPM
 * keeps none of its writes, nor of a session it was branched from: its review can then read
 * nothing but files inside this project, from git.
 */
function belongsTo(sessionId: string, raw: string, projectPath: string): boolean {
  const recorded = getSessionProjectPath(sessionId) ?? getSessionProjectPath(raw);
  if (recorded) return samePath(recorded, projectPath);
  return !lineage(sessionId).some(keepsSessionWrites);
}

/**
 * The id that owns the session's files (a provider that minted its own id moved them there),
 * or the response refusing it.
 */
function sessionOf(c: Context<Env>): string | Response {
  const raw = c.req.param("id") ?? "";
  const id = resolveMigratedSession(raw);
  if (!isValidBaselineSessionId(id)) return c.json(err("Invalid session id"), 400);
  if (!belongsTo(id, raw, c.get("projectPath"))) return c.json(err("Session not found"), 404);
  return id;
}

/**
 * POST /chat/sessions/:id/file-changes { paths?: string[] }
 *
 * Every file the session changed. The server knows the files it kept a "before" for; `paths`
 * adds the ones the browser read off the transcript, which covers a session older than those
 * copies. Files with no net change are left out.
 */
chatFileChangesRoutes.post("/sessions/:id/file-changes", async (c) => {
  const sessionId = sessionOf(c);
  if (typeof sessionId !== "string") return sessionId;
  const body = await c.req.json<{ paths?: unknown }>().catch(() => ({ paths: undefined }));
  const paths = Array.isArray(body.paths)
    ? body.paths.filter((p): p is string => typeof p === "string").slice(0, MAX_SESSION_CHANGE_PATHS)
    : [];
  try {
    const files = await sessionFileChanges({ sessionId, projectPath: c.get("projectPath"), paths });
    return c.json(ok({ files }));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/**
 * POST /chat/sessions/:id/file-changes/reviewed { files: { path, version }[], reviewed: boolean }
 *
 * Mark files reviewed as they were shown (`version`), or unmark them. A file that has changed
 * since it was shown is left as it was and named in `stale`.
 */
chatFileChangesRoutes.post("/sessions/:id/file-changes/reviewed", async (c) => {
  const sessionId = sessionOf(c);
  if (typeof sessionId !== "string") return sessionId;
  const body = await c.req.json<{ files?: unknown; reviewed?: unknown }>().catch(() => ({ files: undefined, reviewed: undefined }));
  if (!Array.isArray(body.files) || typeof body.reviewed !== "boolean") return c.json(err("files and reviewed are required"), 400);
  const files = body.files
    .filter((f): f is { path: string; version: string } => typeof f?.path === "string" && f.path !== "" && typeof f.version === "string")
    .slice(0, MAX_SESSION_CHANGE_PATHS);
  try {
    return c.json(ok(await setSessionFilesReviewed({ sessionId, projectPath: c.get("projectPath"), files, reviewed: body.reviewed })));
  } catch (e) {
    return c.json(err((e as Error).message), 500);
  }
});

/** More block keys than any one file has; a bigger list is cut. */
const MAX_BLOCK_KEYS = 2000;
const ANSWERS = new Set<SessionAnswer>(["keep", "open", "revert"]);

/** The files of an answer, or null when one of them does not name a file and a version. */
function answerFiles(value: unknown): SessionAnswerFile[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: SessionAnswerFile[] = [];
  for (const f of value.slice(0, MAX_SESSION_CHANGE_PATHS) as Record<string, unknown>[]) {
    if (typeof f?.path !== "string" || !f.path || typeof f.version !== "string") return null;
    if (f.keys === undefined) {
      out.push({ path: f.path, version: f.version });
      continue;
    }
    if (!Array.isArray(f.keys)) return null;
    const keys = f.keys.filter((k): k is string => typeof k === "string" && k !== "").slice(0, MAX_BLOCK_KEYS);
    if (keys.length === 0) return null;
    out.push({ path: f.path, version: f.version, keys });
  }
  return out;
}

function failure(c: { json: (body: unknown, status: number) => Response }, e: unknown): Response {
  const status = (e as { status?: number }).status;
  return c.json(err((e as Error).message), status === 403 ? 403 : 500);
}

/**
 * POST /chat/sessions/:id/file-changes/answer
 *   { answer: "keep" | "open" | "revert", files: [{ path, version, keys?: string[] }] }
 *
 * Keep change blocks, open them again, or put them back on disk the way they were — every block
 * of a file when its `keys` are absent. A file no longer at `version`, or no longer holding a
 * block it names, is left alone and answered `stale`. A file whose last open block is answered is
 * marked reviewed. The answer's `undoId` undoes the whole of it.
 */
chatFileChangesRoutes.post("/sessions/:id/file-changes/answer", async (c) => {
  const sessionId = sessionOf(c);
  if (typeof sessionId !== "string") return sessionId;
  const body = await c.req.json<{ answer?: unknown; files?: unknown }>().catch(() => ({}) as { answer?: unknown; files?: unknown });
  const files = answerFiles(body.files);
  if (!ANSWERS.has(body.answer as SessionAnswer) || !files) {
    return c.json(err("answer must be keep, open or revert, and files must name each file's path and version"), 400);
  }
  try {
    return c.json(ok(await answerSessionChanges({ sessionId, projectPath: c.get("projectPath"), answer: body.answer as SessionAnswer, files })));
  } catch (e) {
    return failure(c, e);
  }
});

/** POST /chat/sessions/:id/file-changes/undo { undoId } — undo an answer, every file of it or none. */
chatFileChangesRoutes.post("/sessions/:id/file-changes/undo", async (c) => {
  const sessionId = sessionOf(c);
  if (typeof sessionId !== "string") return sessionId;
  const body = await c.req.json<{ undoId?: unknown }>().catch(() => ({}) as { undoId?: unknown });
  if (typeof body.undoId !== "string" || !body.undoId) return c.json(err("undoId is required"), 400);
  try {
    return c.json(ok(await undoSessionAnswer({ sessionId, projectPath: c.get("projectPath"), undoId: body.undoId })));
  } catch (e) {
    return failure(c, e);
  }
});

/** The files a turn revert was shown at, or null when one of them does not name a path and a version. */
function shownFiles(value: unknown): { path: string; version: string }[] | null {
  if (!Array.isArray(value)) return null;
  const out: { path: string; version: string }[] = [];
  for (const f of value.slice(0, MAX_SESSION_CHANGE_PATHS) as Record<string, unknown>[]) {
    if (typeof f?.path !== "string" || !f.path || typeof f.version !== "string") return null;
    out.push({ path: f.path, version: f.version });
  }
  return out;
}

/**
 * POST /chat/sessions/:id/file-changes/revert-turn { calls: string[], apply?: { path, version }[] }
 *
 * Revert a turn, named by its calls (the tool use ids in it). Without `apply`, what it would do to
 * each file it touched; with it, do that — unless a file is no longer at the version the preview
 * showed it at, when nothing is written and the answer is `stale`. The `undoId` undoes it.
 */
chatFileChangesRoutes.post("/sessions/:id/file-changes/revert-turn", async (c) => {
  const sessionId = sessionOf(c);
  if (typeof sessionId !== "string") return sessionId;
  const body = await c.req.json<{ calls?: unknown; apply?: unknown }>().catch(() => ({}) as { calls?: unknown; apply?: unknown });
  const calls = Array.isArray(body.calls)
    ? body.calls.filter((call): call is string => typeof call === "string" && call !== "").slice(0, MAX_TURN_CALLS)
    : [];
  const apply = body.apply === undefined ? undefined : shownFiles(body.apply);
  if (calls.length === 0 || apply === null) {
    return c.json(err("calls must name the turn's calls, and apply each file's path and version"), 400);
  }
  try {
    return c.json(ok(await revertTurn({ sessionId, calls, ...(apply ? { apply } : {}) })));
  } catch (e) {
    return failure(c, e);
  }
});

/** GET /chat/sessions/:id/file-changes/diff?path= — both sides of one file the session changed. */
chatFileChangesRoutes.get("/sessions/:id/file-changes/diff", async (c) => {
  const sessionId = sessionOf(c);
  if (typeof sessionId !== "string") return sessionId;
  const path = c.req.query("path");
  if (!path) return c.json(err("path is required"), 400);
  try {
    const diff = await sessionFileDiff({ sessionId, projectPath: c.get("projectPath"), path });
    if (!diff) return c.json(err("This session has no change to that file"), 404);
    return c.json(ok(diff));
  } catch (e) {
    const status = (e as { status?: number }).status;
    return c.json(err((e as Error).message), status === 403 ? 403 : 500);
  }
});
