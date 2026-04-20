import { useState, useEffect, useCallback } from "react";
import { api, projectUrl } from "@/lib/api-client";
import type { ProjectTag } from "../../../types/chat";

/** Fetch project tags + counts; returns state for filter chips */
export function useProjectTags(projectName: string | undefined) {
  const [projectTags, setProjectTags] = useState<ProjectTag[]>([]);
  const [tagCounts, setTagCounts] = useState<Record<number, number>>({});

  const loadTags = useCallback(async () => {
    if (!projectName) return;
    try {
      const data = await api.get<{ tags: ProjectTag[]; counts: Record<number, number> }>(
        `${projectUrl(projectName)}/tags`,
      );
      setProjectTags(data.tags);
      setTagCounts(data.counts);
    } catch { /* silent */ }
  }, [projectName]);

  useEffect(() => { loadTags(); }, [loadTags]);

  return { projectTags, tagCounts, loadTags };
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
