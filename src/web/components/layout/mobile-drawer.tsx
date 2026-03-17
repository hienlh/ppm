import { useState, useCallback } from "react";
import {
  X, Bug, FolderOpen, GitBranch, MessageSquare,
} from "lucide-react";
import { useProjectStore } from "@/stores/project-store";
import { useSettingsStore } from "@/stores/settings-store";
import { FileTree } from "@/components/explorer/file-tree";
import { GitStatusPanel } from "@/components/git/git-status-panel";
import { ChatHistoryPanel } from "@/components/chat/chat-history-panel";
import { openBugReport } from "@/lib/report-bug";
import { cn } from "@/lib/utils";

type DrawerTab = "explorer" | "git" | "history";

const TABS: { id: DrawerTab; label: string; icon: React.ElementType }[] = [
  { id: "explorer", label: "Explorer", icon: FolderOpen },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "history", label: "History", icon: MessageSquare },
];

interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MobileDrawer({ isOpen, onClose }: MobileDrawerProps) {
  const { activeProject } = useProjectStore();
  const version = useSettingsStore((s) => s.version);
  const [activeTab, setActiveTab] = useState<DrawerTab>("explorer");

  const handleReportBug = useCallback(() => openBugReport(version), [version]);

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 md:hidden transition-opacity duration-200",
        isOpen ? "opacity-100" : "opacity-0 pointer-events-none",
      )}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-label="Close drawer"
      />

      {/* Drawer panel */}
      <div
        className={cn(
          "fixed left-0 top-0 bottom-0 w-[280px] bg-background border-r border-border",
          "z-50 flex flex-col transition-transform duration-300 ease-out",
          isOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* Header — logo + close */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <span className="text-sm font-bold text-primary tracking-tight">
            {activeProject?.name ?? "PPM"}
          </span>
          <button
            onClick={onClose}
            className="flex items-center justify-center size-8 rounded-md hover:bg-surface-elevated transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Tab content — scrollable */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {activeTab === "explorer" && (
            activeProject ? (
              <FileTree onFileOpen={onClose} />
            ) : (
              <p className="px-4 py-6 text-xs text-text-secondary text-center">
                Select a project from the bottom nav bar
              </p>
            )
          )}
          {activeTab === "git" && (
            <GitStatusPanel metadata={{ projectName: activeProject?.name }} />
          )}
          {activeTab === "history" && (
            <ChatHistoryPanel projectName={activeProject?.name} />
          )}
        </div>

        {/* Bottom tab bar — thumb-friendly */}
        <div className="shrink-0 border-t border-border">
          <div className="flex items-center">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex-1 flex flex-col items-center gap-0.5 py-2.5 text-[10px] transition-colors",
                    isActive ? "text-primary" : "text-text-secondary",
                  )}
                >
                  <Icon className="size-4" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* Report Bug + Version */}
          <div className="flex items-center justify-between px-4 py-2 border-t border-border">
            {version && <span className="text-[10px] text-text-subtle">v{version}</span>}
            <button
              onClick={handleReportBug}
              className="flex items-center gap-1 text-[10px] text-text-subtle hover:text-text-secondary transition-colors"
            >
              <Bug className="size-3" />
              <span>Report Bug</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
