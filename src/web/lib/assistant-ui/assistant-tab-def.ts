import { deriveTabId } from "@/stores/panel-utils";
import { dbObjectTabTitle, queryTabMetadata, targetFields, type DbTarget } from "@/lib/db-tabs";
import { basename } from "@/lib/utils";
import { tabSessionId } from "@/lib/tab-session-id";
import { isTabForFile } from "@/lib/ai-tab-placement";
import type { Tab } from "@/stores/tab-store";
import type { AssistantOpenTabTarget } from "../../../shared/assistant-ui-protocol";

/**
 * The tab `ui_open_tab` opens for each kind, as the rest of the app opens that kind (the
 * session list for a chat, the database explorer for a table, Source Control for Review
 * changes), so the Assistant's tab is the same tab the user would have got. Pure: the
 * executor (`assistant-ui-actions.ts`) hands it to the stores.
 */

export interface MatchableTab {
  id: string;
  type: string;
  projectId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AssistantTabDef {
  tab: Omit<Tab, "id">;
  /**
   * Whether an open tab already shows this, so it is brought forward instead of opened twice.
   * Never true for what is new on every open: a new chat, a terminal, a Query tab.
   */
  matches: (tab: MatchableTab) => boolean;
}

const never = () => false;

/** Matches the id `deriveTabId` gives the tab, and the `@<panel>` copies a split makes of it. */
function byDerivedId(tab: Omit<Tab, "id">): (t: MatchableTab) => boolean {
  const id = deriveTabId(tab.type, tab.metadata);
  return (t) => t.id === id || t.id.startsWith(`${id}@`);
}

export function buildAssistantTabDef(
  target: AssistantOpenTabTarget,
  project: string,
  opts: { queryNumber?: number } = {},
): AssistantTabDef {
  const base = { projectId: project as string | null, closable: true };
  switch (target.kind) {
    case "chat": {
      const metadata = {
        projectName: project,
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        ...(target.providerId ? { providerId: target.providerId } : {}),
      };
      const sessionId = target.sessionId;
      return {
        tab: { ...base, type: "chat", title: target.title || (sessionId ? "Chat" : "AI Chat"), metadata },
        // A chat's tab keeps the id it was opened with after it gains a session, so it is found by session.
        matches: sessionId ? (t) => tabSessionId({ type: t.type, metadata: t.metadata }) === sessionId : never,
      };
    }
    case "terminal":
      return { tab: { ...base, type: "terminal", title: "Terminal", metadata: { projectName: project } }, matches: never };
    case "database": {
      const where: DbTarget = { kind: "connection", connectionId: target.connectionId, ...(target.database ? { database: target.database } : {}) };
      const place = {
        ...targetFields(where),
        connectionName: target.connectionName,
        dbType: target.dbType,
        ...(target.color ? { connectionColor: target.color } : {}),
      };
      // A saved connection belongs to no project: its tabs show in every workspace.
      if (target.table) {
        const tab: Omit<Tab, "id"> = {
          type: "database", projectId: null, closable: true,
          title: dbObjectTabTitle(where, target.connectionName, target.table),
          metadata: { ...place, schemaName: target.schema ?? "", tableName: target.table },
        };
        return { tab, matches: byDerivedId(tab) };
      }
      const number = opts.queryNumber ?? 1;
      return {
        tab: { type: "db-query", projectId: null, closable: true, title: `Query ${number}`, metadata: { ...place, ...queryTabMetadata("", number) } },
        matches: never,
      };
    }
    case "file": {
      const metadata = { filePath: target.filePath, ...(target.projectName ? { projectName: target.projectName } : {}) };
      const tab: Omit<Tab, "id"> = { type: "editor", title: basename(target.filePath), projectId: target.projectName, closable: true, metadata };
      // An editor's id is its path, which two projects can share: the project tells them apart.
      return { tab, matches: (t) => isTabForFile(t, target.filePath, target.projectName) };
    }
    case "git": {
      if (target.view === "log") {
        // `git-log` is one per project, but its derived id is not stable: match by type and project.
        return {
          tab: { ...base, type: "git-log", title: "Git Log", metadata: { projectName: project } },
          matches: (t) => t.type === "git-log" && (t.projectId ?? t.metadata?.projectName) === project,
        };
      }
      const tab: Omit<Tab, "id"> = { ...base, type: "git-review", title: "Review changes", metadata: { projectName: project } };
      return { tab, matches: byDerivedId(tab) };
    }
    case "settings": {
      const tab: Omit<Tab, "id"> = {
        type: "settings", title: "Settings", projectId: null, closable: true,
        ...(target.section ? { metadata: { category: target.section } } : {}),
      };
      return { tab, matches: byDerivedId(tab) };
    }
  }
}
