import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { useTabStore } from "../../stores/tab.store";
import type { TabType } from "../../stores/tab.store";

const ProjectList = lazy(() =>
  import("../projects/project-list").then((m) => ({ default: m.ProjectList })),
);

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <span className="text-sm">{label} — Coming Soon</span>
    </div>
  );
}

function TabView({ type }: { type: TabType }) {
  switch (type) {
    case "projects":
      return <ProjectList />;
    case "terminal":
      return <ComingSoon label="Terminal" />;
    case "chat":
      return <ComingSoon label="Chat" />;
    case "editor":
      return <ComingSoon label="Editor" />;
    case "git-graph":
      return <ComingSoon label="Git Graph" />;
    case "git-status":
      return <ComingSoon label="Git Status" />;
    case "git-diff":
      return <ComingSoon label="Git Diff" />;
    case "settings":
      return <ComingSoon label="Settings" />;
    default:
      return null;
  }
}

function LoadingSpinner() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}

export function TabContent() {
  const { tabs, activeTabId } = useTabStore();
  const activeTab = tabs.find((t) => t.id === activeTabId);

  if (!activeTab) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        No tab open
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden h-full">
      <Suspense fallback={<LoadingSpinner />}>
        <TabView type={activeTab.type} />
      </Suspense>
    </div>
  );
}
