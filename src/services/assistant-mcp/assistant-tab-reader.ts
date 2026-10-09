import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { projectService } from "../project.service.ts";
import { terminalService } from "../terminal.service.ts";
import { resolveTabTarget, type TabToolsBinding } from "../tab-tools-mcp/tab-target.ts";
import { isAssistantProject } from "../../shared/assistant-project.ts";
import {
  READ_TAB_CHAT_MESSAGES, lineWindow, tailWindow, type TabDescription,
} from "../../shared/assistant-tab-content.ts";
import { resolveAssistantProject, resolveAssistantSessionTarget, type AssistantProject, type AssistantSessionTarget } from "./assistant-project-scope.ts";
import { readChatPage, type ChatPage } from "./assistant-chat-page.ts";

/**
 * Reads what a tab shows, for `ui_read_tab`: the device described the tab (`describe_tab`);
 * the server reads the parts it holds itself — a file, a terminal's output, a chat's messages —
 * under the same rules the Assistant's other reads follow. A file is resolved against the
 * project the TAB belongs to, never the Assistant's own folder; a file or terminal outside
 * every registered project is not read without the user's approval; PPM's private folders are
 * refused outright by `resolveTabTarget`.
 */

export type TabReadOutcome =
  | { kind: "content"; content: Record<string, unknown> }
  | { kind: "needs-approval"; reason: string; details: Record<string, unknown> }
  | { kind: "error"; message: string };

export interface TabReaderDeps {
  listProjects: () => AssistantProject[];
  terminal: { get(id: string): { projectPath: string } | undefined; getBuffer(id: string): string };
  readChat: (target: AssistantSessionTarget, opts: { limit: number; before?: number }) => Promise<ChatPage>;
}

const defaultDeps: TabReaderDeps = {
  listProjects: () => projectService.list().filter((p) => !isAssistantProject(p.name)),
  terminal: terminalService,
  readChat: readChatPage,
};

/** Files larger than this are not read whole to find a window in them. */
export const MAX_READ_FILE_BYTES = 32 * 1024 * 1024;
const TERMINAL_ID_RE = /^[0-9a-f-]{36}$/i;

const content = (c: Record<string, unknown>): TabReadOutcome => ({ kind: "content", content: c });
const error = (message: string): TabReadOutcome => ({ kind: "error", message });
const unreadable = (why: string): TabReadOutcome => content({ readable: false, note: why });
const bindingOf = (p: AssistantProject | null): TabToolsBinding =>
  ({ sessionId: "", projectPath: p?.path ?? null, projectName: p?.name ?? null });

/** The registered project `name` names, or null (not registered any more, or none). */
function projectNamed(name: string | null, deps: TabReaderDeps): AssistantProject | null {
  if (!name) return null;
  const found = resolveAssistantProject(name, deps.listProjects);
  return found.ok ? found.value : null;
}

/** The registered project an absolute path lies in, by its real location. */
async function projectHolding(absolute: string, deps: TabReaderDeps): Promise<AssistantProject | null> {
  const real = await realpath(absolute).catch(() => resolve(absolute));
  for (const p of deps.listProjects()) {
    const root = await realpath(p.path).catch(() => resolve(p.path));
    if (real === root || real.startsWith(root.endsWith(sep) ? root : root + sep)) return p;
  }
  return null;
}

const windowed = (w: ReturnType<typeof lineWindow>, again: string) => ({
  ...w, ...(w.nextOffset !== undefined ? { more: `${again} with offset: ${w.nextOffset}` } : {}),
});

async function readEditor(desc: TabDescription, offset: number, deps: TabReaderDeps): Promise<TabReadOutcome> {
  const ed = desc.editor;
  if (!ed || ed.special) return unreadable("This editor shows a diff, a viewer or inline text, not a file PPM can read for you.");
  if (ed.untitled) {
    return content({ source: "untitled editor text (never saved)", ...windowed(ed.unsaved ?? { text: "", fromLine: 0, toLine: 0, totalLines: 0 }, "Read more") });
  }
  if (!ed.filePath) return error("The device did not say which file this tab shows.");
  const tabProject = projectNamed(desc.project, deps);
  if (!tabProject && !isAbsolute(ed.filePath) && !ed.filePath.startsWith("~")) {
    return error(`This tab names its file relative to the project "${desc.project ?? "(none)"}", which is not registered in PPM any more.`);
  }
  const target = await resolveTabTarget(ed.filePath, bindingOf(tabProject));
  if (!target.ok) return error(target.error);
  const absolute = target.target.projectName && tabProject ? resolve(tabProject.path, target.target.filePath) : target.target.filePath;
  const owner = target.target.projectName ? tabProject : await projectHolding(absolute, deps);
  if (!owner) {
    return {
      kind: "needs-approval",
      reason: "The file is outside every registered project; reading it needs the user's approval.",
      details: { path: target.target.displayPath },
    };
  }
  const head = { project: owner.name, path: target.target.displayPath };
  if (ed.dirty && ed.unsaved) return content({ ...head, source: "the editor's unsaved text (not on disk yet)", ...windowed(ed.unsaved, "Read more") });
  try {
    if ((await stat(absolute)).size > MAX_READ_FILE_BYTES) return error(`${head.path} is larger than ${MAX_READ_FILE_BYTES / 1024 / 1024} MB; PPM does not read it here.`);
    const bytes = await readFile(absolute);
    if (bytes.subarray(0, 8192).includes(0)) return unreadable(`${head.path} is a binary file.`);
    return content({ ...head, source: "the file on disk", ...windowed(lineWindow(bytes.toString("utf8"), offset), "Read more") });
  } catch (e) {
    return error(`${head.path} could not be read: ${(e as Error).message}`);
  }
}

/** Terminal output as text: colours and cursor sequences gone, a carriage return's overwrite applied. */
export function terminalLines(raw: string): string[] {
  const lines = stripVTControlCharacters(raw).replace(/\r\n/g, "\n").split("\n")
    .map((line) => (line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line));
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines;
}

async function readTerminal(desc: TabDescription, offset: number, deps: TabReaderDeps): Promise<TabReadOutcome> {
  const id = desc.terminal?.sessionId;
  if (!id) return unreadable("This terminal has not started a shell on this device yet.");
  if (!TERMINAL_ID_RE.test(id)) return error("The device named a terminal PPM does not recognise.");
  const session = deps.terminal.get(id);
  if (!session) return error("This terminal's shell has ended; there is no output left to read.");
  const owner = await projectHolding(session.projectPath, deps);
  if (!owner) {
    return {
      kind: "needs-approval",
      reason: "This terminal runs outside every registered project; reading it needs the user's approval.",
      details: { folder: session.projectPath },
    };
  }
  const lines = terminalLines(deps.terminal.getBuffer(id));
  return content({
    project: owner.name, source: "terminal output, newest last (colours removed)",
    ...windowed(tailWindow(lines, offset), "Read older lines"),
  });
}

async function readChat(desc: TabDescription, offset: number, deps: TabReaderDeps): Promise<TabReadOutcome> {
  const sessionId = desc.details?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) return content({ messages: [], note: "A new chat: no messages yet." });
  const project = resolveAssistantProject(desc.project, deps.listProjects);
  if (!project.ok) return error(project.error);
  const target = resolveAssistantSessionTarget(project.value, sessionId, desc.details?.providerId);
  if (!target.ok) return error(target.error);
  const page = await deps.readChat(target.value, { limit: READ_TAB_CHAT_MESSAGES, ...(offset > 0 ? { before: offset } : {}) });
  return content({
    project: project.value.name, sessionId: target.value.sessionId, providerId: target.value.providerId,
    start: page.start, total: page.total,
    ...(page.start > 0 ? { more: `${page.start} older messages; read them with offset: ${page.start}` } : {}),
    messages: page.messages,
  });
}

function readDatabase(desc: TabDescription): TabReadOutcome {
  const db = desc.database ?? {};
  const rows = db.rows;
  return content({
    ...(db.sql !== undefined ? { sql: db.sql } : {}),
    ...(rows
      ? { columns: rows.columns, rows: rows.rows, ...(rows.more ? { moreRows: "The tab holds more rows than these; query them with db_query." } : {}) }
      : { note: "No rows are loaded in this tab on the device (it has not run, or is not open in a panel)." }),
  });
}

/** What the tab shows, read; content only — the caller adds the tab's description. */
export async function readDescribedTab(desc: TabDescription, offset: number, deps: TabReaderDeps = defaultDeps): Promise<TabReadOutcome> {
  switch (desc.type) {
    case "editor": return readEditor(desc, offset, deps);
    case "terminal": return readTerminal(desc, offset, deps);
    case "chat": return readChat(desc, offset, deps);
    case "database":
    case "db-query": return readDatabase(desc);
    default: return unreadable("Content is not readable for this tab type; the description is all PPM can say about it.");
  }
}
