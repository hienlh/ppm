/**
 * What the clean-up is told about the conversation a voice message lands in, so it can tell a
 * misheard "hồ nô" from the project's "Hono": the chat's last messages, the text already typed,
 * the project's CLAUDE.md headings and terms, Claude's memory for the project, its file names and
 * the word lists. Every source is optional and bounded — a missing file, an unreadable session or
 * a cold file index leaves its part empty and never fails the message or holds it up.
 */
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ASSISTANT_PROJECT_NAME } from "../../shared/assistant-project.ts";
import { listNoteRows } from "../assistant-notes/assistant-notes-db.ts";
import { configService } from "../config.service.ts";
import { createLogger } from "../logger.ts";
import { claudeProjectMemoryDir } from "../provider-shared-context.ts";
import type { SessionRef } from "../session-turns/session-turn-index.service.ts";
import { CONTEXT_LIMITS, contextLineOf, cutBlock, flat, instructionsDigest, fileNamesFromIndexJson, joinWithin } from "./voice-context-sources.ts";

const log = createLogger("voice-context");

/** How long the chat's last messages may take to read before the clean-up goes without them. */
const SESSION_READ_MS = 3_000;
/** How long a file index may take; a cold one on a large project is skipped, not waited for. */
const FILE_INDEX_MS = 1_000;
/** Bytes of a CLAUDE.md or MEMORY.md read; the digest needs no more than the top of either. */
const MAX_DOC_BYTES = 512 * 1024;

export interface VoiceContext {
  recentMessages: string[];
  typed: string;
  /** CLAUDE.md headings and terms. */
  instructions: string;
  memory: string;
  fileNames: string[];
  words: string[];
  /** The PPM Assistant only: the registered projects' names and its notebook. */
  projectNames?: string[];
  notebook?: string;
}

export interface VoiceContextInput {
  project: string;
  /** The project's folder; for the Assistant, its work directory (sessions only). */
  projectPath: string;
  sessionId?: string;
  providerId?: string;
  typed?: string;
  words: string[];
}

/** The reads, swappable so tests need no transcripts, index worker or home directory. */
export interface VoiceContextDeps {
  recentMessages: (ref: SessionRef) => Promise<string[]>;
  fileIndexJson: (projectPath: string) => Promise<Uint8Array | null>;
  claudeHome: () => string;
  notebookTexts: () => string[];
}

async function readHead(path: string, maxBytes = MAX_DOC_BYTES): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return "";
  } finally {
    await handle?.close().catch(() => {});
  }
}

function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((done) => { timer = setTimeout(() => done(fallback), ms); });
  return Promise.race([work.catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

/**
 * The last text messages of a session. The session is resolved by the turn index, which proves it
 * belongs to `ref.projectPath` before opening anything, so a session id from a request can never
 * name another project's transcript.
 */
async function readRecentMessages(ref: SessionRef): Promise<string[]> {
  const { listSessionTurns } = await import("../session-turns/session-turn-index.service.ts");
  const { readSessionTurnMessages } = await import("../session-turns/session-turn-reader.ts");
  const { turns } = await listSessionTurns(ref);
  const ids = turns.slice(-6).map((t) => t.turnId);
  if (ids.length === 0) return [];
  const read = await readSessionTurnMessages(ref, ids);
  const lines = read.flatMap((t) => t.messages).map(contextLineOf).filter((l): l is string => l !== null);
  return lines.slice(-CONTEXT_LIMITS.messages);
}

async function readFileIndexJson(projectPath: string): Promise<Uint8Array | null> {
  const { buildIndex } = await import("../file-list-index.service.ts");
  return (await buildIndex(projectPath, 0)).json;
}

const defaultDeps: VoiceContextDeps = {
  recentMessages: readRecentMessages,
  fileIndexJson: readFileIndexJson,
  claudeHome: () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  notebookTexts: () => listNoteRows().map((n) => n.text),
};

async function sessionMessages(input: VoiceContextInput, deps: VoiceContextDeps): Promise<string[]> {
  const { sessionId, providerId } = input;
  if (!sessionId || (providerId !== "claude" && providerId !== "codex")) return [];
  const ref: SessionRef = { providerId, sessionId, projectPath: input.projectPath };
  return within(deps.recentMessages(ref).catch((e) => {
    log.debug(`no chat context for session=${sessionId}: ${(e as Error).message}`);
    return [];
  }), SESSION_READ_MS, []);
}

async function fileNames(projectPath: string, deps: VoiceContextDeps): Promise<string[]> {
  const json = await within(deps.fileIndexJson(projectPath), FILE_INDEX_MS, null);
  return json ? fileNamesFromIndexJson(json) : [];
}

async function projectDocs(projectPath: string, deps: VoiceContextDeps): Promise<{ instructions: string; memory: string }> {
  const canonical = (await realpath(projectPath).catch(() => resolve(projectPath))).normalize("NFC");
  const [claudeMd, memoryMd] = await Promise.all([
    readHead(join(projectPath, "CLAUDE.md")),
    readHead(join(claudeProjectMemoryDir(deps.claudeHome(), canonical), "MEMORY.md")),
  ]);
  return { instructions: instructionsDigest(claudeMd), memory: cutBlock(memoryMd, CONTEXT_LIMITS.memoryChars) };
}

function assistantExtras(deps: VoiceContextDeps): { projectNames: string[]; notebook: string } {
  const projectNames = configService.get("projects").map((p) => p.name).slice(0, CONTEXT_LIMITS.projectNames);
  let notebook = "";
  try {
    notebook = joinWithin(deps.notebookTexts().map((t) => flat(t, 300)), "\n", CONTEXT_LIMITS.notebookChars);
  } catch (e) {
    log.debug(`no notebook for voice context: ${(e as Error).message}`);
  }
  return { projectNames, notebook };
}

export async function gatherVoiceContext(input: VoiceContextInput, deps: VoiceContextDeps = defaultDeps): Promise<VoiceContext> {
  const typed = cutBlock(input.typed ?? "", CONTEXT_LIMITS.typedChars);
  const isAssistant = input.project === ASSISTANT_PROJECT_NAME;
  if (isAssistant) {
    const recentMessages = await sessionMessages(input, deps);
    return { recentMessages, typed, instructions: "", memory: "", fileNames: [], words: input.words, ...assistantExtras(deps) };
  }
  const [recentMessages, docs, names] = await Promise.all([
    sessionMessages(input, deps),
    projectDocs(input.projectPath, deps),
    fileNames(input.projectPath, deps),
  ]);
  return { recentMessages, typed, ...docs, fileNames: names, words: input.words };
}
