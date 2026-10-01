import { useCallback, useEffect } from "react";
import { projectCacheId } from "@/lib/browser-cache/cache-keys";
import { useSessionListStore } from "@/stores/session-list-store";
import { useProjectRef } from "@/stores/session-list-sync-triggers";
import type { ProjectTag } from "../../../types/chat";

/** Project tags + counts from the shared session-list store — every reader
 * (welcome panel, tab bar, mobile nav) shares the one synced copy instead of
 * fetching its own. */
export function useProjectTags(projectName: string | undefined) {
  const project = useProjectRef(projectName);
  const id = project ? projectCacheId(project) : null;

  useEffect(() => {
    if (project) void useSessionListStore.getState().ensure(project);
  }, [project]);

  const tagsState = useSessionListStore((s) => (id ? s.byProject[id]?.tags : null) ?? null);

  const loadTags = useCallback(() => {
    if (project) void useSessionListStore.getState().refreshTags(project);
  }, [project]);

  return { projectTags: tagsState?.tags ?? [], tagCounts: tagsState?.counts ?? {}, loadTags };
}

/** Horizontal chip bar for filtering sessions by tag */
export function TagChipBar({ projectTags, tagCounts, totalCount, selectedTagId, onSelect }: {
  projectTags: ProjectTag[];
  tagCounts: Record<number, number>;
  totalCount: number;
  selectedTagId: number | null;
  onSelect: (tagId: number | null) => void;
}) {
  if (projectTags.length === 0) return null;
  return (
    <div className="flex items-center gap-1 px-2 py-1.5 overflow-x-auto scrollbar-none">
      <button
        onClick={() => onSelect(null)}
        className={`shrink-0 rounded-md border px-2 py-1 text-[10px] transition-colors ${
          selectedTagId === null ? "bg-primary/20 border-primary text-primary" : "border-border bg-surface text-text-secondary hover:bg-surface-elevated"
        }`}
      >All ({totalCount})</button>
      {projectTags.map((tag) => (
        <button
          key={tag.id}
          onClick={() => onSelect(selectedTagId === tag.id ? null : tag.id)}
          className={`shrink-0 flex items-center gap-1 rounded-md border px-2 py-1 text-[10px] transition-colors ${
            selectedTagId === tag.id ? "border-current" : "border-border bg-surface hover:bg-surface-elevated"
          }`}
          style={selectedTagId === tag.id ? { backgroundColor: tag.color + "20", color: tag.color, borderColor: tag.color } : undefined}
        >
          <span className="size-2 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
          {tag.name} ({tagCounts[tag.id] ?? 0})
        </button>
      ))}
    </div>
  );
}
