/**
 * Showing one project's tab from outside the tab bar: a push notification's link, or a link
 * clicked inside an HTML file preview. Both name a PPM address (`/project/<name>/<type>/…`),
 * and both must land the same way a page load of that address would.
 */
import { useProjectStore } from "@/stores/project-store";
import { useTabStore, type TabType } from "@/stores/tab-store";
import { hydrateWorkspaceFromServer } from "@/stores/panel-utils";
import { autoOpenFromUrl, parseUrlState, type UrlState } from "@/hooks/use-url-sync";

/** The tab a PPM address names, or null for an address on another origin or a broken one. */
export function ppmUrlState(url: string): UrlState | null {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === window.location.origin ? parseUrlState(parsed) : null;
  } catch {
    return null;
  }
}

/**
 * Switch to the project and open (or focus) the tab. False for a project this PPM does not
 * have. A tab type of null shows the project as it was left.
 */
export async function showProjectTab(projectName: string, tabType: TabType | null, tabIdentifier: string | null): Promise<boolean> {
  const target = useProjectStore.getState().projects.find((p) => p.name === projectName);
  if (!target) return false;
  if (useTabStore.getState().currentProject !== target.name) {
    // Without a local copy of the layout, switching would create an empty one and overwrite the saved tabs.
    if (!localStorage.getItem(`ppm-panels-${target.name}`)) await hydrateWorkspaceFromServer(target.name);
    useProjectStore.getState().setActiveProject(target);
    useTabStore.getState().switchProject(target.name);
  }
  if (tabType) autoOpenFromUrl(tabType, tabIdentifier, target.name);
  return true;
}
