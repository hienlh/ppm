/**
 * Reads what {@link rankVocabulary} ranks — a project's recent task codes and titles, its chat
 * titles and its CLAUDE.md — and keeps the result for a day. Every read is bounded and optional:
 * a project with no tasks, no chats or no CLAUDE.md simply contributes less, and a failed read
 * leaves its part empty rather than failing a voice message.
 *
 * The PPM Assistant is spoken to about every project, so its list is the union of all of them plus
 * its notebook. Any other project gets its own words only: one project's names and terms never
 * reach another project's prompt.
 */
import { open } from "node:fs/promises";
import { join } from "node:path";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import { configService } from "../config.service.ts";
import { getDb } from "../db.service.ts";
import { createLogger } from "../logger.ts";
import { projectKey } from "../project-name-for-path.ts";
import { instructionTermsOf, rankVocabulary, type RankedTerm, type VocabularySources } from "./voice-auto-vocabulary.ts";

const log = createLogger("voice-vocabulary");

/** How far back tasks and chats count: what was talked about lately is what will be said next. */
const RECENT_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_TASKS = 60;
const MAX_TASK_CODES = 15;
const MAX_CHATS = 80;
const MAX_DOC_BYTES = 256 * 1024;
/** A list is rebuilt at most this often; tasks and chats change by the day, not by the minute. */
export const AUTO_VOCABULARY_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a voice message waits for a cold list before it goes on without one. */
const BUILD_WAIT_MS = 800;

interface ProjectRef { name: string; path: string }

async function readHead(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buf = Buffer.alloc(MAX_DOC_BYTES);
    const { bytesRead } = await handle.read(buf, 0, MAX_DOC_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

function safe<T>(what: string, read: () => T, fallback: T): T {
  try {
    return read();
  } catch (e) {
    log.debug(`no ${what} for the voice vocabulary: ${(e as Error).message}`);
    return fallback;
  }
}

/** Recently touched tasks of these projects: their codes (`<project>/<n>`) and titles, newest first. */
function recentTasks(projects: readonly ProjectRef[], now: number): { codes: string[]; titles: string[] } {
  if (projects.length === 0) return { codes: [], titles: [] };
  const nameByKey = new Map(projects.map((p) => [projectKey(p.path), p.name]));
  const keys = [...nameByKey.keys()];
  const rows = safe("tasks", () => getDb().query(
    `SELECT project_key, number, title FROM tasks
     WHERE deleted_at IS NULL AND updated_at >= ? AND project_key IN (${keys.map(() => "?").join(",")})
     ORDER BY updated_at DESC LIMIT ${MAX_TASKS}`,
  ).all(now - RECENT_MS, ...keys) as Array<{ project_key: string; number: number; title: string }>, []);
  const codes: string[] = [];
  for (const row of rows) {
    const name = nameByKey.get(row.project_key);
    if (name && codes.length < MAX_TASK_CODES) codes.push(`${name}/${row.number}`);
  }
  return { codes, titles: rows.map((r) => r.title) };
}

/** Titles of the projects' chats touched lately, newest first. */
function recentChatTitles(projectNames: readonly string[], now: number): string[] {
  if (projectNames.length === 0) return [];
  const since = new Date(now - RECENT_MS).toISOString().replace("T", " ").slice(0, 19);
  return safe("chat titles", () => (getDb().query(
    `SELECT t.title FROM session_titles t JOIN session_metadata m ON m.session_id = t.session_id
     WHERE t.updated_at >= ? AND m.project_name IN (${projectNames.map(() => "?").join(",")})
     ORDER BY t.updated_at DESC LIMIT ${MAX_CHATS}`,
  ).all(since, ...projectNames) as Array<{ title: string }>).map((r) => r.title), []);
}

function notebookTexts(): string[] {
  return safe("notebook", () => (getDb().query("SELECT text FROM assistant_notes ORDER BY id DESC LIMIT 100").all() as Array<{ text: string }>)
    .map((r) => r.text), []);
}

/** Every source for `project`, read now. */
export async function readVocabularySources(project: string, now = Date.now()): Promise<VocabularySources> {
  const all = configService.get("projects").filter((p) => p.name !== ASSISTANT_PROJECT_NAME);
  const isAssistant = project === ASSISTANT_PROJECT_NAME;
  const projects = isAssistant ? all : all.filter((p) => p.name === project);
  const tasks = recentTasks(projects, now);
  const docs = await Promise.all(projects.map((p) => readHead(join(p.path, "CLAUDE.md"))));
  return {
    projectNames: projects.map((p) => p.name),
    taskCodes: tasks.codes,
    taskTitles: tasks.titles,
    chatTitles: recentChatTitles(projects.map((p) => p.name), now),
    instructionTerms: docs.flatMap(instructionTermsOf),
    ...(isAssistant ? { notes: notebookTexts() } : {}),
  };
}

interface CacheEntry { at: number; words: RankedTerm[]; building?: Promise<RankedTerm[]> }
const cache = new Map<string, CacheEntry>();

/** A rebuild that takes longer than this is given up, so the next message can try again. */
const BUILD_GIVE_UP_MS = 15_000;

async function build(project: string, now: number): Promise<RankedTerm[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const giveUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`reading the sources took over ${BUILD_GIVE_UP_MS / 1000} s`)), BUILD_GIVE_UP_MS);
  });
  const sources = await Promise.race([readVocabularySources(project, now), giveUp]).finally(() => clearTimeout(timer));
  const words = rankVocabulary(sources);
  cache.set(project, { at: now, words });
  return words;
}

/**
 * `project`'s picked-up words: the kept list while it is younger than a day, else a fresh one.
 * A rebuild that takes longer than {@link BUILD_WAIT_MS} is not waited for — the old list (or none)
 * is used and the new one lands for the next message.
 */
export async function autoVocabulary(project: string, now = Date.now()): Promise<RankedTerm[]> {
  const entry = cache.get(project);
  if (entry && now - entry.at < AUTO_VOCABULARY_TTL_MS) return entry.words;
  if (entry?.building) return entry.words;
  const building = build(project, now).catch((e) => {
    log.warn(`could not build the voice vocabulary for "${project}": ${(e as Error).message}`);
    return entry?.words ?? [];
  }).finally(() => {
    const current = cache.get(project);
    if (current?.building) delete current.building;
  });
  cache.set(project, { at: entry?.at ?? 0, words: entry?.words ?? [], building });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<RankedTerm[]>((done) => { timer = setTimeout(() => done(entry?.words ?? []), BUILD_WAIT_MS); });
  return Promise.race([building, late]).finally(() => clearTimeout(timer));
}

/** Drops the kept lists, so the next message reads its sources again (tests, settings changes). */
export function clearAutoVocabularyCache(): void {
  cache.clear();
}
