import {
  FolderOpen,
  Terminal,
  MessageSquare,
  GitBranch,
  GitCommitHorizontal,
  FileDiff,
  FileCode,
  Settings,
  Menu,
  X,
} from "lucide-react";
import { useTabStore, type TabType } from "@/stores/tab-store";
import { cn } from "@/lib/utils";
import { useEffect, useRef } from "react";

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

interface MobileNavProps {
  onMenuPress: () => void;
}

/**
 * Mobile bottom tab bar — scrollable tabs with menu button on the left.
 */
export function MobileNav({ onMenuPress }: MobileNavProps) {
  const { tabs, activeTabId, setActiveTab, closeTab } = useTabStore();
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const prevTabCount = useRef(tabs.length);

  // Auto-scroll to new tab when added
  useEffect(() => {
    if (tabs.length > prevTabCount.current && activeTabId) {
      const el = tabRefs.current.get(activeTabId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      }
    }
    prevTabCount.current = tabs.length;
  }, [tabs.length, activeTabId]);

  return (
    <nav className="fixed bottom-0 left-0 right-0 md:hidden bg-background border-t border-border z-40">
      <div className="flex items-center h-12">
        {/* Menu button — opens drawer with file tree + new tab options */}
        <button
          onClick={onMenuPress}
          className="flex items-center justify-center size-12 shrink-0 text-text-secondary border-r border-border"
        >
          <Menu className="size-5" />
        </button>

        <div className="flex-1 flex items-center h-12 overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = TAB_ICONS[tab.type];
            const isActive = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(tab.id, el);
                  else tabRefs.current.delete(tab.id);
                }}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex items-center gap-1 px-3 h-12 whitespace-nowrap text-xs shrink-0 border-t-2 transition-colors",
                  isActive
                    ? "border-primary bg-surface text-primary"
                    : "border-transparent text-text-secondary",
                )}
              >
                <Icon className="size-4" />
                <span className="max-w-[80px] truncate">{tab.title}</span>
                {tab.closable && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    className="ml-0.5 p-0.5 rounded hover:bg-surface-elevated"
                  >
                    <X className="size-3" />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
