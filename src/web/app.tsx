import { useEffect } from "react";
import { Menu, Settings } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Sidebar } from "@/components/layout/sidebar";
import { TabBar } from "@/components/layout/tab-bar";
import { TabContent } from "@/components/layout/tab-content";
import { MobileNav } from "@/components/layout/mobile-nav";
import { useSettingsStore } from "@/stores/settings.store";
import { useProjectStore } from "@/stores/project.store";
import { useTabStore } from "@/stores/tab.store";
import { cn } from "@/lib/utils";

function MobileHeader() {
  const { activeProject } = useProjectStore();
  const { openTab } = useTabStore();
  const { toggleSidebar } = useSettingsStore();

  const title = activeProject ? activeProject.name : "PPM";

  return (
    <header className="md:hidden flex items-center h-12 px-3 border-b border-border bg-background shrink-0 gap-2">
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={toggleSidebar}
      >
        <Menu className="size-4" />
      </Button>

      <span className="flex-1 font-semibold text-sm truncate">{title}</span>

      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={() => openTab({ type: "settings", title: "Settings", closable: true })}
      >
        <Settings className="size-4" />
      </Button>
    </header>
  );
}

function ThemeSync() {
  const { theme } = useSettingsStore();

  useEffect(() => {
    const root = document.documentElement;
    const apply = (dark: boolean) =>
      dark ? root.classList.add("dark") : root.classList.remove("dark");

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      apply(mq.matches);
      const handler = (e: MediaQueryListEvent) => apply(e.matches);
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
    apply(theme === "dark");
  }, [theme]);

  return null;
}

export function App() {
  const { sidebarOpen } = useSettingsStore();

  return (
    <TooltipProvider>
      <ThemeSync />
      {/* Full viewport */}
      <div className="flex flex-col h-dvh overflow-hidden bg-background text-foreground">
        {/* Mobile header */}
        <MobileHeader />

        {/* Main content area */}
        <div className="flex flex-1 overflow-hidden">
          {/* Desktop sidebar */}
          <Sidebar />

          {/* Right pane: tab bar + content */}
          <div
            className={cn(
              "flex flex-col flex-1 overflow-hidden",
              !sidebarOpen && "md:ml-0",
            )}
          >
            {/* Desktop tab bar */}
            <TabBar />

            {/* Tab content */}
            <TabContent />
          </div>
        </div>

        {/* Mobile bottom nav */}
        <MobileNav />

        {/* Mobile bottom nav spacer */}
        <div className="md:hidden h-14 shrink-0" />
      </div>
    </TooltipProvider>
  );
}
