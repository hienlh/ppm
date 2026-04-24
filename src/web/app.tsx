import { useEffect, useState, useCallback, useRef } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PanelLayout } from "@/components/layout/panel-layout";
import { Sidebar } from "@/components/layout/sidebar";
import { ProjectBar } from "@/components/layout/project-bar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { MobileDrawer } from "@/components/layout/mobile-drawer";
import { ProjectBottomSheet } from "@/components/layout/project-bottom-sheet";
import { LoginScreen } from "@/components/auth/login-screen";
import { useProjectStore, resolveOrder } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import {
  fetchWorkspaceFromServer,
  resolveWorkspaceConflict,
} from "@/stores/panel-utils";
import {
  useSettingsStore,
  applyThemeClass,
} from "@/stores/settings-store";
import { getAuthToken } from "@/lib/api-client";
import { useUrlSync, parseUrlState, autoOpenFromUrl } from "@/hooks/use-url-sync";
import { useGlobalKeybindings } from "@/hooks/use-global-keybindings";
import { useNotificationBadge } from "@/hooks/use-notification-badge";
import { useServerReload } from "@/hooks/use-server-reload";
import { CommandPalette } from "@/components/layout/command-palette";
import { ComparePicker } from "@/components/editor/compare-picker";
import { BugReportPopup } from "@/components/shared/bug-report-popup";
import { UpgradeBanner } from "@/components/layout/upgrade-banner";
import { ImageOverlay } from "@/components/shared/image-overlay";
import { DiagramOverlay } from "@/components/shared/diagram-overlay";
import { ConnectionLostOverlay } from "@/components/shared/connection-lost-overlay";
import { StatusBar } from "@/components/layout/status-bar";
import { ExtensionQuickPick } from "@/components/extensions/extension-quickpick";
import { ExtensionInputBox } from "@/components/extensions/extension-inputbox";
import { useExtensionWs } from "@/hooks/use-extension-ws";
import { cn } from "@/lib/utils";

type AuthState = "checking" | "authenticated" | "unauthenticated";

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [upgradeBannerVisible, setUpgradeBannerVisible] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"explorer" | "git" | "settings" | undefined>();
  const [projectSheetOpen, setProjectSheetOpen] = useState(false);

  // Listen for "open-mobile-settings" event (from project bottom sheet)
  useEffect(() => {
    const handler = () => { setDrawerTab("settings"); setDrawerOpen(true); };
    window.addEventListener("open-mobile-settings", handler);
    return () => window.removeEventListener("open-mobile-settings", handler);
  }, []);
  const [mountedProjects, setMountedProjects] = useState<Set<string>>(
    () => new Set(["__global__"]),
  );
  const theme = useSettingsStore((s) => s.theme);
  const deviceName = useSettingsStore((s) => s.deviceName);
  const fetchProjects = useProjectStore((s) => s.fetchProjects);
  const fetchServerInfo = useSettingsStore((s) => s.fetchServerInfo);
  const activeProject = useProjectStore((s) => s.activeProject);

  // Capture URL state on mount — before any effect can overwrite it
  const initialUrlRef = useRef(parseUrlState());

  // Apply theme on mount and when it changes
  useEffect(() => {
    applyThemeClass(theme);

    // Listen for OS theme changes when set to "system"
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyThemeClass("system");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [theme]);

  // Fetch server info on mount (before auth — shown on login screen)
  useEffect(() => {
    fetchServerInfo();
  }, [fetchServerInfo]);

  // Auth check on mount
  useEffect(() => {
    async function checkAuth() {
      const token = getAuthToken();

      // If no token stored, try without auth (server may have auth disabled)
      try {
        const headers: HeadersInit = {};
        if (token) headers["Authorization"] = `Bearer ${token}`;

        const res = await fetch("/api/auth/check", { headers });
        const json = await res.json();

        if (json.ok) {
          setAuthState("authenticated");
        } else {
          setAuthState("unauthenticated");
        }
      } catch {
        // Network error — try to proceed if no auth required
        setAuthState("unauthenticated");
      }
    }

    checkAuth();
  }, []);

  // URL sync — keeps browser URL in sync with active project/tab
  useUrlSync();

  // Global keyboard shortcuts (Shift+Shift → command palette, Alt+[/] → cycle tabs)
  const { paletteOpen, paletteInitialQuery, closePalette } = useGlobalKeybindings();

  // Notification badge — syncs document.title + favicon with unread count
  useNotificationBadge();

  // Auto-reload when server restarts (clears SW cache first)
  useServerReload();

  // Extension WS bridge — connects to /ws/extensions for UI updates (only after auth)
  useExtensionWs(authState === "authenticated");

  // Warn before closing browser tab (prevents accidental Ctrl+W)
  useEffect(() => {
    if (authState !== "authenticated") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [authState]);

  // Load keybindings after auth confirmed (must not call ApiClient before auth)
  useEffect(() => {
    if (authState !== "authenticated") return;
    import("@/stores/keybindings-store").then(({ useKeybindingsStore }) => {
      useKeybindingsStore.getState().loadFromServer();
    });
  }, [authState]);

  // Fetch projects after auth, then restore workspace + URL
  useEffect(() => {
    if (authState !== "authenticated") return;

    fetchProjects().then(async () => {
      const urlState = initialUrlRef.current;
      const { projects, customOrder } = useProjectStore.getState();
      if (projects.length === 0) return;

      // URL project takes priority, then fall back to first sorted project
      let target = urlState.projectName
        ? projects.find((p) => p.name === urlState.projectName)
        : undefined;
      if (!target) {
        target = resolveOrder(projects, customOrder)[0];
      }
      if (!target) return;

      // Fetch server workspace BEFORE activating project.
      // setActiveProject triggers switchProject which creates an empty layout
      // with a new timestamp if localStorage is empty (new tunnel/device).
      // By pre-populating localStorage, switchProject picks up the server data.
      const serverLayout = await fetchWorkspaceFromServer(target.name);
      if (serverLayout) {
        const localRaw = localStorage.getItem(`ppm-panels-${target.name}`);
        const localLayout = localRaw ? JSON.parse(localRaw) : null;
        const resolved = resolveWorkspaceConflict(localLayout, serverLayout);
        if (resolved && resolved === serverLayout) {
          // Server wins — write directly to localStorage (no server sync needed)
          localStorage.setItem(
            `ppm-panels-${target.name}`,
            JSON.stringify(serverLayout),
          );
        }
      }

      useProjectStore.getState().setActiveProject(target);

      // Switch panel layout to target project BEFORE opening URL tabs.
      // Without this, autoOpenFromUrl creates tabs in the __global__ layout
      // which get lost when the switchProject effect fires after render.
      useTabStore.getState().switchProject(target.name);

      // Auto-open target tab from URL (type-based)
      if (urlState.tabType) {
        autoOpenFromUrl(urlState.tabType, urlState.tabIdentifier, target!.name);
      }
      // Legacy: ?openChat= query param
      if (urlState.openChat) {
        autoOpenFromUrl("chat", urlState.openChat, target!.name);
        const url = new URL(window.location.href);
        url.searchParams.delete("openChat");
        window.history.replaceState(null, "", url.pathname);
      }
    });
  }, [authState, fetchProjects]);

  // Switch project tabs when active project changes
  useEffect(() => {
    const projectName = activeProject?.name ?? "__global__";
    useTabStore.getState().switchProject(projectName);
  }, [activeProject?.name]);

  // Keep-alive: mount workspace on first visit, never unmount
  useEffect(() => {
    const projectName = activeProject?.name ?? "__global__";
    setMountedProjects((prev) => {
      if (prev.has(projectName)) return prev;
      return new Set([...prev, projectName]);
    });
  }, [activeProject?.name]);

  // On initial auth with no project selected, ensure a tab set exists
  useEffect(() => {
    if (authState === "authenticated" && !activeProject) {
      useTabStore.getState().switchProject("__global__");
    }
  }, [authState, activeProject]);

  const handleLoginSuccess = useCallback(() => {
    setAuthState("authenticated");
  }, []);

  if (authState === "checking") {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-background">
        <div className="animate-pulse text-text-secondary text-sm">
          Loading...
        </div>
      </div>
    );
  }

  if (authState === "unauthenticated") {
    return <LoginScreen onSuccess={handleLoginSuccess} />;
  }

  const activeProjectName = activeProject?.name ?? "__global__";

  return (
    <TooltipProvider>
      <div className="h-dvh flex flex-col bg-background text-foreground overflow-hidden relative">
        {/* Upgrade banner — shown when new version available */}
        <UpgradeBanner onVisibilityChange={setUpgradeBannerVisible} />

        {/* Beta ribbon — top-left on desktop, top-right on mobile */}
        <div className="fixed z-50 overflow-hidden pointer-events-none max-md:right-0 max-md:top-0 md:left-0 md:top-0 w-10 h-10">
          <div className="absolute flex items-center justify-center max-md:rotate-45 max-md:right-[-18px] max-md:top-[4px] md:-rotate-45 md:left-[-18px] md:top-[4px] w-[60px] bg-amber-500 text-white text-[6px] font-bold leading-none py-[2.5px] shadow-sm">
            BETA
          </div>
        </div>

        {/* Mobile device name badge — floating top-left */}
        {deviceName && (
          <div className={cn("md:hidden fixed left-0 z-50 px-2 py-0.5 bg-primary/80 text-primary-foreground text-[10px] font-medium rounded-br transition-[top]", upgradeBannerVisible ? "top-7" : "top-0")}>
            {deviceName}
          </div>
        )}

        {/* Main layout */}
        <div className="flex flex-1 overflow-hidden">
          {/* Desktop project bar (far left, non-collapsible) */}
          <ProjectBar />

          {/* Desktop sidebar */}
          <Sidebar />

          {/* Content area — keep-alive per project */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {[...mountedProjects].map((projectName) => (
              <div
                key={projectName}
                className={cn(
                  "flex-1 overflow-hidden pb-12 md:pb-0",
                  activeProjectName !== projectName && "hidden",
                )}
              >
                <PanelLayout projectName={projectName} />
              </div>
            ))}
            <StatusBar />
          </div>
        </div>

        {/* Mobile bottom nav */}
        <MobileNav
          onMenuPress={() => setDrawerOpen(true)}
          onProjectsPress={() => setProjectSheetOpen(true)}
        />

        {/* Mobile drawer overlay */}
        <MobileDrawer
          isOpen={drawerOpen}
          onClose={() => { setDrawerOpen(false); setDrawerTab(undefined); }}
          initialTab={drawerTab}
        />

        {/* Mobile project bottom sheet */}
        <ProjectBottomSheet
          isOpen={projectSheetOpen}
          onClose={() => setProjectSheetOpen(false)}
        />

        {/* Command palette (Shift+Shift) */}
        <CommandPalette open={paletteOpen} onClose={closePalette} initialQuery={paletteInitialQuery} />

        {/* Compare Files picker (Mod+Alt+D, palette, context menus) — singleton */}
        <ComparePicker />

        {/* Global bug report popup */}
        <BugReportPopup />

        {/* Global image lightbox */}
        <ImageOverlay />

        {/* Global diagram lightbox (mermaid) */}
        <DiagramOverlay />

        {/* Extension modals (QuickPick, InputBox) */}
        <ExtensionQuickPick />
        <ExtensionInputBox />

        {/* Connection lost overlay — shown when API unreachable for >15s */}
        <ConnectionLostOverlay />

        {/* Toast notifications */}
        <Toaster
          position="bottom-left"
          closeButton
          toastOptions={{
            className: "bg-surface border-border text-foreground",
          }}
        />
      </div>
    </TooltipProvider>
  );
}
