/**
 * TabPool — persistent tab rendering with DOM reparenting.
 *
 * All tab components are mounted ONCE in a hidden off-screen container and
 * never unmounted when moved between panels or split. useLayoutEffect
 * physically moves each tab's wrapper DOM node into the correct panel slot
 * via appendChild (which moves, not clones). Component instances, hooks,
 * and all internal state (xterm buffer, Monaco editor, chat scroll) survive.
 *
 * Why not createPortal? Changing a portal's container element causes React
 * to unmount/remount the children — defeating the purpose.
 */
import { useRef, useLayoutEffect, useEffect, useSyncExternalStore, Suspense, lazy } from "react";
import { Loader2 } from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import { useMountedTabsStore } from "@/stores/mounted-tabs-store";
import type { TabType } from "@/stores/tab-store";
import { collectTabEntries, filterMountableEntries } from "./tab-pool-collect";
import { DOCK_PANEL_ID } from "@/stores/panel-utils";

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

// ---------------------------------------------------------------------------
// Slot registry — panels register their content container refs here
// ---------------------------------------------------------------------------
type SlotListener = () => void;

class SlotRegistry {
  private slots = new Map<string, HTMLDivElement>();
  private listeners = new Set<SlotListener>();
  private version = 0;

  register(panelId: string, el: HTMLDivElement | null) {
    if (el) {
      if (this.slots.get(panelId) === el) return;
      this.slots.set(panelId, el);
    } else {
      if (!this.slots.has(panelId)) return;
      this.slots.delete(panelId);
    }
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  get(panelId: string): HTMLDivElement | undefined {
    return this.slots.get(panelId);
  }

  subscribe(fn: SlotListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getVersion(): number {
    return this.version;
  }
}

const registry = new SlotRegistry();

/** Called by EditorPanel to register its content slot */
export function registerPanelSlot(panelId: string, el: HTMLDivElement | null) {
  registry.register(panelId, el);
}

// ---------------------------------------------------------------------------
// TabPool — renders all tabs in a hidden container, reparents into slots
// ---------------------------------------------------------------------------
export function TabPool() {
  const hiddenRef = useRef<HTMLDivElement>(null);

  // Re-render when slots change (panel mount/unmount)
  useSyncExternalStore(
    (cb) => registry.subscribe(cb),
    () => registry.getVersion(),
  );

  const panels = usePanelStore((s) => s.panels);
  const grid = usePanelStore((s) => s.grid);
  const currentProject = usePanelStore((s) => s.currentProject);
  const projectGrids = usePanelStore((s) => s.projectGrids);

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
    // Off-screen mount point. React mounts tab wrappers here, then
    // useLayoutEffect moves them into panel slots before the browser paints.
    <div ref={hiddenRef} style={{ position: "fixed", top: 0, left: 0, width: 0, height: 0, overflow: "hidden", pointerEvents: "none", visibility: "hidden" }}>
      {tabEntries.map((entry) => (
        <ReparentingTab
          key={entry.tabId}
          tabId={entry.tabId}
          panelId={entry.panelId}
          type={entry.type}
          metadata={entry.metadata}
          isActive={entry.isActive}
          hiddenContainer={hiddenRef}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReparentingTab — mounts once, physically moves between panel slots
// ---------------------------------------------------------------------------
interface ReparentingTabProps {
  tabId: string;
  panelId: string;
  type: TabType;
  metadata?: Record<string, unknown>;
  isActive: boolean;
  hiddenContainer: React.RefObject<HTMLDivElement | null>;
}

function ReparentingTab({ tabId, panelId, type, metadata, isActive, hiddenContainer }: ReparentingTabProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const Component = TAB_COMPONENTS[type];

  // On unmount: move wrapper back to hidden container so React's removeChild
  // can find it. Without this, the wrapper stays orphaned in the slot (the DOM
  // patch swallows the NotFoundError) and covers other tabs.
  useLayoutEffect(() => {
    return () => {
      const wrapper = wrapperRef.current;
      const hidden = hiddenContainer.current;
      if (wrapper && hidden && wrapper.parentElement !== hidden) {
        hidden.appendChild(wrapper);
      }
    };
  }, [hiddenContainer]);

  // Imperatively move the wrapper DOM node into the correct panel slot.
  // appendChild on an already-mounted node moves it (DOM spec — no clone/destroy).
  // useLayoutEffect runs before paint, so the user never sees the off-screen state.
  // No deps — must run every render because React's reconciliation may call
  // insertBefore() to reorder keyed children, moving reparented nodes back
  // to the hidden container. The early-return guard keeps this cheap.
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const slot = registry.get(panelId);
    if (!wrapper) return;

    // Panel slot not mounted (e.g., mobile renders only the focused panel).
    // Move wrapper back to hidden container so it doesn't overlap in the wrong slot.
    if (!slot) {
      const hidden = hiddenContainer.current;
      if (hidden && wrapper.parentElement !== hidden) {
        hidden.appendChild(wrapper);
      }
      return;
    }

    if (wrapper.parentElement === slot) return;

    // Save scroll positions — appendChild resets them during the DOM move
    const scrollables: { el: Element; top: number; left: number }[] = [];
    wrapper.querySelectorAll("*").forEach((el) => {
      if (el.scrollTop || el.scrollLeft) {
        scrollables.push({ el, top: el.scrollTop, left: el.scrollLeft });
      }
    });

    slot.appendChild(wrapper);

    // Restore scroll positions synchronously before paint
    for (const { el, top, left } of scrollables) {
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  });

  if (!Component) return null;

  return (
    <div
      ref={wrapperRef}
      className="absolute inset-0"
      style={isActive ? undefined : { display: "none" }}
      data-tab-pool-id={tabId}
      onMouseDownCapture={() => {
        // Tab content is DOM-reparented out of EditorPanel's fiber subtree, so
        // EditorPanel's onMouseDown never sees clicks on the content body. Set
        // focus here where panelId is known — keeps focusedPanelId correct for
        // every tab type. Dock content is excluded so new tabs open in the grid.
        if (panelId !== DOCK_PANEL_ID) usePanelStore.getState().setFocusedPanel(panelId);
      }}
    >
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-full">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        }
      >
        <Component metadata={metadata} tabId={tabId} />
      </Suspense>
    </div>
  );
}
