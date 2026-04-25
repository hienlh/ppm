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
import { useRef, useLayoutEffect, useSyncExternalStore, Suspense, lazy } from "react";
import { Loader2 } from "lucide-react";
import { usePanelStore } from "@/stores/panel-store";
import type { TabType } from "@/stores/tab-store";

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
  ports: lazy(() => import("@/components/ports/port-forwarding-tab").then((m) => ({ default: m.PortForwardingTab }))),
  extension: lazy(() => import("@/components/extensions/extension-webview").then((m) => ({ default: m.ExtensionWebview }))),
  "extension-webview": lazy(() => import("@/components/extensions/extension-webview").then((m) => ({ default: m.ExtensionWebview }))),
  "conflict-editor": lazy(() => import("@/components/editor/conflict-editor").then((m) => ({ default: m.ConflictEditor }))),
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

  // Collect all tabs across visible panels (only panels in current grid)
  const visiblePanelIds = new Set(grid.flat());
  const tabEntries: { tabId: string; panelId: string; type: TabType; metadata?: Record<string, unknown>; isActive: boolean }[] = [];

  for (const panelId of visiblePanelIds) {
    const panel = panels[panelId];
    if (!panel) continue;
    for (const tab of panel.tabs) {
      tabEntries.push({
        tabId: tab.id,
        panelId,
        type: tab.type,
        metadata: tab.metadata,
        isActive: tab.id === panel.activeTabId,
      });
    }
  }

  // Stable key order — prevents React from calling insertBefore() to reorder
  // children, which would yank reparented DOM nodes back to the hidden container
  // and reset scroll positions / trigger resize observers.
  tabEntries.sort((a, b) => a.tabId.localeCompare(b.tabId));

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
      style={isActive ? undefined : { opacity: 0, pointerEvents: "none" }}
      data-tab-pool-id={tabId}
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
