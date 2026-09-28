import { useEffect, useRef, type ReactNode } from "react";
import { useTabStore } from "@/stores/tab-store";
import { emitOnboardingEvidence } from "@/lib/onboarding/onboarding-types";

/** Loaded Markdown is readable in Preview too; a Suspense fallback never counts. */
export function OnboardingRunDocumentPreview({ projectName, filePath, tabId, ready, children }: {
  projectName?: string; filePath?: string; tabId?: string; ready: boolean; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const activeTabId = useTabStore((state) => state.activeTabId);
  useEffect(() => {
    const report = () => {
      if (!ready || !projectName || !filePath || !tabId || activeTabId !== tabId) return;
      const visible = !!ref.current?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      if (visible) emitOnboardingEvidence({ type: "file-ready", projectName, tabId, visible,
        isRunDocument: /^readme(?:\.[^/\\]+)?$/i.test(filePath.split(/[/\\]/).pop() ?? "") });
    };
    report();
    window.addEventListener("ppm:onboarding-refresh", report);
    return () => window.removeEventListener("ppm:onboarding-refresh", report);
  }, [projectName, filePath, tabId, ready, activeTabId]);
  return <div ref={ref} className="flex flex-1 min-h-0 flex-col">{children}</div>;
}
