import { useEffect, useState, useCallback } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PanelLayout } from "@/components/layout/panel-layout";
import { Sidebar } from "@/components/layout/sidebar";
import { ProjectBar } from "@/components/layout/project-bar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { MobileDrawer } from "@/components/layout/mobile-drawer";
import { ProjectBottomSheet } from "@/components/layout/project-bottom-sheet";
import { LoginScreen } from "@/components/auth/login-screen";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import {
  useSettingsStore,
  applyThemeClass,
} from "@/stores/settings-store";
import { getAuthToken } from "@/lib/api-client";
import { useUrlSync, parseUrlState } from "@/hooks/use-url-sync";
import { useGlobalKeybindings } from "@/hooks/use-global-keybindings";
import { useHealthCheck } from "@/hooks/use-health-check";
import { CommandPalette } from "@/components/layout/command-palette";
import { cn } from "@/lib/utils";

type AuthState = "checking" | "authenticated" | "unauthenticated";

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [projectSheetOpen, setProjectSheetOpen] = useState(false);
  const [mountedProjects, setMountedProjects] = useState<Set<string>>(
    () => new Set(["__global__"]),
  );
  const theme = useSettingsStore((s) => s.theme);
  const deviceName = useSettingsStore((s) => s.deviceName);
  const fetchProjects = useProjectStore((s) => s.fetchProjects);
  const fetchServerInfo = useSettingsStore((s) => s.fetchServerInfo);
  const activeProject = useProjectStore((s) => s.activeProject);

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
  useEffect(() => { fetchServerInfo(); }, [fetchServerInfo]);

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

  // Health check — detects server crash/restart
  useHealthCheck();

  // Fetch projects after auth, then restore from URL if applicable
  useEffect(() => {
    if (authState !== "authenticated") return;

    fetchProjects().then(() => {
      const { projectName: urlProject, tabId: urlTab } = parseUrlState();
      const projects = useProjectStore.getState().projects;

      if (urlProject) {
        const matched = projects.find((p) => p.name === urlProject);
        if (matched) {
          useProjectStore.getState().setActiveProject(matched);
          // After switchProject runs, restore active tab from URL
          if (urlTab) {
            queueMicrotask(() => {
              const { tabs } = useTabStore.getState();
              if (tabs.some((t) => t.id === urlTab)) {
                useTabStore.getState().setActiveTab(urlTab);
              }
            });
          }
          return;
        }
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
        {/* Mobile device name badge — floating top-left */}
        {deviceName && (
          <div className="md:hidden fixed top-0 left-0 z-50 px-2 py-0.5 bg-primary/80 text-primary-foreground text-[10px] font-medium rounded-br">
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
        </div>

        {/* Mobile bottom nav */}
        <MobileNav
          onMenuPress={() => setDrawerOpen(true)}
          onProjectsPress={() => setProjectSheetOpen(true)}
        />

        {/* Mobile drawer overlay */}
        <MobileDrawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
        />

        {/* Mobile project bottom sheet */}
        <ProjectBottomSheet
          isOpen={projectSheetOpen}
          onClose={() => setProjectSheetOpen(false)}
        />

        {/* Command palette (Shift+Shift) */}
        <CommandPalette open={paletteOpen} onClose={closePalette} initialQuery={paletteInitialQuery} />

        {/* Toast notifications */}
        <Toaster
          position="bottom-left"
          toastOptions={{
            className: "bg-surface border-border text-foreground",
          }}
        />
      </div>
    </TooltipProvider>
  );
}
