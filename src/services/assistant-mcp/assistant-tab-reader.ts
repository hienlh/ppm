import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { projectService } from "../project.service.ts";
import { terminalService } from "../terminal.service.ts";
import { resolvePath } from "../fs-path-guard.service.ts";
import { assertReadPermitted } from "../fs-ops/fs-ops-read-write.service.ts";
import { isAssistantProject } from "../../shared/assistant-project.ts";
import {
  READ_TAB_CHAT_MESSAGES, tailWindow, type TabDescription,
} from "../../shared/assistant-tab-content.ts";
import { resolveAssistantProject, resolveAssistantSessionTarget, type AssistantProject, type AssistantSessionTarget } from "./assistant-project-scope.ts";
import { readChatPage, type ChatPage } from "./assistant-chat-page.ts";
import { findAiConnection } from "./assistant-db-tools.ts";
import { assistantPrivateRoots, isAssistantPrivatePath } from "../assistant/assistant-private-paths.ts";
import { isWindowsNonDrivePath } from "../design/design-tool-policy.ts";

/**
 * Reads what a tab shows, for `ui_read_tab`: the device described the tab (`describe_tab`);
 * the server adds what it holds itself — a terminal's output, a chat's messages — under the
 * same rules the Assistant's other reads follow.
 *
 * A file tab is answered with where the file is, never with the file: the agent reads it with
 * its provider's own read tool, which the Assistant's tool policy governs (inside the registered
 * projects unasked, elsewhere and in credential stores only with approval), so one rule decides
 * every file read. What only the device holds — an editor's unsaved text — comes back too, and
 * since no read tool can reach it, the same rule is applied to it here: unsaved text of a file
 * outside every registered project, or in a credential store (`assistant-private-paths.ts`), is
 * returned only once the user approves.
 *
 * A database tab's SQL and rows are the device's to send. For a saved connection they are read
 * only when the user left it available to the AI — the setting `db_query` and `ui_open_tab`
 * honour. A database file opened by path has no such setting, so it follows the file rule: inside
 * a registered project it is read, elsewhere or in a credential store only once approved.
 */

/** What an approval to read would let out: unsaved editor text, terminal output or a database tab. */
export type ReadApprovalSubject = "unsaved" | "terminal" | "database";

export type TabReadOutcome =
  | { kind: "content"; content: Record<string, unknown> }
  | {
    kind: "needs-approval";
    /** Outside every registered project, or in a store of logins and keys. */
    why: "outside" | "private";
    subject: ReadApprovalSubject;
    reason: string;
    details: Record<string, unknown>;
  }
  | { kind: "error"; message: string };

export interface TabReaderDeps {
  listProjects: () => AssistantProject[];
  terminal: { get(id: string): { projectPath: string } | undefined; getBuffer(id: string): string };
  readChat: (target: AssistantSessionTarget, opts: { limit: number; before?: number }) => Promise<ChatPage>;
  /** The private roots a file is checked against; the Assistant's own list unless a test names others. */
  privateRoots?: () => readonly string[];
}

const defaultDeps: TabReaderDeps = {
  listProjects: () => projectService.list().filter((p) => !isAssistantProject(p.name)),
  terminal: terminalService,
  readChat: readChatPage,
};

const TERMINAL_ID_RE = /^[0-9a-f-]{36}$/i;

const content = (c: Record<string, unknown>): TabReadOutcome => ({ kind: "content", content: c });
const error = (message: string): TabReadOutcome => ({ kind: "error", message });
const unreadable = (why: string): TabReadOutcome => content({ readable: false, note: why });

/** Where a file read goes, said in every answer about a file tab. */
export const READ_WITH_YOUR_OWN_TOOL = "PPM does not read files for you here: read this path with your own file-reading tool. "
  + "Inside the registered projects that runs without asking; anywhere else, or where logins and keys are kept, "
  + "that tool asks the user first.";

/** The registered project `name` names, or null (not registered any more, or none). */
function projectNamed(name: string | null | undefined, deps: TabReaderDeps): AssistantProject | null {
  if (!name) return null;
  const found = resolveAssistantProject(name, deps.listProjects);
  return found.ok ? found.value : null;
}

const realOrSelf = (path: string): Promise<string> =>
  isWindowsNonDrivePath(path) ? Promise.resolve(path) : realpath(path).catch(() => path);

/** The registered project an absolute path lies in, by its real location. */
async function projectHolding(absolute: string, deps: TabReaderDeps): Promise<AssistantProject | null> {
  const real = await realOrSelf(resolve(absolute));
  for (const p of deps.listProjects()) {
    const root = await realOrSelf(resolve(p.path));
    if (real === root || real.startsWith(root.endsWith(sep) ? root : root + sep)) return p;
  }
  return null;
}

interface FileLocation {
  absolute: string;
  /** The registered project holding it, by its real location; null for none. */
  owner: AssistantProject | null;
  /** In a store of logins and keys, as written or where it points. */
  privateStore: boolean;
}

/**
 * Where the file a tab names is, judged as written and where it points: a link inside a project
 * can lead into `~/.ssh`. A path PPM keeps to itself (its own folder, `~/.cloudflared`) or one
 * on no local drive is refused — checked before anything touches the disk, since on Windows a
 * UNC path names another machine and resolving it opens an SMB session there.
 */
async function locateFile(filePath: string, tabProject: AssistantProject | null, deps: TabReaderDeps): Promise<FileLocation | string> {
  let absolute: string;
  if (isAbsolute(filePath) || filePath.startsWith("~")) absolute = resolvePath(filePath);
  else if (tabProject) absolute = resolve(tabProject.path, filePath);
  else return "The tab names its file relative to a project that is not registered in PPM any more.";
  const refused = `PPM does not name ${absolute}: it is in a folder PPM keeps private, or not on one of this machine's drives.`;
  try {
    assertReadPermitted(absolute, absolute);
  } catch {
    return refused;
  }
  const real = await realOrSelf(absolute);
  try {
    assertReadPermitted(absolute, real);
  } catch {
    return refused;
  }
  const roots = deps.privateRoots?.() ?? assistantPrivateRoots();
  return {
    absolute,
    owner: await projectHolding(absolute, deps),
    privateStore: isAssistantPrivatePath(absolute, roots) || isAssistantPrivatePath(real, roots),
  };
}

/** The approval a read of this file's content needs, or null when it may be read unasked. */
function fileApproval(loc: FileLocation, subject: ReadApprovalSubject, what: string): TabReadOutcome | null {
  if (loc.privateStore) {
    return {
      kind: "needs-approval", why: "private", subject, details: { path: loc.absolute },
      reason: `The file is where logins or keys are kept; reading ${what} needs the user's approval.`,
    };
  }
  if (!loc.owner) {
    return {
      kind: "needs-approval", why: "outside", subject, details: { path: loc.absolute },
      reason: `The file is outside every registered project; reading ${what} needs the user's approval.`,
    };
  }
  return null;
}

async function readEditor(desc: TabDescription, deps: TabReaderDeps, approved: boolean): Promise<TabReadOutcome> {
  const ed = desc.editor;
  if (!ed || ed.special) return unreadable("This editor shows a diff, a viewer or inline text, not a file.");
  const unsaved = ed.unsaved ?? { text: "", fromLine: 0, toLine: 0, totalLines: 0 };
  const more = unsaved.nextOffset !== undefined ? { more: `Read more with offset: ${unsaved.nextOffset}` } : {};
  if (ed.untitled) return content({ source: "untitled editor text (never saved)", ...unsaved, ...more });
  if (!ed.filePath) return error("The device did not say which file this tab shows.");
  const loc = await locateFile(ed.filePath, projectNamed(desc.project, deps), deps);
  if (typeof loc === "string") return error(loc);
  const head = { project: loc.owner?.name ?? null, path: loc.absolute, readWith: READ_WITH_YOUR_OWN_TOOL };
  if (!(ed.dirty && ed.unsaved)) return content({ ...head, unsavedChanges: false });
  const ask = approved ? null : fileApproval(loc, "unsaved", "its unsaved text");
  if (ask) return ask;
  return content({
    ...head, unsavedChanges: true, source: "the editor's unsaved text (not on disk yet; the file on disk differs)", ...unsaved, ...more,
  });
}

/** Terminal output as text: colours and cursor sequences gone, a carriage return's overwrite applied. */
export function terminalLines(raw: string): string[] {
  const lines = stripVTControlCharacters(raw).replace(/\r\n/g, "\n").split("\n")
    .map((line) => (line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line));
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  return lines;
}

async function readTerminal(desc: TabDescription, offset: number, deps: TabReaderDeps, approved: boolean): Promise<TabReadOutcome> {
  const id = desc.terminal?.sessionId;
  if (!id) return unreadable("This terminal has not started a shell on this device yet.");
  if (!TERMINAL_ID_RE.test(id)) return error("The device named a terminal PPM does not recognise.");
  const session = deps.terminal.get(id);
  if (!session) return error("This terminal's shell has ended; there is no output left to read.");
  const owner = await projectHolding(session.projectPath, deps);
  if (!owner && !approved) {
    return {
      kind: "needs-approval",
      why: "outside",
      subject: "terminal",
      reason: "This terminal runs outside every registered project; reading it needs the user's approval.",
      details: { folder: session.projectPath },
    };
  }
  const lines = terminalLines(deps.terminal.getBuffer(id));
  const w = tailWindow(lines, offset);
  return content({
    project: owner?.name ?? null, ...(owner ? {} : { folder: session.projectPath }), source: "terminal output, newest last (colours removed)",
    ...w, ...(w.nextOffset !== undefined ? { more: `Read older lines with offset: ${w.nextOffset}` } : {}),
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

/**
 * What a database tab shows, as the device sent it, under `source` (the connection or the file).
 * `moreRows` says where the rest can be read from: `db_query` reaches only saved connections.
 */
function databaseContent(source: Record<string, unknown>, db: NonNullable<TabDescription["database"]>, moreRows: string): TabReadOutcome {
  const rows = db.rows;
  return content({
    ...source,
    ...(db.sql !== undefined ? { sql: db.sql } : {}),
    ...(rows
      ? { columns: rows.columns, rows: rows.rows, ...(rows.more ? { moreRows } : {}) }
      : { note: "No rows are loaded in this tab on the device (it has not run, or is not open in a panel)." }),
  });
}

/**
 * A database tab's SQL and rows, checked here, not on the device: the rows are already in the
 * browser, so the server is the one place that can keep them from the agent. A saved connection
 * must be available to the AI; a database file opened by path follows the file rule.
 */
async function readDatabase(desc: TabDescription, deps: TabReaderDeps, approved: boolean): Promise<TabReadOutcome> {
  const db = desc.database ?? {};
  if (db.connectionId !== undefined) {
    const found = findAiConnection(db.connectionId);
    if (!found.ok) return error(found.error);
    return databaseContent({ connection: found.conn.name }, db, "The tab holds more rows than these; query them with db_query.");
  }
  if (!db.file) {
    return error("This tab names neither a saved connection nor a database file, so PPM cannot tell whose data it shows; its SQL and rows are not read.");
  }
  const tabProject = db.file.project ? projectNamed(db.file.project, deps) : null;
  if (db.file.project && !tabProject) return error(`The tab's database file belongs to "${db.file.project}", which is not a registered project any more.`);
  const loc = await locateFile(db.file.path, tabProject, deps);
  if (typeof loc === "string") return error(loc);
  const ask = approved ? null : fileApproval(loc, "database", "its SQL and rows");
  if (ask) return ask;
  return databaseContent({ project: loc.owner?.name ?? null, file: loc.absolute }, db,
    "The tab holds more rows than these; a database file opened by path is not a connection db_query can reach.");
}

/**
 * What the tab shows, read; content only — the caller adds the tab's description. Unsaved text,
 * terminal output or a database file's rows from outside every registered project (or a
 * credential store) answer `needs-approval` unless `approved`: the user has just approved it.
 */
export async function readDescribedTab(
  desc: TabDescription,
  offset: number,
  deps: TabReaderDeps = defaultDeps,
  opts: { approved?: boolean } = {},
): Promise<TabReadOutcome> {
  const approved = opts.approved === true;
  switch (desc.type) {
    case "editor": return readEditor(desc, deps, approved);
    case "terminal": return readTerminal(desc, offset, deps, approved);
    case "chat": return readChat(desc, offset, deps);
    case "database":
    case "db-query": return readDatabase(desc, deps, approved);
    default: return unreadable("Content is not readable for this tab type; the description is all PPM can say about it.");
  }
}
