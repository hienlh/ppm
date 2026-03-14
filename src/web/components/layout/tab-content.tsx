import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { useTabStore } from "../../stores/tab.store";
import type { Tab, TabType } from "../../stores/tab.store";

const GitGraph = lazy(() =>
  import("../git/git-graph").then((m) => ({ default: m.GitGraph })),
);
const GitStatusPanel = lazy(() =>
  import("../git/git-status-panel").then((m) => ({ default: m.GitStatusPanel })),
);
const GitDiffTab = lazy(() =>
  import("../git/git-diff-tab").then((m) => ({ default: m.GitDiffTab })),
);

const ProjectList = lazy(() =>
  import("../projects/project-list").then((m) => ({ default: m.ProjectList })),
);
const CodeEditor = lazy(() =>
  import("../editor/code-editor").then((m) => ({ default: m.CodeEditor })),
);
const DiffViewer = lazy(() =>
  import("../editor/diff-viewer").then((m) => ({ default: m.DiffViewer })),
);
const TerminalTab = lazy(() =>
  import("../terminal/terminal-tab").then((m) => ({ default: m.TerminalTab })),
);
const ChatTab = lazy(() =>
  import("../chat/chat-tab").then((m) => ({ default: m.ChatTab })),
);

function ComingSoon({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      <span className="text-sm">{label} — Coming Soon</span>
    </div>
  );
}

function TabView({ tab }: { tab: Tab }) {
  const meta = tab.metadata ?? {};
  switch (tab.type) {
    case "projects":
      return <ProjectList />;
    case "terminal":
      return <TerminalTab terminalId={tab.id} />;
    case "chat":
      return <ChatTab sessionId={meta.sessionId as string | undefined} />;
    case "editor":
      return (
        <CodeEditor
          filePath={meta.filePath as string}
          tabId={tab.id}
        />
      );
    case "git-graph":
      return <ComingSoon label="Git Graph" />;
    case "git-status":
      return <ComingSoon label="Git Status" />;
    case "git-diff":
      return (
        <DiffViewer
          leftPath={meta.leftPath as string}
          rightPath={meta.rightPath as string}
        />
      );
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
        <TabView tab={activeTab} />
      </Suspense>
    </div>
  );
}
