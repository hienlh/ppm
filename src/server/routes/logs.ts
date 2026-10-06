/**
 * The Logs window: the log records with their filters, the issues AI sorted them into, and the
 * pieces of a bug report (an AI draft, the environment, GitHub's labels and a duplicate search).
 *
 * Mounted under `/api` after `authMiddleware`. `GET /api/logs/recent`, the old bug report's
 * tail, is a separate route in `src/server/index.ts`, signed in too.
 * Reads are GETs on purpose: the access log keeps those at DEBUG, and the window queries on
 * every filter change.
 */
import { Hono } from "hono";
import { err, ok } from "../../types/api.ts";
import { DEFAULT_LOG_FILTER, LOG_RANGES, LOG_SOURCE_IDS, type LogRange, type LogSourceId } from "../../shared/logs-model.ts";
import type { LogQueryParams, ReportDraftRequest } from "../../shared/logs-api.ts";
import { queryLogs, readAround } from "../../services/logs/log-store.ts";
import { analyze, getIssues, getIssuesSummary, setAuto, setDismissed, undismissAll } from "../../services/logs/log-issues.ts";
import { draftReport } from "../../services/logs/log-report-draft.ts";
import { logEnvironment } from "../../services/logs/log-environment.ts";
import { repoLabels, searchDuplicates } from "../../services/logs/github-issues.ts";

export const logsRoutes = new Hono();

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const MAX_DRAFT_LINES = 2000;
const MAX_DRAFT_CHARS = 400_000;

function sourceParam(v: string | undefined): LogSourceId | "all" {
  return (LOG_SOURCE_IDS as readonly string[]).includes(v ?? "") ? (v as LogSourceId) : "all";
}

/** `?src=ai&lv=error,warn&off=ai:sdk&q=…&re=1&cs=1&chat=<id>&range=1h&from=<ms>&before=<id>&reach=<id>&limit=500` */
export function parseLogQuery(q: Record<string, string | undefined>): LogQueryParams {
  const lv = q.lv === undefined ? null : new Set(q.lv.split(",").filter(Boolean));
  const range = (LOG_RANGES as readonly string[]).includes(q.range ?? "") ? (q.range as LogRange) : "1h";
  return {
    src: sourceParam(q.src),
    levels: lv
      ? { error: lv.has("error"), warn: lv.has("warn"), info: lv.has("info"), debug: lv.has("debug") }
      : DEFAULT_LOG_FILTER.levels,
    tagsOff: (q.off ?? "").split(",").filter((t) => t.includes(":")).slice(0, 200),
    q: (q.q ?? "").slice(0, 500),
    regex: q.re === "1",
    caseSensitive: q.cs === "1",
    chat: q.chat || null,
    range,
    from: Number(q.from) || 0,
    ...(q.before ? { before: q.before } : {}),
    ...(q.reach ? { reach: q.reach } : {}),
    limit: Number(q.limit) || 500,
  };
}

logsRoutes.get("/", async (c) => {
  try {
    return c.json(ok(await queryLogs(parseLogQuery(c.req.query()), c.req.raw.signal)));
  } catch (e) {
    // An aborted request (the window asked for something newer) has nobody left to answer.
    return c.json(err(message(e)), c.req.raw.signal.aborted ? 400 : 500);
  }
});

/** `?ids=<id>,<id>&n=5&src=ai` — records around a selection, for a report's context lines. */
logsRoutes.get("/around", async (c) => {
  const ids = (c.req.query("ids") ?? "").split(",").filter(Boolean).slice(0, 2000);
  const n = Math.max(0, Math.min(50, Number(c.req.query("n")) || 0));
  try {
    return c.json(ok(await readAround(ids, n, sourceParam(c.req.query("src")))));
  } catch (e) {
    return c.json(err(message(e)), 500);
  }
});

logsRoutes.get("/issues", async (c) => {
  try {
    return c.json(ok(await getIssues()));
  } catch (e) {
    return c.json(err(message(e)), 500);
  }
});

logsRoutes.get("/issues/summary", async (c) => {
  try {
    return c.json(ok(await getIssuesSummary()));
  } catch (e) {
    return c.json(err(message(e)), 500);
  }
});

/** Starts a run and answers at once; the window hears the result as `logs:issues-changed`. */
logsRoutes.post("/issues/analyze", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { full?: unknown };
  void analyze(body.full === true).catch(() => { /* kept in the issue state's `error` */ });
  return c.json(ok({ started: true }));
});

logsRoutes.post("/issues/auto", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { on?: unknown };
  if (typeof body.on !== "boolean") return c.json(err("on must be true or false"), 400);
  setAuto(body.on);
  return c.json(ok({ auto: body.on }));
});

logsRoutes.post("/issues/undismiss-all", (c) => {
  undismissAll();
  return c.json(ok({}));
});

logsRoutes.post("/issues/:id/dismiss", async (c) => {
  if (!(await setDismissed(c.req.param("id"), true))) return c.json(err("No such issue"), 404);
  return c.json(ok({}));
});

logsRoutes.post("/issues/:id/undismiss", async (c) => {
  if (!(await setDismissed(c.req.param("id"), false))) return c.json(err("No such issue"), 404);
  return c.json(ok({}));
});

export function parseDraftRequest(raw: unknown): ReportDraftRequest | string {
  const b = raw as Partial<Record<keyof ReportDraftRequest, unknown>> | null;
  if (!b || !Array.isArray(b.snippets) || !Array.isArray(b.environment)) return "snippets and environment are required";
  let lines = 0;
  let chars = 0;
  const snippets: ReportDraftRequest["snippets"] = [];
  for (const s of b.snippets as Array<Record<string, unknown>>) {
    if (!s || typeof s.label !== "string" || !Array.isArray(s.lines) || !s.lines.every((l) => typeof l === "string")) {
      return "each snippet needs a label and lines";
    }
    lines += s.lines.length;
    chars += (s.lines as string[]).reduce((a, l) => a + l.length, 0);
    snippets.push({ label: s.label, lines: s.lines as string[] });
  }
  if (lines > MAX_DRAFT_LINES || chars > MAX_DRAFT_CHARS) return "too many lines for one report";
  const environment = (b.environment as unknown[])
    .filter((r): r is [string, string] => Array.isArray(r) && r.length === 2 && typeof r[0] === "string" && typeof r[1] === "string")
    .slice(0, 20);
  return { snippets, environment, ...(typeof b.note === "string" ? { note: b.note } : {}) };
}

logsRoutes.post("/report/draft", async (c) => {
  const parsed = parseDraftRequest(await c.req.json().catch(() => null));
  if (typeof parsed === "string") return c.json(err(parsed), 400);
  try {
    return c.json(ok(await draftReport(parsed)));
  } catch (e) {
    return c.json(err(message(e)), 502);
  }
});

logsRoutes.get("/environment", async (c) => c.json(ok(await logEnvironment())));

logsRoutes.get("/github/labels", async (c) => c.json(ok(await repoLabels())));

logsRoutes.get("/github/duplicates", async (c) => {
  try {
    return c.json(ok(await searchDuplicates(c.req.query("q") ?? "")));
  } catch (e) {
    return c.json(err(message(e)), 502);
  }
});
