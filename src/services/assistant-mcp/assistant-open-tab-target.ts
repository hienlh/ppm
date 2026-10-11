import { getSessionDesignSlug, getSessionTitle } from "../db.service.ts";
import { resolveTabTarget } from "../tab-tools-mcp/tab-target.ts";
import { ASSISTANT_TAB_KINDS, isAssistantTabKind, type AssistantOpenTabTarget } from "../../shared/assistant-ui-protocol.ts";
import { resolveAssistantSessionTarget, type AssistantProject, type Scoped } from "./assistant-project-scope.ts";
import { findAiConnection } from "./assistant-db-tools.ts";

/**
 * Turns `ui_open_tab`'s `kind` and `target` into what the device opens, checked against what
 * PPM has registered: a chat proven to be the project's, a connection the user left available
 * to the AI, a file the editor's own read rules allow. The device gets only these normalised
 * fields, never the agent's raw input.
 */

const MAX_NAME_CHARS = 200;
const MAX_LINE = 10_000_000;
const SECTION_RE = /^[a-z][a-z-]{0,39}$/;
const PROVIDERS = ["claude", "codex"] as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** An optional short name (a table, a schema, a database); null when malformed. */
function optionalName(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > MAX_NAME_CHARS || /[\0\r\n]/.test(value)) return null;
  return value;
}

function chatTarget(project: AssistantProject, t: Record<string, unknown>): Scoped<AssistantOpenTabTarget> {
  if (t.sessionId === undefined || t.sessionId === null || t.sessionId === "") {
    if (t.providerId !== undefined && !PROVIDERS.includes(t.providerId as never)) {
      return { ok: false, error: "`target.providerId` must be \"claude\" or \"codex\"." };
    }
    return { ok: true, value: { kind: "chat", ...(t.providerId ? { providerId: t.providerId as "claude" | "codex" } : {}) } };
  }
  const session = resolveAssistantSessionTarget(project, t.sessionId, t.providerId);
  if (!session.ok) return session;
  const { sessionId, providerId } = session.value;
  const design = getSessionDesignSlug(sessionId);
  if (design) {
    return { ok: false, error: `That chat belongs to the design "${design.slice(0, 100)}" and opens with it; ask the user to open the design.` };
  }
  const title = getSessionTitle(sessionId)?.slice(0, 100);
  return { ok: true, value: { kind: "chat", sessionId, providerId, ...(title ? { title } : {}) } };
}

function databaseTarget(t: Record<string, unknown>): Scoped<AssistantOpenTabTarget> {
  const found = findAiConnection(t.connectionId);
  if (!found.ok) return found;
  const table = optionalName(t.table);
  const schema = optionalName(t.schema);
  const database = optionalName(t.database);
  if (table === null || schema === null || database === null) {
    return { ok: false, error: `\`target.table\`, \`schema\` and \`database\` must be names of at most ${MAX_NAME_CHARS} characters.` };
  }
  const { conn } = found;
  return {
    ok: true,
    value: {
      kind: "database", connectionId: conn.id, connectionName: conn.name, dbType: conn.type,
      ...(conn.color ? { color: conn.color } : {}),
      ...(database ? { database } : {}), ...(schema ? { schema } : {}), ...(table ? { table } : {}),
    },
  };
}

async function fileTarget(project: AssistantProject, t: Record<string, unknown>): Promise<Scoped<AssistantOpenTabTarget>> {
  let line: number | undefined;
  if (t.line !== undefined && t.line !== null) {
    if (typeof t.line !== "number" || !Number.isInteger(t.line) || t.line < 1 || t.line > MAX_LINE) {
      return { ok: false, error: "`target.line` must be a line number from 1." };
    }
    line = t.line;
  }
  const resolved = await resolveTabTarget(t.path, { sessionId: "", projectPath: project.path, projectName: project.name });
  if (!resolved.ok) return { ok: false, error: resolved.error.replace("`path`", "`target.path`") };
  const { filePath, projectName } = resolved.target;
  return { ok: true, value: { kind: "file", filePath, projectName, ...(line ? { line } : {}) } };
}

export async function resolveOpenTabTarget(
  project: AssistantProject,
  kind: unknown,
  rawTarget: unknown,
): Promise<Scoped<AssistantOpenTabTarget>> {
  if (!isAssistantTabKind(kind)) return { ok: false, error: `\`kind\` must be one of: ${ASSISTANT_TAB_KINDS.join(", ")}.` };
  if (rawTarget !== undefined && rawTarget !== null && !isObj(rawTarget)) return { ok: false, error: "`target` must be an object." };
  const t = isObj(rawTarget) ? rawTarget : {};
  switch (kind) {
    case "chat": return chatTarget(project, t);
    case "terminal": return { ok: true, value: { kind: "terminal" } };
    case "database": return databaseTarget(t);
    case "file": return fileTarget(project, t);
    case "git": {
      const view = t.view ?? "review";
      if (view !== "review" && view !== "log") return { ok: false, error: "`target.view` must be \"review\" or \"log\"." };
      return { ok: true, value: { kind: "git", view } };
    }
    case "settings": {
      if (t.section === undefined || t.section === null || t.section === "") return { ok: true, value: { kind: "settings" } };
      if (typeof t.section !== "string" || !SECTION_RE.test(t.section)) return { ok: false, error: "`target.section` is not a Settings section id." };
      return { ok: true, value: { kind: "settings", section: t.section } };
    }
  }
}
