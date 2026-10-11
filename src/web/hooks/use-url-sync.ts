import { useEffect, useRef } from "react";
import { useTabStore, type TabType } from "@/stores/tab-store";
import { useWindowStore } from "@/components/floating-window/window-store";
import { openSettings } from "@/components/settings/open-settings";
import { openAssistant } from "@/components/assistant/open-assistant";
import { isAssistantProject } from "../../shared/assistant-project";
import { assistantLinkFromLocation, type AssistantDeepLink } from "@/lib/assistant-deep-link";
import { isMobileDevice } from "@/hooks/use-is-mobile";
import { isValidDesignSlug } from "../../services/design/design-slug";
import { designTabMetadata } from "@/lib/design/design-tab-metadata";
import { dbObjectTabTitle, dbTabMetadataFromId, targetOf } from "@/lib/db-tabs";

// ---------------------------------------------------------------------------
// URL state types
// ---------------------------------------------------------------------------

export interface UrlState {
  projectName: string | null;
  tabType: TabType | null;
  tabIdentifier: string | null;
  openChat: string | null;
  /**
   * An address that opens the PPM Assistant (`/assistant?session=…`, or the older
   * `/project/__assistant__?openChat=…`), and the session it names. Never a project to open.
   */
  assistant: AssistantDeepLink | null;
}

const VALID_TAB_TYPES: TabType[] = [
  "terminal", "chat", "editor", "database", "db-structure", "db-sql", "sqlite",
  "git-diff", "settings",
  "extension", "group", "design", "assistant",
];

// ---------------------------------------------------------------------------
// Parse URL → state
// ---------------------------------------------------------------------------

/**
 * `decodeURIComponent` throws `URIError` on a percent that is not an escape —
 * a hand-edited address, a truncated share link, a `%` in a branch name that
 * was never encoded. Thrown from here it reaches the root and unmounts the app,
 * so a mistyped URL would blank the page instead of just not resolving to a tab.
 */
function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Parse the current URL to extract project name and tab info.
 * Format: /project/{name}/{tabType}/{...identifier}
 */
export function parseUrlState(): UrlState {
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);
  const openChat = params.get("openChat");

  // The Assistant's virtual project is never a workspace to open, whatever an address says:
  // an address naming it opens the Assistant instead, and its `openChat` is the Assistant's.
  const assistant = assistantLinkFromLocation(path, window.location.search);
  if (assistant) return { projectName: null, tabType: null, tabIdentifier: null, openChat: null, assistant };

  const match = path.match(/^\/project\/([^/]+)(?:\/([^/]+)(\/.*)?)?/);
  if (!match) return { projectName: null, tabType: null, tabIdentifier: null, openChat, assistant: null };

  const projectName = decodePathSegment(match[1]!);
  const rawType = match[2] ?? null;
  const rawIdentifier = match[3] ? match[3].slice(1) : null; // strip leading /

  // Legacy fallback: /project/{name}/tab/{tabId}
  if (rawType === "tab") {
    return { projectName, tabType: null, tabIdentifier: null, openChat, assistant: null };
  }

  const tabType = VALID_TAB_TYPES.includes(rawType as TabType) ? (rawType as TabType) : null;

  return { projectName, tabType, tabIdentifier: rawIdentifier, openChat, assistant: null };
}

// ---------------------------------------------------------------------------
// Build URL from state
// ---------------------------------------------------------------------------

/**
 * Build URL path from project name and deterministic tab ID.
 */
export function buildUrl(projectName: string | null, tabId: string | null): string {
  if (!projectName || projectName === "__global__" || isAssistantProject(projectName)) return "/";

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

export function buildMetadataFromUrl(
  type: TabType, identifier: string | null, projectName: string,
): Record<string, unknown> | null {
  switch (type) {
    case "editor": return identifier ? { filePath: identifier, projectName } : null;
    case "chat": {
      if (!identifier) return null;
      const slashIdx = identifier.indexOf("/");
      const rawSessionId = slashIdx === -1 ? identifier : identifier.slice(slashIdx + 1);
      const providerId = slashIdx === -1 ? undefined : identifier.slice(0, slashIdx);
      // Validate UUID format — short/random IDs from tab derivation must not be used as session IDs
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawSessionId);
      const sessionId = isUuid ? rawSessionId : undefined;
      return { ...(sessionId && { sessionId }), ...(providerId && { providerId }), projectName };
    }
    case "terminal": return { terminalIndex: parseInt(identifier ?? "1", 10), projectName };
    case "git-diff": return identifier ? { filePath: identifier, projectName } : null;
    case "settings": return {};
    // The id names the table and where it is; the tab reads the connection's name and engine itself.
    case "database":
    case "db-structure":
    case "db-sql":
      return identifier ? dbTabMetadataFromId(type, identifier) : null;
    case "sqlite": return identifier ? { filePath: identifier, projectName } : null;
    case "extension": return identifier ? { viewType: identifier, projectName } : null;
    case "group": return identifier ? { groupId: identifier, projectName } : null;
    // The URL names the design only. The provider is resolved by the design tab itself,
    // among the providers that can carry design instructions, which is why it is pending.
    case "design": return isValidDesignSlug(identifier)
      ? designTabMetadata({ projectName, designSlug: identifier })
      : null;
    default: return null;
  }
}

function buildTitleFromUrl(type: TabType, identifier: string | null): string {
  switch (type) {
    case "editor": return identifier?.split("/").pop() ?? "File";
    case "chat": return "Chat";
    case "terminal": return `Terminal ${identifier ?? "1"}`;
    case "git-diff": return identifier?.split("/").pop() ?? "Diff";
    case "settings": return "Settings";
    case "database":
    case "db-structure":
    case "db-sql": {
      const m = identifier ? dbTabMetadataFromId(type, identifier) : null;
      const name = (m?.tableName ?? m?.objectName) as string | undefined;
      return name ? dbObjectTabTitle(targetOf(m ?? undefined), undefined, name) : "Database";
    }
    case "sqlite": return identifier?.split("/").pop() ?? "SQLite";
    case "extension": {
      if (!identifier) return "Extension";
      // "git-graph" → "Git Graph"
      return identifier.split("-").map(w => (w[0]?.toUpperCase() ?? "") + w.slice(1)).join(" ");
    }
    case "group": return "Group";
    case "design": return "Design";
    default: return type;
  }
}

/**
 * Settings has no desktop tab — it opens as its own floating window — and the Assistant opens
 * in a window too, so a URL naming either has to go through the same router every other entry
 * point uses.
 *
 * The wait matters: `restoreAll` REPLACES the window map when the desktop layer mounts, so a
 * window opened before that runs is silently discarded and the URL looks like it did nothing.
 * This is reachable in practice because the URL open happens inside async project resolution,
 * which can beat the layer's layout effect. Mobile needs no wait — it gets a tab, and the
 * window layer never mounts (so `restored` would never flip and this would hang).
 */
function onceWindowLayerIsReady(open: () => void): void {
  if (isMobileDevice() || useWindowStore.getState().restored) {
    open();
    return;
  }
  const unsubscribe = useWindowStore.subscribe((state) => {
    if (!state.restored) return;
    unsubscribe();
    open();
  });
}

/**
 * Opens the Assistant an address asked for, on the session it names, over whichever project is
 * on screen — never as a chat of some project. The address itself is dropped: it names no
 * workspace, so the workspace's own address takes over from here.
 */
export function openAssistantFromAddress(link: AssistantDeepLink): void {
  window.history.replaceState(null, "", "/");
  onceWindowLayerIsReady(() => openAssistant(link));
}

/** Auto-open or focus a tab based on URL state */
export function autoOpenFromUrl(
  tabType: TabType,
  tabIdentifier: string | null,
  projectName: string,
): void {
  if (tabType === "settings") {
    onceWindowLayerIsReady(() => openSettings());
    return;
  }
  // The Assistant opens in a window on a desktop, so it waits for the layer the same way.
  // Its address names only the tab (`/assistant`), never a session or its virtual project.
  if (tabType === "assistant") {
    onceWindowLayerIsReady(() => openAssistant());
    return;
  }

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
