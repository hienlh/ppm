import type { Json } from "../mcp-http-endpoint.ts";
import { projectService } from "../project.service.ts";
import { listProjectSessions, searchProjectChats } from "../chat-session-queries.service.ts";
import { readChatPage } from "./assistant-chat-page.ts";
import { isAssistantSession } from "../assistant/assistant-session.ts";
import { isAssistantProject } from "../../shared/assistant-project.ts";
import { resolveAssistantProject, resolveAssistantSessionTarget } from "./assistant-project-scope.ts";
import { MAX_MESSAGES_READ, MAX_SEARCH_RESULTS, MAX_SESSIONS_LISTED } from "./assistant-mcp-tools.ts";
import { clip, errorResult, intArg, jsonResult } from "./assistant-tool-output.ts";

/**
 * The Assistant's tools that read PPM's projects and chats. Each goes through the same service
 * the matching route uses, so the Assistant reads what the user's own screens show. Text from
 * chats is returned as data; the Assistant's instructions say it never directs the Assistant.
 */

const MAX_TITLE_CHARS = 200;
const MAX_SNIPPET_CHARS = 400;

type Args = Record<string, unknown>;

export function projectsList(): Json {
  const projects = projectService.list()
    .filter((p) => !isAssistantProject(p.name))
    .map((p) => ({ name: p.name, path: p.path }));
  return jsonResult({ projects }, { key: "projects", list: projects });
}

export async function chatListSessions(args: Args): Promise<Json> {
  const project = resolveAssistantProject(args.project);
  if (!project.ok) return errorResult(project.error);
  const limit = intArg(args.limit, 30, 1, MAX_SESSIONS_LISTED);
  const offset = intArg(args.offset, 0, 0, 1_000_000);
  if (limit === null || offset === null) return errorResult(`\`limit\` must be 1–${MAX_SESSIONS_LISTED} and \`offset\` a whole number from 0.`);
  if (args.query !== undefined && typeof args.query !== "string") return errorResult("`query` must be text.");
  const { sessions, hasMore } = await listProjectSessions(project.value.path, {
    query: (args.query as string | undefined)?.toLowerCase().trim() ?? "", limit, offset,
  });
  const list = sessions
    .filter((s) => !isAssistantSession(s.id))
    .map((s) => ({
      sessionId: s.id,
      providerId: s.providerId,
      title: clip(s.title || "(untitled)", MAX_TITLE_CHARS),
      lastActive: s.updatedAt || s.createdAt || null,
      ...(s.pinned ? { pinned: true } : {}),
      ...(s.tag ? { tag: s.tag.name } : {}),
      ...(s.designSlug ? { design: s.designSlug } : {}),
    }));
  return jsonResult({
    project: project.value.name, sessions: list, ...(hasMore ? { nextOffset: offset + limit } : {}),
  }, { key: "sessions", list });
}

export async function chatSearch(args: Args): Promise<Json> {
  const project = resolveAssistantProject(args.project);
  if (!project.ok) return errorResult(project.error);
  if (typeof args.query !== "string" || !args.query.trim()) return errorResult("`query` is required: the words to look for.");
  const limit = intArg(args.limit, 20, 1, MAX_SEARCH_RESULTS);
  if (limit === null) return errorResult(`\`limit\` must be 1–${MAX_SEARCH_RESULTS}.`);
  const { results, indexing } = await searchProjectChats(project.value.path, args.query.trim().slice(0, 500), limit);
  const hits = results
    .filter((r) => !isAssistantSession(r.sessionId))
    .map((r) => ({
      sessionId: r.sessionId,
      providerId: r.providerId ?? null,
      title: clip(r.title || "(untitled)", MAX_TITLE_CHARS),
      matchedIn: r.matchedIn,
      snippet: clip(r.snippet.replace(/<\/?mark>/g, ""), MAX_SNIPPET_CHARS),
      at: r.ts || null,
    }));
  return jsonResult({
    project: project.value.name,
    results: hits,
    ...(indexing.running ? { note: `Message search is still indexing (${indexing.indexed} of ${indexing.total} chats); results may be incomplete.` } : {}),
  }, { key: "results", list: hits });
}

export async function chatReadMessages(args: Args): Promise<Json> {
  const project = resolveAssistantProject(args.project);
  if (!project.ok) return errorResult(project.error);
  const target = resolveAssistantSessionTarget(project.value, args.sessionId, args.providerId);
  if (!target.ok) return errorResult(target.error);
  const limit = intArg(args.limit, 30, 1, MAX_MESSAGES_READ);
  const before = args.before === undefined || args.before === null ? undefined : intArg(args.before, 0, 0, Number.MAX_SAFE_INTEGER);
  if (limit === null || before === null) return errorResult(`\`limit\` must be 1–${MAX_MESSAGES_READ} and \`before\` a whole number from 0.`);
  const { start, total, messages } = await readChatPage(target.value, { limit, ...(before !== undefined ? { before } : {}) });
  return jsonResult({
    project: project.value.name,
    sessionId: target.value.sessionId,
    providerId: target.value.providerId,
    start,
    total,
    ...(start > 0 ? { olderMessages: `${start} older; call again with before: ${start}` } : {}),
    messages,
  });
}
