/**
 * The server's own messages into chats for the task store, sent as origin `ppm_ui` with no browser
 * needed: the user's choice on a decision task, word for word, to the chat doing the task; and
 * "wake the manager", one turn telling the project's manager chat what changed (and, from the
 * handed-off work checker, which children need it). Task text goes through `neutralizePpmTags`:
 * only the server writes `ppm-…-v1` blocks. A `ppm_ui` message never answers a card on screen —
 * behind a running turn it waits for that turn to end.
 */
import { basename } from "node:path";
import { CHAT_BUSY, chatControl, type ChatControl, type MessageServerOrigin } from "../chat-control/chat-control.ts";
import { getDb, getSessionProvider } from "../db.service.ts";
import { projectNameForPath } from "../project-name-for-path.ts";
import { neutralizePpmTags } from "../assistant-watch/watch-event-text.ts";
import type { Actor, HistoryEntry, LinkState, Task } from "../../shared/ppm-tasks.ts";
import type { SessionDelivery } from "../../shared/session-collab.ts";
import { formatTaskRef } from "../../shared/ppm-tasks-refs.ts";
import { listLinkStateChangesSince, loadTask, rowToHistory, type HistoryRow } from "./ppm-tasks-db.ts";
import { managerSessionFor } from "./ppm-tasks-write.ts";
import { workingSessionRefusal } from "./ppm-tasks-session-check.ts";
import { getTaskProject } from "./ppm-tasks-projects.service.ts";
import { reserveManagerWake, type WakeReservation } from "./ppm-tasks-wake-budget.ts";

export interface PpmTasksDeliverEnv {
  chat(): ChatControl | null;
  reserveWake(managerSessionId: string, projectKey: string, byUser: boolean): WakeReservation;
  now(): number;
}

const liveEnv: PpmTasksDeliverEnv = { chat: chatControl, reserveWake: reserveManagerWake, now: () => Date.now() };
let env: PpmTasksDeliverEnv = liveEnv;

/** Tests swap the chat door, budget and clock; null puts the live ones back. */
export function setPpmTasksDeliverEnv(next: Partial<PpmTasksDeliverEnv> | null): void {
  env = next ? { ...liveEnv, ...next } : liveEnv;
}

export type DeliverOutcome =
  | { ok: true; sessionId: string; delivered: SessionDelivery }
  | { ok: false; reason: "not_found" | "no_option" | "no_session" | "no_chat" | "budget" | "busy" | "nothing" | "error"; error?: string };

function projectNameOf(projectKey: string): string {
  const path = getTaskProject(projectKey)?.projectPath ?? projectKey;
  return projectNameForPath(path) ?? basename(path);
}

const providerOf = (sessionId: string): string => getSessionProvider(sessionId) ?? "claude";

async function send(sessionId: string, projectName: string, providerId: string, text: string, origin: MessageServerOrigin = "ppm_ui"): Promise<DeliverOutcome> {
  const chat = env.chat();
  if (!chat) return { ok: false, reason: "no_chat", error: "No chat layer runs in this process" };
  try {
    const result = await chat.sendUserMessage(sessionId, text, { origin, projectName, providerId });
    if (!result.ok) return { ok: false, reason: result.error === CHAT_BUSY ? "busy" : "error", error: result.error };
    return { ok: true, sessionId: result.sessionId, delivered: result.delivered ?? "started" };
  } catch (e) {
    return { ok: false, reason: "error", error: (e as Error).message };
  }
}

/** One line of task text: PPM tags defused and line breaks folded, so it cannot forge lines of its own. */
export const oneLine = (text: string): string => neutralizePpmTags(text.replace(/\s+/g, " ").trim());

/** Most news lines one wake carries; the rest is counted. */
const MAX_WAKE_LINES = 60;

/** The text a decision choice is sent as. */
export function decisionText(task: Task, ref: string, optionId: string): string | null {
  const index = task.decision?.options.findIndex((o) => o.id === optionId) ?? -1;
  if (!task.decision || index < 0) return null;
  const option = task.decision.options[index]!;
  return `Decision on ${ref} "${oneLine(task.title)}": ${String.fromCharCode(65 + index)} — ${oneLine(option.label)}`;
}

/** Sends the chosen option to the working chat, else the project's manager chat. */
export async function deliverDecision(taskId: string, optionId: string): Promise<DeliverOutcome> {
  const task = loadTask(taskId);
  if (!task || task.deletedAt !== null) return { ok: false, reason: "not_found" };
  const projectName = projectNameOf(task.projectKey);
  const text = decisionText(task, formatTaskRef(task.number, projectName), optionId);
  if (!text) return { ok: false, reason: "no_option" };
  const target = task.workingSessionId ?? managerSessionFor(task.projectKey);
  if (!target) return { ok: false, reason: "no_session" };
  // Asked again at delivery: the chat may have moved or become an Assistant session since.
  if (task.workingSessionId && workingSessionRefusal(task.projectKey, task.workingSessionId)) return { ok: false, reason: "no_session" };
  return send(target, projectName, providerOf(target), text);
}

export interface ManagerNews {
  history: HistoryEntry[];
  linkStates: LinkState[];
  /** Where the manager's news cursor moves once this news is delivered. */
  cursor: { historyId: number; at: number };
}

/**
 * What changed in the project since its manager was last told: history rows by anyone but a
 * manager (its own changes are not news to it) and link states that changed. Formatting is the
 * news entry's job; this only collects.
 */
export function pendingManagerNews(projectKey: string, now: number = env.now()): ManagerNews {
  const db = getDb();
  const cursor = db.query("SELECT manager_news_history_id AS id, manager_news_at AS at FROM task_projects WHERE project_key = ?").get(projectKey) as { id: number; at: number } | null;
  if (!cursor) return { history: [], linkStates: [], cursor: { historyId: 0, at: now } };
  const rows = db.query("SELECT * FROM task_history WHERE project_key = ? AND id > ? ORDER BY id").all(projectKey, cursor.id) as HistoryRow[];
  const maxId = rows.length ? rows[rows.length - 1]!.id : cursor.id;
  return {
    history: rows.map(rowToHistory).filter((h) => h.actor.kind !== "manager"),
    linkStates: listLinkStateChangesSince(projectKey, cursor.at),
    cursor: { historyId: maxId, at: now },
  };
}

/** Marks news up to `cursor` as told. Never moves the cursor backwards. */
export function advanceManagerNews(projectKey: string, cursor: { historyId: number; at: number }): void {
  getDb().query(
    "UPDATE task_projects SET manager_news_history_id = MAX(manager_news_history_id, ?), manager_news_at = MAX(manager_news_at, ?) WHERE project_key = ?",
  ).run(cursor.historyId, cursor.at, projectKey);
}

export type ManagerNewsFormatter = (news: ManagerNews, projectKey: string) => string[];

/** One plain line per change; the AI tools phase registers the real wording. */
const defaultFormatter: ManagerNewsFormatter = (news) => [
  ...news.history.map((h) => {
    const task = h.taskId ? loadTask(h.taskId) : null;
    const what = task ? `${formatTaskRef(task.number)} "${task.title}"` : "project settings";
    return `- ${what}: ${h.kind} by ${h.actor.label}`;
  }),
  ...news.linkStates.map((l) => `- ${l.kind} ${l.ref} changed`),
];
let formatter: ManagerNewsFormatter = defaultFormatter;

export function setManagerNewsFormatter(next: ManagerNewsFormatter | null): void {
  formatter = next ?? defaultFormatter;
}

export interface WakeOptions {
  /**
   * Nobody asked for this wake and nobody is there: the handed-off work checker found trouble on
   * its own. The turn is then sent as a `watch` turn — unattended, so nothing in it can show the
   * user an approval card — and, like any watch message, only into a quiet chat: a manager that is
   * mid-turn or showing a card answers `busy` and is asked again later.
   */
  unattended?: boolean;
}

/** Projects with a wake on its way: a second one would read and send the same news again. */
const waking = new Set<string>();

/**
 * Wakes the project's manager chat with one turn carrying its pending news plus `extraLines` (the
 * checker's findings): a `ppm_ui` turn by default (the user pressed "Tell manager now"), a `watch`
 * turn with `unattended`. Charged to the wake budget; refused, nothing is sent and the news stays
 * for the manager's next turn. The cursor moves only once the chat took the turn.
 */
export async function wakeManager(projectKey: string, actor: Actor, extraLines: string[] = [], opts: WakeOptions = {}): Promise<DeliverOutcome> {
  if (waking.has(projectKey)) return { ok: false, reason: "error", error: "A wake of this manager is already on its way" };
  waking.add(projectKey);
  try {
    return await wakeOnce(projectKey, actor, extraLines, opts);
  } finally {
    waking.delete(projectKey);
  }
}

async function wakeOnce(projectKey: string, actor: Actor, extraLines: string[], opts: WakeOptions): Promise<DeliverOutcome> {
  const manager = managerSessionFor(projectKey);
  if (!manager) return { ok: false, reason: "no_session" };
  const news = pendingManagerNews(projectKey);
  // The caller's lines (the checker's findings) first: when the cap cuts, it cuts the news, which
  // stays for the manager's next turn anyway, not the findings the wake is for.
  let lines = [...extraLines, ...formatter(news, projectKey)].map(oneLine).filter(Boolean);
  if (lines.length === 0) return { ok: false, reason: "nothing" };
  if (lines.length > MAX_WAKE_LINES) lines = [...lines.slice(0, MAX_WAKE_LINES), `- …and ${lines.length - MAX_WAKE_LINES} more`];
  const reserved = env.reserveWake(manager, projectKey, actor.kind === "user" && !opts.unattended);
  if (!reserved.ok) return { ok: false, reason: "budget", error: reserved.message };
  const projectName = projectNameOf(projectKey);
  const where = neutralizePpmTags(projectName);
  const header = actor.kind === "ppm"
    ? `PPM Tasks — handed-off work in ${where} needs you:`
    : `PPM Tasks — ${neutralizePpmTags(actor.label)} asked PPM to tell you now about changes in ${where}:`;
  // A watch message is not defused by the chat door the way a ppm_ui one is: every line already went
  // through `oneLine`, and the header's only outside text (the project's name) through neutralizePpmTags.
  const outcome = await send(manager, projectName, providerOf(manager), [header, ...lines].join("\n"), opts.unattended ? "watch" : "ppm_ui");
  if (!outcome.ok) {
    reserved.release();
    return outcome;
  }
  advanceManagerNews(projectKey, news.cursor);
  return outcome;
}
