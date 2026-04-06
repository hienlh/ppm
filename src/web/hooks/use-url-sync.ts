import { useEffect, useRef } from "react";
import { useTabStore, type TabType } from "@/stores/tab-store";

// ---------------------------------------------------------------------------
// URL state types
// ---------------------------------------------------------------------------

export interface UrlState {
  projectName: string | null;
  tabType: TabType | null;
  tabIdentifier: string | null;
  openChat: string | null;
}

const VALID_TAB_TYPES: TabType[] = [
  "terminal", "chat", "editor", "database", "sqlite",
  "postgres", "git-graph", "git-diff", "settings", "ports",
];

// ---------------------------------------------------------------------------
// Parse URL → state
// ---------------------------------------------------------------------------

/**
 * Parse the current URL to extract project name and tab info.
 * Format: /project/{name}/{tabType}/{...identifier}
 */
export function parseUrlState(): UrlState {
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);
  const openChat = params.get("openChat");

  const match = path.match(/^\/project\/([^/]+)(?:\/([^/]+)(\/.*)?)?/);
  if (!match) return { projectName: null, tabType: null, tabIdentifier: null, openChat };

  const projectName = decodeURIComponent(match[1]!);
  const rawType = match[2] ?? null;
  const rawIdentifier = match[3] ? match[3].slice(1) : null; // strip leading /

  // Legacy fallback: /project/{name}/tab/{tabId}
  if (rawType === "tab") {
    return { projectName, tabType: null, tabIdentifier: null, openChat };
  }

  const tabType = VALID_TAB_TYPES.includes(rawType as TabType) ? (rawType as TabType) : null;

  return { projectName, tabType, tabIdentifier: rawIdentifier, openChat };
}

// ---------------------------------------------------------------------------
// Build URL from state
// ---------------------------------------------------------------------------

/**
 * Build URL path from project name and deterministic tab ID.
 */
export function buildUrl(projectName: string | null, tabId: string | null): string {
  if (!projectName || projectName === "__global__") return "/";

  let url = `/project/${encodeURIComponent(projectName)}`;
  if (!tabId) return url;

  // Strip panel suffix (@panel-xxx) — not meaningful in URLs
  const atIdx = tabId.indexOf("@");
  const cleanId = atIdx !== -1 ? tabId.slice(0, atIdx) : tabId;

  // tabId format: "type:identifier" or "type" (singletons)
  const colonIdx = cleanId.indexOf(":");
  if (colonIdx === -1) {
    // Singleton: git-graph, settings
    url += `/${cleanId}`;
  } else {
    const type = cleanId.slice(0, colonIdx);
    const identifier = cleanId.slice(colonIdx + 1);
    // Real slashes — no encoding for paths. Only encode special URL chars.
    url += `/${type}/${identifier.replace(/[?#]/g, encodeURIComponent)}`;
  }
  return url;
}

// ---------------------------------------------------------------------------
// Tab ID reconstruction from URL
// ---------------------------------------------------------------------------

/** Reconstruct deterministic tab ID from parsed URL */
export function tabIdFromUrl(tabType: TabType, tabIdentifier: string | null): string {
  if (!tabIdentifier) return tabType; // singleton
  return `${tabType}:${tabIdentifier}`;
}

// ---------------------------------------------------------------------------
// Auto-open tab from URL
// ---------------------------------------------------------------------------

function buildMetadataFromUrl(
  type: TabType, identifier: string | null, projectName: string,
): Record<string, unknown> | null {
  switch (type) {
    case "editor": return identifier ? { filePath: identifier, projectName } : null;
    case "chat": {
      if (!identifier) return null;
      const slashIdx = identifier.indexOf("/");
      if (slashIdx === -1) return { sessionId: identifier, projectName };
      const providerId = identifier.slice(0, slashIdx);
      const sessionId = identifier.slice(slashIdx + 1);
      return sessionId ? { sessionId, providerId, projectName } : null;
    }
    case "terminal": return { terminalIndex: parseInt(identifier ?? "1", 10), projectName };
    case "git-graph": return { projectName };
    case "git-diff": return identifier ? { filePath: identifier, projectName } : null;
    case "settings": return {};
    case "database": {
      const [connId, tableName] = (identifier ?? "").split(":");
      return connId ? { connectionId: connId, tableName: tableName ?? "" } : null;
    }
    case "sqlite": return identifier ? { filePath: identifier, projectName } : null;
    case "postgres": {
      const [connId, tableName] = (identifier ?? "").split(":");
      return connId ? { connectionId: connId, tableName: tableName ?? "" } : null;
    }
    case "ports": return null;
    default: return null;
  }
}

function buildTitleFromUrl(type: TabType, identifier: string | null): string {
  switch (type) {
    case "editor": return identifier?.split("/").pop() ?? "File";
    case "chat": return "Chat";
    case "terminal": return `Terminal ${identifier ?? "1"}`;
    case "git-graph": return "Git Graph";
    case "git-diff": return identifier?.split("/").pop() ?? "Diff";
    case "settings": return "Settings";
    case "database": return identifier ?? "Database";
    case "sqlite": return identifier?.split("/").pop() ?? "SQLite";
    case "postgres": return identifier ?? "PostgreSQL";
    case "ports": return "Ports";
    default: return type;
  }
}

/** Auto-open or focus a tab based on URL state */
export function autoOpenFromUrl(
  tabType: TabType,
  tabIdentifier: string | null,
  projectName: string,
): void {
  const { tabs, setActiveTab, openTab } = useTabStore.getState();
  const expectedId = tabIdFromUrl(tabType, tabIdentifier);

  // Check if tab already exists
  const existing = tabs.find((t) => t.id === expectedId);
  if (existing) {
    setActiveTab(existing.id);
    return;
  }

  // Auto-create tab from URL
  const metadata = buildMetadataFromUrl(tabType, tabIdentifier, projectName);
  if (!metadata) return;

  openTab({
    type: tabType,
    title: buildTitleFromUrl(tabType, tabIdentifier),
    projectId: projectName,
    closable: true,
    metadata,
  });
}

// ---------------------------------------------------------------------------
// Hook: sync URL ↔ tab state
// ---------------------------------------------------------------------------

/**
 * Sync tab/project state with browser URL.
 * - On tab/project change → pushState with type-based URL
 * - On popstate (back/forward) → restore/create tab from URL
 */
export function useUrlSync() {
  const activeTabId = useTabStore((s) => s.activeTabId);
  const currentProject = useTabStore((s) => s.currentProject);
  const isPopState = useRef(false);

  // Push URL when active tab or project changes
  useEffect(() => {
    if (isPopState.current) {
      isPopState.current = false;
      return;
    }

    const newUrl = buildUrl(currentProject, activeTabId);
    if (window.location.pathname !== newUrl) {
      window.history.pushState(null, "", newUrl);
    }
  }, [activeTabId, currentProject]);

  // Listen for back/forward navigation
  useEffect(() => {
    function handlePopState() {
      const { tabType, tabIdentifier } = parseUrlState();
      if (!tabType) return;

      isPopState.current = true;
      const { tabs, setActiveTab } = useTabStore.getState();
      const expectedId = tabIdFromUrl(tabType, tabIdentifier);
      const existing = tabs.find((t) => t.id === expectedId);

      if (existing) {
        setActiveTab(existing.id);
      } else {
        // Auto-open tab on back/forward if it was closed
        const project = useTabStore.getState().currentProject;
        if (project) autoOpenFromUrl(tabType, tabIdentifier, project);
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
}
