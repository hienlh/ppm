/**
 * TabPool — persistent tab rendering with DOM reparenting.
 *
 * All tab components are mounted ONCE and never unmounted when moved between panels or
 * split. Each tab gets a wrapper element that is created once and portalled into; a
 * layout effect physically moves that wrapper into the correct panel slot via appendChild
 * (which moves, not clones). Component instances, hooks, and all internal state (xterm
 * buffer, Monaco editor, chat scroll) survive.
 *
 * A portal is safe here precisely because the container element is stable: the objection
 * to portals is that *changing* a portal's container remounts its children, and nothing
 * ever swaps a wrapper. In exchange React binds its listeners to the wrapper itself, so
 * they travel with the node — including into another document.
 */
import { useState, useEffect, useSyncExternalStore, lazy } from "react";
import { usePanelStore } from "@/stores/panel-store";
import { useMountedTabsStore } from "@/stores/mounted-tabs-store";
import type { TabType } from "@/stores/tab-store";
import { collectTabEntries, filterMountableEntries } from "./tab-pool-collect";
import { slotRegistry } from "./tab-pool-registry";
import { ReparentingTab } from "./reparenting-tab";
import { useWindowPanelReconcile } from "./use-window-panel-reconcile";

export { registerPanelSlot } from "./tab-pool-registry";

// ---------------------------------------------------------------------------
// Lazy tab components (single source of truth for all tab types)
// ---------------------------------------------------------------------------
const TAB_COMPONENTS: Record<TabType, React.LazyExoticComponent<React.ComponentType<{ metadata?: Record<string, unknown>; tabId?: string }>>> = {
  terminal: lazy(() => import("@/components/terminal/terminal-tab").then((m) => ({ default: m.TerminalTab }))),
  chat: lazy(() => import("@/components/chat/chat-tab").then((m) => ({ default: m.ChatTab }))),
  editor: lazy(() => import("@/components/editor/code-editor").then((m) => ({ default: m.CodeEditor }))),
  database: lazy(() => import("@/components/database/database-viewer").then((m) => ({ default: m.DatabaseViewer }))),
  sqlite: lazy(() => import("@/components/sqlite/sqlite-viewer").then((m) => ({ default: m.SqliteViewer }))),
  postgres: lazy(() => import("@/components/postgres/postgres-viewer").then((m) => ({ default: m.PostgresViewer }))),
  "git-diff": lazy(() => import("@/components/editor/diff-viewer").then((m) => ({ default: m.DiffViewer }))),
  settings: lazy(() => import("@/components/settings/settings-tab").then((m) => ({ default: m.SettingsTab }))),
  extension: lazy(() => import("@/components/extensions/extension-webview").then((m) => ({ default: m.ExtensionWebview }))),
  "extension-webview": lazy(() => import("@/components/extensions/extension-webview").then((m) => ({ default: m.ExtensionWebview }))),
  "conflict-editor": lazy(() => import("@/components/editor/conflict-editor").then((m) => ({ default: m.ConflictEditor }))),
  "system-monitor": lazy(() => import("@/components/system/system-monitor-tab").then((m) => ({ default: m.SystemMonitorTab }))),
  "git-log": lazy(() => import("@/components/git/git-log-panel").then((m) => ({ default: m.GitLogPanel }))),
  "ai-resource": lazy(() => import("@/components/ai-resources/ai-resource-editor").then((m) => ({ default: m.AiResourceEditor }))),
  group: lazy(() => import("@/components/group-chat/group-chat-tab").then((m) => ({ default: m.GroupChatTab }))),
};

const HIDDEN_CONTAINER_STYLE: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  width: 0,
  height: 0,
  overflow: "hidden",
  pointerEvents: "none",
  visibility: "hidden",
};

// ---------------------------------------------------------------------------
// TabPool — renders all tabs into wrappers parked off-screen, reparents into slots
// ---------------------------------------------------------------------------
export function TabPool() {
  // State, not a ref: a tab's wrapper must be appended to a real element on its very
  // first layout effect, and a parent ref is still null while its children's effects run.
  const [hiddenContainer, setHiddenContainer] = useState<HTMLDivElement | null>(null);

  // Re-render when slots change (panel mount/unmount)
  useSyncExternalStore(
    (cb) => slotRegistry.subscribe(cb),
    () => slotRegistry.getVersion(),
  );

  const panels = usePanelStore((s) => s.panels);
  const grid = usePanelStore((s) => s.grid);
  const currentProject = usePanelStore((s) => s.currentProject);
  const projectGrids = usePanelStore((s) => s.projectGrids);

  // Detached tabs and their floating windows are persisted separately, so a reload can
  // restore one without the other; this repairs the mismatch once per project load.
  useWindowPanelReconcile();

  // Collect tabs from ALL mounted projects (not just active) to preserve
  // tab state across project switches (keep-alive). Each project's
  // PanelLayout stays mounted (CSS hidden), so slots remain registered.
  // Logic lives in tab-pool-collect.ts (pure helper) so it is unit-testable
  // without a DOM; it also applies the stable tabId sort that prevents React
  // insertBefore() reorders from yanking reparented DOM nodes back here.
  const allEntries = collectTabEntries(panels, grid, projectGrids, currentProject);

  // Lazy mount: a saved workspace can hold dozens of tabs, and mounting them
  // all on boot runs every tab's data-fetch effects at once (measured: 515
  // requests / 36.7 MB for 18 chat tabs), starving the tab the user is
  // actually waiting on. Mount only what is visible NOW plus anything already
  // mounted earlier this session, so keep-alive still holds for opened tabs.
  // `isActive` is per-panel, so every panel of a split contributes its own tab.
  const mounted = useMountedTabsStore((s) => s.mounted);
  const tabEntries = filterMountableEntries(allEntries, mounted);

  // Record visible tabs so they stay mounted after the user switches away.
  // Filtering on `isActive` above means this never delays a tab's first paint —
  // it only makes the decision sticky. Keyed on the id list so it is a no-op
  // on unrelated re-renders.
  const visibleIds = allEntries.filter((e) => e.isActive).map((e) => e.tabId);
  // JSON, not join("|") — editor tab ids embed file paths and "|" is a legal
  // filename character, so a delimiter join is ambiguous.
  const visibleKey = JSON.stringify(visibleIds);
  useEffect(() => {
    const { mount } = useMountedTabsStore.getState();
    for (const id of visibleIds) mount(id);
    // visibleIds is derived from visibleKey; depending on the string keeps the
    // effect stable across re-renders that don't change the visible set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey]);

  return (
    // Off-screen parking spot. Tab wrappers live here until a layout effect moves them
    // into a panel slot, and come back whenever their panel has no slot mounted.
    <div ref={setHiddenContainer} style={HIDDEN_CONTAINER_STYLE}>
      {hiddenContainer &&
        tabEntries.map((entry) => {
          const Component = TAB_COMPONENTS[entry.type];
          if (!Component) return null;
          return (
            <ReparentingTab
              key={entry.tabId}
              tabId={entry.tabId}
              panelId={entry.panelId}
              component={Component}
              metadata={entry.metadata}
              isActive={entry.isActive}
              hiddenContainer={hiddenContainer}
            />
          );
        })}
    </div>
  );
}
