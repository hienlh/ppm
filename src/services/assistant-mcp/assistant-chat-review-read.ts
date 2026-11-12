import { resolve } from "node:path";
import type { SessionFileChange } from "../../shared/session-file-changes.ts";
import type { SessionTurnCalls } from "../session-file-baselines/session-turn-calls.ts";
import type { ReviewChatOnCard, ReviewFileOnCard } from "./assistant-approval-summary-review.ts";
import type { ChatTarget } from "./assistant-chat-tool-target.ts";
import { projectRoute, type RouteQuery } from "./assistant-route-rules.ts";
import type { ToolContext } from "./assistant-tool-family.ts";
import { clip } from "./assistant-tool-output.ts";

/**
 * How the review tools read a chat's changes: through the routes the Review tab calls, so the
 * list, its versions and its blocks are the ones the user would see. The list is asked for with
 * the paths the chat's own tool calls name (the turns route reads them off the transcript), as the
 * browser does — without them a session older than PPM's copies would list nothing.
 */

export interface ReviewState {
  turns: SessionTurnCalls;
  files: SessionFileChange[];
}

/** `…/chat/sessions/<id>/file-changes<rest>` of the chat's project. */
export const reviewRoute = (chat: ChatTarget, rest = "", query: RouteQuery = {}) =>
  projectRoute(chat.project.name, `chat/sessions/${encodeURIComponent(chat.sessionId)}/file-changes${rest}`, query);

export const cardChat = (chat: ChatTarget): ReviewChatOnCard => ({ project: chat.project.name, sessionId: chat.sessionId, title: chat.facts.title });

const failed = (what: string, r: { status: number; error?: string }) => `Could not read the chat's ${what}: ${r.error ?? `PPM answered ${r.status}`}`;

export async function readTurns(ctx: ToolContext, chat: ChatTarget): Promise<SessionTurnCalls | string> {
  const r = await ctx.callRoute<SessionTurnCalls>("GET", reviewRoute(chat, "/turns", { providerId: chat.providerId }));
  return r.ok && Array.isArray(r.data?.turns) ? r.data! : failed("turns", r);
}

/** The turns and the change list, as the Review tab would show them now. */
export async function readReview(ctx: ToolContext, chat: ChatTarget): Promise<ReviewState | string> {
  const turns = await readTurns(ctx, chat);
  if (typeof turns === "string") return turns;
  const r = await ctx.callRoute<{ files?: SessionFileChange[] }>("POST", reviewRoute(chat), { paths: turns.paths });
  return r.ok && Array.isArray(r.data?.files) ? { turns, files: r.data!.files } : failed("file changes", r);
}

const samePath = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * The listed file `path` names — as listed, or relative to the project. Only a listed file can be
 * named: a path the list does not hold is never sent on.
 */
export function pickFile(files: SessionFileChange[], projectPath: string, path: unknown): SessionFileChange | string {
  if (typeof path !== "string" || !path.trim()) return "Each file needs a `path` from chat_changes.";
  const wanted = [path, resolve(projectPath, path)];
  const file = files.find((f) => wanted.some((w) => samePath(f.path, w)));
  return file ?? `"${clip(path, 200)}" is not among this chat's changed files; call chat_changes for the list.`;
}

/** One file in an answer: what goes to the route, and how the card shows it. */
export interface PickedFile {
  answer: { path: string; version: string; keys?: string[] };
  card: ReviewFileOnCard;
  file: SessionFileChange;
}

/** The files `raw` names, each at the version just listed, with only blocks the file has. */
export function pickFiles(state: ReviewState, projectPath: string, raw: unknown): PickedFile[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "`files` must name at least one file from chat_changes.";
  const out: PickedFile[] = [];
  for (const item of raw as Array<Record<string, unknown>>) {
    const file = pickFile(state.files, projectPath, item?.path);
    if (typeof file === "string") return file;
    if (out.some((p) => p.file.path === file.path)) continue;
    if (item.blocks === undefined) {
      out.push({ file, answer: { path: file.path, version: file.version }, card: { path: file.path, added: file.additions, removed: file.deletions } });
      continue;
    }
    const keys = Array.isArray(item.blocks) ? [...new Set(item.blocks.filter((k): k is string => typeof k === "string" && k !== ""))] : [];
    const known = new Set((file.blocks ?? []).map((b) => b.key));
    if (keys.length === 0 || keys.some((k) => !known.has(k))) {
      return `"${file.path}" has no such block${known.size ? "; its block keys are in chat_changes with this path" : " list: it can only be answered whole"}.`;
    }
    out.push({ file, answer: { path: file.path, version: file.version, keys }, card: { path: file.path, blocks: { named: keys.length, of: known.size } } });
  }
  return out;
}

/** Every listed file, whole, that `want` picks: what an answer without `files` acts on. */
export function allFiles(state: ReviewState, want: (f: SessionFileChange) => boolean): PickedFile[] {
  return state.files.filter(want).map((file) => ({
    file, answer: { path: file.path, version: file.version }, card: { path: file.path, added: file.additions, removed: file.deletions },
  }));
}
