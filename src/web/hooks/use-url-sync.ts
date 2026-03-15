import { useEffect, useRef } from "react";
import { useTabStore } from "@/stores/tab-store";

/**
 * Parse the current URL to extract project name and tab ID.
 * Expected format: /project/:projectName/tab/:tabId
 */
export function parseUrlState(): { projectName: string | null; tabId: string | null } {
  const path = window.location.pathname;
  const match = path.match(/^\/project\/([^/]+)(?:\/tab\/([^/]+))?/);
  if (!match) return { projectName: null, tabId: null };
  return {
    projectName: match[1] ? decodeURIComponent(match[1]) : null,
    tabId: match[2] ? decodeURIComponent(match[2]) : null,
  };
}

/**
 * Build URL path from project name and tab ID.
 */
function buildUrl(projectName: string | null, tabId: string | null): string {
  if (!projectName || projectName === "__global__") return "/";
  let url = `/project/${encodeURIComponent(projectName)}`;
  if (tabId) url += `/tab/${encodeURIComponent(tabId)}`;
  return url;
}

/**
 * Sync tab/project state with browser URL.
 * - On tab/project change → pushState (enables back/forward navigation)
 * - On popstate (back/forward) → restore tab from URL
 */
export function useUrlSync() {
  const activeTabId = useTabStore((s) => s.activeTabId);
  const currentProject = useTabStore((s) => s.currentProject);
  const isPopState = useRef(false);

  // Push URL when active tab or project changes
  useEffect(() => {
    // Skip push if this change was triggered by popstate (back/forward)
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
      const { tabId } = parseUrlState();
      const { tabs, setActiveTab } = useTabStore.getState();
      if (tabId && tabs.some((t) => t.id === tabId)) {
        isPopState.current = true;
        setActiveTab(tabId);
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
}
