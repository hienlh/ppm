import {
  FolderOpen,
  Terminal,
  MessageSquare,
  GitBranch,
  GitCommitHorizontal,
  FileDiff,
  Settings,
  X,
  FileCode,
} from "lucide-react";
import { useProjectStore } from "@/stores/project-store";
import { useTabStore, type TabType } from "@/stores/tab-store";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { FileTree } from "@/components/explorer/file-tree";

interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

const TAB_ICONS: Record<TabType, React.ElementType> = {
  projects: FolderOpen,
  terminal: Terminal,
  chat: MessageSquare,
  editor: FileCode,
  "git-graph": GitBranch,
  "git-status": GitCommitHorizontal,
  "git-diff": FileDiff,
  settings: Settings,
};

const NEW_TAB_OPTIONS: { type: TabType; label: string }[] = [
  { type: "projects", label: "Projects" },
  { type: "terminal", label: "Terminal" },
  { type: "chat", label: "AI Chat" },
  { type: "git-status", label: "Git Status" },
  { type: "git-graph", label: "Git Graph" },
  { type: "settings", label: "Settings" },
];

/**
 * Mobile drawer overlay — opens from bottom-left menu button.
 * Top: file tree of current project.
 * Bottom: new tab options.
 */
export function MobileDrawer({ isOpen, onClose }: MobileDrawerProps) {
  const activeProject = useProjectStore((s) => s.activeProject);
  const openTab = useTabStore((s) => s.openTab);

  function handleNewTab(type: TabType) {
    const needsProject =
      type === "git-graph" || type === "git-status" || type === "git-diff" || type === "terminal" || type === "chat";
    const metadata = needsProject
      ? { projectName: activeProject?.name }
      : undefined;
    const label = NEW_TAB_OPTIONS.find((o) => o.type === type)?.label ?? type;
    openTab({ type, title: label, metadata, projectId: activeProject?.name ?? null, closable: type !== "projects" });
    onClose();
  }

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 md:hidden transition-opacity duration-200",
        isOpen
          ? "opacity-100"
          : "opacity-0 pointer-events-none",
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
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <FolderOpen className="size-4 text-primary" />
            <span className="text-sm font-semibold truncate">
              {activeProject?.name ?? "PPM"}
            </span>
          </div>
          <button
            onClick={onClose}
            className="flex items-center justify-center size-8 rounded-md hover:bg-surface-elevated transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* File tree — takes remaining space */}
        <div className="flex-1 overflow-y-auto">
          {activeProject ? (
            <FileTree onFileOpen={onClose} />
          ) : (
            <p className="px-4 py-3 text-xs text-text-secondary">
              No project selected.
            </p>
          )}
        </div>

        {/* New tab options — pinned at bottom */}
        <Separator />
        <div className="px-2 py-2 space-y-0.5">
          <p className="px-2 pb-1 text-xs font-semibold text-text-secondary uppercase tracking-wider">
            New Tab
          </p>
          {NEW_TAB_OPTIONS.map((opt) => {
            const Icon = TAB_ICONS[opt.type];
            return (
              <button
                key={opt.type}
                onClick={() => handleNewTab(opt.type)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-text-secondary hover:bg-surface-elevated hover:text-foreground transition-colors min-h-[40px]"
              >
                <Icon className="size-4 shrink-0" />
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
