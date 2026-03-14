import { useEffect, useState, useCallback } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TabBar } from "@/components/layout/tab-bar";
import { TabContent } from "@/components/layout/tab-content";
import { Sidebar } from "@/components/layout/sidebar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { MobileDrawer } from "@/components/layout/mobile-drawer";
import { LoginScreen } from "@/components/auth/login-screen";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore } from "@/stores/tab-store";
import {
  useSettingsStore,
  applyThemeClass,
} from "@/stores/settings-store";
import { getAuthToken } from "@/lib/api-client";
import { Menu } from "lucide-react";

type AuthState = "checking" | "authenticated" | "unauthenticated";

export function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const theme = useSettingsStore((s) => s.theme);
  const fetchProjects = useProjectStore((s) => s.fetchProjects);
  const activeProject = useProjectStore((s) => s.activeProject);
  const tabs = useTabStore((s) => s.tabs);

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

  // Fetch projects after auth
  useEffect(() => {
    if (authState === "authenticated") {
      fetchProjects();
    }
  }, [authState, fetchProjects]);

  // Open default tab if none open after auth
  useEffect(() => {
    if (authState === "authenticated" && tabs.length === 0) {
      useTabStore.getState().openTab({
        type: "projects",
        title: "Projects",
        closable: false,
      });
    }
  }, [authState, tabs.length]);

  const handleLoginSuccess = useCallback(() => {
    setAuthState("authenticated");
  }, []);

  if (authState === "checking") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-pulse text-text-secondary text-sm">
          Loading...
        </div>
      </div>
    );
  }

  if (authState === "unauthenticated") {
    return <LoginScreen onSuccess={handleLoginSuccess} />;
  }

  return (
    <TooltipProvider>
      <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
        {/* Mobile header */}
        <header className="flex md:hidden items-center h-12 px-3 border-b border-border bg-background">
          <button
            onClick={() => setDrawerOpen(true)}
            className="flex items-center justify-center size-9 rounded-md hover:bg-surface-elevated transition-colors"
          >
            <Menu className="size-5" />
          </button>
          <span className="ml-2 text-sm font-semibold truncate">
            PPM
            {activeProject ? ` — ${activeProject.name}` : ""}
          </span>
        </header>

        {/* Main layout */}
        <div className="flex flex-1 overflow-hidden">
          {/* Desktop sidebar */}
          <Sidebar />

          {/* Content area */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Desktop tab bar */}
            <TabBar />

            {/* Tab content */}
            <main className="flex-1 overflow-hidden pb-12 md:pb-0">
              <TabContent />
            </main>
          </div>
        </div>

        {/* Mobile bottom nav */}
        <MobileNav />

        {/* Mobile drawer overlay */}
        <MobileDrawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
        />

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
