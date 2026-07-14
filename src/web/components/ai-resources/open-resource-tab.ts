import { useTabStore } from "@/stores/tab-store";
import type { AiResourceItem } from "@/lib/api-ai-resources";

/** Open (or focus) an AI resource in an editor tab. */
export function openResourceTab(item: AiResourceItem, project: string): void {
  const store = useTabStore.getState();
  const existing = store.tabs.find(
    (t) => t.type === "ai-resource" && (t.metadata?.filePath as string) === item.filePath,
  );
  if (existing) {
    store.setActiveTab(existing.id);
    return;
  }
  store.openTab({
    type: "ai-resource",
    title: item.name,
    projectId: null,
    closable: true,
    metadata: {
      filePath: item.filePath,
      name: item.name,
      resourceType: item.type,
      scope: item.scope,
      readOnly: item.readOnly,
      shadowed: item.shadowed,
      shadowedBy: item.shadowedBy ?? null,
      project,
    },
  });
}
